import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink, Pencil, ChevronLeft } from 'lucide-react';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { formatDate, formatCurrency } from '@/utils/formatters';

// A read-only sales-invoice card that slides in from the right when a row is
// clicked, instead of leaving the list for the full /sales/invoices/:id page —
// the same "open a record → side card" pattern the Bills list uses. Parties,
// line items and the money at a glance, with the list still behind it so the
// next row is one click away. The full page stays the place to EDIT.

// Payment status read off the receivable balance — the same definition the
// list's Payment column uses, so the card and the row agree.
function payState(total, balance) {
  const t = Number(total) || 0;
  const b = Number(balance);
  if (Number.isFinite(b) && b <= 0 && t > 0) return { label: 'Paid', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  if (Number.isFinite(b) && b > 0 && b < t) return { label: 'Partial', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
  return { label: 'Unpaid', cls: 'bg-rose-50 text-rose-700 border-rose-200' };
}

export default function InvoiceQuickView({ id, onClose, onOpenFull, onEdit, canEdit, inline = false, showBack = false }) {
  const [inv, setInv] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    setLoading(true);
    setError(null);
    setInv(null);
    apiClient.get(`/api/sales/invoices/${id}/`)
      .then(({ data }) => { if (alive) setInv(data); })
      .catch(() => { if (alive) setError('Could not load this invoice.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id]);

  // Esc closes, matching the backdrop click.
  useEffect(() => {
    if (!id) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, onClose]);

  if (!id) return null;

  const lines = inv?.invoice_lines || [];
  const num = (v) => Number(v) || 0;
  const bal = num(inv?.outstanding);
  const pay = inv ? payState(inv.grand_total, inv.outstanding) : null;

  const Row = ({ label, value, strong, tone }) => (
    <div className="flex items-center justify-between py-1">
      <span className="text-[12px] text-slate-500">{label}</span>
      <span className={`tabular-nums ${strong ? 'text-[13px] font-bold' : 'text-[12px] font-medium'} ${tone || 'text-slate-800'}`}>{value}</span>
    </div>
  );

  const shell = (
    <div className={inline ? '' : 'fixed inset-0 z-[70] print:hidden'}>
      {/* Backdrop — click anywhere off the card to close. */}
      {!inline && (
        <button
          aria-label="Close invoice"
          onClick={onClose}
          className="absolute inset-0 bg-slate-900/40 animate-[fadeIn_120ms_ease-out]"
        />
      )}
      {/* Panel */}
      <aside className={inline
        ? 'bg-white rounded-xl border border-slate-200 flex flex-col overflow-hidden'
        : 'absolute right-0 top-0 h-full w-full max-w-3xl bg-white shadow-2xl border-l border-slate-200 flex flex-col animate-[slideInRight_160ms_ease-out]'}>
        {/* Header */}
        <div className="shrink-0 border-b border-slate-200 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            {showBack && (
              <button type="button" onClick={onClose} aria-label="Back"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 shrink-0 self-start">
                <ChevronLeft size={16} /> Back
              </button>
            )}
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Sales invoice</p>
              <h2 className="text-base font-bold text-slate-900 truncate">
                {inv?.invoice_no || (loading ? 'Loading…' : 'Invoice')}
              </h2>
              {inv && (
                <p className="text-[12px] text-slate-500 mt-0.5">
                  {inv.invoice_date ? formatDate(inv.invoice_date) : '—'}
                  {inv.tally_invoice_no ? <> · Tally {inv.tally_invoice_no}</> : null}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {pay && <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 whitespace-nowrap ${pay.cls}`}>{pay.label}</span>}
              {inv && <StatusBadge status={inv.status} />}
              <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition" title="Close (Esc)">
                <X size={18} />
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {loading && <p className="text-sm text-slate-400">Loading invoice…</p>}
          {error && <p className="text-sm text-rose-600">{error}</p>}

          {inv && (
            <>
              {/* Parties */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div className="col-span-2">
                  <p className="text-[11px] text-slate-400">Customer</p>
                  <p className="text-[13px] font-semibold text-slate-900">{inv.customer_name || inv.buyer_name || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400">Company</p>
                  <p className="text-[12px] font-medium text-slate-700">{inv.company_name || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400">Destination</p>
                  <p className="text-[12px] font-medium text-slate-700">{inv.destination || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400">Due date</p>
                  <p className="text-[12px] font-medium text-slate-700">{inv.effective_due_date ? formatDate(inv.effective_due_date) : '—'}</p>
                </div>
                {(inv.so_no || inv.dc_no) && (
                  <div className="col-span-2 flex gap-4">
                    {inv.so_no && <span className="text-[12px] text-slate-500">SO: <span className="font-medium text-slate-700">{inv.so_no}</span></span>}
                    {inv.dc_no && <span className="text-[12px] text-slate-500">DC: <span className="font-medium text-slate-700">{inv.dc_no}</span></span>}
                  </div>
                )}
              </div>

              {/* Line items */}
              <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-1.5">Line items</p>
                {lines.length === 0 ? (
                  <p className="text-[12px] text-slate-400 italic">No line items.</p>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500">
                          <th className="text-left font-medium px-2 py-1.5">Item</th>
                          <th className="text-right font-medium px-2 py-1.5">Qty</th>
                          <th className="text-right font-medium px-2 py-1.5">Rate</th>
                          <th className="text-right font-medium px-2 py-1.5">GST%</th>
                          <th className="text-right font-medium px-2 py-1.5">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {lines.map((l, i) => {
                          const gst = Number(l.gst_rate) || (Number(l.cgst_rate) || 0) + (Number(l.sgst_rate) || 0) + (Number(l.igst_rate) || 0);
                          return (
                            <tr key={l.id || i} className="text-slate-700">
                              <td className="px-2 py-1.5">
                                <span className="font-medium text-slate-800">{l.display_name || l.product_name || l.description || '—'}</span>
                              </td>
                              <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                                {l.quantity != null ? Number(l.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '—'}
                                {l.uom ? <span className="text-slate-400 ml-0.5">{l.uom}</span> : null}
                              </td>
                              <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{l.rate != null ? formatCurrency(l.rate) : '—'}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{gst ? `${gst}%` : '—'}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap font-medium">{l.amount != null ? formatCurrency(l.amount) : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Totals */}
              <div className="rounded-lg border border-slate-200 px-3 py-2">
                <Row label="Taxable value" value={formatCurrency(inv.subtotal)} />
                {num(inv.cgst_total) > 0 && <Row label="CGST" value={formatCurrency(inv.cgst_total)} />}
                {num(inv.sgst_total) > 0 && <Row label="SGST" value={formatCurrency(inv.sgst_total)} />}
                {num(inv.igst_total) > 0 && <Row label="IGST" value={formatCurrency(inv.igst_total)} />}
                {num(inv.tds_total) > 0 && <Row label="TDS" value={`- ${formatCurrency(inv.tds_total)}`} />}
                <div className="my-1 border-t border-slate-200" />
                <Row label="Invoice total" value={formatCurrency(inv.grand_total)} strong />
                <Row label="Received" value={formatCurrency(inv.received)} tone="text-emerald-600" />
                <Row label="Outstanding" value={formatCurrency(inv.outstanding)} strong tone={bal > 0 ? 'text-rose-600' : 'text-slate-800'} />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-slate-200 px-4 py-2.5 flex items-center justify-between gap-2">
          <button onClick={() => onOpenFull(id)}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-indigo-600 hover:text-indigo-800">
            <ExternalLink size={15} /> Open full invoice
          </button>
          {canEdit && inv?.status === 'DRAFT' && (
            <button onClick={() => onEdit(id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50">
              <Pencil size={14} /> Edit
            </button>
          )}
        </div>
      </aside>
    </div>
  );

  return inline ? shell : createPortal(shell, document.body);
}
