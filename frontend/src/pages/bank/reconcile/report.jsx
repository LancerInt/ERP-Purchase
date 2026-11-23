import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { RefreshCw, CheckCircle2, AlertTriangle, CalendarClock, HelpCircle, Landmark, ListChecks } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import EnterEntryModal from './EnterEntryModal.jsx';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate, formatCurrency } from '@/utils/formatters';

const TABS = [
  { key: 'matched', label: 'Matched', icon: CheckCircle2, color: 'text-green-600' },
  { key: 'date_mismatch', label: 'Date Mismatch', icon: CalendarClock, color: 'text-amber-600' },
  { key: 'amount_mismatch', label: 'Amount Mismatch', icon: AlertTriangle, color: 'text-red-600' },
  { key: 'statement_only', label: 'On Statement Only', icon: HelpCircle, color: 'text-slate-600' },
];

// Base columns every tab shows. Date/Amount Mismatch tabs additionally get
// an explicit "Tally says" column placed right next to the value it's being
// compared against — match_notes describes the gap in prose, but the actual
// two numbers/dates side by side is what you need to judge it at a glance.
// Cheque-clearing narrations use a bank shorthand prefix ("CLG/", "CHQ",
// "CTS") — without this, a cleared cheque's number is indistinguishable
// from a random reference digit string. NEFT/RTGS/IMPS/UPI references are
// already self-evidently UTR-style strings and are left as-is.
const _CHEQUE_NARRATION_RE = /\b(clg|chq|cts)\b/i;

function renderReference(value, row) {
  if (!value) return '—';
  if (_CHEQUE_NARRATION_RE.test(row.narration || '')) return `Cheque #${value}`;
  return value;
}

const BASE_COLUMNS = [
  { field: 'txn_date', header: 'Statement Date', width: '120px', render: (v) => formatDate(v) },
  { field: 'narration', header: 'Narration', width: '260px' },
  { field: 'reference_no', header: 'Reference', width: '150px', render: renderReference },
  {
    field: 'debit', header: 'Debit', width: '110px',
    render: (v) => v > 0 ? <span className="text-red-600">{formatCurrency(v)}</span> : '—',
  },
  {
    field: 'credit', header: 'Credit', width: '110px',
    render: (v) => v > 0 ? <span className="text-green-600">{formatCurrency(v)}</span> : '—',
  },
];

const TALLY_DATE_COLUMN = {
  field: 'matched_tally_date', header: 'Tally Date', width: '120px',
  render: (v) => v ? <span className="text-amber-700 font-medium">{formatDate(v)}</span> : '—',
};

const TALLY_AMOUNT_COLUMN = {
  field: 'matched_tally_amount', header: 'Tally Amount', width: '120px',
  render: (v) => v ? <span className="text-red-700 font-medium">{formatCurrency(v)}</span> : '—',
};

const TAIL_COLUMNS = [
  {
    field: 'matched_receipt_voucher', header: 'Matched Voucher', width: '150px',
    render: (v, row) => v || row.matched_payment_voucher || '—',
  },
  { field: 'match_notes', header: 'Notes', width: '220px' },
];

function lineColumnsFor(tab, { onEnter, onUndo, busyId } = {}) {
  const action = {
    field: '__act', header: '', width: '120px',
    render: (_, row) => {
      const busy = busyId === row.id;
      if (tab === 'statement_only') {
        return (
          <button type="button" onClick={() => onEnter?.(row)} disabled={busy}
            className="h-7 px-2.5 rounded-lg bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap">
            {num(row.debit) > 0 ? 'Record payment' : 'Record receipt'}
          </button>
        );
      }
      // `entry_created` is a fact on the row, not a string to match. Matching
      // sets the same matched_* FKs that creating does, so prose in
      // match_notes cannot tell the two apart — and offering Undo on a
      // merely-matched line would invite deleting a pre-existing payment.
      if (row.entry_created) {
        return (
          <button type="button" onClick={() => onUndo?.(row)} disabled={busy}
            className="h-7 px-2.5 rounded-lg border border-slate-300 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap">
            {busy ? 'Undoing…' : 'Undo'}
          </button>
        );
      }
      return null;
    },
  };
  if (tab === 'date_mismatch') return [...BASE_COLUMNS, TALLY_DATE_COLUMN, ...TAIL_COLUMNS, action];
  if (tab === 'amount_mismatch') return [...BASE_COLUMNS, TALLY_AMOUNT_COLUMN, ...TAIL_COLUMNS, action];
  return [...BASE_COLUMNS, ...TAIL_COLUMNS, action];
}

const num = (v) => Number(v) || 0;

export default function BankStatementReport() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('matched');
  const [isMatching, setIsMatching] = useState(false);
  const [entryLine, setEntryLine] = useState(null);   // line being entered
  const [busyId, setBusyId] = useState(null);         // line being undone
  const tallyOnlyRef = useRef(null);

  // Scoped to one half of the statement when opened from Payments Made
  // (debits) or Receivables (credits). One CSV carries both sides, and the
  // parser and matcher stay shared for exactly that reason — but the person
  // clearing payables should not have to scroll past customer receipts to
  // find their rows. Nothing is hidden from the data, only from this view;
  // the other side is still recorded and still shows on the other page.
  const [searchParams] = useSearchParams();
  const side = searchParams.get('side') || '';
  const sideFilter = useCallback((rows) => {
    if (side === 'debit') return (rows || []).filter((r) => Number(r.debit) > 0);
    if (side === 'credit') return (rows || []).filter((r) => Number(r.credit) > 0);
    return rows || [];
  }, [side]);
  const SIDE_COPY = {
    debit: { title: 'Payments in this statement', noun: 'payment' },
    credit: { title: 'Receipts in this statement', noun: 'receipt' },
  }[side] || null;

  // This endpoint returns a single object ({upload, matched, ...}), not a
  // paginated list — useApiData is hardcoded for list/array responses and
  // silently discards anything else as [], which made this page's loading
  // state never resolve. Fetched directly instead, matching the pattern
  // other single-record detail pages already use (e.g. purchase order detail).
  // `silent` skips the loading spinner for background polling refreshes —
  // only the initial load and an explicit manual retry should show it.
  const fetchReport = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient.get(`/api/finance/bank-statements/${id}/report/`);
      setData(res.data);
    } catch (err) {
      setError(err.response?.data || err.message);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchReport(); }, [fetchReport]);
  const refetch = fetchReport;

  // A large/scanned statement is parsed synchronously inside the upload
  // request, which can take several minutes once a big PDF needs the
  // page-chunked retry path — landing on this report page (a second tab,
  // or the upload page redirecting before its own request settled) while
  // that's still running shows a stale PENDING row that looks like a dead
  // end, even though it isn't. Poll quietly until it resolves either way
  // rather than leaving the user to guess and manually refresh.
  const uploadStatus = data?.upload?.parsing_status;
  useEffect(() => {
    if (uploadStatus !== 'PENDING') return undefined;
    const id = setInterval(() => fetchReport(true), 5000);
    return () => clearInterval(id);
  }, [uploadStatus, fetchReport]);

  const rerunMatch = useCallback(async () => {
    setIsMatching(true);
    try {
      await apiClient.post(`/api/finance/bank-statements/${id}/auto_match/`);
      toast.success('Reconciliation re-run.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsMatching(false);
    }
  }, [id, refetch]);

  // Three-way check. Loaded without the Tally leg by default: that leg costs a
  // connector round trip and can park the read, while statement-vs-ERP is the
  // pair that answers "did I record everything in this file?" — which must not
  // wait on Tally being reachable. The Tally column is pulled on demand.
  const [tw, setTw] = useState(null);
  const [twBusy, setTwBusy] = useState(false);
  const loadThreeWay = useCallback(async (withTally = false) => {
    setTwBusy(true);
    try {
      const r = await apiClient.get(
        `/api/finance/bank-statements/${id}/three-way/${withTally ? '?with_tally=1' : ''}`,
        { timeout: withTally ? 600000 : 60000 });
      setTw(r.data);
      if (withTally && r.data?.tally?.error) {
        toast.error('Could not reach Tally — showing the statement vs ERP check only.');
      }
    } catch {
      setTw(null);
    } finally {
      setTwBusy(false);
    }
  }, [id]);
  useEffect(() => { loadThreeWay(false); }, [loadThreeWay]);

  const undoEntry = useCallback(async (row) => {
    setBusyId(row.id);
    try {
      await apiClient.post(`/api/finance/bank-statements/${id}/undo-entry/`, { line_id: row.id });
      toast.success('Entry reversed — the bill/invoice has been put back.');
      refetch();
      loadThreeWay(false);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }, [id, refetch, loadThreeWay]);

  const upload = data?.upload;
  const tallyOnly = data?.tally_only || { receipts: [], payments: [] };
  // Both sides here are always this exact bank account, never cash — the
  // matching pool this comes from (bank_reconciliation._candidate_pool)
  // explicitly excludes cash ledgers, and a cash ledger has no statement to
  // upload/reconcile against in the first place.
  const tallyOnlyRows = [
    ...(tallyOnly.receipts || []).map(r => ({ ...r, kind: 'Bank Receipt (money in)' })),
    ...(tallyOnly.payments || []).map(p => ({ ...p, kind: 'Bank Payment (money out)' })),
  ];

  const breadcrumbs = [
    { label: 'Bank', href: '/bank/dashboard' },
    { label: 'Reconcile Statement', href: '/bank/reconcile' },
    { label: 'Reconciliation Report' },
  ];

  return (
    <MainLayout>
      <div className="space-y-4 sm:space-y-5">
        <PageHeader
          title="Bank Statement Reconciliation"
          subtitle={upload ? `${upload.bank_account_name} · ${formatDate(upload.statement_period_start)} – ${formatDate(upload.statement_period_end)}` : ''}
          breadcrumbs={breadcrumbs}
          actions={{
            right: (
              <button
                onClick={rerunMatch}
                disabled={isMatching || upload?.parsing_status !== 'PARSED'}
                className="flex items-center gap-1.5 px-3 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
              >
                <RefreshCw size={14} className={isMatching ? 'animate-spin' : ''} />
                Re-run matching
              </button>
            ),
          }}
        />

        <ListState error={error} onRetry={refetch}>
          {isLoading || !upload ? (
            <div className="bg-white rounded-lg border border-slate-200 p-8 text-center text-slate-500">Loading…</div>
          ) : upload.parsing_status === 'PENDING' ? (
            <div className="bg-white rounded-lg border border-slate-200 p-5">
              <div className="flex items-center gap-2 mb-2">
                <RefreshCw size={16} className="animate-spin text-slate-400" />
                <span className="font-medium text-slate-800">Still processing…</span>
              </div>
              <p className="text-sm text-slate-600">
                A large or scanned statement can take a few minutes to read. This page will update
                on its own — no need to refresh.
              </p>
            </div>
          ) : upload.parsing_status !== 'PARSED' ? (
            <div className="bg-white rounded-lg border border-red-200 p-5">
              <div className="flex items-center gap-2 mb-2">
                <StatusBadge status={upload.parsing_status} />
                <span className="font-medium text-slate-800">This statement could not be reconciled.</span>
              </div>
              <p className="text-sm text-slate-600">{upload.parse_error || 'The file could not be parsed.'}</p>
            </div>
          ) : (
            <>
              {data.summary && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    data.summary.opening_balance != null && { label: 'Opening Balance', value: data.summary.opening_balance, color: 'text-slate-500' },
                    { label: 'Total Withdrawals', value: data.summary.total_debit, color: 'text-red-600' },
                    { label: 'Total Deposits', value: data.summary.total_credit, color: 'text-green-600' },
                    data.summary.closing_balance != null && { label: 'Closing Balance', value: data.summary.closing_balance, color: 'text-slate-500' },
                  ].filter(Boolean).map(({ label, value, color }) => (
                    <div key={label} className="p-3 sm:p-4 rounded-lg border border-slate-200 bg-white">
                      <div className={`text-xs font-medium ${color}`}>{label}</div>
                      <div className="text-lg font-semibold text-slate-800 mt-1">{formatCurrency(value)}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Does this statement tie? The statement is the bank's own word,
                  so a mismatch names which system is short rather than just
                  reporting a difference. */}
              {tw && (
                <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <h3 className="text-sm font-semibold text-slate-800">Does this tie?</h3>
                    <button type="button" onClick={() => loadThreeWay(true)} disabled={twBusy}
                      className="h-7 px-2.5 rounded-lg border border-slate-300 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                      {twBusy ? 'Checking…' : 'Check against Tally'}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {[
                      { label: 'Statement says', value: tw.statement?.closing,
                        note: "The bank's own closing balance" },
                      { label: 'ERP says', value: tw.erp?.closing,
                        note: 'Opening + everything recorded here',
                        gap: tw.gaps?.erp_vs_statement },
                      { label: 'Tally says', value: tw.tally?.closing,
                        note: tw.tally?.closing == null
                          ? 'Not checked yet' : `Ledger: ${tw.tally_ledger || '—'}`,
                        gap: tw.gaps?.tally_vs_statement },
                    ].map(({ label, value, note, gap }) => {
                      const off = gap != null && Number(gap) !== 0;
                      return (
                        <div key={label} className={`rounded-lg border p-3 ${off ? 'border-red-200 bg-red-50/40' : 'border-slate-200'}`}>
                          <div className="text-xs font-medium text-slate-500">{label}</div>
                          <div className="text-lg font-semibold text-slate-800 mt-1 tabular-nums">
                            {value == null ? '—' : formatCurrency(value)}
                          </div>
                          <div className="text-[11px] text-slate-400">{note}</div>
                          {off && (
                            <div className="text-[11px] font-medium text-red-600 mt-1 tabular-nums">
                              off by {formatCurrency(Math.abs(Number(gap)))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {tw.verdict && (
                    <p className="text-xs text-slate-600 mt-3">{tw.verdict}</p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                {/* Informational, not a tab — total line count across every
                    bucket, so the four filtered counts below always have a
                    denominator to check against without adding them up by hand. */}
                <div className="text-left p-3 sm:p-4 rounded-lg border border-slate-200 bg-white">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                    <ListChecks size={14} />
                    Total Transactions
                  </div>
                  <div className="text-xl font-semibold text-slate-800 mt-1">{data.summary?.total_lines ?? upload.total_lines ?? '—'}</div>
                </div>
                {TABS.map(({ key, label, icon: Icon, color }) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={`text-left p-3 sm:p-4 rounded-lg border transition ${
                      activeTab === key ? 'border-primary-500 bg-primary-50' : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <div className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
                      <Icon size={14} />
                      {label}
                    </div>
                    <div className="text-xl font-semibold text-slate-800 mt-1">{sideFilter(data[key]).length}</div>
                  </button>
                ))}
                {/* Not a tab (that table is always shown below, not filtered
                    by activeTab) — this tile just gives the count the same
                    top-level visibility as the four buckets above it, since
                    it was previously easy to miss as plain text below the
                    fold. */}
                <button
                  onClick={() => tallyOnlyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className="text-left p-3 sm:p-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition"
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium text-purple-600">
                    <Landmark size={14} />
                    In Tally, Not on Statement
                  </div>
                  <div className="text-xl font-semibold text-slate-800 mt-1">{tallyOnlyRows.length}</div>
                </button>
              </div>

              <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
                {SIDE_COPY && (
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <h3 className="text-sm font-semibold text-slate-800">{SIDE_COPY.title}</h3>
                    <button type="button" onClick={() => navigate(`/bank/reconcile/${id}`)}
                      className="h-7 px-2.5 rounded-lg border border-slate-300 text-[11px] font-medium text-slate-600 hover:bg-slate-50">
                      Show the whole statement
                    </button>
                  </div>
                )}
                {activeTab === 'statement_only' && sideFilter(data[activeTab]).length > 0 && (
                  <p className="text-xs text-slate-500 mb-3">
                    These moved in the bank but have no record in the ERP. Record each one
                    against a bill/invoice — or on account when it settles no single document —
                    and the paid, payable and outstanding figures update with it.
                  </p>
                )}
                <DataTable
                  columns={lineColumnsFor(activeTab, {
                    onEnter: setEntryLine, onUndo: undoEntry, busyId,
                  })}
                  data={sideFilter(data[activeTab])}
                  isLoading={false}
                  emptyMessage={SIDE_COPY
                    ? `No ${SIDE_COPY.noun}s in this bucket.`
                    : 'Nothing in this bucket.'}
                />
              </div>

              <div ref={tallyOnlyRef} className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4 scroll-mt-4">
                <h3 className="text-sm font-semibold text-slate-800 mb-3">
                  In Tally, not on the statement ({tallyOnlyRows.length})
                </h3>
                <DataTable
                  columns={[
                    { field: 'kind', header: 'Type', width: '160px' },
                    { field: 'voucher_no', header: 'Voucher', width: '120px' },
                    { field: 'date', header: 'Date', width: '110px', render: (v) => formatDate(v) },
                    { field: 'amount', header: 'Amount', width: '120px', render: (v) => formatCurrency(v) },
                    {
                      field: 'party', header: 'Party', width: '200px',
                      render: (_, row) => row.customer || row.vendor || '—',
                    },
                  ]}
                  data={tallyOnlyRows}
                  isLoading={false}
                  emptyMessage="No unmatched Tally entries in this statement's window."
                />
              </div>
            </>
          )}
        </ListState>
      </div>

      {entryLine && (
        <EnterEntryModal
          uploadId={id}
          line={entryLine}
          onClose={() => setEntryLine(null)}
          onDone={() => { setEntryLine(null); refetch(); loadThreeWay(false); }}
        />
      )}
    </MainLayout>
  );
}
