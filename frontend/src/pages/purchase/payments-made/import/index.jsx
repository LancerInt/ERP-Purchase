import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Upload, Loader2, FileText, X } from 'lucide-react';
import MainLayout from '../../../../components/layout/MainLayout';
import PageHeader from '../../../../components/common/PageHeader';
import ListState from '@/components/common/ListState.jsx';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import ImportStatementModal from '@/components/common/ImportStatementModal.jsx';
import { confirm } from '@/components/common/confirm';
import apiClient from '../../../../utils/api.js';
import useLookup from '../../../../hooks/useLookup.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';
import { formatDate } from '@/utils/formatters';

const todayISO = () => new Date().toISOString().slice(0, 10);

// Import Bank Statements — a page (not a popup) in the Scan-Inbox style:
// upload a statement inline, then every uploaded statement shows its pipeline
// (Detected -> Entered -> Missing) with a Record button. Recording still uses
// the proven review step (Phase 2 moves it fully onto the page).
export default function ImportBankStatements() {
  const navigate = useNavigate();
  const { options: accountOptions } = useLookup('/api/bank/accounts/?real_bank=1&include_cash=1', {
    labelField: (a) => (a.internal_alias ? `${a.internal_alias} · ${a.code} · ${a.nickname}` : `${a.code} · ${a.nickname}`),
    valueField: 'id',
  });
  const { options: companyOptions } = useLookup('/api/companies/', { labelField: 'company_code' });

  const [company, setCompany] = useState(''); // '' = All
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const [inbox, setInbox] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(null); // {id, account} -> open recording

  const loadInbox = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = { side: 'debit' };
      if (company) params.company = company;
      const { data } = await apiClient.get('/api/finance/bank-statements/inbox/', { params });
      setInbox(data.results || []);
    } catch (err) {
      setError(err.response?.data || err.message);
    } finally {
      setIsLoading(false);
    }
  }, [company]);

  useEffect(() => { loadInbox(); }, [loadInbox]);

  // Close/archive a statement off the inbox (soft — keeps its lines + any
  // recorded payments). Confirm when rows are still unrecorded.
  const dismissStatement = useCallback(async (s) => {
    if (s.missing > 0) {
      const ok = await confirm({
        message: `Close this statement? It still has ${s.missing} row(s) to record. To start over, upload the file again to re-import it fresh.`,
        confirmLabel: 'Close', isDangerous: true,
      });
      if (!ok) return;
    }
    try {
      await apiClient.post(`/api/finance/bank-statements/${s.id}/dismiss/`);
      setInbox((list) => list.filter((x) => x.id !== s.id));
      toast.success('Statement closed — upload the file again to re-import it.');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  }, []);

  const upload = useCallback(async () => {
    if (!account || !file) { toast.error('Pick a bank account and a file.'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('bank_account', account);
      fd.append('statement_file', file);
      fd.append('statement_period_start', from);
      fd.append('statement_period_end', to);
      fd.append('skip_match', '1'); // parse only — this page records, not reconciles
      const { data } = await apiClient.post('/api/finance/bank-statements/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 700000, // a scanned PDF goes through vision extraction
      });
      if (data.parsing_status === 'ERROR') {
        toast.error(data.parse_error || 'Could not read this statement.');
        return;
      }
      toast.success(data.reused_existing ? 'Already uploaded — opening it.' : 'Statement read — record the payments.');
      setFile(null);
      await loadInbox();
      setActive({ id: data.id, account }); // jump straight into recording
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [account, file, from, to, loadInbox]);

  const Stat = ({ label, value, cls }) => (
    <div className="flex-1 text-center">
      <div className={`text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );

  return (
    <MainLayout>
      <PageHeader
        title="Import Bank Statements"
        subtitle="Upload a statement and record the payments in it"
        breadcrumbs={[{ label: 'Finance' }, { label: 'Payments Made', to: '/purchase/payments-made' }, { label: 'Import' }]}
      />
      {/* Drill into a statement: record its rows INLINE on the page (no popup). */}
      {active && (
        <div className="space-y-3">
          <button
            onClick={() => { setActive(null); loadInbox(); }}
            className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
          ><ArrowLeft size={15} /> Back to statements</button>
          <ImportStatementModal
            embedded
            side="debit"
            initialUploadId={active.id}
            initialAccount={active.account}
            onClose={() => { setActive(null); loadInbox(); }}
            onRecorded={loadInbox}
          />
        </div>
      )}

      {!active && (<>
      {/* Redundant back removed — the PageHeader already has a back button. */}

      {/* Inline upload */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-5">
        <h3 className="text-sm font-semibold text-slate-700 mb-1">Upload a statement</h3>
        <p className="text-[11px] text-slate-400 mb-3">CSV or Excel export, or a PDF/photo — a scan is read automatically.</p>
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 items-end">
          <div className="lg:col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">Bank account <span className="text-red-500">*</span></label>
            <CustomSelect value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Select the account this statement is for…" className="w-full">
              {accountOptions.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Period start</label>
            <CustomDatePicker value={from} onChange={(e) => setFrom(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Period end</label>
            <CustomDatePicker value={to} onChange={(e) => setTo(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          </div>
          <div className="lg:col-span-3">
            <label className="block text-xs font-medium text-slate-600 mb-1">Statement file <span className="text-red-500">*</span></label>
            <input type="file" accept=".csv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="w-full text-sm file:mr-3 file:h-9 file:px-3 file:rounded-lg file:border-0 file:bg-slate-100 file:text-slate-700" />
          </div>
          <div>
            <button type="button" onClick={upload} disabled={busy || !account || !file}
              className="w-full h-10 inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
              {busy ? 'Reading…' : 'Read statement'}
            </button>
          </div>
        </div>
      </div>

      {/* Uploaded statements — pipeline cards */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-slate-700">Uploaded statements</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-slate-500 mr-1">Company</span>
          <button type="button" onClick={() => setCompany('')}
            className={`px-2.5 py-1 text-xs font-medium rounded-full border ${company === '' ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400'}`}>All</button>
          {companyOptions.map((c) => (
            <button key={c.value} type="button" onClick={() => setCompany(c.value)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border ${company === c.value ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400'}`}>{c.label}</button>
          ))}
        </div>
      </div>
      <ListState error={error} onRetry={loadInbox}>
        {isLoading && inbox.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400">Loading…</div>
        ) : inbox.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-400">
            No statements uploaded yet. Upload one above to get started.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {inbox.map((s) => {
              const pct = s.detected ? Math.round((s.entered / s.detected) * 100) : 0;
              const done = s.detected > 0 && s.missing === 0;
              return (
                <div key={s.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate" title={s.bank_account?.label}>
                        {s.bank_account?.label || '—'}
                        {s.company_code && <span className="ml-2 text-[10px] text-slate-400">{s.company_code}</span>}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>{s.period_start ? formatDate(s.period_start) : '—'} – {s.period_end ? formatDate(s.period_end) : '—'}</span>
                        {s.file_name && <span className="inline-flex items-center gap-1"><FileText size={11} />{s.file_name}</span>}
                        <span>uploaded {s.uploaded_at ? formatDate(s.uploaded_at) : '—'}</span>
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-1.5">
                      <button
                        onClick={() => setActive({ id: s.id, account: s.bank_account?.id || '' })}
                        className={`h-8 px-3 rounded-lg text-xs font-medium ${done ? 'border border-slate-300 bg-white text-slate-600 hover:bg-slate-50' : 'bg-primary-600 text-white hover:bg-primary-700'}`}
                      >{done ? 'Review' : 'Record'}</button>
                      <button
                        onClick={() => dismissStatement(s)}
                        title="Close this statement off the list. To start over, upload the file again to re-import it fresh."
                        aria-label="Close and re-import statement"
                        className="h-8 px-2.5 inline-flex items-center gap-1 rounded-lg border border-slate-200 text-xs font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                      ><X size={14} /> Close</button>
                    </div>
                  </div>

                  <div className="mt-3 flex items-stretch gap-2 rounded-lg bg-slate-50 border border-slate-100 py-2">
                    <Stat label="Detected" value={s.detected} cls="text-slate-700" />
                    <div className="w-px bg-slate-200" />
                    <Stat label="Entered" value={s.entered} cls="text-emerald-600" />
                    <div className="w-px bg-slate-200" />
                    <Stat label="Missing" value={s.missing} cls={s.missing ? 'text-amber-600' : 'text-slate-400'} />
                  </div>

                  <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className={`h-full ${done ? 'bg-emerald-500' : 'bg-primary-500'}`} style={{ width: `${pct}%` }} />
                  </div>
                  {(s.by_type?.payments || s.by_type?.transfers || s.by_type?.expenses || s.by_type?.other) ? (
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                      {s.by_type.payments ? <span className="px-1.5 py-0.5 rounded bg-primary-50 text-primary-700">{s.by_type.payments} payment(s)</span> : null}
                      {s.by_type.transfers ? <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">{s.by_type.transfers} transfer(s)</span> : null}
                      {s.by_type.expenses ? <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">{s.by_type.expenses} expense(s)</span> : null}
                      {s.by_type.other ? <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{s.by_type.other} other</span> : null}
                    </div>
                  ) : null}
                  {s.parsing_status === 'ERROR' && (
                    <div className="mt-2 text-[11px] text-red-600">Parse error: {s.parse_error || 'could not read this statement.'}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ListState>
      </>)}
    </MainLayout>
  );
}
