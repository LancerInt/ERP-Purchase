/**
 * Bills, embedded under Vendor Details on Purchase Analytics.
 *
 * The per-bill list from the standalone Bills page, scoped to the dashboard's
 * own filters (company / vendor / period), so it reads as the detail behind the
 * Vendor Details aggregates. Collapsed by default and loaded only when expanded,
 * so it never slows the dashboard's first paint. The /purchase/bills page is
 * kept for now; new bills show here on the next open (item 1).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, ChevronLeft, Search, X, Receipt } from 'lucide-react';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

const PAGE_SIZE = 15;

async function fetchAll(url) {
  const out = [];
  let next = `${url}${url.includes('?') ? '&' : '?'}page_size=500`;
  for (let i = 0; i < 60 && next; i++) {
    const { data } = await apiClient.get(next);
    const rows = Array.isArray(data) ? data : (data?.results || []);
    out.push(...rows);
    next = (!Array.isArray(data) && data?.next) ? data.next : null;
  }
  return out;
}

const paymentStatus = (r) => {
  const total = Number(r.total_amount) || 0;
  const bal = Number(r.balance_due);
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
  if (!(Number(r.balance_due) > 0) || !r.due_date) return 0;
  const d = Math.floor((Date.now() - new Date(`${r.due_date}T00:00:00`).getTime()) / 86400000);
  return d > 0 ? d : 0;
};

function BillsBody({ companyId, vendorId, from, to, vendorName, source }) {
  const navigate = useNavigate();
  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const params = new URLSearchParams({ slim: 'list', exclude_opening: '1', purchases_only: '1' });
    if (source && source !== 'all') params.set('source', source);
    if (companyId) params.set('company', companyId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    fetchAll(`/api/purchase/bills/?${params}`)
      .then((rows) => { if (alive) { setRaw(rows); setError(false); } })
      .catch(() => { if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [source, companyId, from, to]);

  const rows = useMemo(() => {
    let r = raw || [];
    if (companyId) r = r.filter((x) => String(x.company) === String(companyId));
    if (vendorId) r = r.filter((x) => String(x.vendor) === String(vendorId));
    else if (vendorName) r = r.filter((x) => (x.vendor_name || '') === vendorName);
    if (from && to) r = r.filter((x) => x.bill_date && x.bill_date >= from && x.bill_date <= to);
    const s = q.trim().toLowerCase();
    if (s) {
      r = r.filter((x) => [x.bill_no, x.vendor_name, x.company_name, x.vendor_invoice_no, x.total_amount, x.status]
        .some((v) => v != null && String(v).toLowerCase().includes(s)));
    }
    return [...r].sort((a, b) => String(b.bill_date || '').localeCompare(String(a.bill_date || '')));
  }, [raw, companyId, vendorId, vendorName, from, to, q]);

  const totals = useMemo(() => rows.reduce((a, r) => ({
    taxable: a.taxable + (Number(r.subtotal) || 0),
    gst: a.gst + (Number(r.tax_amount) || 0),
    total: a.total + (Number(r.total_amount) || 0),
    outstanding: a.outstanding + (Number(r.balance_due) || 0),
  }), { taxable: 0, gst: 0, total: 0, outstanding: 0 }), [rows]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cp = Math.min(page, totalPages);
  const pageRows = rows.slice((cp - 1) * PAGE_SIZE, cp * PAGE_SIZE);

  if (error) return <p className="px-4 py-6 text-center text-sm text-rose-600">Could not load bills.</p>;

  return (
    <div className="px-3 sm:px-4 pb-3">
      <div className="flex flex-wrap items-center gap-2 py-2.5">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search bill no, vendor invoice, amount…"
            className="w-full border border-slate-300 rounded-lg pl-8 pr-7 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400" />
          {q && <button type="button" onClick={() => { setQ(''); setPage(1); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={13} /></button>}
        </div>
        <span className="text-[11px] text-slate-400 tabular-nums ml-auto">{rows.length} bill(s)</span>
      </div>

      {loading ? (
        <div className="space-y-1.5 py-2">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-9 rounded bg-slate-100 animate-pulse" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">No bills match the current filters.</p>
      ) : (
        <>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-[12px]">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wide text-blue-700/80 border-b border-primary-100">
                <tr>
                  <th className="px-3 py-1.5 text-left font-semibold">Bill</th>
                  <th className="px-3 py-1.5 text-left font-semibold">Date</th>
                  {!vendorId && !vendorName && <th className="px-3 py-1.5 text-left font-semibold">Vendor</th>}
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
                      onClick={() => navigate(`/purchase/bills/${r.id}`, { state: { backTo: `${window.location.pathname}${window.location.search}` } })}>
                      <td className="px-3 py-1.5 font-medium text-blue-700 whitespace-nowrap">{r.bill_no || '—'}</td>
                      <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{formatDate(r.bill_date, 'dd-MMM-yy')}</td>
                      {!vendorId && !vendorName && <td className="px-3 py-1.5 text-slate-700 max-w-[200px] truncate" title={r.vendor_name}>{r.vendor_name}</td>}
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{formatCurrency(r.subtotal)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{formatCurrency(r.tax_amount)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-slate-800">{formatCurrency(r.total_amount)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                        <span className={Number(r.balance_due) > 0 ? 'text-rose-600 font-medium' : 'text-emerald-700'}>{formatCurrency(r.balance_due)}</span>
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
                  <td className="px-3 py-1.5" colSpan={(!vendorId && !vendorName) ? 3 : 2}>Total · {rows.length}</td>
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

export default function EmbeddedBills(props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 sm:px-4 py-2.5 text-left hover:bg-slate-50/60 transition-colors">
        <ChevronRight size={14} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="p-1.5 rounded-lg bg-sky-50 text-sky-600"><Receipt size={15} /></span>
        <h3 className="text-sm font-bold text-slate-800">Bills</h3>
        <span className="text-[11px] text-slate-400">· the bills behind the figures above</span>
      </button>
      {open && <BillsBody {...props} />}
    </div>
  );
}
