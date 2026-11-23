/**
 * GSTR-1 Reconciliation (sales) — upload the filed GSTR-1 (JSON) and CHECK it
 * against our Sales Invoices. Read-only. Backend: /api/sales/gstr1/*
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '../../../components/ui/CustomSelect';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import { UploadCloud, Loader2, CheckCircle2, AlertTriangle, FilePlus2, FileX2, Trash2, Link2, ChevronRight, ChevronDown } from 'lucide-react';
import usePagerKeys from '../../../hooks/usePagerKeys.js';

const money = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Compact ₹ for headline/tiles: ₹1.2 Cr · ₹3.4 L · ₹5,600.
const inr = (v) => {
  const n = Number(v || 0);
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const PAGE_SIZE = 10;

function Pager({ page, total, size, onPage }) {
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(page, totalPages);
  return (
    <div className="flex items-center justify-between px-4 py-2 border-t text-xs text-gray-500">
      <span>Showing {total === 0 ? 0 : (p - 1) * size + 1}–{Math.min(p * size, total)} of {total}</span>
      <div className="flex gap-1">
        <button disabled={p <= 1} onClick={() => onPage(p - 1)} className="rounded border px-3 py-1 hover:bg-gray-50 disabled:opacity-40">Prev</button>
        <button disabled={p >= totalPages} onClick={() => onPage(p + 1)} className="rounded border px-3 py-1 hover:bg-gray-50 disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}

const TABS = [
  { key: 'MATCHED', label: 'Matched', field: 'matched', taxField: 'matched_tax', icon: CheckCircle2, cls: 'text-green-600', tint: 'bg-green-50 border-green-200', hint: 'filed = booked' },
  { key: 'MISMATCH', label: 'Amount mismatch', field: 'mismatch', taxField: 'mismatch_tax', icon: AlertTriangle, cls: 'text-amber-600', tint: 'bg-amber-50 border-amber-200', hint: 'tax differs — reconcile' },
  { key: 'ONLY_GSTR1', label: 'Filed, not in our books', field: 'only_in_gstr1', taxField: 'only_gstr1_tax', icon: FileX2, cls: 'text-red-600', tint: 'bg-red-50 border-red-200', hint: 'over-reported or a book gap' },
  { key: 'ONLY_BOOKS', label: 'In our books, not filed', field: 'only_in_books', taxField: 'only_books_tax', icon: FilePlus2, cls: 'text-indigo-600', tint: 'bg-indigo-50 border-indigo-200', hint: 'liability to file — chase it' },
];

export default function Gstr1() {
  const { options: companyOptions } = useLookup('/api/companies/', { labelField: 'legal_name', valueField: 'id' });
  // Company filter in the URL so Back / refresh / sharing restore it.
  const [company, setCompany] = useUrlState('company', '');
  const [uploads, setUploads] = useState([]);
  const [active, setActive] = useState(null);
  const [tab, setTab] = useState('ONLY_BOOKS');
  const [page, setPage] = useState(1);
  // Rows for the active bucket, derived before the keyboard-pager hook reads
  // them. These were declared further down, AFTER usePagerKeys referenced
  // `allRows` — a temporal-dead-zone ReferenceError that crashed the whole page
  // on first render. Computing them here (the state they depend on is already
  // declared above) fixes the crash and keeps one definition.
  const allRows = (active?.rows || []).filter((r) => r.status === tab);
  const pageNum = Math.min(page, Math.max(1, Math.ceil(allRows.length / PAGE_SIZE)));
  const rows = allRows.slice((pageNum - 1) * PAGE_SIZE, pageNum * PAGE_SIZE);
  // Left / Right page this list, the same as every DataTable-backed one.
  // The hook already stands aside for text fields, open dropdowns and modals.
  usePagerKeys({
    enabled: allRows.length > PAGE_SIZE,
    onPrev: () => setPage((p) => Math.max(1, p - 1)),
    onNext: () => setPage((p) => Math.min(Math.max(1, Math.ceil(allRows.length / PAGE_SIZE)), p + 1)),
  });

  const [expanded, setExpanded] = useState(null);
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();

  const selectTab = (k) => { setTab(k); setPage(1); setExpanded(null); };

  const loadUploads = useCallback(() => {
    apiClient.get('/api/sales/gstr1/', { params: company ? { company } : {} })
      .then((r) => setUploads(r.data || [])).catch(() => {});
  }, [company]);
  useEffect(() => { loadUploads(); }, [loadUploads]);

  const pickTab = (su) => {
    // Per-invoice (JSON/Excel) uploads land on "In our books, not in GSTR-1".
    // A summary PDF has no per-invoice buckets, so open the one with rows.
    const summaryOnly = !su.only_in_books && !su.only_in_gstr1 && (su.matched || su.mismatch);
    selectTab(summaryOnly ? (su.mismatch ? 'MISMATCH' : 'MATCHED') : 'ONLY_BOOKS');
  };

  const openUpload = async (id, fallbackSummary) => {
    try {
      const r = await apiClient.get(`/api/sales/gstr1/${id}/`);
      setActive(r.data);
      pickTab(r.data?.summary || {});
    } catch (err) {
      // The upload itself succeeded, so if we have its summary from the POST,
      // still show the counts (rows load on the next open) rather than a blank
      // page. Surface the real cause: a 502/503 means a deploy was mid-flight
      // (retry works); a 500 carries a server detail.
      if (fallbackSummary) { setActive({ summary: fallbackSummary, rows: [] }); pickTab(fallbackSummary); }
      const st = err?.response?.status;
      const detail = err?.response?.data?.detail;
      toast.error(detail
        || (st ? `Couldn't load the report detail (${st})${st >= 502 ? ' — a deploy may be restarting, retry' : ''}.`
              : "Couldn't load the report detail — network error."));
    }
  };

  const upload = async (file) => {
    if (!file) return;
    if (!company) { toast.error('Pick a company first.'); return; }
    setUploading(true);
    const fd = new FormData();
    fd.append('company', company); fd.append('file', file);
    try {
      const res = await apiClient.post('/api/sales/gstr1/upload/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      toast.success(`Checked ${res.data.total_rows} — ${res.data.matched} matched.`);
      loadUploads(); openUpload(res.data.id, res.data);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Upload failed.');
    } finally { setUploading(false); }
  };

  const del = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Remove this GSTR-1 upload and its report?')) return;
    await apiClient.delete(`/api/sales/gstr1/${id}/`).catch(() => {});
    if (active?.summary?.id === id) setActive(null);
    loadUploads();
  };

  const s = active?.summary;

  return (
    <MainLayout>
      <PageHeader
        title="GSTR-1 Reconciliation"
        subtitle="Upload the filed GSTR-1 (JSON for invoice-by-invoice, or the summary PDF for a period totals check) and compare it against our sales books. Read-only — nothing is created or filed."
        breadcrumbs={[{ label: 'Sales' }, { label: 'GSTR-1' }]}
      />

      {/* Upload */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 grid gap-3 md:grid-cols-[260px_1fr] items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Company</label>
          <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)} title="Company">
            <option value="">Select company…</option>
            {companyOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>
        </div>
        <div className="flex items-center gap-3">
          <label className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium cursor-pointer ${uploading ? 'bg-gray-200 text-gray-500' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}>
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
            {uploading ? 'Checking…' : 'Upload GSTR-1 (JSON / PDF)'}
            <input type="file" accept=".json,.xlsx,.xls,.pdf" className="hidden" disabled={uploading}
              onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          <span className="text-[11px] text-gray-400">JSON (Generate JSON on the portal) → per-invoice match · summary PDF → period totals check.</span>
        </div>
      </div>

      {/* Report */}
      {s && (
        <div className="bg-white rounded-xl border border-gray-200 mb-4">
          <div className="px-4 py-3 border-b flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-gray-700">{s.period || s.file_name} · {s.total_rows} invoices checked</div>
            {/* Delete this report (removes the upload + its matched rows). The
                check is read-only, so deleting just clears it — re-upload the
                same or a corrected file to re-run. */}
            <button onClick={(e) => del(s.id, e)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
              <Trash2 size={14} /> Delete report
            </button>
          </div>

          {/* Money-first headline — what was filed vs what's unreconciled, in ₹.
              Filed liability is the tax across everything in the GSTR-1; the two
              exposure chips are the amounts that don't reconcile with the books. */}
          {s.filed_tax !== undefined && (
            <div className="grid gap-3 p-4 border-b sm:grid-cols-3">
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-400">Tax filed in GSTR-1</div>
                <div className="text-2xl font-bold text-gray-800 mt-0.5 tabular-nums">{inr(s.filed_tax)}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">on {inr(s.filed_taxable)} taxable value</div>
              </div>
              <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3">
                <div className="text-[11px] uppercase tracking-wide text-indigo-500">In books, not filed</div>
                <div className="text-2xl font-bold text-indigo-700 mt-0.5 tabular-nums">{inr(s.only_books_tax)}</div>
                <div className="text-[11px] text-indigo-500/80 mt-0.5">{s.only_in_books} invoice(s) · liability still to file</div>
              </div>
              <div className="rounded-xl border border-red-200 bg-red-50 p-3">
                <div className="text-[11px] uppercase tracking-wide text-red-500">Filed, not in books</div>
                <div className="text-2xl font-bold text-red-600 mt-0.5 tabular-nums">{inr(s.only_gstr1_tax)}</div>
                <div className="text-[11px] text-red-500/80 mt-0.5">{s.only_in_gstr1} invoice(s) · over-reported or a book gap</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
            {TABS.map((t) => {
              const Icon = t.icon;
              const tax = t.taxField ? s[t.taxField] : undefined;
              return (
                <button key={t.key} onClick={() => selectTab(t.key)}
                  className={`rounded-xl border p-3 text-left transition ${tab === t.key ? t.tint : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className="flex items-center gap-2 text-xs text-gray-500"><Icon size={14} className={t.cls} />{t.label}</div>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className={`text-2xl font-bold ${t.cls}`}>{s[t.field]}</span>
                    {tax !== undefined && <span className="text-xs font-semibold text-gray-500 tabular-nums">{inr(tax)}</span>}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">{t.hint}</div>
                </button>
              );
            })}
          </div>

          <div className="overflow-x-auto border-t">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase text-gray-400 border-b">
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2 text-right">Taxable</th>
                  <th className="px-3 py-2 text-right">Tax</th>
                  <th className="px-3 py-2">Our invoice</th>
                  <th className="px-3 py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="border-b hover:bg-primary-50/40 transition-colors cursor-pointer" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                      <td className="px-4 py-2">
                        <div className="flex items-start gap-1.5">
                          {expanded === r.id ? <ChevronDown size={14} className="mt-0.5 text-gray-400" /> : <ChevronRight size={14} className="mt-0.5 text-gray-400" />}
                          <div>
                            <div className="font-medium text-gray-800">{r.customer_name || '—'}</div>
                            <div className="text-[11px] text-gray-400 font-mono">{r.customer_gstin}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-gray-600">{r.invoice_no || '—'}{r.section === 'CDNR' && <span className="ml-1 text-[10px] text-amber-600">(note)</span>}</td>
                      <td className="px-3 py-2 text-gray-500">{r.invoice_date || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">₹{money(r.taxable)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-500">₹{money(r.total_tax)}</td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        {r.invoice_id
                          ? <button onClick={() => navigate(`/sales/invoices/${r.invoice_id}`)} className="inline-flex items-center gap-1 text-indigo-600 hover:underline"><Link2 size={12} />{r.invoice_ref}</button>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-gray-500">{r.note}</td>
                    </tr>
                    {expanded === r.id && (
                      <tr className="bg-gray-50 border-b">
                        <td colSpan={7} className="px-9 py-3">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                            <div><span className="text-gray-400">Invoice value</span><div className="font-medium tabular-nums">₹{money(r.invoice_value)}</div></div>
                            <div><span className="text-gray-400">Taxable</span><div className="font-medium tabular-nums">₹{money(r.taxable)}</div></div>
                            <div><span className="text-gray-400">IGST</span><div className="tabular-nums">₹{money(r.igst)}</div></div>
                            <div><span className="text-gray-400">CGST</span><div className="tabular-nums">₹{money(r.cgst)}</div></div>
                            <div><span className="text-gray-400">SGST</span><div className="tabular-nums">₹{money(r.sgst)}</div></div>
                            <div><span className="text-gray-400">Cess</span><div className="tabular-nums">₹{money(r.cess)}</div></div>
                            <div><span className="text-gray-400">Total tax</span><div className="font-medium tabular-nums">₹{money(r.total_tax)}</div></div>
                            <div><span className="text-gray-400">Section</span><div>{r.section}</div></div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {allRows.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400 text-sm">Nothing in this bucket 🎉</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {allRows.length > 0 && <Pager page={pageNum} total={allRows.length} size={PAGE_SIZE} onPage={setPage} />}
        </div>
      )}

      {/* Recent uploads */}
      {uploads.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="px-4 py-3 border-b text-sm font-semibold text-gray-700">Recent GSTR-1 uploads</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase text-gray-400 border-b">
                  <th className="px-4 py-2">Period</th><th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2 text-right">Invoices</th><th className="px-3 py-2 text-right">Matched</th>
                  <th className="px-3 py-2 text-right">In GSTR-1 only</th><th className="px-3 py-2 text-right">In books only</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {uploads.map((u) => (
                  <tr key={u.id} className={`border-b last:border-0 hover:bg-primary-50/40 transition-colors cursor-pointer ${active?.summary?.id === u.id ? 'bg-indigo-50' : ''}`} onClick={() => openUpload(u.id)}>
                    <td className="px-4 py-2 font-medium text-gray-800">{u.period || u.file_name}</td>
                    <td className="px-3 py-2 text-gray-500">{u.company_name || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{u.total_rows}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-green-600">{u.matched}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-600">{u.only_in_gstr1}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-indigo-600">{u.only_in_books}</td>
                    <td className="px-3 py-2 text-right"><button onClick={(e) => del(u.id, e)} title="Delete this upload" className="text-gray-400 hover:text-red-500"><Trash2 size={15} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
