/**
 * One receipt, broken back down into the invoices it settled.
 *
 * The Analytics customer statement shows a receipt the way Tally's ledger does
 * — one row per voucher, so four cheques read as four lines instead of the 42
 * allocation rows underneath them. This is the other half of that: click the
 * receipt and see exactly which bills the money went to, how much each got, and
 * what is still owed on them. Every invoice number links through to the invoice.
 *
 * The split comes from Tally's own bill-wise detail. It looked absent at first
 * because the voucher export fetched BILLALLOCATIONS.LIST without naming its
 * leaf fields, so every allocation arrived carrying only an amount — no bill
 * name, no type — and the parser dropped them. See _collection_envelope.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Receipt as ReceiptIcon, AlertCircle } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '../../../utils/formatters';

/** The bill numbers a payment settled that the ERP holds only inside an opening
 *  balance. Receipt 5 names 258 of them, so the block is capped and expands on
 *  demand — the row stays one line tall until someone asks for the detail. */
function PriorRefs({ refs }) {
  const [open, setOpen] = useState(false);
  if (!refs || !refs.length) return null;
  const CAP = 8;
  const shown = open ? refs : refs.slice(0, CAP);
  const hidden = refs.length - shown.length;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 max-w-[460px]">
      <span className="text-[10px] text-slate-400 mr-0.5">settles</span>
      {shown.map(ref => (
        <span key={ref}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-50
                     border border-slate-200 text-slate-600">
          {ref}
        </span>
      ))}
      {hidden > 0 && (
        <button onClick={() => setOpen(true)}
          className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200
                     text-blue-700 hover:bg-blue-100">
          +{hidden} more
        </button>
      )}
      {open && refs.length > CAP && (
        <button onClick={() => setOpen(false)}
          className="text-[10px] px-1.5 py-0.5 rounded text-slate-500 hover:text-slate-700">
          show less
        </button>
      )}
    </div>
  );
}

export default function ReceiptDetail() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const backTo = location.state?.backTo || '/sales/dashboard';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    const qp = new URLSearchParams({ id });
    const cust = sp.get('customer');
    if (cust) qp.set('customer', cust);
    apiClient.get(`/api/sales/receivables/receipt-detail/?${qp.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => {
        if (!cancelled) setError(e.response?.data?.detail || 'Could not load this receipt.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, sp]);

  const lines = data?.lines || [];
  // Customer id, for the two clickable summary tiles (item 17). Prefer the one
  // in the URL (how the receipt was opened), fall back to the response.
  const custId = sp.get('customer') || data?.customer_id || '';
  const totals = useMemo(() => {
    const stillDue = (data?.lines || []).reduce(
      (a, l) => a + Math.max(0, Number(l.still_due || 0)), 0);
    return {
      applied: Number(data?.applied || 0),      // matched to invoices
      unapplied: Number(data?.unapplied || 0),  // excess / advance
      total: Number(data?.total || 0),          // total received
      stillDue,                                 // still owed on those invoices
    };
  }, [data]);

  return (
    <MainLayout>
      <div className="p-4 sm:p-6 max-w-5xl mx-auto">
        <button onClick={() => navigate(backTo, { replace: true })}
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 mb-4">
          <ArrowLeft size={16} /> Back
        </button>

        <div className="flex items-start gap-3 mb-5">
          <div className="p-2 rounded-lg bg-emerald-50 text-emerald-700 shrink-0">
            <ReceiptIcon size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-900 truncate">
              {data?.label || 'Receipt'}
            </h1>
            <p className="text-sm text-slate-500 truncate">{data?.customer_name}</p>
            {/* Receipt date on its own line, in a small readable font (item 14). */}
            {data?.date && (
              <p className="text-xs text-slate-400 mt-0.5">Received on {formatDate(data.date)}</p>
            )}
            {/* Why any of this receipt is unapplied, in full — it names the bill
                references Tally quoted. The heading used to carry a 60-character
                slice of this and cut off mid-sentence. */}
            {data?.note && (
              <p className="mt-1 text-sm text-amber-700">{data.note}</p>
            )}
          </div>
        </div>

        {loading && <div className="py-16 text-center text-slate-500">Loading…</div>}
        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        {!loading && !error && data && (
          <>
            {/* Summary tiles (items 15–17). Plain-language labels replace the
                "Applied / Not applied" jargon; Excess/Advance and Still Due are
                clickable through to the customer statement, where the credit and
                the outstanding invoices behind each figure are listed. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              {[
                { label: 'Total Amount Received', val: totals.total, cls: 'text-slate-900', hint: 'The full value of this receipt.' },
                { label: 'Matched to Invoices', val: totals.applied, cls: 'text-emerald-700', hint: 'Part of the receipt allocated against specific invoices.' },
                { label: 'Excess / Advance', val: totals.unapplied, cls: totals.unapplied ? 'text-amber-700' : 'text-slate-400',
                  hint: 'Paid beyond the billed amount — held as the customer’s credit.',
                  to: totals.unapplied > 0 && custId ? `/sales/customer-insights?customer=${encodeURIComponent(custId)}` : null },
                { label: 'Still Due', val: totals.stillDue, cls: totals.stillDue ? 'text-rose-700' : 'text-slate-400',
                  hint: 'Still owed on the invoices this receipt settled.',
                  to: totals.stillDue > 0 && custId ? `/sales/customer-insights?customer=${encodeURIComponent(custId)}` : null },
              ].map(({ label, val, cls, hint, to }) => {
                const clickable = !!to;
                const Tag = clickable ? 'button' : 'div';
                return (
                  <Tag key={label} type={clickable ? 'button' : undefined} title={hint}
                    onClick={clickable ? () => navigate(to, { state: { backTo: `${location.pathname}${location.search}` } }) : undefined}
                    className={`text-left rounded-xl border border-slate-200 bg-white px-4 py-3 ${clickable ? 'cursor-pointer transition hover:border-indigo-300 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-300' : ''}`}>
                    <div className="text-[11px] uppercase tracking-wide text-slate-500 flex items-center gap-1">
                      {label}{clickable && <span aria-hidden="true" className="text-indigo-400">›</span>}
                    </div>
                    <div className={`text-lg font-semibold tabular-nums ${cls}`}>
                      {formatCurrency(val)}
                    </div>
                  </Tag>
                );
              })}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Invoice Number</th>
                      <th className="px-3 py-2 text-left font-medium">Invoice Date</th>
                      <th className="px-3 py-2 text-right font-medium">Invoice Value</th>
                      <th className="px-3 py-2 text-right font-medium">Amount Received</th>
                      <th className="px-3 py-2 text-right font-medium">Still Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i} className="border-t border-slate-100 odd:bg-white even:bg-slate-50/50">
                        <td className="px-3 py-2 whitespace-nowrap">
                          {l.invoice_id && !l.is_opening
                            ? <button
                                onClick={() => navigate(`/sales/invoices/${l.invoice_id}`,
                                  { state: { backTo: `${location.pathname}${location.search}` } })}
                                className="text-blue-700 hover:underline font-medium">
                                {l.invoice_no || '—'}
                              </button>
                            : <span className="text-slate-500">{l.invoice_no || '—'}</span>}
                          {l.is_opening && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                              opening
                            </span>
                          )}
                          {/* Prior-year bills this money actually settled. The ERP
                              carries 25-26 as one opening balance, not as invoices,
                              so the numbers are shown rather than a document being
                              invented for each. Wraps inline — no extra rows. */}
                          <PriorRefs refs={l.prior_refs} />
                        </td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                          {l.invoice_date ? formatDate(l.invoice_date) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                          {formatCurrency(l.invoice_total)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-emerald-700">
                          {formatCurrency(l.paid_by_this)}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums font-medium ${
                          Number(l.still_due) > 0 ? 'text-rose-700' : 'text-slate-400'}`}>
                          {Number(l.still_due) > 0 ? formatCurrency(l.still_due) : '—'}
                        </td>
                      </tr>
                    ))}

                    {/* Money on this receipt that reached no invoice — the
                        customer paid ahead, or paid more than they were billed.
                        Shown as its own line so the rows add to the receipt. */}
                    {totals.unapplied > 0 && (
                      <tr className="border-t border-slate-100 bg-amber-50/40">
                        <td className="px-3 py-2 text-slate-700" colSpan={3}>
                          {/* "Not applied to any invoice" read like money had
                              gone missing. It has not — it is the customer's
                              credit. The reason, with the bill number Tally
                              quoted, is the note under the heading. */}
                          Kept as credit for this customer
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-amber-700">
                          {formatCurrency(totals.unapplied)}
                        </td>
                        <td className="px-3 py-2" />
                      </tr>
                    )}

                    {!lines.length && !totals.unapplied && (
                      <tr><td colSpan={5} className="px-3 py-10 text-center text-slate-500">
                        Nothing recorded against this receipt.
                      </td></tr>
                    )}
                  </tbody>
                  <tfoot className="bg-slate-50 border-t border-slate-200">
                    <tr>
                      <td className="px-3 py-2 font-semibold text-slate-800" colSpan={3}>
                        Receipt total
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                        {formatCurrency(totals.total)}
                      </td>
                      <td className="px-3 py-2" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <p className="mt-3 text-xs text-slate-500 flex items-start gap-1.5">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>
                Allocation as recorded in Tally's own bill-wise detail
                (<strong>Agst Ref</strong> settles an existing bill,
                <strong> New Ref</strong> opens a new one). Anything Tally left
                unallocated is shown as held credit.
              </span>
            </p>
          </>
        )}
      </div>
    </MainLayout>
  );
}
