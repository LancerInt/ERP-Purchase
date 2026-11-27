/**
 * GST 2B Reconciliation — upload the government's GSTR-2B (Excel) and CHECK it
 * against our Purchase Bills. Read-only: nothing is created or filed, our bills
 * are only read. Backend: /api/purchase/gst2b/*
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import { Button } from '../../../components/ui';
import CustomSelect from '../../../components/ui/CustomSelect';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import { UploadCloud, Loader2, CheckCircle2, AlertTriangle, FilePlus2, FileX2, Trash2, Link2, ChevronRight, ChevronDown } from 'lucide-react';
import usePagerKeys from '../../../hooks/usePagerKeys.js';

const money = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

// Compact ₹ for ITC amounts on the tiles (no paise; Cr/L scale for big sums).
const inr = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

const TABS = [
  { key: 'MATCHED', label: 'Matched', field: 'matched', icon: CheckCircle2, cls: 'text-green-600', tint: 'bg-green-50 border-green-200' },
  { key: 'MISMATCH', label: 'Amount mismatch', field: 'mismatch', icon: AlertTriangle, cls: 'text-amber-600', tint: 'bg-amber-50 border-amber-200' },
  { key: 'ONLY_2B', label: 'In 2B, not in our books', field: 'only_in_2b', icon: FileX2, cls: 'text-red-600', tint: 'bg-red-50 border-red-200' },
  { key: 'ONLY_BOOKS', label: 'In our books, not in 2B', field: 'only_in_books', icon: FilePlus2, cls: 'text-indigo-600', tint: 'bg-indigo-50 border-indigo-200' },
];

export default function Gst2B() {
  const { options: companyOptions } = useLookup('/api/companies/', { labelField: 'legal_name', valueField: 'id' });
  // Company follows the GLOBAL header filter (upload + reconciliation re-scope
  // with the rest of the app). On this upload page we still show the company so
  // it's clear which company's 2B is being uploaded, but it's driven by global.
  const { company: globalCompany } = useGlobalCompany();
  const [company, setCompany] = useState(globalCompany || '');
  useEffect(() => { setCompany(globalCompany || ''); }, [globalCompany]);
  const [kind, setKind] = useUrlState('kind', '2B');          // '2B' | '2A' — top tab
  const [uploads, setUploads] = useState([]);
  const [active, setActive] = useState(null);      // { summary, rows }
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

  const [expanded, setExpanded] = useState(null);   // row id expanded
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();

  const selectTab = (k) => { setTab(k); setPage(1); setExpanded(null); };

  const loadUploads = useCallback(() => {
    apiClient.get('/api/purchase/gst2b/', { params: { ...(company ? { company } : {}), kind } })
      .then((r) => setUploads(r.data || [])).catch(() => {});
  }, [company, kind]);
  useEffect(() => { loadUploads(); }, [loadUploads]);

  const switchKind = (k) => { setKind(k); setActive(null); };

  const openUpload = async (id) => {
    try {
      const r = await apiClient.get(`/api/purchase/gst2b/${id}/`);
      setActive(r.data);
      selectTab('ONLY_BOOKS');
    } catch { toast.error('Failed to load report.'); }
  };

  const upload = async (file) => {
    if (!file) return;
    if (!company) { toast.error('Pick a company first.'); return; }
    setUploading(true);
    const fd = new FormData();
    fd.append('company', company); fd.append('file', file); fd.append('kind', kind);
    try {
      const res = await apiClient.post('/api/purchase/gst2b/upload/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      toast.success(`Checked ${res.data.total_rows} invoices — ${res.data.matched} matched.`);
      loadUploads();
      openUpload(res.data.id);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Upload failed.');
    } finally { setUploading(false); }
  };

  const del = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Remove this 2B upload and its report?')) return;
    await apiClient.delete(`/api/purchase/gst2b/${id}/`).catch(() => {});
    if (active?.summary?.id === id) setActive(null);
    loadUploads();
  };

  const s = active?.summary;

  return (
    <MainLayout>
      <PageHeader
        title="GST 2B Reconciliation"
        subtitle="Upload the government's GSTR-2A / 2B and check it against our purchase bills. Read-only — nothing is created or filed."
        breadcrumbs={[{ label: 'Tax / Compliance' }, { label: 'GST 2B Match' }]}
      />

      {/* Top tabs: 2B / 2A */}
      <div className="flex gap-2 mb-4">
        {['2B', '2A'].map((k) => (
          <button key={k} onClick={() => switchKind(k)}
            className={`rounded-lg px-4 py-2 text-sm font-medium border transition ${kind === k ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}>
            GSTR-{k}
          </button>
        ))}
      </div>

      {/* Upload */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 grid gap-3 md:grid-cols-[260px_1fr] items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Company</label>
          <div className="h-[38px] flex items-center rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-gray-700">
            {company
              ? (companyOptions.find((c) => String(c.value) === String(company))?.label || 'Selected company')
              : <span className="text-amber-600">Pick a company in the header first</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium cursor-pointer ${uploading ? 'bg-gray-200 text-gray-500' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}>
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
            {uploading ? 'Checking…' : `Upload GSTR-${kind} (Excel)`}
            <input type="file" accept=".xlsx,.xls" className="hidden" disabled={uploading}
              onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          <span className="text-[11px] text-gray-400">Download the {kind} from the GST portal → upload it here.</span>
        </div>
      </div>

      {/* Report */}
      {s && (
        <div className="bg-white rounded-xl border border-gray-200 mb-4">
          <div className="px-4 py-3 border-b flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-gray-700">
              {s.period || s.file_name} · {s.total_rows} supplier invoices checked
            </div>
            {/* Delete this report (removes the upload + its matched rows). The
                check is read-only, so deleting just clears it — re-upload the
                same or a corrected file to re-run. */}
            <button onClick={(e) => del(s.id, e)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
              <Trash2 size={14} /> Delete report
            </button>
          </div>

          {/* ITC headline — the money the page is really about. */}
          <div className="px-4 pt-4 text-xs text-gray-500">
            This 2B offers <span className="font-semibold text-gray-800">{inr(s.itc_2b)}</span> of ITC ·{' '}
            <span className="font-semibold text-green-700">{inr(s.itc_matched)}</span> cleanly claimable ·{' '}
            <span className="font-semibold text-indigo-700">{inr(s.itc_at_risk)}</span> at risk (supplier hasn&apos;t filed)
          </div>
          {/* Summary tiles = tabs. Each leads with the COUNT and carries its ITC
              (tax) amount + the action needed, so the deviation reads as money. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
            {TABS.map((t) => {
              const Icon = t.icon;
              const itc = { MATCHED: s.itc_matched, MISMATCH: s.itc_mismatch, ONLY_2B: s.itc_only_2b, ONLY_BOOKS: s.itc_at_risk }[t.key];
              const label = t.key === 'ONLY_BOOKS' ? 'ITC at risk · not in 2B' : t.label;
              let sub = itc != null ? `${inr(itc)} ITC` : null;
              if (t.key === 'ONLY_2B' && (s.only_2b_no_vendor != null)) {
                sub = `${inr(itc)} · ${s.only_2b_no_vendor} no vendor · ${s.only_2b_not_booked} not booked`;
              } else if (t.key === 'MISMATCH') {
                sub = `${inr(itc)} ITC · tax differs`;
              } else if (t.key === 'ONLY_BOOKS') {
                sub = `${inr(itc)} · chase the supplier`;
              } else if (t.key === 'MATCHED') {
                sub = `${inr(itc)} ITC · claim`;
              }
              return (
                <button key={t.key} onClick={() => selectTab(t.key)}
                  className={`rounded-xl border p-3 text-left transition ${tab === t.key ? t.tint : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className="flex items-center gap-2 text-xs text-gray-500"><Icon size={14} className={t.cls} />{label}</div>
                  <div className={`text-2xl font-bold mt-1 ${t.cls}`}>{s[t.field]}</div>
                  {sub && <div className="text-[11px] text-gray-500 mt-0.5 tabular-nums">{sub}</div>}
                </button>
              );
            })}
          </div>

          {/* Rows for active tab */}
          <div className="overflow-x-auto border-t">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase text-gray-400 border-b">
                  <th className="px-4 py-2">Supplier</th>
                  <th className="px-3 py-2">Invoice (2B)</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2 text-right">Taxable</th>
                  <th className="px-3 py-2 text-right">Tax</th>
                  <th className="px-3 py-2">Our bill</th>
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
                            <div className="font-medium text-gray-800">{r.supplier_name || '—'}</div>
                            <div className="text-[11px] text-gray-400 font-mono">{r.supplier_gstin}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-gray-600">{r.invoice_no || '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{r.invoice_date || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">₹{money(r.taxable)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-500">₹{money(r.total_tax)}</td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        {r.bill_id
                          ? <button onClick={() => navigate(`/purchase/bills/${r.bill_id}`)} className="inline-flex items-center gap-1 text-indigo-600 hover:underline"><Link2 size={12} />{r.bill_no}</button>
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
                            <div><span className="text-gray-400">ITC available</span><div>{r.itc_available || '—'}</div></div>
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
          <div className="px-4 py-3 border-b text-sm font-semibold text-gray-700">Recent 2B uploads</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase text-gray-400 border-b">
                  <th className="px-4 py-2">Period</th><th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2 text-right">Invoices</th><th className="px-3 py-2 text-right">Matched</th>
                  <th className="px-3 py-2 text-right">In 2B only</th><th className="px-3 py-2 text-right">In books only</th>
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
                    <td className="px-3 py-2 text-right tabular-nums text-red-600">{u.only_in_2b}</td>
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
