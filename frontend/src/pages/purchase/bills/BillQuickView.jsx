import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink, Pencil, ChevronLeft } from 'lucide-react';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { formatDate, formatCurrency } from '@/utils/formatters';

// A read-only bill card that slides in from the right when a row is clicked,
// instead of leaving the list for the full /purchase/bills/:id page. It mirrors
// the "open a record → side card" pattern from the Ledgerline reference: the
// whole bill (parties, line items, the money, and where it lives — ERP vs Tally)
// at a glance, with the list still behind it so the next row is one click away.
// The full page stays the place to EDIT; this is the place to LOOK.

const SUPPLY_LABEL = {
  intra: 'Intra-state (CGST + SGST)',
  inter: 'Inter-state (IGST)',
  none: 'No GST',
  unknown: 'Supply type unknown',
};

// Chip used for both the "where it came from" and "sync" markers, kept tiny so
// two sit side by side without crowding the header.
function Chip({ label, cls, title }) {
  return (
    <span title={title}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

// Same origin/sync read the Source column uses, so the card and the row agree.
export function billSource(row) {
  const inTally = !!row.tally_guid && !String(row.tally_guid).startsWith('OPENING');
  const bornInErp = !!row.is_scanned;
  const matched = !!row.scan_tally_matched;
  const origin = bornInErp
    ? { label: 'ERP', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200', title: 'Entered in the ERP (scanned / emailed invoice)' }
    : inTally
      ? { label: 'Tally', cls: 'bg-teal-50 text-teal-700 border-teal-200', title: 'Imported from a Tally voucher' }
      : { label: 'ERP', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200', title: 'Entered in the ERP' };
  let sync = null;
  if (matched || (inTally && bornInErp)) sync = { label: 'In sync', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', title: 'Present in both the ERP and Tally' };
  else if (bornInErp && !inTally) sync = { label: 'Not in Tally', cls: 'bg-rose-50 text-rose-700 border-rose-200', title: 'In the ERP but not yet matched to a Tally voucher' };
  else if (inTally && !bornInErp) sync = { label: 'Not in ERP', cls: 'bg-amber-50 text-amber-700 border-amber-200', title: 'A Tally voucher with no matching ERP-entered bill' };
  return { inTally, bornInErp, origin, sync };
}

export default function BillQuickView({ id, onClose, onOpenFull, onEdit, canEdit, inline = false, showBack = false }) {
  const [bill, setBill] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    setLoading(true);
    setError(null);
    setBill(null);
    apiClient.get(`/api/purchase/bills/${id}/`)
      .then(({ data }) => { if (alive) setBill(data); })
      .catch(() => { if (alive) setError('Could not load this bill.'); })
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

  const lines = bill?.bill_lines || [];
  const supply = bill?.gst_split?.basis;
  const src = bill ? billSource(bill) : null;
  const num = (v) => Number(v) || 0;
  const bal = num(bill?.balance_due);

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
          aria-label="Close bill"
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
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Purchase bill</p>
              <h2 className="text-base font-bold text-slate-900 truncate">
                {bill?.vendor_invoice_no || bill?.bill_no || (loading ? 'Loading…' : 'Bill')}
              </h2>
              {bill && (
                <p className="text-[12px] text-slate-500 mt-0.5">
                  {bill.bill_date ? formatDate(bill.bill_date) : '—'}
                  {bill.tally_voucher_type ? <> · {bill.tally_voucher_type}</> : null}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {bill && <StatusBadge status={bill.status_display || bill.status} />}
              <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition" title="Close (Esc)">
                <X size={18} />
              </button>
            </div>
          </div>
          {src && (src.origin || src.sync) && (
            <div className="mt-2 flex items-center gap-1.5">
              {src.origin && <Chip {...src.origin} />}
              {src.sync && <Chip {...src.sync} />}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {loading && <p className="text-sm text-slate-400">Loading bill…</p>}
          {error && <p className="text-sm text-rose-600">{error}</p>}

          {bill && (
            <>
              {/* Parties */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div className="col-span-2">
                  <p className="text-[11px] text-slate-400">Vendor</p>
                  <p className="text-[13px] font-semibold text-slate-900">{bill.vendor_name || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400">Category</p>
                  <p className="text-[12px] font-medium text-slate-700">{bill.purchase_category_display || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400">Warehouse</p>
                  <p className="text-[12px] font-medium text-slate-700">{bill.warehouse_name || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400">Supply</p>
                  <p className="text-[12px] font-medium text-slate-700">{SUPPLY_LABEL[supply] || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400">Due date</p>
                  <p className="text-[12px] font-medium text-slate-700">{bill.due_date ? formatDate(bill.due_date) : '—'}</p>
                </div>
                {(bill.po_no || bill.receipt_no) && (
                  <div className="col-span-2 flex gap-4">
                    {bill.po_no && <span className="text-[12px] text-slate-500">PO: <span className="font-medium text-slate-700">{bill.po_no}</span></span>}
                    {bill.receipt_no && <span className="text-[12px] text-slate-500">Receipt: <span className="font-medium text-slate-700">{bill.receipt_no}</span></span>}
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
                          <th className="text-right font-medium px-2 py-1.5">Tax%</th>
                          <th className="text-right font-medium px-2 py-1.5">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {lines.map((l, i) => {
                          const tax = Number(l.tax_percent) > 0 ? Number(l.tax_percent) : Number(l.effective_tax_percent) || 0;
                          return (
                            <tr key={l.id || i} className="text-slate-700">
                              <td className="px-2 py-1.5">
                                <span className="font-medium text-slate-800">{l.item_name || l.product_name || l.description || '—'}</span>
                              </td>
                              <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                                {l.quantity != null ? Number(l.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '—'}
                                {l.uom ? <span className="text-slate-400 ml-0.5">{l.uom}</span> : null}
                              </td>
                              <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{l.rate != null ? formatCurrency(l.rate) : '—'}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{tax ? `${tax}%${l.tax_percent_derived ? '*' : ''}` : '—'}</td>
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
                <Row label="Taxable value" value={formatCurrency(bill.subtotal)} />
                {num(bill.discount_amount) > 0 && <Row label="Discount" value={`- ${formatCurrency(bill.discount_amount)}`} />}
                {/* GST split by place of supply: CGST+SGST intra-state, IGST
                    inter-state. Falls back to the combined figure only when the
                    supply type can't be read (gst_split.basis === 'unknown'). */}
                {num(bill.tax_amount) > 0 && (
                  bill.gst_split?.basis === 'intra' ? (
                    <>
                      <Row label="CGST" value={formatCurrency(Number(bill.gst_split.cgst))} />
                      <Row label="SGST" value={formatCurrency(Number(bill.gst_split.sgst))} />
                    </>
                  ) : bill.gst_split?.basis === 'inter' ? (
                    <Row label="IGST" value={formatCurrency(Number(bill.gst_split.igst))} />
                  ) : (
                    <Row label="GST" value={formatCurrency(bill.tax_amount)} />
                  )
                )}
                {num(bill.other_charges) > 0 && <Row label="Freight / other" value={formatCurrency(bill.other_charges)} />}
                {num(bill.tds_amount) > 0 && <Row label="TDS" value={`- ${formatCurrency(bill.tds_amount)}`} />}
                <div className="my-1 border-t border-slate-200" />
                <Row label="Invoice total" value={formatCurrency(bill.total_amount)} strong />
                <Row label="Paid" value={formatCurrency(bill.amount_paid)} tone="text-emerald-600" />
                <Row label="Outstanding" value={formatCurrency(bill.balance_due)} strong tone={bal > 0 ? 'text-rose-600' : 'text-slate-800'} />
              </div>

              {/* Where it lives — ERP vs Tally, the reference's two record cards. */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700 mb-1">ERP record</p>
                  <p className="text-[12px] text-slate-700">No. <span className="font-medium">{bill.bill_no || '—'}</span></p>
                  <p className="text-[12px] text-slate-700">Entered <span className="font-medium">{bill.created_at ? formatDate(bill.created_at) : '—'}</span></p>
                </div>
                <div className={`rounded-lg border px-3 py-2 ${src?.inTally ? 'border-teal-200 bg-teal-50/50' : 'border-slate-200 bg-slate-50'}`}>
                  <p className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${src?.inTally ? 'text-teal-700' : 'text-slate-400'}`}>Tally record</p>
                  {src?.inTally ? (
                    <>
                      <p className="text-[12px] text-slate-700">Type <span className="font-medium">{bill.tally_voucher_type || 'Purchase'}</span></p>
                      <p className="text-[11px] text-slate-500 break-all">GUID {String(bill.tally_guid).slice(0, 18)}…</p>
                    </>
                  ) : (
                    <p className="text-[12px] text-slate-400">Not in Tally yet</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-slate-200 px-4 py-2.5 flex items-center justify-between gap-2">
          <button onClick={() => onOpenFull(id)}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-indigo-600 hover:text-indigo-800">
            <ExternalLink size={15} /> Open full bill
          </button>
          {canEdit && bill?.status === 'DRAFT' && (
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
