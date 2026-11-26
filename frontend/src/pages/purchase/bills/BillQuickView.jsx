import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink, Pencil, ChevronLeft, FileText, Image as ImageIcon } from 'lucide-react';
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

// Pretty label for an attachment's category code (falls back to the raw code).
const ATT_LABEL = {
  INVOICE: 'Invoice', BILL: 'Invoice', RATE_PROOF: 'Rate proof',
  WEIGHMENT: 'Weighment', TRANSPORT: 'Transport', RECEIPT: 'Receipt',
  VOICE_NOTE: 'Voice note', DEVIATION_PROOF: 'Deviation', OTHER: 'File',
};
const attLabel = (c) => ATT_LABEL[(c || '').toUpperCase()] || (c ? c.replace(/_/g, ' ') : 'File');
const isImageFile = (name = '', type = '') =>
  /^image\//i.test(type) || /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(name);

export default function BillQuickView({ id, onClose, onOpenFull, onEdit, canEdit, inline = false, showBack = false }) {
  const [bill, setBill] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [attachments, setAttachments] = useState([]);

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    setLoading(true);
    setError(null);
    setBill(null);
    setAttachments([]);
    apiClient.get(`/api/purchase/bills/${id}/`)
      .then(({ data }) => { if (alive) setBill(data); })
      .catch(() => { if (alive) setError('Could not load this bill.'); })
      .finally(() => { if (alive) setLoading(false); });
    // Uploaded attachments for this bill (invoice scan, weighment slip, …).
    // A failure here is non-fatal: the card still shows without the strip.
    apiClient.get(`/api/purchase/attachments/?module=BILL&record_id=${id}`)
      .then(({ data }) => { if (alive) setAttachments(Array.isArray(data) ? data : (data?.results || [])); })
      .catch(() => { /* no attachments strip */ });
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

  // All files to show: uploaded attachments + any scanned invoice photos.
  const files = [
    ...attachments.map((a) => ({
      key: `att-${a.id}`, url: a.file_url || a.file,
      name: a.file_name || 'File', category: a.category,
      isImage: isImageFile(a.file_name, a.file_type),
    })),
    ...((bill?.zoho_photos || []).map((p, i) => {
      const url = typeof p === 'string' ? p : (p.url || p.file_url || p.file || '');
      const name = (typeof p === 'object' && (p.name || p.file_name)) || `Invoice scan ${i + 1}`;
      return { key: `scan-${i}`, url, name, category: 'INVOICE', isImage: isImageFile(name, '') || /\.(png|jpe?g|webp)/i.test(url) };
    })),
  ].filter((f) => f.url);

  const Row = ({ label, value, strong, tone }) => (
    <div className="flex items-center justify-between py-1">
      <span className={`${strong ? 'text-[12.5px] font-bold text-slate-800' : 'text-[12px] font-semibold text-slate-600'}`}>{label}</span>
      <span className={`tabular-nums ${strong ? 'text-[13px] font-bold' : 'text-[12px] font-semibold'} ${tone || 'text-slate-900'}`}>{value}</span>
    </div>
  );

  // Label / value row for the left detail ledger (dashed separators).
  const KV = ({ k, v, tone }) => (
    <div className="flex items-start justify-between gap-3 py-1 border-b border-dashed border-slate-100 last:border-b-0">
      <span className="text-[12px] font-semibold text-slate-600 shrink-0">{k}</span>
      <span className={`text-[12px] font-bold text-right min-w-0 ${tone || 'text-slate-900'}`}>{v}</span>
    </div>
  );

  const shell = (
    <div className={inline ? '' : 'fixed inset-0 z-[70] print:hidden flex items-start sm:items-center justify-center p-3 sm:p-6'}>
      {/* Backdrop — click anywhere off the card to close. */}
      {!inline && (
        <button
          aria-label="Close bill"
          onClick={onClose}
          className="absolute inset-0 bg-slate-900/50 animate-[fadeIn_120ms_ease-out]"
        />
      )}
      {/* Panel — centered modal popup */}
      <aside className={inline
        ? 'bg-white rounded-xl border border-slate-200 flex flex-col overflow-hidden'
        : 'relative w-full max-w-3xl max-h-[92vh] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden animate-[popIn_140ms_ease-out]'}>
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
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Purchase bill</p>
              <h2 className="text-base font-bold text-slate-900 truncate">
                {bill?.vendor_invoice_no || bill?.bill_no || (loading ? 'Loading…' : 'Bill')}
              </h2>
              {bill && (
                <div className="mt-1 flex items-center flex-wrap gap-x-2 gap-y-1">
                  <span className="text-[12.5px] font-bold text-slate-800">{bill.vendor_name || '—'}</span>
                  {bill.company_name && (
                    <span className="inline-flex items-center rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">{bill.company_name}</span>
                  )}
                  {bill.vendor_is_msme && (
                    <span className="inline-flex items-center rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">MSME</span>
                  )}
                  {src?.origin && <Chip {...src.origin} />}
                  {bill.purchase_category_display && (
                    <span className="inline-flex items-center rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">{bill.purchase_category_display}</span>
                  )}
                  {src?.sync && <Chip {...src.sync} />}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {bill && <StatusBadge status={bill.status_display || bill.status} />}
              <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition" title="Close (Esc)">
                <X size={18} />
              </button>
            </div>
          </div>
        </div>

        {/* Body — two-column ledger: details on the left, money + files on the right. */}
        <div className="flex-1 overflow-y-auto">
          {loading && <p className="text-sm text-slate-400 px-4 py-3">Loading bill…</p>}
          {error && <p className="text-sm text-rose-600 px-4 py-3">{error}</p>}

          {bill && (
            <div className="grid grid-cols-1 sm:grid-cols-[1.25fr_1fr]">
              {/* LEFT — details + line items */}
              <div className="px-4 py-2.5 border-b sm:border-b-0 sm:border-r border-slate-100">
                <KV k="Bill date" v={bill.bill_date ? formatDate(bill.bill_date) : '—'} />
                <KV k="Due date" v={bill.due_date ? formatDate(bill.due_date) : '—'} />
                <KV k="Warehouse" v={bill.warehouse_name || '—'} />
                <KV k="Supply" v={SUPPLY_LABEL[supply] || '—'} />
                {(bill.po_no || bill.receipt_no) && (
                  <KV k={bill.po_no ? 'PO' : 'Receipt'} v={bill.po_no || bill.receipt_no} />
                )}
                <KV k="ERP no." v={`${bill.bill_no || '—'}${bill.created_at ? ` · ${formatDate(bill.created_at)}` : ''}`} />
                <KV k="Tally" v={src?.inTally ? (bill.tally_voucher_type || 'Synced') : 'Not synced'}
                  tone={src?.inTally ? 'text-teal-700' : 'text-slate-500'} />

                {/* Line items */}
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-bold mt-3 mb-1.5">Line items</p>
                {lines.length === 0 ? (
                  <p className="text-[12px] text-slate-400 italic">No line items.</p>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <table className="w-full text-[11.5px]">
                      <thead>
                        <tr className="bg-slate-50 text-slate-500">
                          <th className="text-left font-semibold px-2 py-1">Item</th>
                          <th className="text-right font-semibold px-2 py-1">Qty</th>
                          <th className="text-right font-semibold px-2 py-1 whitespace-nowrap">Unit price</th>
                          <th className="text-right font-semibold px-2 py-1">Tax%</th>
                          <th className="text-right font-semibold px-2 py-1">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {lines.map((l, i) => {
                          const tax = Number(l.tax_percent) > 0 ? Number(l.tax_percent) : Number(l.effective_tax_percent) || 0;
                          return (
                            <tr key={l.id || i} className="text-slate-700">
                              <td className="px-2 py-1 font-medium text-slate-800">{l.item_name || l.product_name || l.description || '—'}</td>
                              <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                                {l.quantity != null ? Number(l.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '—'}
                                {l.uom ? <span className="text-slate-400 ml-0.5">{l.uom}</span> : null}
                              </td>
                              <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{l.rate != null ? formatCurrency(l.rate) : '—'}</td>
                              <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{tax ? `${tax}%${l.tax_percent_derived ? '*' : ''}` : '—'}</td>
                              <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap font-medium">{l.amount != null ? formatCurrency(l.amount) : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* RIGHT — Amount block + Attachments */}
              <div className="px-4 py-2.5 bg-slate-50/60">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-bold mb-1">Amount</p>
                <Row label="Taxable value" value={formatCurrency(bill.subtotal)} />
                {num(bill.discount_amount) > 0 && <Row label="Discount" value={`- ${formatCurrency(bill.discount_amount)}`} />}
                {/* GST split by place of supply: CGST+SGST intra-state, IGST
                    inter-state. Combined figure only when supply is unknown. */}
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

                {/* Attachments — inside the right column, under the money.
                    Hidden entirely when the bill carries no files. */}
                {files.length > 0 && (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-200">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500 font-bold mb-1.5 flex items-center gap-1.5">
                      Attachments
                      <span className="text-indigo-600 bg-indigo-50 rounded-full px-1.5 text-[10px] font-bold">{files.length}</span>
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {files.map((f) => (
                        <a key={f.key} href={f.url} target="_blank" rel="noopener noreferrer"
                          className="group flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11.5px] font-medium text-slate-700 hover:border-indigo-400 hover:text-indigo-700">
                          {f.isImage ? <ImageIcon size={13} className="text-slate-400 group-hover:text-indigo-500 shrink-0" />
                            : <FileText size={13} className="text-slate-400 group-hover:text-indigo-500 shrink-0" />}
                          <span className="truncate flex-1 min-w-0">{f.name}</span>
                          <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-50 rounded px-1 shrink-0">{attLabel(f.category)}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
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
