/**
 * Invoices, embedded under Customer Details on Sales Analytics.
 *
 * The same per-invoice list the standalone Invoices page shows, but scoped to
 * the dashboard's own filters (company / customer / period) so it reads as the
 * detail behind the Customer Details aggregates. Collapsed by default and the
 * data only loads when expanded, so it never slows the dashboard's first paint.
 *
 * The standalone /sales/invoices page is kept for now; this is the embedded
 * view. New invoices appear here on the next refresh, same as that page.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, ChevronLeft, Search, X, FileText } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import CustomSelect from '@/components/ui/CustomSelect';
import { formatCurrency, formatDate } from '@/utils/formatters';

const PAGE_SIZE = 15;

// Same definitions the Invoices page uses, so the two never drift.
const paymentStatus = (r) => {
  const total = Number(r.grand_total) || 0;
  const bal = Number(r.outstanding);
  if (Number.isFinite(bal) && bal <= 0 && total > 0) return 'Paid';
  if (Number.isFinite(bal) && bal > 0 && bal < total) return 'Partial';
  return 'Unpaid';
};
const PAY_CLS = {
  Paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Partial: 'bg-amber-50 text-amber-700 border-amber-200',
  Unpaid: 'bg-rose-50 text-rose-700 border-rose-200',
};
const daysOverdue = (r) => {
  if (!(Number(r.outstanding) > 0) || !r.due_date) return 0;
  const d = Math.floor((Date.now() - new Date(`${r.due_date}T00:00:00`).getTime()) / 86400000);
  return d > 0 ? d : 0;
};

function InvoicesBody({ companyId, customerId, from, to, custName }) {
  const navigate = useNavigate();
  const { data, isLoading, error } = useApiData('/api/sales/invoices/');
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState('');   // invoice status
  const [payF, setPayF] = useState('');         // Paid / Partial / Unpaid
  const [page, setPage] = useState(1);

  const statusOpts = useMemo(
    () => [...new Set((data || []).map((x) => x.status).filter(Boolean))].sort(),
    [data]);

  const rows = useMemo(() => {
    let r = data || [];
    if (companyId) r = r.filter((x) => String(x.company) === String(companyId));
    if (customerId) r = r.filter((x) => String(x.customer) === String(customerId));
    else if (custName) r = r.filter((x) => (x.customer_name || '') === custName);
    if (from && to) r = r.filter((x) => x.invoice_date && x.invoice_date >= from && x.invoice_date <= to);
    if (statusF) r = r.filter((x) => x.status === statusF);
    if (payF) r = r.filter((x) => paymentStatus(x) === payF);
    const s = q.trim().toLowerCase();
    if (s) {
      r = r.filter((x) => [x.invoice_no, x.customer_name, x.company_name, x.destination, x.grand_total, x.status]
        .some((v) => v != null && String(v).toLowerCase().includes(s)));
    }
    // Newest first.
    return [...r].sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')));
  }, [data, companyId, customerId, custName, from, to, q, statusF, payF]);

  const totals = useMemo(() => rows.reduce((a, r) => ({
    taxable: a.taxable + (Number(r.subtotal) || 0),
    gst: a.gst + (Number(r.cgst_total) || 0) + (Number(r.sgst_total) || 0) + (Number(r.igst_total) || 0),
    total: a.total + (Number(r.grand_total) || 0),
    outstanding: a.outstanding + (Number(r.outstanding) || 0),
  }), { taxable: 0, gst: 0, total: 0, outstanding: 0 }), [rows]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cp = Math.min(page, totalPages);
  const pageRows = rows.slice((cp - 1) * PAGE_SIZE, cp * PAGE_SIZE);

  if (error) return <p className="px-4 py-6 text-center text-sm text-rose-600">Could not load invoices.</p>;

  return (
    <div className="px-3 sm:px-4 pb-3">
      <div className="flex flex-wrap items-center gap-2 py-2.5">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search invoice no, destination, amount…"
            className="w-full border border-slate-300 rounded-lg pl-8 pr-7 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400" />
          {q && <button type="button" onClick={() => { setQ(''); setPage(1); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={13} /></button>}
        </div>
        {/* Status + payment filters, filling the right-side space. */}
        <CustomSelect value={statusF} onChange={(e) => { setStatusF(e.target.value); setPage(1); }} title="Status"
          className="border border-slate-300 rounded-lg px-2 h-8 text-xs bg-white min-w-[120px]">
          <option value="">All Status</option>
          {statusOpts.map((s) => <option key={s} value={s}>{s}</option>)}
        </CustomSelect>
        <CustomSelect value={payF} onChange={(e) => { setPayF(e.target.value); setPage(1); }} title="Payment"
          className="border border-slate-300 rounded-lg px-2 h-8 text-xs bg-white min-w-[120px]">
          <option value="">All Payments</option>
          <option value="Paid">Paid</option>
          <option value="Partial">Partial</option>
          <option value="Unpaid">Unpaid</option>
        </CustomSelect>
        <span className="text-[11px] text-slate-400 tabular-nums ml-auto">{rows.length} invoice(s)</span>
      </div>

      {isLoading ? (
        <div className="space-y-1.5 py-2">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-9 rounded bg-slate-100 animate-pulse" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">No invoices match the current filters.</p>
      ) : (
        <>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-[12px]">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wide text-blue-700/80 border-b border-primary-100">
                <tr>
                  <th className="px-3 py-1.5 text-left font-semibold">Invoice</th>
                  <th className="px-3 py-1.5 text-left font-semibold">Date</th>
                  {!customerId && !custName && <th className="px-3 py-1.5 text-left font-semibold">Customer</th>}
                  <th className="px-3 py-1.5 text-right font-semibold">Taxable</th>
                  <th className="px-3 py-1.5 text-right font-semibold">GST</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Total</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Balance</th>
                  <th className="px-3 py-1.5 text-center font-semibold">Payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pageRows.map((r) => {
                  const od = daysOverdue(r);
                  const st = paymentStatus(r);
                  return (
                    <tr key={r.id} className="transition-colors hover:bg-primary-50/40 cursor-pointer"
                      onClick={() => navigate(`/sales/invoices/${r.id}`, { state: { backTo: `${window.location.pathname}${window.location.search}` } })}>
                      <td className="px-3 py-1.5 font-medium text-blue-700 whitespace-nowrap">{r.invoice_no || '—'}</td>
                      <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{formatDate(r.invoice_date, 'dd-MMM-yy')}</td>
                      {!customerId && !custName && <td className="px-3 py-1.5 text-slate-700 max-w-[200px] truncate" title={r.customer_name}>{r.customer_name}</td>}
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{formatCurrency(r.subtotal)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{formatCurrency((Number(r.cgst_total) || 0) + (Number(r.sgst_total) || 0) + (Number(r.igst_total) || 0))}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-slate-800">{formatCurrency(r.grand_total)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                        <span className={Number(r.outstanding) > 0 ? 'text-rose-600 font-medium' : 'text-emerald-700'}>{formatCurrency(r.outstanding)}</span>
                        {od > 0 && <span className="block text-[10px] text-rose-500">{od}d overdue</span>}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <span className={`text-[10px] font-medium border rounded px-1.5 py-0.5 ${PAY_CLS[st]}`}>{st}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-50 border-t border-slate-200 font-bold text-slate-800">
                <tr>
                  <td className="px-3 py-1.5" colSpan={(!customerId && !custName) ? 3 : 2}>Total · {rows.length}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(totals.taxable)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{formatCurrency(totals.gst)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(totals.total)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-rose-600">{formatCurrency(totals.outstanding)}</td>
                  <td className="px-3 py-1.5" />
                </tr>
              </tfoot>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 pt-2 text-xs text-slate-500">
              <span>Showing {(cp - 1) * PAGE_SIZE + 1}–{Math.min(cp * PAGE_SIZE, rows.length)} of {rows.length}</span>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setPage(cp - 1)} disabled={cp <= 1}
                  className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40" aria-label="Previous page"><ChevronLeft size={15} /></button>
                <span className="px-2 tabular-nums">Page {cp} / {totalPages}</span>
                <button type="button" onClick={() => setPage(cp + 1)} disabled={cp >= totalPages}
                  className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40" aria-label="Next page"><ChevronRight size={15} /></button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function EmbeddedInvoices(props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 sm:px-4 py-2.5 text-left hover:bg-slate-50/60 transition-colors">
        <ChevronRight size={14} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="p-1.5 rounded-lg bg-sky-50 text-sky-600"><FileText size={15} /></span>
        <h3 className="text-sm font-bold text-slate-800">Invoices</h3>
        <span className="text-[11px] text-slate-400">· the bills behind the figures above</span>
      </button>
      {open && <InvoicesBody {...props} />}
    </div>
  );
}
