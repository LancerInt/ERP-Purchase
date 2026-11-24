import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import ListState from '@/components/common/ListState.jsx';
import apiClient from '../../../utils/api.js';
import { ArrowLeft, ArrowRight, FileText } from 'lucide-react';
import { formatDate, formatCurrency } from '@/utils/formatters';

const holdingShort = (id) => 'TRF-' + String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase();

function Field({ label, children }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm text-slate-800 break-words">{children ?? '—'}</div>
    </div>
  );
}

// Detail view for one own-account transfer (sweep). Shows what it is, who
// recorded it and when, and WHERE it came from (the bank statement it was
// read off). No voucher exists — the statement line IS the record — so this
// is the full story of that transfer in one place, like the Bill detail page.
export default function TransferDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data } = await apiClient.get('/api/finance/bank-statements/transfers/', { params: { id } });
      setDetail(data.detail);
    } catch (err) {
      setError(err.response?.data || err.message);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const d = detail;
  const src = d?.source || {};

  return (
    <MainLayout>
      <PageHeader
        title={d ? `Transfer ${holdingShort(d.id)}` : 'Transfer'}
        subtitle="Money swept between your own accounts"
        breadcrumbs={[{ label: 'Bank' }, { label: 'Transfers', to: '/bank/transfers' }, { label: 'Detail' }]}
      />
      <button
        onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/bank/transfers')}
        className="inline-flex items-center gap-1 mb-4 text-sm text-slate-500 hover:text-slate-700"
      ><ArrowLeft size={15} /> Back to Transfers</button>

      <ListState error={error} onRetry={load}>
        {isLoading && !d && (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400">Loading…</div>
        )}
        {d && (
          <div className="space-y-4 max-w-4xl">
            {/* Headline: amount + from -> to */}
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-slate-400">Amount transferred</div>
                  <div className="mt-0.5 text-2xl font-semibold text-slate-900 tabular-nums">
                    {formatCurrency(Number(d.amount) || 0)}
                  </div>
                </div>
                <span className="px-2.5 py-1 text-xs font-semibold bg-indigo-50 text-indigo-700 rounded-full border border-indigo-200">
                  Internal transfer
                </span>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 font-medium">{d.from_account?.label || '—'}</span>
                <ArrowRight size={16} className="text-emerald-600" />
                <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 font-medium border border-emerald-200">{d.to_account?.label || '—'}</span>
              </div>
            </div>

            {/* Transfer details */}
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Transfer</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <Field label="Transaction date">{d.txn_date ? formatDate(d.txn_date) : '—'}</Field>
                <Field label="Entry date (recorded)">{d.entry_date ? formatDate(d.entry_date) : '—'}</Field>
                <Field label="Recorded by">{d.recorded_by || '—'}</Field>
                <Field label="Narration">{d.auto_narration}</Field>
                <Field label="Company">{d.company_code || '—'}</Field>
                <Field label="ERP Holding No">
                  <span className="font-mono text-xs">{d.holding_no}</span>
                </Field>
              </div>
            </div>

            {/* Where it came from — the bank statement */}
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Source — bank statement</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <Field label="Bank account (from)">{src.bank_account?.label || '—'}</Field>
                <Field label="Statement period">
                  {src.period_start ? formatDate(src.period_start) : '—'} – {src.period_end ? formatDate(src.period_end) : '—'}
                </Field>
                <Field label="Uploaded at">{src.uploaded_at ? formatDate(src.uploaded_at) : '—'}</Field>
                <Field label="Statement line #">{src.line_no ?? '—'}</Field>
                <Field label="Reference / UTR">{d.reference_no || '—'}</Field>
                <Field label="Balance on statement">
                  {d.statement_balance != null ? formatCurrency(Number(d.statement_balance)) : '—'}
                </Field>
                <div className="sm:col-span-2 lg:col-span-3">
                  <Field label="Original bank narration">
                    <span className="break-all">{d.bank_narration || '—'}</span>
                  </Field>
                </div>
                {src.file_name && (
                  <div className="sm:col-span-2 lg:col-span-3">
                    <Field label="Statement file">
                      {src.file_url ? (
                        <a href={src.file_url} target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-1.5 text-primary-600 hover:underline">
                          <FileText size={14} /> {src.file_name}
                        </a>
                      ) : src.file_name}
                    </Field>
                  </div>
                )}
              </div>
            </div>

            <p className="text-[11px] text-slate-400">
              This transfer is money moved between your own accounts. No vendor
              payment or expense was created — it's recorded against the
              destination account and read from the bank statement above.
            </p>
          </div>
        )}
      </ListState>
    </MainLayout>
  );
}
