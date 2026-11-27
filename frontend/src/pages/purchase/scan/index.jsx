/**
 * Scan Inbox — bulk purchase-invoice scanning.
 *
 * Drop many PDFs (each may hold several bills). Claude vision segments + reads
 * every invoice, we match each to an existing Tally VendorBill (or flag a new
 * one), and after MANUAL review the item lines are written onto the bill —
 * filling item-wise tracking, item master and purchase analytics.
 *
 * Backend: /api/purchase/scan/* (see ai_parser/scan_views.py)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import { Button } from '../../../components/ui';
import Modal from '../../../components/ui/Modal';
import CustomSelect from '../../../components/ui/CustomSelect';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import usePermissions from '../../../hooks/usePermissions.js';
import {
  UploadCloud, ScanLine, CheckCircle2, AlertTriangle, FilePlus2,
  Loader2, Link2, FileText, X, Search, Zap, Check, Eye, ArrowRight,
} from 'lucide-react';
import { confirm } from '@/components/common/confirm';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';

const money = (v) =>
  Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ERP's production UOM list (master.Product.UOM_CHOICES) — the dropdown options.
const UOM_CODES = ['KG', 'LTR', 'PCS', 'MTR', 'MTS', 'BOX', 'PACK', 'SQM', 'CUM'];
// Map common invoice spellings → the ERP code.
const UOM_ALIAS = {
  KGS: 'KG', KILOGRAM: 'KG', KILOGRAMS: 'KG', KILO: 'KG', KILOS: 'KG',
  L: 'LTR', LT: 'LTR', LTRS: 'LTR', LITRE: 'LTR', LITRES: 'LTR', LITER: 'LTR', LITERS: 'LTR',
  PC: 'PCS', NOS: 'PCS', NO: 'PCS', UNIT: 'PCS', UNITS: 'PCS', EA: 'PCS', PIECES: 'PCS',
  M: 'MTR', MTRS: 'MTR', METER: 'MTR', METERS: 'MTR', METRE: 'MTR', METRES: 'MTR',
  MT: 'MTS', TON: 'MTS', TONS: 'MTS', TONNE: 'MTS', TONNES: 'MTS',
  BOXES: 'BOX', PACKS: 'PACK', PKT: 'PACK', PACKET: 'PACK',
};
// Normalise a raw extracted UOM ("Kg's", "Nos", "Litre") to an ERP code; keep
// the raw text if it's genuinely non-standard (e.g. "BAG") so nothing is lost.
function normUom(raw) {
  if (!raw) return '';
  const s = String(raw).trim().toUpperCase().replace(/['’]S$/, '').replace(/\.$/, '').replace(/\s+/g, '');
  if (UOM_CODES.includes(s)) return s;
  return UOM_ALIAS[s] || String(raw).trim();
}

const STATUS_META = {
  MATCHED:   { label: 'Matched',         cls: 'bg-green-100 text-green-700' },
  UNMATCHED: { label: 'New bill',        cls: 'bg-blue-100 text-blue-700' },
  MISMATCH:  { label: 'Amount mismatch', cls: 'bg-amber-100 text-amber-800' },
  CONFIRMED: { label: 'Confirmed',       cls: 'bg-emerald-600 text-white' },
  SKIPPED:   { label: 'Skipped',         cls: 'bg-gray-200 text-gray-600' },
  FAILED:    { label: 'Failed',          cls: 'bg-red-100 text-red-700' },
  EXTRACTED: { label: 'Read',            cls: 'bg-gray-100 text-gray-600' },
};

function Pill({ status }) {
  const m = STATUS_META[status] || STATUS_META.EXTRACTED;
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${m.cls}`}>{m.label}</span>;
}

// Short company tag (SS / UAI) — mirrors the analytics / invoice tables so the
// same company reads the same abbreviation everywhere.
const companyPill = (name) => {
  if (!name) return '—';
  const n = String(name).toUpperCase();
  if (n.includes('UNITED AGRO')) return 'UAI';
  if (n.includes('BIOCHEM')) return 'SS';
  return String(name).split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
};

// Compact scan timestamp — "18 Nov, 3:56 pm" — scannable, no year clutter (the
// full value is kept on the cell's title for the rare case it's needed).
const fmtScanDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase().replace(/\s/g, '');
  return `${date}, ${time}`;
};

// Whole days elapsed since an ISO timestamp (0 for today / future / unparseable).
const daysSince = (iso) => {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
};

// A scan is "aging" once its bills have sat unconverted this many days — the
// threshold that trips the reminder toast / banner.
const AGING_DAYS = 2;

// Batch status pill colours — colour AND the word (never colour alone) so READY
// vs PROCESSING vs FAILED read at a glance without relying on hue.
const BATCH_STATUS_CLS = {
  READY:      'bg-indigo-50 text-indigo-700 border-indigo-200',
  PROCESSING: 'bg-amber-50 text-amber-700 border-amber-200',
  UPLOADING:  'bg-amber-50 text-amber-700 border-amber-200',
  FAILED:     'bg-red-50 text-red-700 border-red-200',
  DONE:       'bg-emerald-50 text-emerald-700 border-emerald-200',
};

// 10-per-page footer with Prev/Next, shared by both lists.
function Pager({ page, total, size, onPage }) {
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(page, totalPages);
  return (
    <div className="flex items-center justify-between mt-2 pt-2 border-t text-xs text-gray-500">
      <span>Showing {total === 0 ? 0 : (p - 1) * size + 1}–{Math.min(p * size, total)} of {total}</span>
      <div className="flex gap-1">
        <button disabled={p <= 1} onClick={() => onPage(p - 1)}
          className="rounded border px-3 py-1 hover:bg-gray-50 disabled:opacity-40">Prev</button>
        <button disabled={p >= totalPages} onClick={() => onPage(p + 1)}
          className="rounded border px-3 py-1 hover:bg-gray-50 disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}

const PAGE_SIZE = 10;

export default function ScanInbox() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlBatchId = searchParams.get('batch') || '';
  const { options: companyOptions } = useLookup('/api/companies/', { labelField: 'legal_name', valueField: 'id' });
  // Default the upload-batch company to the GLOBAL header company (so a new scan
  // pre-selects the active company). It stays editable — the batch itself can
  // override it, and a loaded batch sets it from its own record.
  const { company: globalCompany } = useGlobalCompany();
  const [company, setCompany] = useState(globalCompany || '');
  useEffect(() => { setCompany((c) => c || globalCompany || ''); }, [globalCompany]);
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [batch, setBatch] = useState(null);      // { batch, bills }
  const [active, setActive] = useState(null);     // bill id under review
  const [recent, setRecent] = useState([]);
  const [recentPage, setRecentPage] = useState(1);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [agingDismissed, setAgingDismissed] = useState(false);
  const agingRemindedRef = useRef(false);
  const [converted, setConverted] = useState([]);
  const [convertedPage, setConvertedPage] = useState(1);
  const navigate = useNavigate();

  // Top-level tabs: the scanning flow + the Pending Approval queue. Held in the
  // URL (?tab=) so returning via the browser Back button (e.g. from a bill opened
  // by "Verify") lands back on the same tab instead of resetting to Scan.
  const topTab = searchParams.get('tab') || 'scan';   // 'scan' | 'pending'
  const setTopTab = useCallback((t) => {
    const p = new URLSearchParams(searchParams);
    if (t === 'scan') p.delete('tab'); else p.set('tab', t);
    setSearchParams(p, { replace: true });
  }, [searchParams, setSearchParams]);
  const [pending, setPending] = useState([]);
  const [pendLoading, setPendLoading] = useState(false);
  const loadPending = useCallback(async () => {
    setPendLoading(true);
    try {
      const { data } = await apiClient.get('/api/import/pending/');
      setPending(data.rows || []);
    } catch { /* keep prior */ }
    finally { setPendLoading(false); }
  }, []);
  useEffect(() => { loadPending(); }, [loadPending]);

  // Restore the batch named in the URL from the DB — NOT by re-scanning. A page
  // reload (or HMR during dev) becomes free: no Gemini call, results never lost.
  useEffect(() => {
    if (!urlBatchId) { setBatch(null); return; }
    if (batch?.batch?.id === urlBatchId) return;   // already loaded
    apiClient.get(`/api/purchase/scan/batches/${urlBatchId}/`)
      .then((r) => { setBatch(r.data); if (r.data?.batch?.company) setCompany(r.data.batch.company); })
      .catch(() => { /* stale/removed batch id — ignore */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlBatchId]);

  // Recent batches — reopen any past scan without re-uploading.
  const loadRecent = useCallback(() => {
    apiClient.get('/api/purchase/scan/batches/', { params: showAllRecent ? { all: 1 } : {} })
      .then((r) => setRecent(r.data || [])).catch(() => {});
  }, [showAllRecent]);
  useEffect(() => { loadRecent(); }, [loadRecent]);

  // Goods bills still left to review in a batch (same rule the Recent-scans table
  // uses for "Left": count only goods, so freight slips never inflate it).
  const pendingOf = useCallback((r) => (r.type_stats
    ? (r.type_stats.goods_pending || 0)
    : (r.bill_count || 0) - ((r.counts?.CONFIRMED || 0) + (r.counts?.SKIPPED || 0))), []);

  // Aging reminder — bills scanned but never confirmed. A scan that's been
  // sitting unconverted for AGING_DAYS+ means stock & payables aren't booked yet,
  // so surface it: how long the oldest has waited, and how many bills / scans.
  const aging = useMemo(() => {
    const goods = recent.filter((r) => !r.type_stats || (r.type_stats.goods_total || 0) > 0);
    let bills = 0, batches = 0, oldest = 0;
    for (const r of goods) {
      const p = pendingOf(r);
      if (p <= 0) continue;
      const d = daysSince(r.created_at);
      if (d >= AGING_DAYS) { bills += p; batches += 1; oldest = Math.max(oldest, d); }
    }
    return { bills, batches, oldest };
  }, [recent, pendingOf]);

  // Nudge once per visit when the data first shows aged, unconverted bills.
  useEffect(() => {
    if (agingRemindedRef.current || aging.bills <= 0) return;
    agingRemindedRef.current = true;
    toast(
      `${aging.oldest} days passed — ${aging.bills} bill${aging.bills > 1 ? 's' : ''} `
      + `across ${aging.batches} scan${aging.batches > 1 ? 's' : ''} still not converted.`,
      { icon: <AlertTriangle size={16} className="text-amber-500" />, duration: 6000 },
    );
  }, [aging]);

  const retryDoc = async (id) => {
    try {
      const res = await apiClient.post(`/api/purchase/scan/documents/${id}/retry/`, {});
      setBatch(res.data);
      toast.success('Re-read the file.');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Retry failed.');
    }
  };

  // Converted invoices (Confirmed → written to a bill) — shown below Recent Scans.
  const loadConverted = useCallback(() => {
    apiClient.get('/api/purchase/scan/converted/').then((r) => setConverted(r.data || [])).catch(() => {});
  }, []);
  useEffect(() => { loadConverted(); }, [loadConverted]);

  // Product vs Freight view. Freight = pending scanned FREIGHT bills, each mapped
  // to its goods bill by the invoice no written on the slip.
  const [scanKind, setScanKind] = useState('PRODUCT');
  const [freightBills, setFreightBills] = useState([]);
  const [linkFor, setLinkFor] = useState(null);   // freight bill being manually linked
  const [dupWarn, setDupWarn] = useState(null);   // just-scanned bills already in the inbox
  const loadFreightBills = useCallback(() => {
    apiClient.get('/api/purchase/scan/freight-bills/').then((r) => setFreightBills(r.data || [])).catch(() => {});
  }, []);
  useEffect(() => { loadFreightBills(); }, [loadFreightBills]);

  // Undo the stock a converted scan posted — reverses the ledger rows only; the
  // bill and its lines stay. For a wrong post caught after confirm.
  const undoStock = useCallback(async (scanId) => {
    if (!window.confirm('Remove the stock this scan added to the ledger?\n\nThe bill and its item lines stay — only the stock movement is reversed.')) return;
    try {
      const r = await apiClient.post(`/api/purchase/scan/bills/${scanId}/unpost_stock/`, {});
      toast.success(r.data?.detail || 'Stock reversed.');
      loadConverted();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not undo stock.');
    }
  }, [loadConverted]);

  // Revert a mistaken confirm — undoes the bill (or, for a merge into a
  // pre-existing Tally bill, just the lines this scan wrote) + its stock,
  // and drops the scan back to reviewable so it can be corrected and
  // re-confirmed. See revert_scan_bill's docstring on the backend for
  // exactly what does and doesn't get torn down.
  const revertBill = useCallback(async (scanId) => {
    if (!window.confirm('Revert this confirmed scan?\n\nA bill created purely by this scan is fully deleted (with its stock). A bill this scan merged into stays — only the lines and stock it added are removed. Either way the scan goes back to reviewable — reopen its batch and click Refresh to see it there.')) return;
    try {
      await apiClient.post(`/api/purchase/scan/bills/${scanId}/revert/`, {});
      toast.success('Reverted — back in the review list.');
      loadConverted();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not revert.');
    }
  }, [loadConverted]);

  const openBatch = (id) => setSearchParams({ batch: id });
  const newScan = () => { setSearchParams({}); setBatch(null); };

  const deleteBatch = async (id, e) => {
    if (e) e.stopPropagation();
    if (!window.confirm('Remove this scan from the inbox?\n(Any bill already created from it stays — only the scan record is deleted.)')) return;
    try {
      await apiClient.delete(`/api/purchase/scan/batches/${id}/`);
      if (urlBatchId === id) newScan();
      loadRecent();
      toast.success('Scan removed.');
    } catch {
      toast.error('Delete failed.');
    }
  };

  // Free-text internal note on a scan batch (Recent-scans list) — no link to
  // anything; saved on blur/Enter, kept in the list so it shows and stays editable.
  const saveNote = async (id, note) => {
    try {
      await apiClient.patch(`/api/purchase/scan/batches/${id}/`, { note });
      setRecent((rows) => rows.map((r) => (r.id === id ? { ...r, note } : r)));
    } catch {
      toast.error('Could not save the note.');
    }
  };

  // Remove one freight scan from the inbox — the per-row X on the Freight bills
  // list, mirroring the Recent-scans X (which deletes a whole batch).
  const deleteFreight = async (id, e) => {
    if (e) e.stopPropagation();
    if (!window.confirm('Remove this freight scan from the inbox?\n(Any bill it was linked to stays — only the scan record is deleted.)')) return;
    try {
      await apiClient.delete(`/api/purchase/scan/bills/${id}/`);
      loadFreightBills();
      toast.success('Freight scan removed.');
    } catch {
      toast.error('Delete failed.');
    }
  };

  const addFiles = (list) => {
    const arr = Array.from(list || []).filter(
      (f) => /\.(pdf|png|jpe?g|webp)$/i.test(f.name)
    );
    setFiles((prev) => [...prev, ...arr]);
  };

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  }, []);

  const upload = async () => {
    if (!company) { toast.error('Pick a company first.'); return; }
    if (!files.length) { toast.error('Add at least one PDF/image.'); return; }
    setUploading(true);
    const fd = new FormData();
    fd.append('company', company);
    if (scanKind === 'FREIGHT') fd.append('bill_type', 'FREIGHT');   // "select freight and scan"
    files.forEach((f) => fd.append('files', f));
    try {
      const res = await apiClient.post('/api/purchase/scan/upload/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 600000, // vision reads each doc — allow up to 10 min
      });
      setBatch(res.data);
      setFiles([]);
      if (res.data?.batch?.id) setSearchParams({ batch: res.data.batch.id });  // persist in URL
      loadRecent(); loadFreightBills();
      const n = res.data?.bills?.length || 0;
      toast.success(scanKind === 'FREIGHT' ? `Read ${n} freight bill(s) — see the Freight view.` : `Read ${n} bill(s) from ${files.length} file(s).`);
      // Strict duplicate check — any just-scanned bill already sitting unconfirmed
      // in the inbox. Ask the operator to remove the duplicate or keep both.
      if ((res.data?.duplicates || []).length) setDupWarn(res.data.duplicates);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const reloadBatch = async () => {
    const id = batch?.batch?.id || urlBatchId;
    if (!id) return;
    const res = await apiClient.get(`/api/purchase/scan/batches/${id}/`);
    setBatch(res.data);
  };

  const bills = batch?.bills || [];
  const counts = batch?.batch?.counts || {};
  const failedDocs = (batch?.documents || []).filter((d) => d.status === 'FAILED');

  return (
    <MainLayout>
      <PageHeader
        title="Scan Invoices"
        subtitle="Drop scanned purchase invoices — AI reads each bill; you review, then it fills the item lines."
        breadcrumbs={[{ label: 'Import Data' }, { label: 'Scan Inbox' }]}
      />

      {/* Top tabs — Scan flow + the triage Inbox/Pending queues moved here. */}
      <div className="flex gap-6 border-b border-slate-200 mb-4 px-1">
        {[['scan', '🖨️ Scan', 0], ['pending', '⏳ Pending Approval', pending.length]].map(([id, label, n]) => (
          <button key={id} onClick={() => setTopTab(id)}
            className={`pb-2 border-b-2 text-sm ${topTab === id ? 'border-indigo-500 text-indigo-600 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
            {label}{n > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full ml-1 bg-amber-50 text-amber-600">{n}</span>}
          </button>
        ))}
      </div>

      {topTab === 'pending' && (
        <TriagePending pending={pending} loading={pendLoading} reload={loadPending}
          onApproved={(ids) => setPending((ps) => ps.filter((p) => !ids.includes(p.id)))} />
      )}

      {topTab === 'scan' && (<>
      {/* ── Upload card (compact) ───────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-3 mb-4">
        {/* One row: company + scan-type toggle + the primary Scan action. */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1 sm:flex-none">
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Company</label>
            <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)} title="Company">
              <option value="">Select company…</option>
              {companyOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">Scan type</label>
            <div className="inline-flex bg-gray-100 border border-gray-200 rounded-lg p-0.5 gap-0.5">
              {[['PRODUCT', '🧾 Purchase'], ['FREIGHT', '🚚 Freight']].map(([k, label]) => (
                <button key={k} type="button" onClick={() => setScanKind(k)}
                  title={k === 'FREIGHT' ? 'Freight slips — mapped to their goods bill by the written bill no.' : 'Normal purchase invoices'}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${scanKind === k ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="ml-auto">
            <Button onClick={upload} disabled={uploading} icon={uploading ? Loader2 : ScanLine}>
              {uploading ? 'Reading…' : `Scan ${files.length || ''} file${files.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>

        {/* Slim, single-line drop zone. */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`mt-3 rounded-lg border-2 border-dashed px-4 py-2.5 flex items-center justify-center gap-2 text-center transition ${dragOver ? 'border-indigo-400 bg-indigo-50' : 'border-gray-300'}`}
        >
          <UploadCloud className="text-gray-400 shrink-0" size={18} />
          <p className="text-xs text-gray-600">
            Drag &amp; drop PDFs / images, or{' '}
            <label className="text-indigo-600 font-medium cursor-pointer">browse
              <input type="file" multiple accept=".pdf,image/*" className="hidden"
                onChange={(e) => addFiles(e.target.files)} />
            </label>
            <span className="text-gray-400"> — one PDF can hold many bills, split automatically.</span>
          </p>
        </div>

        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 bg-gray-100 rounded px-2 py-0.5 text-[11px] text-gray-600">
                <FileText size={11} /> {f.name}
                <button onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500"><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Product vs Freight view — scanned freight bills list on their own. */}
      <div className="inline-flex bg-gray-100 border border-gray-200 rounded-lg p-0.5 gap-0.5 mb-3">
        {[['PRODUCT', '🧾 Purchase bills'], ['FREIGHT', '🚚 Freight bills']].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setScanKind(k)}
            className={`px-3 py-1.5 rounded-md text-sm font-semibold transition ${scanKind === k ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            {label}{k === 'FREIGHT' && freightBills.length > 0 ? ` (${freightBills.length})` : ''}
          </button>
        ))}
      </div>

      {/* ── Freight bills — scanned transporter slips, mapped to their goods bill ── */}
      {scanKind === 'FREIGHT' && (
        <div className="bg-white rounded-xl border border-gray-200 mb-4">
          <div className="px-4 py-3 border-b text-sm font-semibold text-gray-700">Scanned freight bills — click to review</div>
          {freightBills.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-gray-400">No freight bills to review. Scan a transporter's slip (Freight bill).</div>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase text-gray-400 border-b">
                <th className="px-4 py-2">Transporter</th><th className="px-3 py-2">Freight bill no</th>
                <th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Maps to bill</th>
                <th className="px-3 py-2">Scanned at</th><th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr></thead>
              <tbody>
                {freightBills.map((fb) => (
                  <tr key={fb.id} className="border-b last:border-0 hover:bg-primary-50/40 transition-colors cursor-pointer" onClick={() => setActive(fb.id)}>
                    <td className="px-4 py-2 font-medium text-gray-800">{fb.transporter_name || '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{fb.freight_invoice_no || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(fb.freight_amount)}</td>
                    <td className="px-3 py-2">{fb.freight_linked_bill_no
                      ? <span className="text-emerald-700">🔗 {fb.freight_linked_bill_no}</span>
                      : <span className="text-amber-600">{fb.freight_ref_no ? `“${fb.freight_ref_no}” — no match` : 'not mapped'}</span>}</td>
                    <td className="px-3 py-2 text-gray-500">{fb.scanned_at ? new Date(fb.scanned_at).toLocaleString() : ''}</td>
                    <td className="px-3 py-2 text-center"><span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">{fb.status}</span></td>
                    <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex items-center gap-2 justify-end">
                        <button onClick={() => setLinkFor(fb)}
                          className="border border-indigo-200 text-indigo-600 hover:bg-indigo-50 rounded-md px-3 py-1 text-xs font-semibold inline-flex items-center gap-1">
                          <Link2 size={12} /> Link
                        </button>
                        <button onClick={(e) => deleteFreight(fb.id, e)} title="Remove scan"
                          className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500"><X size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      )}

      {/* ── Recent scans — pending invoices left to review (table, 10 per page) ── */}
      {scanKind === 'PRODUCT' && (() => {
        // Purchase view lists only batches that actually have GOODS bills;
        // freight-only batches belong in the Freight bills view. "Bills left"
        // counts goods pending only, so a batch's auto-detected freight slips
        // never inflate the purchase queue.
        const goodsBatches = recent.filter((r) => !r.type_stats || (r.type_stats.goods_total || 0) > 0);
        if (goodsBatches.length === 0) return null;
        const page = Math.min(recentPage, Math.max(1, Math.ceil(goodsBatches.length / PAGE_SIZE)));
        const rows = goodsBatches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        return (
          <>
          {/* Aging reminder — unconverted scans whose stock & payables aren't
              booked yet. Dismissible for the session; the toast fires once too. */}
          {aging.bills > 0 && !agingDismissed && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
              <div className="flex-1 leading-relaxed">
                <span className="font-semibold">{aging.oldest} days passed</span> — {aging.bills} bill{aging.bills > 1 ? 's' : ''} across {aging.batches} scan{aging.batches > 1 ? 's' : ''} still not converted. Review and confirm them so their stock and payables get booked.
              </div>
              <button onClick={() => setAgingDismissed(true)} aria-label="Dismiss reminder"
                className="shrink-0 rounded p-0.5 text-amber-500 hover:bg-amber-100 hover:text-amber-700"><X size={14} /></button>
            </div>
          )}
          <div className="bg-white rounded-xl border border-gray-200 mb-4">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="text-sm font-semibold text-gray-700">Recent scans — click a row to reopen (no re-scan)</span>
              <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                <input type="checkbox" checked={showAllRecent} onChange={(e) => setShowAllRecent(e.target.checked)} />
                Show converted too
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400 border-b">
                    <th className="px-4 py-2">Company</th>
                    <th className="px-3 py-2">File</th>
                    <th className="px-3 py-2">Notes</th>
                    <th className="px-3 py-2 text-right" title="Total bills detected in this file">Total</th>
                    <th className="px-3 py-2 text-right" title="Bills still left to review">Left</th>
                    <th className="px-3 py-2">Scanned</th>
                    <th className="px-3 py-2 text-center">Status</th>
                    <th className="px-3 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const total = r.type_stats ? (r.type_stats.goods_total || 0) : (r.bill_count || 0);
                    const pending = r.type_stats
                      ? (r.type_stats.goods_pending || 0)
                      : (r.bill_count || 0) - ((r.counts?.CONFIRMED || 0) + (r.counts?.SKIPPED || 0));
                    const done = total > 0 && pending === 0;
                    const age = daysSince(r.created_at);
                    const aged = pending > 0 && age >= AGING_DAYS;
                    return (
                      <tr key={r.id}
                        className={`border-b last:border-0 hover:bg-gray-50 cursor-pointer ${urlBatchId === r.id ? 'bg-indigo-50' : ''}`}
                        onClick={() => openBatch(r.id)}>
                        <td className="px-4 py-2">
                          <span title={r.company_name || ''}
                            className="inline-block px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200">
                            {companyPill(r.company_name)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {r.file_name ? (
                            <span className="inline-flex items-center gap-1.5 max-w-[190px]" title={r.file_name}>
                              <FileText size={13} className="text-gray-400 shrink-0" />
                              <span className="truncate text-gray-600">{r.file_name}</span>
                              {r.doc_count > 1 && (
                                <span className="shrink-0 rounded bg-gray-100 text-gray-500 px-1 text-[10px] font-semibold"
                                  title={`${r.doc_count} files in this scan`}>+{r.doc_count - 1}</span>
                              )}
                            </span>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            defaultValue={r.note || ''}
                            placeholder="Add note…"
                            title="Internal note for this scan (not linked to anything)"
                            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (r.note || '')) saveNote(r.id, v); }}
                            className="w-36 max-w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                          />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500">{total || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-800">
                          {done
                            ? <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 size={12} />0</span>
                            : pending}
                        </td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap"
                          title={r.created_at ? new Date(r.created_at).toLocaleString() : ''}>
                          <span className="inline-flex items-center gap-1.5">
                            {fmtScanDate(r.created_at)}
                            {aged && (
                              <span className="rounded bg-amber-100 text-amber-700 border border-amber-200 px-1 py-0.5 text-[10px] font-bold"
                                title={`${pending} bill${pending > 1 ? 's' : ''} unconverted for ${age} days`}>{age}d</span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${BATCH_STATUS_CLS[r.status] || 'bg-gray-50 text-gray-600 border-gray-200'}`}>{r.status}</span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button onClick={(e) => deleteBatch(r.id, e)} title="Remove scan" aria-label="Remove scan"
                            className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500"><X size={14} /></button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 pb-1"><Pager page={page} total={goodsBatches.length} size={PAGE_SIZE} onPage={setRecentPage} /></div>
          </div>
          </>
        );
      })()}

      {/* ── Review grid ─────────────────────────────────────────────── */}
      {batch && (
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <div className="text-sm font-semibold text-gray-700">
              {bills.length} bill(s) detected
              <span className="ml-2 text-xs font-normal text-gray-400">
                {Object.entries(counts).map(([k, v]) => `${STATUS_META[k]?.label || k}: ${v}`).join(' · ')}
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={newScan} responsiveLabel>New scan</Button>
              <Button variant="outline" onClick={reloadBatch} icon={Loader2} responsiveLabel>Refresh</Button>
            </div>
          </div>

          {failedDocs.length > 0 && (
            <div className="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="text-xs font-semibold text-red-700 mb-1">{failedDocs.length} file(s) failed to read</div>
              {failedDocs.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2 text-[11px] text-red-700 py-0.5">
                  <span className="truncate"><AlertTriangle size={11} className="inline mr-1" />{d.original_name} — {d.error_message || 'extraction failed'}</span>
                  <button onClick={() => retryDoc(d.id)} className="rounded border border-red-300 px-2 py-0.5 hover:bg-red-100 whitespace-nowrap">Retry</button>
                </div>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase text-gray-400 border-b">
                  <th className="px-4 py-2">Vendor</th>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-right">Items ∑</th>
                  <th className="px-3 py-2">Target bill</th>
                  <th className="px-3 py-2 text-center">Recon</th>
                  <th className="px-3 py-2 text-center">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id} className="border-b last:border-0 hover:bg-primary-50/40 transition-colors">
                    <td className="px-4 py-2">
                      <div className="font-medium text-gray-800 flex items-center gap-1">
                        {b.vendor_name || '—'}
                        {b.confidence > 0 && Number(b.confidence) < 0.7 && (
                          <AlertTriangle size={12} className="text-amber-500" title={`Low confidence (${Math.round(Number(b.confidence) * 100)}%) — review carefully`} />
                        )}
                      </div>
                      {!b.matched_vendor && <div className="text-[11px] text-amber-600">vendor not mapped</div>}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{b.invoice_no || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">₹{money(b.total_amount)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500">₹{money(b.items_total)}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {b.matched_bill_no
                        ? <span className="inline-flex items-center gap-1 text-green-700"><Link2 size={12} />{b.matched_bill_no}</span>
                        : b.created_bill_no
                          ? <span className="inline-flex items-center gap-1 text-emerald-700"><FilePlus2 size={12} />{b.created_bill_no}</span>
                          : <span className="inline-flex items-center gap-1 text-blue-600"><FilePlus2 size={12} />new</span>}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {b.reconciled
                        ? <CheckCircle2 className="inline text-green-600" size={16} />
                        : <AlertTriangle className="inline text-amber-500" size={16} />}
                    </td>
                    <td className="px-3 py-2 text-center"><Pill status={b.status} /></td>
                    <td className="px-3 py-2 text-right">
                      <Button variant="outline" onClick={() => setActive(b.id)} disabled={b.status === 'CONFIRMED'}>
                        {b.status === 'CONFIRMED' ? 'Done' : 'Review'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Converted to bills (table, 10 per page) ─────────────────────── */}
      {converted.length > 0 && (() => {
        const page = Math.min(convertedPage, Math.max(1, Math.ceil(converted.length / PAGE_SIZE)));
        const rows = converted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        return (
          <div className="bg-white rounded-xl border border-gray-200 mb-4 mt-4">
            <div className="px-4 py-3 border-b text-sm font-semibold text-gray-700">Converted to bills — {converted.length} invoice(s) written</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase text-gray-400 border-b">
                    <th className="px-4 py-2">Vendor</th>
                    <th className="px-3 py-2">Invoice</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2">Bill No</th>
                    <th className="px-3 py-2">Converted at</th>
                    <th className="px-3 py-2 text-right">Stock</th>
                    <th className="px-3 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="border-b last:border-0 hover:bg-primary-50/40 transition-colors cursor-pointer"
                      onClick={() => c.link && navigate(c.link)}>
                      <td className="px-4 py-2 font-medium text-gray-800">
                        {c.kind === 'FREIGHT' && <span className="mr-1.5 text-[10px] font-semibold uppercase bg-amber-100 text-amber-700 rounded px-1.5 py-0.5">Freight</span>}
                        {c.vendor_name || '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{c.invoice_no || '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">₹{money(c.total_amount)}</td>
                      <td className="px-3 py-2 text-emerald-700 font-medium">{c.bill_no || '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{c.committed_at ? new Date(c.committed_at).toLocaleString() : ''}</td>
                      <td className="px-3 py-2 text-right">
                        {c.stock_posted ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); undoStock(c.id); }}
                            className="text-xs px-2 py-1 rounded border border-rose-200 text-rose-600 hover:bg-rose-50"
                          >
                            Undo stock
                          </button>
                        ) : (
                          <span className="text-[11px] text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); revertBill(c.id); }}
                          className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                        >
                          Revert
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 pb-1"><Pager page={page} total={converted.length} size={PAGE_SIZE} onPage={setConvertedPage} /></div>
          </div>
        );
      })()}
      </>)}

      {active && (
        <ReviewModal
          billId={active}
          company={company}
          onClose={() => setActive(null)}
          onCommitted={async () => { setActive(null); await reloadBatch(); loadRecent(); loadConverted(); loadFreightBills(); }}
          onScanned={async (newId) => { await reloadBatch(); loadRecent(); loadFreightBills(); if (newId) setActive(newId); }}
        />
      )}

      {linkFor && (
        <FreightLinkModal
          fb={linkFor}
          onClose={() => setLinkFor(null)}
          onLinked={() => { setLinkFor(null); loadFreightBills(); loadConverted(); }}
          onGotoBills={() => navigate(
            `/purchase/bills?linkFreight=${linkFor.id}&freightNo=${encodeURIComponent(linkFor.freight_invoice_no || '')}`
          )}
        />
      )}

      {dupWarn && (
        <DuplicateModal
          dups={dupWarn}
          onClose={() => setDupWarn(null)}
          onRemoved={async () => { setDupWarn(null); await reloadBatch(); loadRecent(); loadFreightBills(); }}
        />
      )}
    </MainLayout>
  );
}

/* ── Triage panels (Inbox + Pending Approval) ─────────────────────────────
 * Moved here from the old Import Data › Ledger (triage) page so Scan Inbox hosts
 * BOTH the scanning flow and the document-triage flow as tabs:
 *   Inbox   — scanned/imported docs auto-classified → Route (or Auto-route all)
 *             creates each as a DRAFT bill on its destination.
 *   Pending — the auto-routed DRAFT bills, verified + approved here (per-bill or
 *             Approve All); approval flips DRAFT→OPEN so it shows on Bills. */
const TRIAGE_TYPES = ['Purchase', 'Expense', 'Freight-Inward', 'Freight-Local', 'Payment', 'Sales Invoice', 'Receipt'];
const TRIAGE_DEST = {
  Purchase: 'Purchase Bills', Expense: 'Expense Bills',
  'Freight-Inward': 'Freight Inward', 'Freight-Local': 'Local Freight',
  Payment: 'Payments Made', 'Sales Invoice': 'Sales Invoices', Receipt: 'Receipts',
};
const TRIAGE_SRC_CHIP = { Scan: 'bg-indigo-50 text-indigo-600', Tally: 'bg-emerald-50 text-emerald-600', Bank: 'bg-sky-50 text-sky-600' };
const triageSrcChip = (s) => TRIAGE_SRC_CHIP[s] || 'bg-slate-100 text-slate-500';
const triageAmt = (a) => '₹' + Number(a || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function TriageInbox({ onPendingChange }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [picks, setPicks] = useState({});
  const [routing, setRouting] = useState(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadInbox = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data } = await apiClient.get('/api/import/inbox/');
      setRows(data.rows || []);
      const seed = {};
      (data.rows || []).forEach((r) => { if (r.type) seed[r.id] = r.type; });
      setPicks(seed);
    } catch (err) { setError(getApiErrorMessage(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadInbox(); }, [loadInbox]);

  const doRoute = useCallback(async (row, type) => {
    setRouting(row.id);
    try {
      const { data } = await apiClient.post(`/api/import/route/${row.id}/`, { type });
      if (data.needs_vendor) { toast('Map the vendor to finish routing.', { icon: '✍️' }); navigate(data.review_path); return; }
      if (data.needs_merge) { toast('A matching bill exists — choose merge or separate.', { icon: '⚠️' }); navigate(data.review_path); return; }
      if (data.already_done) { toast('Already a complete bill — removed.', { icon: '✓' }); setRows((rs) => rs.filter((r) => r.id !== row.id)); return; }
      toast.success(`Routed to ${data.routed_to} — pending approval`);
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      onPendingChange?.();
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setRouting(null); }
  }, [navigate, onPendingChange]);

  const autoRouteAll = useCallback(async () => {
    if (!(await confirm({
      message: 'Auto-route all clean items? Each becomes a DRAFT bill in Pending Approval (needs-vendor / duplicate items stay in the inbox). Nothing is finalised until you approve.',
      confirmLabel: 'Auto-route all',
    }))) return;
    setAutoBusy(true);
    try {
      const { data } = await apiClient.post('/api/import/auto-route/', {});
      toast.success(`Routed ${data.routed} → Pending. ${data.skipped} left in inbox${data.errors ? `, ${data.errors} error(s)` : ''}.`);
      await loadInbox();
      onPendingChange?.();
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setAutoBusy(false); }
  }, [loadInbox, onPendingChange]);

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center gap-2 text-[11px] text-slate-500">
        <span>Sources:</span>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600">Scan</span>
        <span className="ml-auto flex items-center gap-3">
          <span>{rows.length} awaiting routing</span>
          <button onClick={autoRouteAll} disabled={autoBusy || rows.length === 0}
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-3 py-1 rounded-lg bg-indigo-600 text-white disabled:opacity-50">
            {autoBusy ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />} Auto-route all
          </button>
        </span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 gap-2"><Loader2 size={16} className="animate-spin" /> Loading…</div>
      ) : error ? (
        <div className="py-16 text-center text-rose-500 text-sm">{error}</div>
      ) : rows.length === 0 ? (
        <div className="py-16 text-center text-slate-400 text-sm">Nothing waiting — the inbox is clear.</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-white text-[10px] uppercase tracking-wider text-slate-400 text-left border-b border-slate-100">
              <th className="px-3 py-2">Src</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Party</th>
              <th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Type (auto · confirm)</th><th className="px-3 py-2">Route</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const t = picks[r.id] || '';
              return (
                <tr key={r.id} className="hover:bg-primary-50/40 transition-colors">
                  <td className="px-3 py-2"><span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${triageSrcChip(r.source)}`}>{r.source}</span></td>
                  <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{r.date || '—'}</td>
                  <td className="px-3 py-2 font-medium text-slate-800">{r.party}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{triageAmt(r.amount)}</td>
                  <td className="px-3 py-2">
                    <select value={t} onChange={(e) => setPicks((p) => ({ ...p, [r.id]: e.target.value }))}
                      className={`border ${t ? 'border-slate-300' : 'border-amber-400 bg-amber-50'} rounded px-2 py-1 text-xs`}>
                      <option value="">— classify —</option>
                      {TRIAGE_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <button disabled={!t || routing === r.id} onClick={() => doRoute(r, t)}
                      className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg ${t ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}>
                      {routing === r.id ? <><Loader2 size={11} className="animate-spin" /> Routing…</> : <>Route → {t ? (TRIAGE_DEST[t] || '—') : ''} <ArrowRight size={11} /></>}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TriagePending({ pending, loading, reload, onApproved }) {
  const navigate = useNavigate();
  const [approving, setApproving] = useState(null);   // id | 'all'

  const approve = useCallback(async (ids, which) => {
    if (!ids.length) return;
    if (which === 'all' && !(await confirm({
      message: `Approve all ${ids.length} pending bill(s)? They move Draft → Open and appear on the Bills page.`,
      confirmLabel: 'Approve all',
    }))) return;
    setApproving(which);
    try {
      const { data } = await apiClient.post('/api/purchase/bills/approve-all/', { ids });
      toast.success(`Approved ${data.approved} bill(s)`);
      onApproved?.(ids);
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setApproving(null); }
  }, [onApproved]);

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-2 bg-amber-50/60 border-b border-amber-100 flex items-center gap-2 text-[11px] text-amber-700">
        Auto-routed bills (DRAFT) — verify each, then approve. They reach the Bills page only after approval.
        <span className="ml-auto">
          <button onClick={() => approve(pending.map((p) => p.id), 'all')} disabled={approving || pending.length === 0}
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-3 py-1 rounded-lg bg-emerald-600 text-white disabled:opacity-50">
            {approving === 'all' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Approve all
          </button>
        </span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 gap-2"><Loader2 size={16} className="animate-spin" /> Loading…</div>
      ) : pending.length === 0 ? (
        <div className="py-16 text-center text-slate-400 text-sm">Nothing pending — run “Auto-route all” on the Inbox.</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-white text-[10px] uppercase tracking-wider text-slate-400 text-left border-b border-slate-100">
              <th className="px-3 py-2">Date</th><th className="px-3 py-2">Party</th><th className="px-3 py-2">Bill No</th>
              <th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Destination</th><th className="px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pending.map((p) => (
              <tr key={p.id} className="hover:bg-primary-50/40 transition-colors">
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{p.date || '—'}</td>
                <td className="px-3 py-2 font-medium text-slate-800">{p.party}</td>
                <td className="px-3 py-2 font-mono text-slate-500">{p.reference || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">{triageAmt(p.amount)}</td>
                <td className="px-3 py-2 text-slate-600">{p.dest_label}</td>
                <td className="px-3 py-2 flex items-center gap-2">
                  <button onClick={() => navigate(`/purchase/bills/${p.id}`, { state: { backTo: '/import/scan?tab=pending' } })}
                    title="Open the bill with its scanned copy to compare, then come back here"
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
                    <Eye size={11} /> Verify
                  </button>
                  <button onClick={() => approve([p.id], p.id)} disabled={approving === p.id}
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-emerald-600 text-white disabled:opacity-50">
                    {approving === p.id ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Approve
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── Duplicate-scan warning ───────────────────────────────────────────────
 * Shown right after a scan when a just-read bill is already sitting UNCONFIRMED
 * in the inbox (same vendor + bill no + date). Remove deletes the just-scanned
 * copy (keeps the original); Cancel keeps both. */
function DuplicateModal({ dups, onClose, onRemoved }) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await Promise.all(dups.map((d) => apiClient.delete(`/api/purchase/scan/bills/${d.scan_id}/`)));
      toast.success(`Removed ${dups.length} duplicate scan${dups.length > 1 ? 's' : ''}.`);
      onRemoved();
    } catch {
      toast.error('Could not remove the duplicate(s).');
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-slate-900/55 p-4 overflow-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mt-16" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-start gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <h3 className="text-base font-bold text-gray-800">Older duplicate found</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {dups.length === 1 ? 'An older copy of this bill is' : `Older copies of these ${dups.length} bills are`} already
              in the inbox (same vendor, bill no and date). Keep the ones you just scanned and remove the old, or cancel.
            </p>
          </div>
        </div>
        <div className="px-5 py-3 max-h-64 overflow-auto divide-y divide-gray-50">
          {dups.map((d) => (
            <div key={d.scan_id} className="py-2 text-sm">
              <div className="font-semibold text-gray-800">{d.bill_no}</div>
              <div className="text-[12px] text-gray-500">{[d.vendor, d.date].filter(Boolean).join(' · ')}</div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm border border-gray-300 text-gray-600 hover:bg-gray-100">Cancel (keep both)</button>
          <button onClick={remove} disabled={busy}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50 inline-flex items-center gap-1">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Remove old {dups.length > 1 ? 'copies' : 'copy'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Freight → Bill manual link popup ─────────────────────────────────────
 * Shows the bill the written number points to (a suggestion), lets the operator
 * search ALL purchase bills (cross-company, scan-made included), or jump to the
 * Bills page to pick. Confirming attaches the freight to that bill (it then shows
 * on the bill's "Freight attached" card). Automatic matching is disabled for now. */
function FreightLinkModal({ fb, onClose, onLinked, onGotoBills }) {
  const [ref, setRef] = useState('');
  const [suggested, setSuggested] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);   // whole bill object
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    let alive = true;
    apiClient.get(`/api/purchase/scan/link-candidates/${fb.id}/`)
      .then((r) => { if (!alive) return; setRef(r.data?.ref_no || ''); setSuggested(r.data?.suggested || null); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [fb.id]);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      apiClient.get('/api/purchase/scan/bill-search/', { params: { q, include_scan: 1 } })
        .then((r) => { if (alive) setResults(r.data || []); })
        .catch(() => { if (alive) setResults([]); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  const link = async () => {
    if (!selected) return;
    setLinking(true);
    try {
      await apiClient.post(`/api/purchase/scan/bills/${fb.id}/link_bill/`, { bill_id: selected.id });
      toast.success(`Freight ${fb.freight_invoice_no || ''} linked to bill ${selected.bill_no} — shown on that bill.`);
      onLinked();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not link the freight.');
    } finally { setLinking(false); }
  };

  const BillRow = ({ b, badge }) => (
    <button type="button" onClick={() => setSelected(b)}
      className={`w-full text-left flex items-center gap-3 rounded-lg border px-3 py-2.5 transition ${selected?.id === b.id ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300'}`}>
      <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${selected?.id === b.id ? 'border-indigo-500 bg-indigo-500' : 'border-gray-300'}`} />
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-sm text-gray-800">{b.bill_no}
          {badge && <span className="ml-2 text-[10px] font-semibold text-emerald-700 bg-emerald-100 rounded px-1.5 py-0.5">{badge}</span>}</span>
        <span className="block text-[12px] text-gray-500 truncate">{[b.vendor, b.company, b.bill_date].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="font-semibold tabular-nums text-sm text-gray-800">{money(b.total)}</span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-slate-900/55 p-4 overflow-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl mt-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b">
          <div>
            <h3 className="text-base font-bold text-gray-800">Link freight to a purchase bill</h3>
            <p className="text-xs text-gray-500 mt-0.5">Attach this freight slip to the goods bill it belongs to.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 items-center px-5 py-3 bg-teal-50 border-b text-[13px]">
          <span className="font-semibold text-teal-700">🚚 {fb.transporter_name || '—'}</span>
          <span className="text-gray-400">·</span>
          <span>Freight bill <b>{fb.freight_invoice_no || '—'}</b></span>
          <span className="text-gray-400">·</span>
          <span className="tabular-nums">{money(fb.freight_amount)}</span>
          <span className="text-gray-400">·</span>
          <span className="text-gray-600">written ref <code className="bg-black/5 rounded px-1.5 py-0.5 text-[12px]">{ref || '— none —'}</code></span>
        </div>

        <div className="px-5 py-4">
          {loading ? (
            <div className="text-sm text-gray-400 py-4 text-center"><Loader2 size={16} className="inline animate-spin mr-1" /> Finding the suggested bill…</div>
          ) : suggested ? (
            <>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mb-1.5">Suggested from the written number</p>
              <BillRow b={suggested} badge="✓ likely match" />
            </>
          ) : (
            <div className="flex gap-3 items-start rounded-lg border border-amber-200 bg-amber-50 p-3">
              <span>⚠️</span>
              <p className="text-[13px] text-amber-800">No bill matches {ref ? `“${ref}”` : 'this slip'}. Search below, or open the Bills page to pick.</p>
            </div>
          )}

          <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mt-4 mb-1.5">Or search all purchase bills</p>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by bill no, vendor, or amount…"
              className="w-full border rounded-lg pl-8 pr-2 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
          </div>
          <div className="mt-2 space-y-1.5 max-h-52 overflow-auto">
            {q.trim() && results.length === 0 && <div className="text-xs text-gray-400 px-1 py-2">No bills match “{q}”. Try the Bills page →</div>}
            {results.map((b) => <BillRow key={b.id} b={b} badge={b.from_tally ? 'Tally' : null} />)}
          </div>

          <div className="mt-4 pt-3 border-t border-dashed flex flex-wrap gap-2 items-center justify-between text-[13px] text-gray-500">
            <span>Can’t find the bill here?</span>
            <button onClick={onGotoBills} className="text-indigo-600 font-semibold hover:underline inline-flex items-center gap-1">
              Open the Bills page to pick <Link2 size={13} />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t bg-gray-50">
          <span className="text-xs text-gray-500">{selected ? `Selected bill ${selected.bill_no}` : 'No bill selected'}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm border border-gray-300 text-gray-600 hover:bg-gray-100">Cancel</button>
            <button onClick={link} disabled={!selected || linking}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1">
              {linking ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Link to this bill
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Purchase (Tally) voucher types for the Review popup ──────────────────
 * The built-ins are the standard Tally purchase vouchers; operators can add
 * their own via the "+", which now saves to the SERVER (shared across all
 * users) instead of per-browser localStorage. De-dup is case-insensitive, so
 * "GST Purchase" and "gst purchase" can never both exist — first spelling wins.
 */
const BASE_VOUCHER_TYPES = [
  'GST Purchase',
  'GST Purchase-Fruit',
  'Purchase-Bought Note',
  'Journal',
];

// Spend category — matches VendorBill.PURCHASE_CATEGORY_CHOICES (same as Email Inbox).
const CATEGORIES = [
  ['RM', 'RM Purchase'],
  ['PACKING', 'Packing Material'],
  ['FREIGHT', 'Freight / Transport'],
  ['EXPENSES', 'Expenses'],
  ['FRUIT', 'Fruit Purchase'],
  ['LAB_EXPENSE', 'Lab Expense'],
  ['MACHINERY', 'Machinery / Capital'],
];

// Merge built-ins + custom (+ any extras like a bill's already-saved value),
// trimmed and de-duped CASE-INSENSITIVELY. First spelling wins.
function mergeVoucherTypes(...lists) {
  const seen = new Set();
  const out = [];
  for (const t of lists.flat()) {
    const name = (t || '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/* ───────────────────────────── Review modal ───────────────────────────── */
function ReviewModal({ billId, company, onClose, onCommitted, onScanned }) {
  const [b, setB] = useState(null);
  const [saving, setSaving] = useState(false);
  const [gstLoading, setGstLoading] = useState(false);
  const [gstResult, setGstResult] = useState(null);
  // "Link to existing freight" — one transporter slip covering several goods bills.
  const [lfq, setLfq] = useState('');
  const [lfopen, setLfopen] = useState(false);
  const [lfres, setLfres] = useState([]);
  useEffect(() => {
    if (!lfopen || !lfq.trim()) { setLfres([]); return undefined; }
    const t = setTimeout(() => {
      apiClient.get(`/api/purchase/freight/search/?q=${encodeURIComponent(lfq.trim())}`)
        .then((r) => setLfres(r.data.results || []))
        // Report a failed search instead of showing an empty list — see the note
        // in the Email Inbox copy of this search.
        .catch((e) => {
          setLfres([]);
          toast.error(e?.response?.status === 404
            ? 'Freight search is unavailable (endpoint missing). Tell IT.'
            : 'Could not search freight. Check your connection and try again.');
        });
    }, 250);
    return () => clearTimeout(t);
  }, [lfq, lfopen]);
  // "Link to existing bill" — manual search to merge this scan into an existing bill.
  const [lbq, setLbq] = useState('');
  const [lbopen, setLbopen] = useState(false);
  const [lbres, setLbres] = useState([]);
  useEffect(() => {
    if (!lbopen || !lbq.trim()) { setLbres([]); return undefined; }
    const t = setTimeout(() => {
      apiClient.get(`/api/purchase/bills/search/?q=${encodeURIComponent(lbq.trim())}${company ? `&company=${encodeURIComponent(company)}` : ''}`)
        .then((r) => setLbres(r.data.results || []))
        .catch((e) => {
          setLbres([]);
          toast.error(e?.response?.status === 404
            ? 'Bill search is unavailable (endpoint missing). Tell IT.'
            : 'Could not search bills. Check your connection and try again.');
        });
    }, 250);
    return () => clearTimeout(t);
  }, [lbq, lbopen, company]);
  const [remember, setRemember] = useState(true);   // remember matches on confirm
  const [mergeCheck, setMergeCheck] = useState(false);   // manual approve-the-merge gate
  const [mchoice, setMchoice] = useState(undefined);     // operator's pick: undefined=not chosen, null=new bill, id=merge
  const [translating, setTranslating] = useState(false); // "Translate to English" in flight
  // ?slim=1 -> id + vendor_name only. This is a dropdown; the full vendor
  // record is ~1.2 MB and the page uses the name. Opt-in, so every other
  // caller of /api/vendors/ is untouched, and useLookup caches per endpoint
  // string so this cannot contaminate their cache.
  const { options: vendorOptions } = useLookup('/api/vendors/?slim=1', { labelField: 'vendor_name', valueField: 'id' });
  const { options: transporterOptions } = useLookup('/api/transporters/', { labelField: 'name', valueField: 'id' });
  const { options: companyOpts } = useLookup('/api/companies/', { labelField: 'legal_name', valueField: 'id' });
  const isFreight = b?.bill_type === 'FREIGHT';
  // Once freight has been enabled (via the toggle), keep BOTH tabs clickable for
  // the rest of the review — so you can flip Goods<->Freight to verify before
  // confirming without the Freight tab locking you back out.
  const [freightUnlocked, setFreightUnlocked] = useState(false);
  useEffect(() => { if (isFreight) setFreightUnlocked(true); }, [isFreight]);
  const [locations, setLocations] = useState([]);   // warehouses (with nested godowns) for stock intake
  // Freight: "Already in Tally" mode — link to an existing bill instead of creating a new freight record.
  const [freightTally, setFreightTally] = useState(false);
  const [billQuery, setBillQuery] = useState('');
  const [billResults, setBillResults] = useState([]);
  const [billSearching, setBillSearching] = useState(false);
  const [freightUploading, setFreightUploading] = useState(false);   // scanning a new freight PDF from inside the popup
  // Operator-added dropdown options (Purchase type + item-line Charge type) are
  // saved on the SERVER and shared across every user. Reading/selecting is open
  // to all; ADDING one ("+") needs the 'Scan Categories' permission.
  const { canCreate } = usePermissions();
  const canAddType = canCreate('Scan Categories');
  const [purchaseTypeOpts, setPurchaseTypeOpts] = useState([]);   // server-added labels
  const [chargeTypeOpts, setChargeTypeOpts] = useState([]);       // server-added charge labels
  const loadTypeOptions = useCallback(() => {
    apiClient.get('/api/purchase/scan/type-options/')
      .then((r) => {
        const rows = r.data || [];
        setPurchaseTypeOpts(rows.filter((o) => o.kind === 'PURCHASE_TYPE').map((o) => o.label));
        setChargeTypeOpts(rows.filter((o) => o.kind === 'CHARGE_TYPE').map((o) => o.label));
      })
      .catch(() => {});
  }, []);
  useEffect(() => { loadTypeOptions(); }, [loadTypeOptions]);

  // Warehouses + godowns for this company, for the stock-intake dropdowns.
  useEffect(() => {
    if (!company) { setLocations([]); return; }
    apiClient.get('/api/purchase/scan/locations/', { params: { company } })
      .then((r) => setLocations(r.data || []))
      .catch(() => setLocations([]));
  }, [company]);

  // Load fresh detail (includes vendor_candidates). Normalise each line's UOM
  // to an ERP code so the dropdown pre-selects (Kg's → KG).
  useEffect(() => {
    apiClient.get(`/api/purchase/scan/bills/${billId}/`)
      .then((r) => {
        setB({ ...r.data, lines: (r.data.lines || []).map((l) => ({ ...l, uom: normUom(l.uom) })) });
        // A freight bill already linked to a Tally bill opens in "Already in Tally" mode.
        setFreightTally(r.data.bill_type === 'FREIGHT' && !!r.data.matched_bill);
      })
      .catch(() => toast.error('Failed to load bill.'));
  }, [billId]);

  // Preview: fetch the scan as a blob and frame THAT. Django sends
  // X-Frame-Options: DENY on the file, which blocks a direct iframe src — but a
  // blob: URL carries no such header, so it renders.
  //
  // `previewError` exists so a failed fetch is DISTINGUISHABLE from a slow one —
  // without it, both looked identical ("Loading preview…" forever), because the
  // catch cleared previewSrc back to null with no record of what happened.
  const [previewSrc, setPreviewSrc] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewRetryKey, setPreviewRetryKey] = useState(0);
  const fileUrl = b?.document?.file_url || null;
  useEffect(() => {
    setPreviewSrc(null);
    setPreviewError(null);
    if (!fileUrl) return undefined;
    let obj;
    let cancelled = false;

    // In prod the scan lives on R2 at an ABSOLUTE, cross-origin URL. Fetching it
    // as a blob (to bypass X-Frame-Options) needs R2 to answer CORS — which a
    // presigned R2 URL does NOT — so the browser blocks the read and it shows
    // "Couldn't load the scan — network error" (the bug). But an <img>/<iframe>
    // `src` does not need CORS, and R2 serves raw files with no X-Frame-Options,
    // so for an absolute URL we just point the preview STRAIGHT at it. The blob
    // dance is only needed for the dev /media path, where Django sends
    // X-Frame-Options: DENY that a blob: URL sidesteps.
    const isAbsolute = /^https?:\/\//i.test(fileUrl);
    if (isAbsolute) {
      setPreviewSrc(fileUrl);
      return () => { cancelled = true; };
    }

    apiClient.get(fileUrl, { responseType: 'blob' }).then((r) => r.data)
      .then((blob) => {
        if (cancelled) return;
        obj = URL.createObjectURL(blob);
        setPreviewSrc(obj);
      })
      .catch((e) => {
        if (cancelled) return;
        const status = e.status || e.response?.status;
        setPreviewError(
          status ? `Couldn't load the scan (HTTP ${status}).` : "Couldn't load the scan — network error."
        );
      });
    return () => { cancelled = true; if (obj) URL.revokeObjectURL(obj); };
  }, [fileUrl, previewRetryKey]);

  if (!b) {
    return (
      <Modal isOpen onClose={onClose} title="Review invoice" size="full">
        <div className="py-10 text-center text-gray-400"><Loader2 className="animate-spin inline" /> Loading…</div>
      </Modal>
    );
  }

  const setField = (k, v) => setB({ ...b, [k]: v });

  // "+" on the Purchase type dropdown: add a new Tally voucher type. Blocks
  // case-insensitive duplicates (selects the existing spelling instead), and
  // persists the operator's own types per browser.
  const addVoucherType = async () => {
    const name = (window.prompt('New purchase type — type the EXACT Tally voucher name:') || '').trim();
    if (!name) return;
    const known = mergeVoucherTypes(BASE_VOUCHER_TYPES, purchaseTypeOpts);
    const dup = known.find((t) => t.toLowerCase() === name.toLowerCase());
    if (dup) {
      setField('voucher_type', dup);   // already exists (any case) → just select it
      toast(`"${dup}" already exists — selected it.`);
      return;
    }
    try {
      // Saved server-side so EVERY user sees it (was per-browser localStorage).
      await apiClient.post('/api/purchase/scan/type-options/', { kind: 'PURCHASE_TYPE', label: name });
      await loadTypeOptions();
      setField('voucher_type', name);
      toast.success(`Added "${name}" — visible to everyone now.`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not add (you may not have permission).');
    }
  };

  // Add a shared item-line CHARGE type via "+", saved server-side for all users.
  const addChargeType = async (i) => {
    const name = (window.prompt('New charge type name (e.g. Testing, Loading):') || '').trim();
    if (!name) return;
    const dup = ['FREIGHT', 'OTHER', ...chargeTypeOpts].find((t) => t.toLowerCase() === name.toLowerCase());
    if (dup) { setLine(i, 'charge_type', dup); return; }
    try {
      await apiClient.post('/api/purchase/scan/type-options/', { kind: 'CHARGE_TYPE', label: name });
      await loadTypeOptions();
      setLine(i, 'charge_type', name);
      toast.success(`Added "${name}" — visible to everyone now.`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not add (you may not have permission).');
    }
  };

  const setLine = (i, k, v) => {
    const lines = b.lines.map((l, j) => {
      if (j !== i) return l;
      const nl = { ...l, [k]: v };
      // Editing Qty or Rate recomputes Amount = Qty x Rate (the invoice math),
      // instead of leaving the extracted amount stale. Only when BOTH are real
      // numbers, so a charge/lump-sum line (rate blank) keeps its typed amount.
      if (k === 'qty' || k === 'rate') {
        const q = Number(nl.qty), r = Number(nl.rate);
        if (String(nl.qty).trim() !== '' && String(nl.rate).trim() !== ''
            && !Number.isNaN(q) && !Number.isNaN(r)) {
          nl.amount = String(Math.round(q * r * 100) / 100);
        }
      }
      return nl;
    });
    setB({ ...b, lines });
  };
  // Add a row the extractor missed. The GST rate is carried over from the last
  // line because an invoice almost always bills one rate throughout - it saves
  // retyping and is still editable. Everything else starts blank so nothing is
  // invented on the operator's behalf.
  const addLine = () => {
    const prev = (b.lines || [])[(b.lines || []).length - 1] || {};
    const lines = [...(b.lines || []), {
      description: '', hsn: '', qty: '', uom: '', rate: '', discount: '', amount: '',
      gst: prev.gst || '', is_charge: false, charge_type: '', product_id: null,
      _added: true,
    }];
    setB({ ...b, lines });
  };
  const removeLine = (i) => {
    const lines = (b.lines || []).filter((_, j) => j !== i);
    setB({ ...b, lines });
  };
  const itemsTotal = (b.lines || []).reduce((s, l) => s + Number(l.amount || 0), 0);
  // Same state (vendor GSTIN state == company GSTIN state) -> CGST + SGST;
  // different state -> IGST. Reacts as the operator edits the GSTIN.
  const stateOf = (g) => { const s = String(g || '').trim(); return /^\d{2}/.test(s) ? s.slice(0, 2) : ''; };
  const interstate = (() => { const c = stateOf(b.company_gstin), v = stateOf(b.vendor_gstin); return !!(c && v && c !== v); })();
  const half = (g) => { const n = Number(g) || 0; return n ? String(n / 2) : ''; };
  const totalGst = (b.lines || []).reduce((s, l) => s + (Number(l.amount) || 0) * (Number(l.gst) || 0) / 100, 0);
  // Live reconcile: items (ex-GST) + their GST should equal the invoice total.
  // Computed here (not the stale backend b.reconciled flag) so the check badge
  // reacts as the operator fixes a mis-read Qty/Rate/Amount. Advisory only.
  const reconciledLive = (() => {
    const total = Number(b.total_amount) || 0;
    if (!total) return false;
    return Math.abs((itemsTotal + totalGst) - total) <= Math.max(1, total * 0.01);
  })();
  // Godowns inside the chosen warehouse (for the second stock-intake dropdown).
  const godowns = (locations.find((w) => String(w.id) === String(b.warehouse))?.godowns) || [];

  const save = async (extra = {}) => {
    const payload = {
      vendor_name: b.vendor_name, invoice_no: b.invoice_no, invoice_date: b.invoice_date,
      due_date: b.due_date || null,
      subtotal: b.subtotal, tax_amount: b.tax_amount, total_amount: b.total_amount,
      voucher_type: b.voucher_type || '',
      update_stock: !!b.update_stock,
      // Warehouse is a bill-level tag now (carries onto the Vendor Bill) — save it
      // regardless of Update-stock. Godown is only for the stock intake.
      warehouse: b.warehouse || null,
      godown: b.update_stock ? (b.godown || null) : null,
      // Drop a row that was added and never filled in. Only a completely
      // untouched one goes - description, qty, rate and amount all empty -
      // which an extracted line never is, because the extractor always writes
      // at least qty "1". Without this a forgotten blank row becomes a blank
      // line on the bill at confirm.
      lines: (b.lines || []).filter((l) => !(
        !String(l.description || '').trim() && !String(l.qty || '').trim()
        && !String(l.rate || '').trim() && !String(l.amount || '').trim()
      )),
      bill_type: b.bill_type || 'GOODS',
      freight_target: b.freight_target || 'INWARD',
      freight_amount: b.freight_amount || 0,
      // GROSS model + DC (branch transfer) — mirrors the Email Inbox.
      freight_tds: b.freight_tds || 0,
      freight_roundoff: b.freight_roundoff || 0,
      freight_weight_charge: b.freight_weight_charge || 0,
      is_dc: !!b.is_dc,
      dc_no: b.dc_no || '', dc_from: b.dc_from || '', dc_to: b.dc_to || '',
      dc_material: b.dc_material || '', dc_value: b.dc_value || 0,
      freight_invoice_no: b.freight_invoice_no || '',
      freight_ref_no: b.freight_ref_no || '',
      freight_invoice_date: b.freight_invoice_date || null,
      tds_amount: b.tds_amount || 0,
      category: b.category || '',
      transporter: b.transporter || null,
      transporter_name: b.transporter_name || '',
      lorry_no: b.lorry_no || '',
      link_freight: b.link_freight || null,
      ...(b.matched_vendor ? { matched_vendor: b.matched_vendor } : {}),
      ...extra,
    };
    const r = await apiClient.patch(`/api/purchase/scan/bills/${billId}/`, payload);
    setB(r.data);
    return r.data;
  };

  // Picking / changing the vendor must re-check THAT vendor's existing bills
  // right away — the merge candidates + matched bill are vendor-scoped, so
  // without this the review keeps the scan-time "no related bill" and the
  // operator can silently create a duplicate. Saving returns the recomputed
  // candidate_bills / matched_bill, which setB() then shows.
  const pickVendor = async (v) => {
    setField('matched_vendor', v);
    try { await save({ matched_vendor: v || null }); }
    catch { toast.error('Could not re-check existing bills for this vendor.'); }
  };

  const lookupGstin = async () => {
    setGstLoading(true); setGstResult(null);
    try {
      const r = await apiClient.get('/api/purchase/scan/gstin/', { params: { gstin: b.vendor_gstin } });
      setGstResult(r.data);
    } catch (err) {
      setGstResult({ found: false, error: err?.response?.data?.detail || 'Lookup failed.' });
    } finally { setGstLoading(false); }
  };

  const createVendor = async () => {
    try {
      const r = await apiClient.post(`/api/purchase/scan/bills/${billId}/create_vendor/`, { vendor_name: b.vendor_name });
      setB(r.data);
      toast.success(`Vendor "${b.vendor_name}" created & mapped.`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not create vendor.');
    }
  };

  // Switch Goods ⇆ Freight — PATCH so the backend auto-matches the transporter.
  const changeBillType = async (v) => {
    try {
      // Non-destructive: the switch only flips bill_type. The goods total and the
      // freight amount live in SEPARATE fields (total_amount vs freight_amount),
      // so toggling never mutates either — goods total is preserved exactly.
      const r = await apiClient.patch(`/api/purchase/scan/bills/${billId}/`, { bill_type: v });
      setB({ ...r.data, lines: (r.data.lines || []).map((l) => ({ ...l, uom: normUom(l.uom) })) });
    } catch { toast.error('Could not switch type.'); }
  };

  // Freight "Pick from Tally": search existing bills, and link/unlink the picked one.
  const searchBills = async (q) => {
    setBillQuery(q);
    if (!q.trim()) { setBillResults([]); return; }
    setBillSearching(true);
    try {
      const r = await apiClient.get('/api/purchase/scan/bill-search/', { params: { company, q } });
      setBillResults(r.data || []);
    } catch { setBillResults([]); } finally { setBillSearching(false); }
  };
  const linkTallyBill = async (row) => {
    try {
      const r = await apiClient.patch(`/api/purchase/scan/bills/${billId}/`, { matched_bill: row ? row.id : null });
      setB({ ...r.data, lines: (r.data.lines || []).map((l) => ({ ...l, uom: normUom(l.uom) })) });
      if (row) { setBillResults([]); setBillQuery(''); toast.success(`Linked to ${row.bill_no}.`); }
    } catch { toast.error('Could not link the bill.'); }
  };

  // Attach the picked freight bill as THIS bill's document (replace it) — shown
  // in the preview HERE, in place. No new bill (no duplicate) and no AI re-read
  // (no cost). The operator fills the freight amount / TDS below.
  const scanFreightFiles = async (list) => {
    const arr = Array.from(list || []).filter((f) => /\.(pdf|png|jpe?g|webp)$/i.test(f.name));
    if (!arr.length) return;
    setFreightUploading(true);
    const fd = new FormData();
    fd.append('file', arr[0]);
    try {
      const r = await apiClient.post(`/api/purchase/scan/bills/${billId}/replace_freight_doc/`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000,
      });
      setB({ ...r.data, lines: (r.data.lines || []).map((l) => ({ ...l, uom: normUom(l.uom) })) });
      toast.success('Freight bill attached — shown on the left.');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not attach the freight bill.');
    } finally { setFreightUploading(false); }
  };

  const createTransporter = async () => {
    const nm = b.transporter_name || b.vendor_name;
    try {
      // Persist the edited transporter name first, then create from it.
      await save();
      const r = await apiClient.post(`/api/purchase/scan/bills/${billId}/create_transporter/`, { transporter_name: nm });
      setB(r.data);
      toast.success(`Transporter "${nm}" created & mapped.`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not create transporter.');
    }
  };

  // The HEADER fields are compulsory (except HSN). The item LINES are optional —
  // fill them if you have them, but they never block a confirm. Returns the list
  // of what still needs filling (empty = good to confirm).
  const missingFields = () => {
    const blank = (v) => v === undefined || v === null || String(v).trim() === '';
    const pos = (v) => Number(v) > 0;       // must be a value > 0
    const need = [];
    if (b.bill_type === 'FREIGHT') {
      // Freight advice needs only a transporter. The freight bill no / date /
      // amount are optional (blank until the transporter's slip is scanned).
      if (!b.transporter) need.push('Transporter');
      return need;
    }
    if (!b.matched_vendor) need.push('Vendor (ERP master)');
    if (blank(b.vendor_name)) need.push('Vendor on invoice');
    if (blank(b.invoice_no)) need.push('Invoice no');
    if (blank(b.invoice_date)) need.push('Invoice date');
    if (!pos(b.subtotal)) need.push('Taxable');
    if (blank(b.tax_amount)) need.push('GST');          // 0 allowed (exempt), but must be filled
    if (!pos(b.total_amount)) need.push('Total');
    if (blank(b.voucher_type)) need.push('Purchase type');
    // Stock posting is disabled for now, so Warehouse/Godown are NOT required to
    // confirm. The fields stay visible + saved for when stock update is turned on.
    return need;
  };

  const confirm = async (replace = false, approvedMerge = false, ignoreDuplicate = false) => {
    const need = missingFields();
    if (need.length) {
      toast.error(`Fill everything except HSN first — missing: ${need.slice(0, 4).join(' · ')}${need.length > 4 ? ` +${need.length - 4} more` : ''}`);
      return;
    }
    // MANUAL CHECK: if this scan matches an existing (Tally) bill, pause and make
    // the operator approve the merge before anything is written. Nothing merges
    // until they click the button in the gate below — but PRE-SELECT whatever the
    // inline picker at the top already shows (matched bill → that merge row; no
    // match → "new bill") so the operator isn't forced to pick the same thing twice.
    // Freight bills never merge into a goods bill — skip the merge gate.
    if (b.bill_type !== 'FREIGHT' && !approvedMerge) { setMchoice(b.matched_bill ?? null); setMergeCheck(true); return; }
    setSaving(true);
    try {
      await save();
      const res = await apiClient.post(`/api/purchase/scan/bills/${billId}/confirm/`, { replace, remember, ignore_duplicate: ignoreDuplicate });
      // A detected duplicate now comes back as a normal 200 with this flag (not a
      // 4xx error) — same merge choice as before, minus the scary red console
      // error. Offer MERGE first, then "separate", then skip.
      if (res?.data?.needs_merge_choice) {
        const dup = res.data.duplicate_bill;
        if (dup?.id && window.confirm(`${res.data.detail}\n\nClick OK to MERGE this scan into ${dup.bill_no} — keeps ONE bill, no duplicate. Click Cancel if it is a genuinely DIFFERENT bill.`)) {
          await setMatchedBill(dup.id);
          return confirm(false, true);   // matched_bill now set -> merges
        }
        if (window.confirm('Create it as a SEPARATE new bill instead?\n\nClick OK to create a separate bill. Click Cancel to skip (do nothing).')) {
          return confirm(false, true, true);
        }
        return;   // operator cancelled both — nothing written
      }
      toast.success(b.bill_type === 'FREIGHT'
        ? 'Freight bill confirmed — attached to its purchase bill.'
        : 'Item lines written to the bill.');
      onCommitted();
    } catch (err) {
      const d = err?.response?.data;
      const msg = d?.detail || d?.error
        || (typeof d === 'string' ? d : '')
        || err?.message || 'Confirm failed.';
      // TWO guards say "already has" and they need OPPOSITE remedies. Matching
      // both with one test offered "create a separate bill" for a refused MERGE,
      // which produced the very duplicate the merge existed to prevent.
      if (/already has\s+\d+\s+line/i.test(msg)) {
        // MERGE guard: the target bill already carries lines. On a bill that came
        // from Tally that is the import's summary line, and replacing it with the
        // scanned breakdown is the point of merging - the scan holds the products,
        // Tally holds the money.
        if (window.confirm(`${msg}\n\nClick OK to REPLACE the existing line(s) with the scanned ones. Click Cancel to skip.`)) {
          return confirm(true, true, ignoreDuplicate);
        }
      } else if (/already has/i.test(msg)) {
        // DUPLICATE guard: this scan matches an existing bill. The usual right move
        // is to MERGE the scan into it — attach the scanned items + PDF, keep ONE
        // bill (shows "Scan + Tally"), NO duplicate — so offer that FIRST when the
        // backend tells us which bill it is. Only if she says it is a genuinely
        // DIFFERENT bill (transport/freight vendors legitimately bill the same
        // amount repeatedly) do we fall through to create-separate / skip.
        const dup = d?.duplicate_bill;
        if (dup?.id && window.confirm(`${msg}\n\nClick OK to MERGE this scan into ${dup.bill_no} — keeps ONE bill, no duplicate. Click Cancel if it is a genuinely DIFFERENT bill.`)) {
          await setMatchedBill(dup.id);
          return confirm(false, true);   // matched_bill now set -> merges, same as the picker
        }
        if (window.confirm('Create it as a SEPARATE new bill instead?\n\nClick OK to create a separate bill. Click Cancel to skip (do nothing).')) {
          return confirm(false, true, true);
        }
      } else {
        toast.error(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  // Manually set / clear which existing bill this scan matches (null = new bill).
  const setMatchedBill = async (targetBillId) => {
    try {
      const r = await apiClient.patch(`/api/purchase/scan/bills/${billId}/`, { matched_bill: targetBillId });
      setB({ ...r.data, lines: (r.data.lines || []).map((l) => ({ ...l, uom: normUom(l.uom) })) });
    } catch { toast.error('Could not update the match.'); }
  };

  // Re-run the AI pre-fill (Purchase type / Category / Warehouse) on this bill.
  // Fills only blanks — a manual pick is never overwritten.
  const rerunSuggest = async () => {
    try {
      const r = await apiClient.patch(`/api/purchase/scan/bills/${billId}/`, { rerun_suggest: true });
      setB({ ...r.data, lines: (r.data.lines || []).map((l) => ({ ...l, uom: normUom(l.uom) })) });
      toast.success('Re-applied AI pre-fill (warehouse / type / category).');
    } catch { toast.error('Could not re-run suggestions.'); }
  };

  // Translate the item-line descriptions to English (for a bill scanned before the
  // English extraction, or a regional-script one). Updates only the descriptions.
  const translateLines = async () => {
    setTranslating(true);
    try {
      const r = await apiClient.patch(`/api/purchase/scan/bills/${billId}/`, { translate_lines: true });
      setB({ ...r.data, lines: (r.data.lines || []).map((l) => ({ ...l, uom: normUom(l.uom) })) });
      toast.success('Lines translated to English.');
    } catch { toast.error('Could not translate the lines.'); } finally { setTranslating(false); }
  };

  // "Not the same bill" — clear the auto-match so a NEW separate bill is created.
  const keepSeparate = async () => {
    setMergeCheck(false);
    try { await save({ matched_bill: null }); } catch { /* surfaced on confirm */ }
    confirm(false, true);
  };

  const doc = b.document || {};
  const isPdf = /pdf/i.test(doc.content_type || '') || /\.pdf($|\?)/i.test(fileUrl || '');
  // Jump the PDF viewer to THIS invoice's first page (multi-bill PDFs).
  const pageHash = isPdf ? `#page=${b.page_start}` : '';
  // Embedded viewer: hide the browser PDF chrome — toolbar=0 drops the
  // edit/print/download/zoom bar and navpanes=0 the thumbnail strip — so the
  // panel is just the scanned page to scroll and compare against the fields.
  const embedHash = isPdf ? `#page=${b.page_start}&toolbar=0&navpanes=0&scrollbar=1` : '';

  return (
    <Modal
      isOpen onClose={onClose} size="screen" closeLeft
      title={`Review — ${b.vendor_name || 'invoice'} ${b.invoice_no ? `· ${b.invoice_no}` : ''}`}
      footer={
        <div className="flex items-center justify-between w-full">
          <div className="text-xs">
            {isFreight ? (
              <>Freight payable <b className="tabular-nums">₹{money((Number(b.freight_amount) || 0) + (Number(b.freight_weight_charge) || 0) - (Number(b.freight_tds) || 0) - (Number(b.freight_roundoff) || 0))}</b> <span className="text-gray-400">→ {b.freight_target === 'LOCAL' ? 'Local' : 'Inward'} Freight</span></>
            ) : (
              <>Items ∑ <b className="tabular-nums">₹{money(itemsTotal)}</b> vs total <b className="tabular-nums">₹{money(b.total_amount)}</b>{' '}
              {reconciledLive ? <span className="text-green-600">✓ reconciles</span> : <span className="text-amber-600">⚠ check</span>}</>
            )}
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none" title="Save the vendor & product matches so the same names auto-map next time">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember these matches
            </label>
            <Button variant="outline" onClick={() => apiClient.post(`/api/purchase/scan/bills/${billId}/skip/`).then(onCommitted)}>Skip</Button>
            <Button variant="outline" onClick={() => save().then(() => toast.success('Saved.'))}>Save</Button>
            <Button onClick={() => confirm(false)} disabled={saving} icon={saving ? Loader2 : CheckCircle2}>
              {saving ? 'Writing…' : 'Confirm & write lines'}
            </Button>
          </div>
        </div>
      }
    >
      {mergeCheck && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 p-4" onClick={() => setMergeCheck(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={18} className="text-indigo-600 shrink-0" />
              <h3 className="text-base font-bold text-slate-800">Related bill check</h3>
            </div>
            <p className="text-sm text-slate-700">
              Is this the same as an existing bill? <b>You must choose</b> — nothing is created or merged until you pick.
            </p>
            <div className="mt-3">
              <div className="max-h-48 overflow-auto rounded border border-slate-200 divide-y divide-slate-50">
                <button type="button" onClick={() => setMchoice(null)}
                  className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-slate-50 ${mchoice === null ? 'bg-blue-50' : ''}`}>
                  <span className={`w-3.5 h-3.5 rounded-full border shrink-0 ${mchoice === null ? 'border-blue-500 bg-blue-500' : 'border-slate-300'}`} />
                  <span className="font-medium text-slate-700">No — create a new separate bill</span>
                </button>
                {(b.candidate_bills || []).map((c) => {
                  const sel = mchoice === c.id;
                  return (
                    <button type="button" key={c.id} onClick={() => setMchoice(c.id)}
                      className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-slate-50 ${sel ? 'bg-blue-50' : c.recommended ? 'bg-amber-50/60' : ''}`}>
                      <span className={`w-3.5 h-3.5 rounded-full border shrink-0 ${sel ? 'border-blue-500 bg-blue-500' : 'border-slate-300'}`} />
                      <span className="text-slate-500 shrink-0">Merge into</span>
                      <span className="font-medium text-slate-800 shrink-0">{c.invoice_no || c.bill_no}</span>
                      <span className="text-slate-400 shrink-0">{c.bill_date ? new Date(c.bill_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : ''}</span>
                      {c.recommended && <span className="text-[9px] uppercase tracking-wide bg-amber-100 text-amber-700 rounded px-1 shrink-0">★ same bill</span>}
                      {c.invoice_match
                        ? <span className="text-[9px] uppercase tracking-wide bg-blue-100 text-blue-700 rounded px-1 shrink-0">invoice no ✓</span>
                        : <span className="text-[9px] uppercase tracking-wide bg-emerald-100 text-emerald-700 rounded px-1 shrink-0">same amount + date</span>}
                      <span className="ml-auto tabular-nums text-slate-700 shrink-0">₹{money(c.total)}</span>
                    </button>
                  );
                })}
              </div>
              {(!b.candidate_bills || b.candidate_bills.length === 0) && (
                <p className="mt-1 text-[11px] text-slate-400">No related bill found for this vendor — pick <b>No — create a new bill</b>.</p>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setMergeCheck(false)}
                className="px-3 py-2 rounded-lg text-sm border border-slate-300 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button
                onClick={async () => { setMergeCheck(false); await setMatchedBill(mchoice ?? null); confirm(false, true); }}
                disabled={saving || mchoice === undefined}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {mchoice === undefined ? 'Choose an option above' : mchoice === null ? 'Create new bill & write' : 'Merge & write lines'}
              </button>
            </div>
          </div>
        </div>
      )}
      {!isFreight && b.matched_bill_info && (
        <div className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-xs">
          <div className="flex items-center gap-2 font-semibold text-indigo-900">
            <Link2 size={14} className="text-indigo-600" />
            Matches existing bill {b.matched_bill_info.invoice_no || b.matched_bill_info.bill_no}
            {b.matched_bill_info.from_tally && (
              <span className="text-[10px] uppercase tracking-wide bg-indigo-100 text-indigo-700 rounded px-1.5 py-0.5">from Tally</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-indigo-800">
            <span>Bill total: <b className="tabular-nums">₹{money(b.matched_bill_info.total)}</b></span>
            {b.matched_bill_info.is_paid
              ? <span className="text-emerald-700 font-medium">✓ Paid ₹{money(b.matched_bill_info.paid)}{b.matched_bill_info.payment_date ? ` on ${new Date(b.matched_bill_info.payment_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}</span>
              : <span className="text-amber-700">Not yet paid</span>}
          </div>
          <div className="mt-1.5 text-[11px] text-indigo-700 leading-snug">
            On <b>Confirm</b>, this stays as <b>one</b> bill — your scanned products and invoice date{b.invoice_date ? ` (${new Date(b.invoice_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })})` : ''} are added to it, and its Paid status is kept. No duplicate is created.
          </div>
        </div>
      )}
      {b.duplicate && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-center gap-2">
          <AlertTriangle size={14} /> <span>{b.duplicate} Confirming again may create a duplicate — consider <b>Skip</b>.</span>
        </div>
      )}

      {/* Company (buyer) + the "is this one of this vendor's bills?" picker, side
          by side to save height. Company defaults to the batch company; change it
          only if THIS bill is for another company (re-scopes vendor + bill). The
          picker shows the vendor's bills so the operator can verify the auto-match
          or pick the right one — "No — new bill" leaves it to create a fresh one. */}
      {(() => {
        const showPicker = !isFreight && b.matched_vendor && b.candidate_bills && b.candidate_bills.length > 0;
        return (
      <div className={`mb-3 grid gap-3 items-start ${showPicker ? 'lg:grid-cols-2' : ''}`}>
        <div className="flex flex-col gap-3 min-w-0">
          <div className="rounded-lg border-2 border-indigo-300 bg-slate-50 px-3 py-2">
            <label className="block text-[11px] font-medium text-gray-500 mb-0.5">Company (buyer)</label>
            <CustomSelect value={b.company || b.batch_company || ''} title="Company"
              onChange={(e) => { const v = e.target.value || null; setField('company', v); save({ company: v }).then(() => toast.success('Company changed — vendor re-checked.')).catch(() => toast.error('Could not change the company.')); }}>
              {companyOpts.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
            <p className="text-[10px] text-gray-400 mt-0.5">Scanned under <b>{b.batch_company_name || '—'}</b> — change only if this bill is for another company.</p>
          </div>
          {/* Link to existing bill — tucked under Company to keep the row compact. */}
          {!isFreight && (
            <div className="rounded-lg border-2 border-indigo-300 bg-white px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">Not listed above? Search any existing bill to merge this scan into it.</div>
                <button type="button" onClick={() => setLbopen((o) => !o)}
                  className="text-[11px] font-medium border border-indigo-300 text-indigo-700 bg-white rounded-md px-2 py-0.5 hover:bg-indigo-50 shrink-0">
                  <Search size={11} className="inline -mt-0.5" /> Link to existing bill
                </button>
              </div>
              {lbopen && (
                <div className="mt-2">
                  <input autoFocus value={lbq} onChange={(e) => setLbq(e.target.value)}
                    placeholder="Company name / invoice no / GSTIN / date (YYYY-MM-DD)"
                    className="w-full border border-slate-300 rounded-md px-2 py-1 text-xs" />
                  {lbres.length > 0 && (
                    <div className="mt-1 max-h-56 overflow-auto rounded-md border border-slate-200 divide-y divide-slate-100">
                      {lbres.map((c) => {
                        const paid = Number(c.amount_paid) || 0;
                        const total = Number(c.total) || 0;
                        const paidLabel = paid <= 0 ? 'Unpaid (open)' : paid >= total ? `Fully paid ₹${money(paid)}` : `Part paid ₹${money(paid)} of ₹${money(total)}`;
                        return (
                          <button type="button" key={c.id}
                            onClick={() => { setMatchedBill(c.id); setLbopen(false); setLbq(''); }}
                            className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-semibold text-slate-800">{c.invoice_no || c.bill_no}</span>
                              {c.vendor_name && <span className="text-slate-500">· {c.vendor_name}</span>}
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              {c.gstin ? `${c.gstin} · ` : ''}Bill date {c.bill_date ? new Date(c.bill_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                              {' · '}Total <b className="text-slate-700">₹{money(c.total)}</b>
                              {' · '}<span className={paid > 0 ? 'text-emerald-700 font-medium' : 'text-amber-600 font-medium'}>{paidLabel}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {lbq.trim() && lbres.length === 0 && <p className="text-[11px] text-slate-400 mt-1">No bills match “{lbq}”.</p>}
                </div>
              )}
            </div>
          )}
        </div>
        {showPicker && (
        <div className="rounded-lg border-2 border-indigo-300 bg-white min-w-0">
          <div className="px-3 py-2 border-b border-slate-100">
            <div className="text-xs font-semibold text-slate-700">Is this invoice already one of this vendor&apos;s bills?</div>
            <div className="text-[11px] text-slate-400">Pick the matching bill to merge into it — or choose the first option to create a brand‑new bill.</div>
          </div>
          <div className="max-h-56 overflow-auto divide-y divide-slate-100">
            <button type="button" onClick={() => setMatchedBill(null)}
              className={`w-full text-left px-3 py-2 text-xs flex items-start gap-2.5 hover:bg-slate-50 ${!b.matched_bill ? 'bg-blue-50' : ''}`}>
              <span className={`mt-0.5 w-3.5 h-3.5 rounded-full border shrink-0 ${!b.matched_bill ? 'border-blue-500 bg-blue-500' : 'border-slate-300'}`} />
              <span>
                <div className="font-medium text-slate-700">No — this is a new bill</div>
                <div className="text-[11px] text-slate-400">Create a fresh bill from this scan.</div>
              </span>
            </button>
            {b.candidate_bills.map((c) => {
              const sel = String(b.matched_bill || '') === String(c.id);
              const paid = Number(c.amount_paid) || 0;
              const total = Number(c.total) || 0;
              const paidLabel = paid <= 0 ? 'Unpaid (open)'
                : paid >= total ? `Fully paid ₹${money(paid)}`
                : `Part paid ₹${money(paid)} of ₹${money(total)}`;
              return (
                <button type="button" key={c.id} onClick={() => setMatchedBill(c.id)}
                  className={`w-full text-left px-3 py-2 text-xs flex items-start gap-2.5 hover:bg-slate-50 ${sel ? 'bg-blue-50' : c.recommended ? 'bg-amber-50/60' : ''}`}>
                  <span className={`mt-0.5 w-3.5 h-3.5 rounded-full border shrink-0 ${sel ? 'border-blue-500 bg-blue-500' : 'border-slate-300'}`} />
                  <span className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-slate-500">Merge into bill</span>
                      <span className="font-semibold text-slate-800">{c.invoice_no || c.bill_no}</span>
                      {c.recommended && <span className="text-[9px] uppercase tracking-wide bg-amber-100 text-amber-700 rounded px-1">★ same bill</span>}
                      {c.invoice_match
                        ? <span className="text-[9px] uppercase tracking-wide bg-blue-100 text-blue-700 rounded px-1">invoice no ✓</span>
                        : <span className="text-[9px] uppercase tracking-wide bg-emerald-100 text-emerald-700 rounded px-1">same amount + date</span>}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Bill date {c.bill_date ? new Date(c.bill_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                      {' · '}Total <b className="text-slate-700">₹{money(c.total)}</b>
                      {' · '}<span className={paid > 0 ? 'text-emerald-700 font-medium' : 'text-amber-600 font-medium'}>{paidLabel}</span>
                    </div>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        )}
      </div>
        );
      })()}

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Scan preview */}
        <div className="min-h-[300px] bg-gray-50 rounded-lg border overflow-hidden flex flex-col">
          {previewSrc
            ? (isPdf
              ? <iframe title="scan" src={`${previewSrc}${embedHash}`} className="w-full flex-1 min-h-[420px]" />
              : <img alt="scan" src={previewSrc} className="w-full object-contain max-h-[420px]" />)
            : previewError
              ? (
                <div className="p-8 text-center text-sm flex-1 flex flex-col items-center justify-center gap-2">
                  <span className="text-red-500">{previewError}</span>
                  <button
                    onClick={() => setPreviewRetryKey((k) => k + 1)}
                    className="text-indigo-600 hover:underline text-xs font-medium"
                  >
                    Retry
                  </button>
                </div>
              )
              : <div className="p-8 text-center text-gray-400 text-sm flex-1">{fileUrl ? 'Loading preview…' : 'No preview'}</div>}
          <div className="px-3 py-1.5 text-[11px] text-gray-400 border-t flex items-center justify-between">
            <span className="truncate">{doc.original_name} · pages {b.page_start}–{b.page_end}</span>
            {/* Opens the blob we already fetched, NOT the API path: a new tab is
                a plain navigation carrying no Authorization header, so linking
                the (authenticated) file endpoint straight would just 401. */}
            {previewSrc && <a href={`${previewSrc}${pageHash}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline whitespace-nowrap ml-2">Open ↗</a>}
          </div>
        </div>

        {/* Extracted data */}
        <div className="space-y-3">
          {/* Bill mode — a segmented tab: goods bill vs freight bill. GOODS is the
              default; FREIGHT creates a freight record instead of a vendor bill. */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="inline-flex bg-gray-100 border border-gray-200 rounded-lg p-0.5 gap-0.5">
              <button type="button" onClick={() => changeBillType('GOODS')}
                className={`px-3 py-1.5 rounded-md text-sm font-semibold transition ${!isFreight ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                Goods bill
              </button>
              {/* Disabled until the "separate freight bill" toggle is first ticked
                  (no landing on freight by mis-clicking). Once unlocked it stays
                  clickable so you can flip both ways to verify before confirming. */}
              <button type="button" onClick={() => changeBillType('FREIGHT')} disabled={!freightUnlocked}
                title={!freightUnlocked ? 'Tick “This is a separate freight bill” below to switch' : ''}
                className={`px-3 py-1.5 rounded-md text-sm font-semibold transition inline-flex items-center gap-1.5 ${isFreight ? 'bg-white text-teal-700 shadow-sm' : (freightUnlocked ? 'text-gray-500 hover:text-gray-700' : 'text-gray-300 cursor-not-allowed')}`}>
                🚚 Freight bill
              </button>
            </div>
            <span className="text-[11px] text-gray-400">{isFreight ? '→ lines become routes; nothing to stock or the item master' : 'normal purchase bill'}</span>
          </div>

          {isFreight && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
              <div className="text-[11px] text-amber-800">Freight bill — the lines are <b>routes, not products</b> (nothing added to the item master).</div>

              {/* THIS scanned document IS the freight bill — it's already read and
                  attaches to the Inward Freight advice on confirm (no need to
                  re-scan). You can optionally scan a DIFFERENT freight PDF. */}
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5">
                {freightUploading ? (
                  <div className="text-xs text-gray-500 inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Reading freight bill…</div>
                ) : (
                  <div className="flex items-center gap-2">
                    <FileText size={15} className="text-emerald-600 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-emerald-800 truncate">📎 {doc.original_name}</div>
                      <div className="text-[10px] text-emerald-700/80"><b>Shown on the left ←</b> This freight bill attaches to the Inward Freight advice on confirm.</div>
                    </div>
                    <label className="text-[11px] text-indigo-600 font-medium cursor-pointer hover:underline shrink-0 whitespace-nowrap">
                      scan a different one
                      <input type="file" multiple accept=".pdf,image/*" className="hidden"
                        onChange={(e) => scanFreightFiles(e.target.files)} />
                    </label>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-medium text-gray-500 mb-0.5">Transporter on bill (extracted)</label>
                  <input value={b.transporter_name || ''} onChange={(e) => setField('transporter_name', e.target.value)}
                    placeholder="e.g. Anjen Enterprises" className="w-full border rounded px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-gray-500 mb-0.5">Transporter — ERP master<span className="text-rose-500"> *</span></label>
                  <CustomSelect value={b.transporter || ''} onChange={(e) => setField('transporter', e.target.value)} title="Transporter">
                    <option value="">{b.transporter_master_name ? b.transporter_master_name : '— not mapped —'}</option>
                    {transporterOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </CustomSelect>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-gray-500 mb-0.5">Lorry / vehicle no</label>
                  <input value={b.lorry_no || ''} onChange={(e) => setField('lorry_no', e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {!b.transporter && (b.transporter_candidates || []).length > 0 && <span className="text-[11px] text-gray-400">Suggestions:</span>}
                {!b.transporter && (b.transporter_candidates || []).map((c) => (
                  <button key={c.id} onClick={() => setField('transporter', c.id)}
                    className="text-[11px] bg-indigo-50 text-indigo-700 rounded px-2 py-0.5 hover:bg-indigo-100">{c.name}</button>
                ))}
                <button onClick={createTransporter}
                  className="text-[11px] bg-emerald-50 text-emerald-700 rounded px-2 py-0.5 hover:bg-emerald-100 inline-flex items-center gap-1">
                  <FilePlus2 size={11} /> Create “{b.transporter_name || b.vendor_name || 'new'}” as transporter
                </button>
              </div>

              {/* Where this freight lands + GROSS money model (mirrors Email Inbox):
                  Payable = freight + weight − TDS − round-off. LOCAL unlocks the DC
                  section. Weight = an optional weighment charge some slips add. */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-medium text-gray-500 mb-0.5">Lands on</label>
                  <CustomSelect value={b.freight_target || 'INWARD'} title="Freight target"
                    onChange={(e) => { setField('freight_target', e.target.value); save({ freight_target: e.target.value }).catch(() => {}); }}>
                    <option value="INWARD">Inward Freight</option>
                    <option value="LOCAL">Local Freight</option>
                  </CustomSelect>
                </div>
                <Field label="Weight charge" value={b.freight_weight_charge} onChange={(v) => setField('freight_weight_charge', v)} />
                <Field label="TDS" value={b.freight_tds} onChange={(v) => setField('freight_tds', v)} />
                <Field label="Round-off (±)" value={b.freight_roundoff} onChange={(v) => setField('freight_roundoff', v)} />
              </div>
              <div className="text-[12px] text-amber-900">Payable <b className="tabular-nums">₹{money((Number(b.freight_amount) || 0) + (Number(b.freight_weight_charge) || 0) - (Number(b.freight_tds) || 0) - (Number(b.freight_roundoff) || 0))}</b> <span className="text-gray-400">= freight{Number(b.freight_weight_charge) ? ' + weight' : ''} − TDS − round-off</span></div>

              {/* DC / branch transfer — LOCAL freight only. Goods value is reference
                  only (never booked); only the freight is money. Toggling on pre-fills
                  the blanks from the parse (server), then the reviewer confirms. */}
              {b.freight_target === 'LOCAL' && (
                <div className="rounded-lg border border-indigo-200 bg-white p-2.5 space-y-2">
                  <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer select-none">
                    <input type="checkbox" checked={!!b.is_dc}
                      onChange={(e) => { const on = e.target.checked; setField('is_dc', on); save({ is_dc: on }).catch(() => {}); }}
                      className="mt-0.5 w-4 h-4" />
                    <span>This is a <b>DC / branch transfer</b> (internal delivery challan)
                      <span className="block text-[11px] text-gray-400">Goods value is reference only — never booked. Only the freight is money.</span></span>
                  </label>
                  {b.is_dc && (<>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="DC no" value={b.dc_no} onChange={(v) => setField('dc_no', v)} />
                      <Field label="Goods value (ref only)" value={b.dc_value} onChange={(v) => setField('dc_value', v)} />
                      <Field label="From" value={b.dc_from} onChange={(v) => setField('dc_from', v)} />
                      <Field label="To" value={b.dc_to} onChange={(v) => setField('dc_to', v)} />
                    </div>
                    <Field label="Material" value={b.dc_material} onChange={(v) => setField('dc_material', v)} />
                  </>)}
                </div>
              )}
            </div>
          )}

          {/* Vendor: extracted name (from invoice)  +  ERP master mapping (hidden for freight) */}
          <div className={isFreight ? 'hidden' : ''}>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-0.5">Vendor on invoice (extracted)<span className="text-rose-500"> *</span></label>
                <input value={b.vendor_name || ''} onChange={(e) => setField('vendor_name', e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-sm" />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-0.5">Vendor — ERP master<span className="text-rose-500"> *</span></label>
                <CustomSelect value={b.matched_vendor || ''} onChange={(e) => pickVendor(e.target.value)} title="Vendor">
                  <option value="">{b.matched_vendor_name ? b.matched_vendor_name : '— not mapped —'}</option>
                  {vendorOptions.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                </CustomSelect>
              </div>
            </div>

            {/* Vendor suggestions + create-new — belong under the VENDOR field,
                NOT under GSTIN. */}
            <div className="flex flex-wrap items-center gap-1 mt-1.5">
              {!b.matched_vendor && b.vendor_candidates?.length > 0 && <span className="text-[11px] text-gray-400">Suggestions:</span>}
              {!b.matched_vendor && (b.vendor_candidates || []).map((c) => (
                <button key={c.id} onClick={() => pickVendor(c.id)}
                  className="text-[11px] bg-indigo-50 text-indigo-700 rounded px-2 py-0.5 hover:bg-indigo-100">
                  {c.name}
                </button>
              ))}
              <button onClick={createVendor}
                className="text-[11px] bg-emerald-50 text-emerald-700 rounded px-2 py-0.5 hover:bg-emerald-100 inline-flex items-center gap-1">
                <FilePlus2 size={11} /> Create “{b.vendor_name || 'new'}” as new vendor
              </button>
            </div>

            {/* GSTIN + official-name lookup — ONLY the lookup result shows here */}
            <div className="mt-2 flex items-end gap-2">
              <div className="flex-1">
                <label className="block text-[11px] font-medium text-gray-500 mb-0.5">GSTIN (extracted)</label>
                <input value={b.vendor_gstin || ''} onChange={(e) => setField('vendor_gstin', e.target.value.toUpperCase())}
                  placeholder="15-char GSTIN" className="w-full border rounded px-2 py-1.5 text-sm font-mono" />
              </div>
              <button onClick={lookupGstin} disabled={gstLoading || (b.vendor_gstin || '').length !== 15}
                className="inline-flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-40 whitespace-nowrap">
                <Search size={12} /> {gstLoading ? 'Looking…' : 'Get name from GSTIN'}
              </button>
            </div>
            {gstResult && (
              <div className="mt-1 text-[11px]">
                {gstResult.found ? (
                  <span className="text-emerald-700">
                    Govt: <b>{gstResult.legal_name}</b>
                    {gstResult.trade_name ? ` (${gstResult.trade_name})` : ''} · {gstResult.status}
                    <button onClick={() => setField('vendor_name', gstResult.legal_name)}
                      className="ml-2 text-indigo-600 underline">use this name</button>
                  </span>
                ) : (
                  <span className="text-amber-600">{gstResult.error}</span>
                )}
              </div>
            )}
          </div>

          {/* Link to an EXISTING shared freight — one transporter slip covering
              several goods bills (goods bill only). */}
          {!isFreight && (
            <div className="rounded-lg border border-teal-200 bg-teal-50/60 p-2.5">
              {b.link_freight ? (
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[12px] text-teal-800">🚚 Linked to freight <b>{b.link_freight_no}</b>{b.link_freight_transporter ? ` · ${b.link_freight_transporter}` : ''} — joins that shared slip on confirm.</span>
                  <button onClick={() => { setField('link_freight', null); save({ link_freight: null }).catch(() => {}); }} className="text-[11px] text-slate-500 hover:text-rose-600 underline shrink-0">unlink</button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-[12px] font-medium text-teal-800">🚚 This bill's freight is on a slip already in the system?</span>
                    <button type="button" onClick={() => setLfopen((o) => !o)} className="text-[11px] font-medium border border-teal-300 text-teal-700 bg-white rounded-md px-2 py-0.5 hover:bg-teal-50 shrink-0"><Search size={11} className="inline -mt-0.5" /> Link to existing freight</button>
                  </div>
                  {lfopen && (
                    <div>
                      <input autoFocus className="w-full border rounded px-2 py-1.5 text-sm" value={lfq} onChange={(e) => setLfq(e.target.value)} placeholder="Search freight no / transporter / amount…" />
                      {lfres.length > 0 && (
                        <div className="mt-1 bg-white border border-slate-200 rounded-lg shadow-sm max-h-56 overflow-auto">
                          {lfres.map((fa) => (
                            <div key={fa.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-slate-50 last:border-0">
                              <div className="min-w-0">
                                <div className="text-[12px] font-semibold text-slate-800 truncate">{fa.advice_no} · {fa.transporter_name || '—'}{fa.freight_no ? ` · no ${fa.freight_no}` : ''}</div>
                                <div className="text-[11px] text-slate-500 truncate">already covers {fa.covered_count} bill{fa.covered_count === 1 ? '' : 's'}</div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-[12px] tabular-nums font-medium text-slate-700">₹{money(fa.base_amount)}</span>
                                <button onClick={() => { setField('link_freight', fa.id); setB((p) => ({ ...p, link_freight: fa.id, link_freight_no: fa.advice_no, link_freight_transporter: fa.transporter_name })); setLfopen(false); setLfq(''); save({ link_freight: fa.id }).then(() => toast.success(`Linked to ${fa.advice_no}`)).catch(() => toast.error('Could not link.')); }} className="text-[11px] font-medium bg-teal-600 text-white rounded-md px-2 py-1 hover:bg-teal-700">Merge into this</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {lfq.trim() && lfres.length === 0 && <p className="text-[11px] text-slate-400 mt-1">No freight matches “{lfq}”.</p>}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {/* Freight has its OWN invoice no/date (blank until the freight bill is
                scanned); goods uses the goods invoice fields. */}
            {isFreight ? (
              <Field label="Freight bill no" value={b.freight_invoice_no} onChange={(v) => setField('freight_invoice_no', v)} placeholder="from the transporter's bill" />
            ) : (
              <Field label="Invoice no" required value={b.invoice_no} onChange={(v) => setField('invoice_no', v)} />
            )}
            {isFreight ? (
              <Field label="Freight bill date" value={b.freight_invoice_date || ''} onChange={(v) => setField('freight_invoice_date', v)} placeholder="YYYY-MM-DD" />
            ) : (
              <Field label="Invoice date" required value={b.invoice_date || ''} onChange={(v) => setField('invoice_date', v)} placeholder="YYYY-MM-DD" />
            )}
            {/* Payment due date for the bill. Auto-filled from the invoice's
                printed due date if the scan read one, or left blank to be
                computed from the vendor's credit days at Confirm; editable. */}
            {!isFreight && (
              <Field label="Due date" value={b.due_date || ''} placeholder="YYYY-MM-DD"
                onChange={(v) => {
                  // A due date before the invoice date is invalid — reject it.
                  if (v && b.invoice_date && v.length >= 10 && v < b.invoice_date) {
                    toast.error('Due date cannot be before the invoice date.');
                    return;
                  }
                  setField('due_date', v);
                }} />
            )}
            {/* Tax split is goods-only. A freight advice stores a single payable
                figure (no CGST/SGST breakdown), so freight shows just the Total. */}
            {!isFreight && (
              <Field label="Taxable" required value={b.subtotal} onChange={(v) => setField('subtotal', v)} />
            )}
            {/* Split to match the line-item table below: same-state bills show
                CGST + SGST separately, interstate bills show one IGST box.
                `tax_amount` stays the single combined value on save either way —
                only the display splits, same doubling trick as the line table. */}
            {!isFreight && (interstate ? (
              <Field label="IGST" required value={b.tax_amount} onChange={(v) => setField('tax_amount', v)} />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Field label="CGST" required value={half(b.tax_amount)}
                  onChange={(v) => setField('tax_amount', String((Number(v) || 0) * 2))} />
                <Field label="SGST" required value={half(b.tax_amount)}
                  onChange={(v) => setField('tax_amount', String((Number(v) || 0) * 2))} />
              </div>
            ))}
            {isFreight ? (
              <Field label="Freight (gross)" required value={b.freight_amount} onChange={(v) => setField('freight_amount', v)} />
            ) : (
              <Field label="Total" required value={b.total_amount} onChange={(v) => setField('total_amount', v)} />
            )}
            {/* Map the freight to the goods bill by the invoice no written on the
                slip (auto-read + manual). Links the Freight Advice to that bill. */}
            {isFreight && (
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-0.5">Freight is for bill (invoice no)</label>
                <input value={b.freight_ref_no || ''} onChange={(e) => setField('freight_ref_no', e.target.value)}
                  onBlur={() => save().catch(() => {})}
                  placeholder="goods bill no written on the slip"
                  className="w-full border rounded px-2 py-1.5 text-sm" />
                {b.freight_linked_bill_no
                  ? <div className="text-[11px] text-emerald-700 mt-0.5">🔗 Links to bill <b>{b.freight_linked_bill_no}</b></div>
                  : (b.freight_ref_no ? <div className="text-[11px] text-amber-600 mt-0.5">No matching bill yet — links on confirm if found.</div> : null)}
              </div>
            )}
            {/* Goods-bill TDS. A freight bill has its OWN TDS (in the freight card
                above, GROSS model) so it isn't shown twice. */}
            {!isFreight && (
              <Field label="TDS (deducted)" value={b.tds_amount} onChange={(v) => setField('tds_amount', v)} />
            )}
            {!isFreight && (
            <div>
              <label className="block text-[11px] font-medium text-gray-500 mb-0.5">
                Purchase type<span className="text-rose-500"> *</span> <span className="text-gray-400">(for Tally reconcile)</span>
              </label>
              <div className="flex items-center gap-1.5">
                <CustomSelect value={b.voucher_type || ''} title="Purchase type"
                  onChange={(e) => setField('voucher_type', e.target.value)} className="flex-1">
                  <option value="">— select —</option>
                  {/* built-ins + operator-added, plus this bill's own saved value
                      if it isn't in the list — so it never shows blank. */}
                  {mergeVoucherTypes(BASE_VOUCHER_TYPES, purchaseTypeOpts, b.voucher_type ? [b.voucher_type] : [])
                    .map((t) => <option key={t} value={t}>{t}</option>)}
                </CustomSelect>
                {canAddType && (
                  <button type="button" onClick={addVoucherType} title="Add a new purchase type (shared with everyone)"
                    className="shrink-0 w-8 h-[34px] flex items-center justify-center border rounded text-lg leading-none text-gray-600 hover:bg-gray-100">
                    +
                  </button>
                )}
              </div>
            </div>
            )}
            {/* Spend category — written to the bill (VendorBill.purchase_category).
                Leave blank to let the auto-classifier decide on confirm. */}
            {!isFreight && (
            <div>
              <label className="block text-[11px] font-medium text-gray-500 mb-0.5">
                Category <span className="text-gray-400">(spend group)</span>
              </label>
              <CustomSelect value={b.category || ''} title="Category"
                onChange={(e) => setField('category', e.target.value)}>
                <option value="">— auto (classify on confirm) —</option>
                {CATEGORIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </CustomSelect>
            </div>
            )}
          </div>

          {/* Freight toggle — mirrors the Goods/Freight tab at the top so the
              operator can flag a separate freight bill right by the amounts.
              Both controls drive the same bill_type, so they stay in sync. */}
          <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer select-none">
            <input type="checkbox" checked={freightUnlocked}
              onChange={(e) => { if (e.target.checked) { setFreightUnlocked(true); changeBillType('FREIGHT'); } else { setFreightUnlocked(false); changeBillType('GOODS'); } }}
              className="mt-0.5 w-4 h-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500" />
            <span>
              This is a <b>separate freight bill</b> (transporter slip)
              <span className="block text-[11px] text-gray-400">Creates an Inward Freight advice — no products, no stock.</span>
            </span>
          </label>
        </div>
      </div>

      {!isFreight && (<>
      {/* Warehouse + the stock-intake toggle on one line — the warehouse this
          bill's goods are for (carries onto the Vendor Bill) and whether to
          receive stock. The Godown picker drops below when stock is on. */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[220px]">
          <div className="flex items-center justify-between mb-0.5">
            <label className="block text-[11px] font-medium text-gray-500">Warehouse</label>
            <button type="button" onClick={rerunSuggest}
              className="text-[11px] font-medium text-blue-600 hover:text-blue-800">↻ Auto-detect warehouse / type</button>
          </div>
          <CustomSelect
            value={b.warehouse || ''}
            title="Warehouse"
            onChange={(e) => setB({ ...b, warehouse: e.target.value || null, godown: null })}
          >
            <option value="">— select warehouse —</option>
            {locations.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}{w.type === 'FACTORY' ? ' (Factory)' : ''}{w.code ? ` · ${w.code}` : ''}
              </option>
            ))}
          </CustomSelect>
        </div>
        <label className="flex items-center gap-2 h-[34px] px-3 border rounded-lg bg-gray-50 text-sm font-medium text-gray-700 cursor-pointer select-none shrink-0"
          title="Off for a transport / service bill with no goods">
          <input
            type="checkbox"
            checked={!!b.update_stock}
            onChange={(e) => setField('update_stock', e.target.checked)}
          />
          Update stock
          <span className="hidden sm:inline text-[11px] font-normal text-gray-400">(goods received)</span>
        </label>
      </div>
      {/* Godown — where the received goods land (uses the Warehouse above). */}
      {b.update_stock && (
        <div className="mt-2 border rounded-lg bg-gray-50 px-3 py-2.5">
          <label className="block text-[11px] font-medium text-gray-500 mb-0.5">Godown</label>
          <CustomSelect
            value={b.godown || ''}
            title="Godown"
            onChange={(e) => setField('godown', e.target.value || null)}
            disabled={!b.warehouse}
          >
            <option value="">{b.warehouse ? '— select godown —' : 'pick a warehouse above first'}</option>
            {godowns.map((g) => (
              <option key={g.id} value={g.id}>{g.name}{g.code ? ` · ${g.code}` : ''}</option>
            ))}
          </CustomSelect>
          {!b.warehouse && <p className="text-[11px] text-amber-600 mt-1">Pick a Warehouse above to receive stock.</p>}
        </div>
      )}

      {/* Line items */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs font-semibold text-gray-600">Item lines</div>
          <button type="button" onClick={translateLines} disabled={translating}
            className="text-[11px] font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50">
            {translating ? 'Translating…' : '🌐 Translate to English'}
          </button>
        </div>
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase text-gray-500 border-b bg-gradient-to-r from-primary-50/70 to-sky-50/40">
                <th className="px-3 py-2 min-w-[220px]">Product on invoice (extracted)</th>
                <th className="px-3 py-2 w-24">HSN</th>
                <th className="px-3 py-2 w-24 text-right">Qty</th>
                <th className="px-3 py-2 w-20">UOM</th>
                <th className="px-3 py-2 w-28 text-right">Rate</th>
                <th className="px-3 py-2 w-20 text-right">Disc%</th>
                <th className="px-3 py-2 w-32 text-right">Amount</th>
                {interstate ? (
                  <th className="px-3 py-2 w-20 text-right">IGST%</th>
                ) : (
                  <>
                    <th className="px-3 py-2 w-20 text-right">CGST%</th>
                    <th className="px-3 py-2 w-20 text-right">SGST%</th>
                  </>
                )}
                <th className="px-3 py-2 w-24 text-center">Product?</th>
                <th className="px-3 py-2 w-56">ERP product (master)</th>
                <th className="px-2 py-2 w-8" aria-label="Remove line"></th>
              </tr>
            </thead>
            <tbody>
              {(b.lines || []).map((l, i) => (
                <tr key={i} className="border-b last:border-0 align-top">
                  <td className="px-2 py-1.5"><input className="w-full border border-gray-200 rounded px-2 py-1.5" value={l.description || ''} onChange={(e) => setLine(i, 'description', e.target.value)} /></td>
                  <td className="px-2 py-1.5"><input className="w-full border border-gray-200 rounded px-2 py-1.5" value={l.hsn || ''} onChange={(e) => setLine(i, 'hsn', e.target.value)} /></td>
                  <td className="px-2 py-1.5">
                    {/* qty_assumed = the bill printed no quantity we could read or
                        derive, so it fell back to 1. Flagged instead of hidden —
                        a silently-wrong qty goes straight into stock. */}
                    <input className={`w-full rounded px-2 py-1.5 text-right border ${l.qty_assumed ? 'border-amber-400 bg-amber-50' : 'border-gray-200'}`}
                      value={l.qty || ''} onChange={(e) => setLine(i, 'qty', e.target.value)}
                      title={l.qty_assumed ? 'No quantity found on the bill — check this' : undefined} />
                    {l.qty_assumed && <div className="text-[10px] text-amber-600 mt-0.5 text-right">check qty</div>}
                  </td>
                  <td className="px-2 py-1.5">
                    <select className="w-full border border-gray-200 rounded px-2 py-1.5 bg-white"
                      value={l.uom || ''} onChange={(e) => setLine(i, 'uom', e.target.value)}>
                      <option value="">—</option>
                      {l.uom && !UOM_CODES.includes(l.uom) && <option value={l.uom}>{l.uom}</option>}
                      {UOM_CODES.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1.5"><input className="w-full border border-gray-200 rounded px-2 py-1.5 text-right" value={l.rate || ''} onChange={(e) => setLine(i, 'rate', e.target.value)} /></td>
                  <td className="px-2 py-1.5"><input className="w-full border border-gray-200 rounded px-2 py-1.5 text-right" value={l.discount || ''} onChange={(e) => setLine(i, 'discount', e.target.value)} placeholder="0" /></td>
                  <td className="px-2 py-1.5"><input className="w-full border border-gray-200 rounded px-2 py-1.5 text-right" value={l.amount || ''} onChange={(e) => setLine(i, 'amount', e.target.value)} /></td>
                  {interstate ? (
                    <td className="px-2 py-1.5"><input className="w-full border border-gray-200 rounded px-2 py-1.5 text-right" value={l.gst || ''} onChange={(e) => setLine(i, 'gst', e.target.value)} /></td>
                  ) : (
                    <>
                      <td className="px-2 py-1.5"><input className="w-full border border-gray-200 rounded px-2 py-1.5 text-right" value={half(l.gst)} onChange={(e) => setLine(i, 'gst', String((Number(e.target.value) || 0) * 2))} /></td>
                      <td className="px-2 py-1.5"><input className="w-full border border-gray-200 rounded px-2 py-1.5 text-right" value={half(l.gst)} onChange={(e) => setLine(i, 'gst', String((Number(e.target.value) || 0) * 2))} /></td>
                    </>
                  )}
                  <td className="px-2 py-1.5 text-center">
                    {/* Off = this line is a charge (freight, packing, …), not a
                        product: no item-master entry, no bill line — the amount
                        still counts, it just lands in the bill's Other charges. */}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!l.is_charge}
                      title={l.is_charge
                        ? 'Charge only — no product will be created; the amount still counts'
                        : 'A product will be created / mapped for this line'}
                      onClick={() => setLine(i, 'is_charge', !l.is_charge)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${!l.is_charge ? 'bg-indigo-600' : 'bg-gray-200'}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${!l.is_charge ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </td>
                  <td className="px-2 py-1.5">
                    {l.is_charge
                      ? (
                        <div className="flex items-center gap-1">
                          <select
                            className="w-full border border-gray-200 rounded px-2 py-1.5 bg-white text-xs"
                            value={l.charge_type || 'FREIGHT'}
                            onChange={(e) => setLine(i, 'charge_type', e.target.value)}
                          >
                            <option value="FREIGHT">Freight charge</option>
                            <option value="OTHER">Other charge</option>
                            {chargeTypeOpts.map((c) => <option key={c} value={c}>{c}</option>)}
                            {/* keep this line's own value selectable if it isn't in the list yet */}
                            {l.charge_type && !['FREIGHT', 'OTHER', ...chargeTypeOpts].includes(l.charge_type)
                              && <option value={l.charge_type}>{l.charge_type}</option>}
                          </select>
                          {canAddType && (
                            <button type="button" onClick={() => addChargeType(i)} title="Add a new charge type (shared with everyone)"
                              className="shrink-0 w-6 h-6 flex items-center justify-center border rounded text-sm leading-none text-gray-500 hover:bg-gray-100">
                              +
                            </button>
                          )}
                        </div>
                      )
                      : <LineProduct line={l} company={company} onPick={(pid) => setLine(i, 'product_id', pid)} onName={(v) => setLine(i, 'product_name', v)}
                          onCreateNew={async (name) => {
                            // Create the item master NOW and map this line to it —
                            // both fields set in ONE update (setLine reads a stale
                            // copy, so two calls would clobber each other).
                            try {
                              const r = await apiClient.post(`/api/purchase/scan/bills/${billId}/create_product/`,
                                { name, uom: l.uom || '', description: l.description || '' });
                              setB((p) => ({ ...p, lines: p.lines.map((ln, j) => (j === i ? { ...ln, product_id: r.data.id, product_name: r.data.name } : ln)) }));
                              toast.success(`Product "${r.data.name}" created & mapped.`);
                              return r.data;
                            } catch (e) {
                              toast.error(e?.response?.data?.detail || 'Could not create product.');
                              return null;
                            }
                          }} />}
                  </td>
                  <td className="px-1 py-1.5 text-center align-middle">
                    <button
                      type="button"
                      onClick={() => removeLine(i)}
                      title="Remove this line"
                      className="w-6 h-6 inline-flex items-center justify-center rounded text-gray-300 hover:text-rose-600 hover:bg-rose-50"
                    >
                      &times;
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* The extractor misses rows on some layouts; this keys the rest in. */}
        <button
          type="button"
          onClick={addLine}
          className="mt-1.5 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-dashed
                     border-gray-300 text-xs font-medium text-gray-600 hover:border-indigo-400
                     hover:text-indigo-600 hover:bg-indigo-50/40"
        >
          + Add product line
        </button>
        <div className="flex items-center justify-between mt-1.5">
          <p className="text-[11px] text-gray-400">
            Unmapped products are auto-created in the item master on confirm. Turn <b>Product?</b> off for a
            freight/charge line — its amount still counts toward the total, but no product is created.
            Nothing is written until you click Confirm.
          </p>
          <div className="text-xs text-gray-600 whitespace-nowrap">
            <span className="text-gray-400 mr-1">Total GST:</span>
            <b className="tabular-nums">₹{money(totalGst)}</b>
            <span className="text-gray-400 ml-1">
              {interstate
                ? `(IGST ₹${money(totalGst)})`
                : `(CGST ₹${money(totalGst / 2)} + SGST ₹${money(totalGst / 2)})`}
            </span>
          </div>
        </div>
      </div>
      </>)}
    </Modal>
  );
}

function Field({ label, value, onChange, placeholder, required }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-gray-500 mb-0.5">
        {label}{required && <span className="text-rose-500"> *</span>}
      </label>
      <input value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="w-full border rounded px-2 py-1 text-sm" />
    </div>
  );
}

/** Per-line product mapper. Opens a POPUP that shows matching item-master
 *  products AND where each was already used (which bills) — so the operator can
 *  confirm it's an existing product before mapping, or create a new one. The
 *  chosen product drives what name the stock posts under. */
function LineProduct({ line, company, onPick, onName, onCreateNew }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(line.description || '');
  const [sug, setSug] = useState([]);
  const [inlineSug, setInlineSug] = useState([]);   // best matches shown in the row
  const [loading, setLoading] = useState(false);
  const [choice, setChoice] = useState(undefined);   // undefined=none · 'new' · product id
  const [picked, setPicked] = useState(line.product_id ? { name: '(mapped)' } : null);
  const [keepNew, setKeepNew] = useState(false);
  // Name the new master will be created as — editable before creating so the
  // operator can clean up the vendor's raw text. Defaults to the scanned name.
  const [newName, setNewName] = useState(line.product_name || line.description || '');
  const [creating, setCreating] = useState(false);

  // Debounced search whenever the popup is open and the query changes.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      apiClient.get('/api/purchase/scan/product-search/', { params: { q, company } })
        .then((r) => { if (alive) setSug(r.data || []); })
        .catch(() => { if (alive) setSug([]); })
        .finally(() => { if (alive) setLoading(false); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [open, q, company]);

  // While the line is still unmapped, fetch the best item-master matches for the
  // scanned description up front and surface them inline (as one-click chips) —
  // so the operator maps with a single click instead of opening the popup.
  const unmapped = !picked && !keepNew && !line.product_id;
  useEffect(() => {
    if (!unmapped) return undefined;
    const desc = (line.description || '').trim();
    if (!desc) { setInlineSug([]); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      apiClient.get('/api/purchase/scan/product-search/', { params: { q: desc, company } })
        .then((r) => { if (alive) setInlineSug((r.data || []).slice(0, 2)); })
        .catch(() => { if (alive) setInlineSug([]); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [unmapped, line.description, company]);

  const pickInline = (s) => { onPick(s.id); setPicked({ name: s.name }); setKeepNew(false); };

  const openModal = () => {
    setQ(line.description || '');
    setNewName(line.product_name || line.description || '');
    setChoice(undefined); setOpen(true);
  };

  const apply = async () => {
    if (choice === 'new') {
      // Create the master NOW (immediate), map this line to it, and close.
      const nm = (newName || line.description || '').trim();
      if (!nm) return;
      setCreating(true);
      const prod = await onCreateNew?.(nm);
      setCreating(false);
      if (!prod) return;                        // failed → keep the popup open
      setPicked({ name: prod.name }); setKeepNew(false);
    } else if (choice) {
      const s = sug.find((x) => x.id === choice);
      onPick(choice); setPicked({ name: s?.name || '(mapped)' }); setKeepNew(false);
    }
    setOpen(false);
  };

  const trigger = (() => {
    if (picked && line.product_id) {
      return (
        <div className="flex items-center gap-1">
          <span className="inline-flex items-center gap-1 text-emerald-700 text-xs truncate max-w-[150px]">
            <CheckCircle2 size={12} />{picked.name}
          </span>
          <button className="text-gray-400 hover:text-indigo-600 text-[11px] underline" onClick={openModal}>change</button>
          <button className="text-gray-400 hover:text-red-500" onClick={() => { setPicked(null); onPick(null); }}><X size={12} /></button>
        </div>
      );
    }
    if (keepNew) {
      return (
        <div className="flex items-center gap-1">
          <FilePlus2 size={12} className="text-blue-700 shrink-0" />
          {/* Editable master name — defaults to the scanned name; edit to create a
              clean master. The bill line keeps the vendor's text. */}
          <input
            value={line.product_name ?? line.description ?? ''}
            onChange={(e) => onName?.(e.target.value)}
            placeholder="master product name"
            title="Name this product will be created as in the master"
            className="border border-blue-200 rounded px-1.5 py-0.5 text-xs w-40 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <button className="text-[11px] text-gray-400 hover:text-indigo-600 underline shrink-0" onClick={openModal}>change</button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        {inlineSug.map((s) => (
          <button key={s.id} type="button" onClick={() => pickInline(s)}
            title={`Map to ${s.name}${s.times_used ? ` · used in ${s.times_used} bill${s.times_used > 1 ? 's' : ''}` : ''}`}
            className="inline-flex items-center gap-1 text-[11px] rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 px-2 py-0.5 hover:bg-emerald-100 max-w-[170px]">
            <CheckCircle2 size={11} className="shrink-0" />
            <span className="truncate">{s.name}</span>
          </button>
        ))}
        <button onClick={openModal} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline">
          <Search size={12} /> {inlineSug.length ? 'Other / new' : 'Map / new'}
        </button>
      </div>
    );
  })();

  return (
    <>
      {trigger}
      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-base font-bold text-slate-800">Map product</h3>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              On the invoice: <b className="text-slate-700">{line.description || '—'}</b>. Pick the existing product it matches
              (stock posts under that name), or create it new.
            </p>

            <div className="relative mb-2">
              <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search the item master…"
                className="w-full border rounded-lg pl-8 pr-2 py-2 text-sm"
              />
            </div>

            <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 divide-y divide-slate-50">
              {loading && <div className="p-3 text-xs text-slate-400">Searching…</div>}
              {!loading && sug.length === 0 && (
                <div className="p-3 text-xs text-slate-400">No match in the item master — create it as a new product below.</div>
              )}
              {sug.map((s) => {
                const sel = choice === s.id;
                return (
                  <button type="button" key={s.id} onClick={() => setChoice(s.id)}
                    className={`w-full text-left px-3 py-2 flex gap-2 hover:bg-indigo-50/60 ${sel ? 'bg-indigo-50' : ''}`}>
                    <span className={`mt-0.5 w-3.5 h-3.5 rounded-full border shrink-0 ${sel ? 'border-indigo-500 bg-indigo-500' : 'border-slate-300'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-medium text-slate-800 text-sm truncate">{s.name}</span>
                        {s.sku && <span className="text-[10px] text-slate-400 shrink-0">{s.sku}</span>}
                      </span>
                      <span className="flex items-center gap-1.5 mt-0.5">
                        {s.times_used > 0
                          ? <span className="text-[10px] uppercase tracking-wide bg-emerald-100 text-emerald-700 rounded px-1">Used in {s.times_used} bill{s.times_used > 1 ? 's' : ''}</span>
                          : <span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1">Not used yet</span>}
                        {s.uom && <span className="text-[10px] text-slate-400">UOM {s.uom}</span>}
                      </span>
                      {(s.recent || []).length > 0 && (
                        <span className="block text-[11px] text-slate-500 mt-1 truncate">
                          {s.recent.map((r, ri) => (
                            <span key={ri}>{ri ? ' · ' : ''}{r.bill_no}{r.date ? ` (${r.date})` : ''}</span>
                          ))}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}

              {/* Create-new option */}
              <button type="button" onClick={() => setChoice('new')}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-emerald-50/60 ${choice === 'new' ? 'bg-emerald-50' : ''}`}>
                <span className={`w-3.5 h-3.5 rounded-full border shrink-0 ${choice === 'new' ? 'border-emerald-500 bg-emerald-500' : 'border-slate-300'}`} />
                <FilePlus2 size={13} className="text-emerald-600 shrink-0" />
                <span className="text-sm text-emerald-700">Create new product — <b>{line.description || 'unnamed'}</b></span>
              </button>

              {/* Editable master name — shown once "Create new" is chosen. The bill
                  line keeps the vendor's exact text; this is what the master is
                  created as, right now (not deferred to Confirm). */}
              {choice === 'new' && (
                <div className="px-3 py-2 bg-emerald-50/40">
                  <label className="block text-[10px] uppercase tracking-wide text-emerald-700 mb-1">Create as (master name)</label>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="product master name"
                    className="w-full border border-emerald-200 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setOpen(false)}
                className="px-3 py-2 rounded-lg text-sm border border-slate-300 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={apply} disabled={choice === undefined || creating}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {creating ? 'Creating…' : choice === 'new' ? 'Create & add' : 'Keep & add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
