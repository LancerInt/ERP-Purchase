/**
 * E-Way Bill vs E-Invoice check (outward supplies).
 *
 * Upload the two GST-portal downloads for a period and see where they disagree:
 * a dispatch that was e-invoiced but never e-way-billed, an e-way bill with no
 * IRN, or amounts that do not tie. Read-only — nothing is filed or generated.
 *
 * Backend: /api/sales/ewb-einvoice/*
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '../../../components/ui/CustomSelect';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import {
  UploadCloud, Loader2, CheckCircle2, AlertTriangle, FileX2, FileWarning,
  Ban, Truck, ReceiptText, Trash2, ChevronRight, ChevronDown, Download,
  X, ShieldCheck, RefreshCw, Factory, Plus, Info,
} from 'lucide-react';
import usePagerKeys from '../../../hooks/usePagerKeys.js';

const money = (v) => Number(v || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const PAGE_SIZE = 15;

/* Buckets. The first four are exceptions — real work; the rest are expected
   gaps, kept visible so the position stays auditable. */
const EXCEPTION_TABS = [
  { key: 'MISSING_EWB', label: 'E-way bill missing', field: 'missing_ewb', icon: FileX2,
    cls: 'text-red-600', tint: 'bg-red-50 border-red-300 ring-1 ring-red-200' },
  { key: 'MISSING_EINV', label: 'E-invoice missing', field: 'missing_einvoice', icon: FileWarning,
    cls: 'text-orange-600', tint: 'bg-orange-50 border-orange-300 ring-1 ring-orange-200' },
  { key: 'MISMATCH', label: 'Amount mismatch', field: 'mismatch', icon: AlertTriangle,
    cls: 'text-amber-600', tint: 'bg-amber-50 border-amber-300 ring-1 ring-amber-200' },
  { key: 'CANCELLED', label: 'Cancellation mismatch', field: 'cancelled_conflict', icon: Ban,
    cls: 'text-rose-600', tint: 'bg-rose-50 border-rose-300 ring-1 ring-rose-200' },
];
const OK_TABS = [
  { key: 'MATCHED', label: 'Matched', field: 'matched', icon: CheckCircle2,
    cls: 'text-green-600', tint: 'bg-green-50 border-green-300' },
  { key: 'BELOW_THRESHOLD', label: 'Below threshold', field: 'below_threshold', icon: ReceiptText,
    cls: 'text-slate-500', tint: 'bg-slate-50 border-slate-300' },
  { key: 'CHALLAN_ONLY', label: 'Delivery challans', field: 'challan_only', icon: Truck,
    cls: 'text-slate-500', tint: 'bg-slate-50 border-slate-300' },
  { key: 'EX_FACTORY', label: 'Ex-factory', field: 'ex_factory', icon: Factory,
    cls: 'text-sky-600', tint: 'bg-sky-50 border-sky-300' },
];
const ALL_TABS = [...EXCEPTION_TABS, ...OK_TABS];

/* Buckets where the ex-factory checkbox is meaningful: a missing e-way bill is
   the thing ex-factory explains, and the ex-factory bucket itself so a mark can
   be undone. Everywhere else the column would be noise. */
const SHOWS_EX_FACTORY = new Set(['MISSING_EWB', 'EX_FACTORY']);

/** One of the two upload slots. Defined at module scope so picking a file does
 *  not remount the input and drop the browser's selection. */
function FileBox({ label, hint, file, onPick, accept }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-500">{label}</label>
      <label className={`flex cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm transition
        ${file ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-300 text-gray-500 hover:border-indigo-300'}`}>
        <UploadCloud size={16} />
        <span className="truncate">{file ? file.name : 'Choose file…'}</span>
        <input type="file" accept={accept} className="hidden"
          onChange={(e) => onPick(e.target.files?.[0] || null)} />
      </label>
      <p className="mt-1 text-[11px] text-gray-400">{hint}</p>
    </div>
  );
}

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

/** Difference cell — blank when the two portals agree. */
function Diff({ value }) {
  const n = Number(value || 0);
  if (!n) return <span className="text-gray-300">—</span>;
  return (
    <span className={`font-semibold tabular-nums ${n > 0 ? 'text-red-600' : 'text-blue-600'}`}>
      {n > 0 ? '+' : '−'}₹{money(Math.abs(n))}
    </span>
  );
}

/**
 * The flag the user asked for: as soon as a check finishes, say plainly what is
 * missing or not tying, rather than leaving it to be noticed in a table.
 */
function ExceptionDialog({ summary, onClose, onGoTo }) {
  if (!summary) return null;
  const clean = summary.exceptions === 0;
  const buckets = EXCEPTION_TABS.filter((t) => summary[t.field] > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-start gap-3 rounded-t-2xl px-5 py-4 ${clean ? 'bg-green-50' : 'bg-red-50'}`}>
          {clean
            ? <ShieldCheck className="text-green-600 shrink-0" size={22} />
            : <AlertTriangle className="text-red-600 shrink-0" size={22} />}
          <div className="flex-1">
            <h3 className={`font-semibold ${clean ? 'text-green-800' : 'text-red-800'}`}>
              {clean
                ? `${summary.period} reconciles cleanly`
                : `${summary.exceptions} item${summary.exceptions === 1 ? '' : 's'} need attention in ${summary.period}`}
            </h3>
            <p className="text-xs text-gray-600 mt-0.5">
              {summary.total_ewaybills} e-way bills checked against {summary.total_einvoices} e-invoices.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="px-5 py-4 space-y-2">
          {clean && (
            <p className="text-sm text-gray-600">
              Every e-invoice above the threshold has a matching e-way bill, and all
              taxable values, CGST, SGST, IGST and invoice totals agree.
            </p>
          )}
          {buckets.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.key} onClick={() => { onGoTo(t.key); onClose(); }}
                className="flex w-full items-center gap-3 rounded-lg border border-gray-200 px-3 py-2.5 text-left hover:bg-gray-50">
                <Icon size={18} className={t.cls} />
                <span className="flex-1 text-sm text-gray-700">{t.label}</span>
                <span className={`text-lg font-bold ${t.cls}`}>{summary[t.field]}</span>
                <ChevronRight size={16} className="text-gray-300" />
              </button>
            );
          })}

          {(summary.below_threshold > 0 || summary.challan_only > 0 || summary.ex_factory > 0) && (
            <p className="pt-2 text-[11px] leading-relaxed text-gray-400 border-t mt-3">
              Not counted as exceptions: {summary.below_threshold} below the taxable-value limit
              (₹{money(summary.threshold_intra)} within state, ₹{money(summary.threshold_inter)} inter-state),
              {' '}{summary.challan_only} delivery challans (no e-invoice due),
              {' '}{summary.ex_factory} ex-factory (the buyer raises the e-way bill).
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">Close</button>
          {!clean && (
            <button onClick={() => { onGoTo(buckets[0].key); onClose(); }}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
              Review {buckets[0].label.toLowerCase()}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Manage ex-factory customers.
 *
 * Permanent rules live here; one-off marks are made with the checkbox on a
 * report row. Customers seen in the open run are offered as one-click picks,
 * with their e-way bill hit rate — 0 of many is the ex-factory signature.
 */
function ExFactoryManager({ company, runId, open, onClose, onChanged }) {
  const [rules, setRules] = useState([]);
  const [parties, setParties] = useState([]);
  const [gstin, setGstin] = useState('');
  const [name, setName] = useState('');

  const load = useCallback(() => {
    apiClient.get('/api/sales/ewb-einvoice/ex-factory/', { params: company ? { company } : {} })
      .then((r) => setRules(r.data || [])).catch(() => {});
    if (runId) {
      apiClient.get(`/api/sales/ewb-einvoice/${runId}/parties/`)
        .then((r) => setParties(r.data || [])).catch(() => {});
    }
  }, [company, runId]);
  useEffect(() => { if (open) load(); }, [open, load]);

  if (!open) return null;

  const add = async (g, n) => {
    const code = (g || '').trim().toUpperCase();
    if (code.length !== 15) { toast.error('Enter the full 15-character GSTIN.'); return; }
    try {
      await apiClient.post('/api/sales/ewb-einvoice/ex-factory/', {
        company: company || undefined, party_gstin: code, party_name: (n || '').trim(),
      });
      setGstin(''); setName(''); load(); onChanged?.();
      toast.success('Added as ex-factory.');
    } catch { toast.error('Could not add that customer.'); }
  };

  const remove = async (id) => {
    await apiClient.delete(`/api/sales/ewb-einvoice/ex-factory/${id}/`).catch(() => {});
    load(); onChanged?.();
  };

  const known = new Set(rules.filter((r) => r.scope === 'CUSTOMER').map((r) => r.party_gstin));
  const permanent = rules.filter((r) => r.scope === 'CUSTOMER');
  const oneOff = rules.filter((r) => r.scope === 'DOCUMENT');
  const suggestions = parties.filter((p) => !known.has(p.party_gstin) && p.with_ewb === 0 && p.invoices >= 3);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b px-5 py-4">
          <div>
            <h3 className="font-semibold text-gray-800">Ex-factory customers</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              The buyer collects at your gate and raises the e-way bill themselves, so it
              never appears in your download. Their invoices are listed as ex-factory
              instead of missing.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close"><X size={18} /></button>
        </div>

        {suggestions.length > 0 && (
          <div className="border-b bg-amber-50/60 px-5 py-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-amber-800">
              <Info size={13} />Looks ex-factory in this period — no e-way bill on any invoice
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((p) => (
                <button key={p.party_gstin} onClick={() => add(p.party_gstin, p.party_name)}
                  className="rounded-full border border-amber-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-amber-100">
                  <Plus size={11} className="mr-1 inline" />
                  {p.party_name || p.party_gstin}
                  <span className="ml-1 text-amber-700">0 / {p.invoices}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-2 px-5 py-4 sm:grid-cols-[200px_1fr_auto]">
          <input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} maxLength={15}
            placeholder="Customer GSTIN" className="rounded-lg border px-3 py-2 font-mono text-sm uppercase" />
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Customer name (optional)" className="rounded-lg border px-3 py-2 text-sm" />
          <button onClick={() => add(gstin, name)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            <Plus size={15} />Add
          </button>
        </div>

        <div className="border-t">
          <p className="px-5 pt-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
            Always ex-factory ({permanent.length})
          </p>
          {permanent.length === 0 && <p className="px-5 py-4 text-sm text-gray-400">None yet.</p>}
          {permanent.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-5 py-2.5">
              <Factory size={14} className="text-sky-500" />
              <span className="font-mono text-xs text-gray-600">{r.party_gstin}</span>
              <span className="flex-1 text-sm text-gray-700">{r.party_name || '—'}</span>
              <button onClick={() => remove(r.id)} className="text-gray-300 hover:text-red-500"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>

        {oneOff.length > 0 && (
          <div className="border-t">
            <p className="px-5 pt-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              One-off ex-factory sales ({oneOff.length})
            </p>
            {oneOff.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-5 py-2.5">
                <span className="font-mono text-xs text-gray-500">{r.doc_no}</span>
                <span className="flex-1 text-sm text-gray-700">{r.party_name || r.party_gstin}</span>
                <button onClick={() => remove(r.id)} className="text-gray-300 hover:text-red-500"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function EwbEinvoiceCheck() {
  const { options: companyOptions } = useLookup('/api/companies/', { labelField: 'legal_name', valueField: 'id' });
  // Company filter in the URL so Back / refresh / sharing restore it.
  const [company, setCompany] = useUrlState('company', '');
  const [ewbFile, setEwbFile] = useState(null);
  const [einvFile, setEinvFile] = useState(null);
  // An e-way bill is due once the taxable value crosses the limit for that
  // movement: the central ₹50,000 inter-state, or the state's own relaxed
  // figure (₹1,00,000 in Tamil Nadu) when the goods stay inside the state.
  const [intraLimit, setIntraLimit] = useState('100000');
  const [interLimit, setInterLimit] = useState('50000');
  const [runs, setRuns] = useState([]);
  const [active, setActive] = useState(null);
  const [tab, setTab] = useState('MISSING_EWB');
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
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [marking, setMarking] = useState(null);

  const selectTab = (k) => { setTab(k); setPage(1); setExpanded(null); };

  const loadRuns = useCallback(() => {
    apiClient.get('/api/sales/ewb-einvoice/', { params: company ? { company } : {} })
      .then((r) => setRuns(r.data || [])).catch(() => {});
  }, [company]);
  useEffect(() => { loadRuns(); }, [loadRuns]);

  const openRun = async (id, { flag = false } = {}) => {
    try {
      const r = await apiClient.get(`/api/sales/ewb-einvoice/${id}/`);
      setActive(r.data);
      const first = EXCEPTION_TABS.find((t) => r.data.summary[t.field] > 0);
      selectTab(first ? first.key : 'MATCHED');
      if (flag) setDialog(r.data.summary);
    } catch { toast.error('Could not load that report.'); }
  };

  const run = async () => {
    if (!ewbFile || !einvFile) { toast.error('Pick both files first.'); return; }
    setBusy(true);
    const fd = new FormData();
    if (company) fd.append('company', company);
    fd.append('ewb_file', ewbFile);
    fd.append('einv_file', einvFile);
    fd.append('threshold_intra', intraLimit || '100000');
    fd.append('threshold_inter', interLimit || '50000');
    try {
      const res = await apiClient.post('/api/sales/ewb-einvoice/upload/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      loadRuns();
      openRun(res.data.id, { flag: true });
      setEwbFile(null); setEinvFile(null);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Check failed.');
    } finally { setBusy(false); }
  };

  const rerun = async () => {
    if (!active?.summary?.id) return;
    setBusy(true);
    try {
      await apiClient.post(`/api/sales/ewb-einvoice/${active.summary.id}/rerun/`,
        { threshold_intra: intraLimit, threshold_inter: interLimit });
      await openRun(active.summary.id, { flag: true });
      loadRuns();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Re-run failed.');
    } finally { setBusy(false); }
  };

  const download = async () => {
    try {
      const res = await apiClient.get(`/api/sales/ewb-einvoice/${active.summary.id}/export/`,
        { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `ewb_einvoice_check_${active.summary.period || 'report'}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Export failed.'); }
  };

  /**
   * Tick/untick ex-factory on one row. `scope` is DOCUMENT for this sale only,
   * or CUSTOMER to make the customer permanently ex-factory. The server
   * re-reconciles, so we reload the report to pick up the moved buckets.
   */
  const markExFactory = async (row, scope, on = true) => {
    setMarking(row.id);
    try {
      await apiClient.post(`/api/sales/ewb-einvoice/rows/${row.id}/ex-factory/`, { scope, on });
      await openRun(active.summary.id);
      loadRuns();
      if (!on) toast.success('Ex-factory mark removed.');
      else if (scope === 'CUSTOMER') toast.success(`${row.party_name || 'Customer'} is now always ex-factory.`);
      else toast.success('Marked ex-factory for this sale.');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not update that row.');
    } finally { setMarking(null); }
  };

  const del = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Remove this check and its report?')) return;
    await apiClient.delete(`/api/sales/ewb-einvoice/${id}/`).catch(() => {});
    if (active?.summary?.id === id) setActive(null);
    loadRuns();
  };

  const s = active?.summary;
  const COLS = SHOWS_EX_FACTORY.has(tab) ? 7 : 6;

  return (
    <MainLayout>
      <PageHeader
        title="E-Way Bill vs E-Invoice Check"
        subtitle="Reconcile a month's e-way bills against its e-invoices — spot the missing document and any tax that does not tie. Read-only."
        breadcrumbs={[{ label: 'Sales' }, { label: 'E-Way Bill Check' }]}
      />

      {/* Inputs */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Company</label>
            <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)} title="Company">
              <option value="">All Companies</option>
              {companyOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
          </div>
          <FileBox label="E-way bills" file={ewbFile} onPick={setEwbFile} accept=".xls,.xlsx"
            hint="ewb.nic.in → Reports → EWB generated by me" />
          <FileBox label="E-invoices" file={einvFile} onPick={setEinvFile} accept=".xlsx"
            hint="e-invoice portal → Returns → GSTR-1 tables (.xlsx)" />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Within state (₹)</label>
              <input type="number" value={intraLimit} onChange={(e) => setIntraLimit(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm tabular-nums" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Inter-state (₹)</label>
              <input type="number" value={interLimit} onChange={(e) => setInterLimit(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm tabular-nums" />
            </div>
            <p className="col-span-2 mt-1 text-[11px] text-gray-400">
              Compared against <strong>taxable value</strong>; the limit is picked per invoice from its place of supply.
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button onClick={run} disabled={busy || !ewbFile || !einvFile}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium
              ${busy || !ewbFile || !einvFile ? 'bg-gray-200 text-gray-500' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
            {busy ? 'Checking…' : 'Run check'}
          </button>
          <button onClick={() => setRulesOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
            <Factory size={15} />Ex-factory customers
          </button>
        </div>
      </div>

      {/* Report */}
      {s && (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div className="text-sm font-semibold text-gray-700">
              {s.period} · {s.total_ewaybills} e-way bills vs {s.total_einvoices} e-invoices
              {s.exceptions > 0
                ? <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">{s.exceptions} to review</span>
                : <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">All clear</span>}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setDialog(s)} className="rounded-lg border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Summary</button>
              <button onClick={rerun} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                <RefreshCw size={13} />Re-run
              </button>
              <button onClick={download} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                <Download size={13} />Export
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
            {ALL_TABS.map((t) => {
              const Icon = t.icon;
              const isException = EXCEPTION_TABS.includes(t);
              const count = s[t.field] || 0;
              return (
                <button key={t.key} onClick={() => selectTab(t.key)}
                  className={`rounded-xl border p-3 text-left transition
                    ${tab === t.key ? t.tint : 'border-gray-200 hover:border-gray-300'}
                    ${isException && count > 0 && tab !== t.key ? 'border-gray-300' : ''}`}>
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Icon size={14} className={t.cls} />{t.label}
                  </div>
                  <div className={`mt-1 text-2xl font-bold ${count === 0 && isException ? 'text-gray-300' : t.cls}`}>
                    {count}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="overflow-x-auto border-t">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase text-gray-400">
                  <th className="px-4 py-2">Party</th>
                  <th className="px-3 py-2">Document</th>
                  <th className="px-3 py-2">E-way bill</th>
                  <th className="px-3 py-2 text-right">Taxable (e-inv)</th>
                  <th className="px-3 py-2 text-right">Invoice value</th>
                  {SHOWS_EX_FACTORY.has(tab) && (
                    <th className="px-3 py-2 text-center whitespace-nowrap">Ex-factory</th>
                  )}
                  <th className="px-3 py-2">What to do</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="cursor-pointer border-b hover:bg-primary-50/40 transition-colors"
                      onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                      <td className="px-4 py-2">
                        <div className="flex items-start gap-1.5">
                          {expanded === r.id
                            ? <ChevronDown size={14} className="mt-0.5 text-gray-400" />
                            : <ChevronRight size={14} className="mt-0.5 text-gray-400" />}
                          <div>
                            <div className="font-medium text-gray-800">{r.party_name || '—'}</div>
                            <div className="font-mono text-[11px] text-gray-400">{r.party_gstin}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-gray-700">{r.doc_no || '—'}</div>
                        <div className="text-[11px] text-gray-400">{r.doc_date || ''} {r.doc_type ? `· ${r.doc_type}` : ''}</div>
                      </td>
                      <td className="px-3 py-2">
                        {r.ewb_no
                          ? <><div className="font-mono text-xs text-gray-600">{r.ewb_no}</div>
                              <div className="text-[11px] text-gray-400">{r.ewb_date || ''}</div></>
                          : <span className="text-red-400">not found</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.status === 'MISSING_EINV' ? <span className="text-gray-300">—</span> : <>₹{money(r.einv_taxable)}</>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                        ₹{money(Number(r.einv_value) || r.ewb_value)}
                      </td>

                      {SHOWS_EX_FACTORY.has(tab) && (
                        <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                          {marking === r.id ? (
                            <Loader2 size={14} className="mx-auto animate-spin text-gray-400" />
                          ) : r.ex_factory_scope === 'CUSTOMER' ? (
                            // Inherited from a permanent rule — not clearable
                            // one row at a time, so say so rather than offering
                            // a checkbox that would silently do nothing.
                            <span title="This customer is always ex-factory. Remove them from the Ex-factory list to undo."
                              className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">
                              <Factory size={11} />always
                            </span>
                          ) : (
                            <div className="flex items-center justify-center gap-1.5">
                              <input type="checkbox" title="This sale was ex-factory"
                                checked={r.ex_factory_scope === 'DOCUMENT'}
                                onChange={(e) => markExFactory(r, 'DOCUMENT', e.target.checked)}
                                className="h-4 w-4 cursor-pointer rounded border-gray-300 text-sky-600 focus:ring-sky-500" />
                              {r.ex_factory_scope !== 'DOCUMENT' && r.party_gstin && (
                                <button onClick={() => markExFactory(r, 'CUSTOMER')}
                                  title={`Always ex-factory for ${r.party_name || r.party_gstin}`}
                                  className="text-[10px] text-gray-400 underline decoration-dotted hover:text-sky-600">
                                  always
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      )}

                      <td className="max-w-md px-3 py-2 text-[12px] text-gray-500">{r.note}</td>
                    </tr>

                    {expanded === r.id && (
                      <tr className="border-b bg-gray-50">
                        <td colSpan={COLS} className="px-9 py-3">
                          <table className="w-full max-w-3xl text-xs">
                            <thead>
                              <tr className="text-gray-400">
                                <th className="py-1 text-left font-normal">Figure</th>
                                <th className="py-1 text-right font-normal">E-way bill</th>
                                <th className="py-1 text-right font-normal">E-invoice</th>
                                <th className="py-1 text-right font-normal">Difference</th>
                              </tr>
                            </thead>
                            <tbody className="tabular-nums">
                              {[
                                ['Assessable / Taxable value', r.ewb_taxable, r.einv_taxable, r.diff_taxable],
                                ['CGST / Central tax', r.ewb_cgst, r.einv_cgst, r.diff_cgst],
                                ['SGST / State-UT tax', r.ewb_sgst, r.einv_sgst, r.diff_sgst],
                                ['IGST / Integrated tax', r.ewb_igst, r.einv_igst, r.diff_igst],
                                ['Total invoice value', r.ewb_value, r.einv_value, r.diff_value],
                              ].map(([label, a, b, d]) => (
                                <tr key={label} className="border-t border-gray-200">
                                  <td className="py-1.5 text-gray-500">{label}</td>
                                  <td className="py-1.5 text-right">₹{money(a)}</td>
                                  <td className="py-1.5 text-right">₹{money(b)}</td>
                                  <td className="py-1.5 text-right"><Diff value={d} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div className="mt-2 flex flex-wrap gap-x-4 text-[11px] text-gray-400">
                            {r.place_of_supply && (
                              <span>
                                Place of supply: {r.place_of_supply}
                                {r.is_intra_state === true && ' · within state'}
                                {r.is_intra_state === false && ' · inter-state'}
                              </span>
                            )}
                            {r.irn && <span className="font-mono">IRN {r.irn}</span>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {allRows.length === 0 && (
                  <tr><td colSpan={COLS} className="px-4 py-8 text-center text-sm text-gray-400">Nothing in this bucket 🎉</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {allRows.length > 0 && <Pager page={pageNum} total={allRows.length} size={PAGE_SIZE} onPage={setPage} />}
        </div>
      )}

      {/* Past checks */}
      {runs.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white">
          <div className="border-b px-4 py-3 text-sm font-semibold text-gray-700">Past checks</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase text-gray-400">
                  <th className="px-4 py-2">Period</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2 text-right">E-way bills</th>
                  <th className="px-3 py-2 text-right">E-invoices</th>
                  <th className="px-3 py-2 text-right">Exceptions</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((u) => (
                  <tr key={u.id} onClick={() => openRun(u.id)}
                    className={`cursor-pointer border-b last:border-0 hover:bg-gray-50 ${active?.summary?.id === u.id ? 'bg-indigo-50' : ''}`}>
                    <td className="px-4 py-2 font-medium text-gray-800">{u.period || '—'}</td>
                    <td className="px-3 py-2 text-gray-500">{u.company_name || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{u.total_ewaybills}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{u.total_einvoices}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {u.exceptions > 0
                        ? <span className="font-semibold text-red-600">{u.exceptions}</span>
                        : <span className="text-green-600">0</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={(e) => del(u.id, e)} className="text-gray-300 hover:text-red-500"><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ExceptionDialog summary={dialog} onClose={() => setDialog(null)} onGoTo={selectTab} />
      <ExFactoryManager company={company} runId={s?.id} open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        onChanged={() => { if (s?.id) openRun(s.id); loadRuns(); }} />
    </MainLayout>
  );
}
