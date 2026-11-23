/**
 * Email Bill Inbox — pulls purchase bills from a Gmail inbox, reads them with AI,
 * and stages them for review. Approving a row creates a Vendor Bill.
 *
 * Fully separate from the Scan Invoice page; talks only to
 * /api/purchase/email-bills/. Nothing posts to purchase until a person approves.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import MainLayout from '../../../components/layout/MainLayout';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import toast from 'react-hot-toast';
import {
  RefreshCw, Settings, Check, X, Search, Loader2, Mail, FileText, GitMerge, CheckCheck,
  Plus, RotateCcw, Download,
} from 'lucide-react';

const API = '/api/purchase/email-bills';
const money = (v) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// When the email arrived — date + time, en-IN.
const dt = (v) => { try { return v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; } catch { return ''; } };
// Pull a human reason out of an axios error — DRF sends either {detail} for a
// raised error or {field: [msg]} for serializer validation. Returns '' so the
// caller can append its own verb ("… failed").
const errText = (e) => {
  const d = e?.response?.data;
  if (!d) return '';
  if (d.detail) return d.detail;
  if (typeof d === 'object') return Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
  return String(d);
};
// A freight/transport line is auto-tracked as a charge — never a product (matches
// the backend _FREIGHT_LINE_RE). Applies only to lines not mapped to a real product.
const FREIGHT_LINE_RE = /freight|transport|cartage|carriage|lorry|courier/i;

// One-line readiness for the inbox row (what still blocks Approve), so the list
// is scannable without opening each bill.
function draftStatus(draft) {
  if (draft.existing_bill_id) return { label: '⚠ Duplicate?', cls: 'text-amber-700 bg-amber-50 border-amber-200' };
  if (draft.is_freight_bill) return draft.transporter
    ? { label: 'Ready', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' }
    : { label: 'Needs transporter', cls: 'text-amber-700 bg-amber-50 border-amber-200' };
  if (!draft.matched_vendor) return { label: 'Needs vendor', cls: 'text-amber-700 bg-amber-50 border-amber-200' };
  if (!draft.voucher_type) return { label: 'Needs voucher type', cls: 'text-amber-700 bg-amber-50 border-amber-200' };
  if (!draft.category) return { label: 'Needs category', cls: 'text-amber-700 bg-amber-50 border-amber-200' };
  const lines = Array.isArray(draft.lines) ? draft.lines : [];
  const unresolved = lines.filter((l) => l && (l.description || '').trim() && !(
    l.is_charge === true
    || (l.is_charge == null && !l.product_id && FREIGHT_LINE_RE.test((l.description || '').trim()))
    || l.product_action === 'create' || l.product_id
  )).length;
  if (unresolved > 0) return { label: `${unresolved} need product`, cls: 'text-amber-700 bg-amber-50 border-amber-200' };
  return { label: 'Ready', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' };
}

// A compact inbox row — click to open the bill's full review page (within the inbox).
function DraftRow({ draft, onOpen, onRemove }) {
  const st = draftStatus(draft);
  const total = Number(draft.total_amount) || 0;
  return (
    <div className="w-full bg-white rounded-xl border border-slate-200 shadow-sm hover:border-indigo-300 hover:shadow px-4 py-3 flex items-center gap-3 transition">
      <button type="button" onClick={onOpen} className="flex items-center gap-3 min-w-0 flex-1 text-left">
        <FileText size={16} className="text-indigo-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-800 truncate">
            {draft.matched_vendor_name || draft.vendor_name || 'Vendor'}
            <span className="text-slate-400 font-normal"> · {draft.invoice_no || 'no invoice no'}</span>
          </div>
          <div className="text-[11px] text-slate-400 truncate">
            {draft.doc_name}
            {draft.received_at && <span className="text-slate-400"> · 📅 {dt(draft.received_at)}</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold text-slate-800 tabular-nums">{money(total)}</div>
          {draft.is_freight_bill && <div className="text-[10px] text-teal-600 font-semibold">🚚 Freight</div>}
          {draft.is_bundle && <div className="text-[10px] text-teal-600 font-semibold">🚚+🧾 Bundle</div>}
        </div>
        <span className={`shrink-0 text-[11px] font-medium border rounded-full px-2 py-0.5 ${st.cls}`}>{st.label}</span>
        <span className="text-slate-300 shrink-0">›</span>
      </button>
      {/* Per-row remove — same as the ✕ on Scan Invoice's recent scans. */}
      <button type="button" title="Remove this bill from the inbox" onClick={onRemove}
        className="shrink-0 text-slate-300 hover:text-rose-500 p-1"><X size={16} /></button>
    </div>
  );
}
// Purchase category — matches VendorBill.PURCHASE_CATEGORY_CHOICES exactly.
const CATEGORIES = [
  ['RM', 'RM Purchase'],
  ['PACKING', 'Packing Material'],
  ['FREIGHT', 'Freight / Transport'],
  ['EXPENSES', 'Expenses'],
  ['FRUIT', 'Fruit Purchase'],
  ['LAB_EXPENSE', 'Lab Expense'],
  ['MACHINERY', 'Machinery / Capital'],
];
// Download each bill file once and reuse it — a multi-bill PDF is shared by many
// rows, so without this every "view bill" re-downloads the whole (large) PDF.
const docBlobCache = new Map();   // doc_id -> { url, type }

export default function EmailBillInbox() {
  const { options: companies } = useLookup('/api/companies/');
  // Names only, for the Customer box on an OUTWARD freight bill. One lookup for
  // the page (the hook caches), not one per card.
  const { options: customerOpts } = useLookup('/api/customers/');
  const customerNames = useMemo(
    () => (customerOpts || []).map((c) => c.label || c.name || '').filter(Boolean),
    [customerOpts]);
  // Company + folder filters live in the URL so Back / refresh / sharing restore
  // the same view (companyId is auto-seeded below when the URL has none).
  const [companyId, setCompanyId] = useUrlState('company', '');
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [stopping, setStopping] = useState(false);     // Stop sent, waiting for the run to halt
  const [showFetch, setShowFetch] = useState(false);   // date-range popup for Fetch
  const [fetchFrom, setFetchFrom] = useState('');
  const [fetchTo, setFetchTo] = useState('');
  // The new Email page: Fetch lists the matching emails; the reviewer ticks the
  // ones to scan. Nothing is read into review until Scan.
  const [pickOpen, setPickOpen] = useState(false);
  const [pickEmails, setPickEmails] = useState([]);
  const [pickSel, setPickSel] = useState(() => new Set());
  const [scanning, setScanning] = useState(false);
  const [approvingAll, setApprovingAll] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [voucherTypes, setVoucherTypes] = useState([]);
  const [locations, setLocations] = useState([]);
  const [view, setView] = useUrlState('view', 'PENDING');   // PENDING (to review) | APPROVED (done, revertable)
  // Four folders: PURCHASE (RM + Packing) | EXPENSE | FRUIT | FREIGHT.
  // Freight then splits three ways by the file-name prefix: SRA -> Inward,
  // Z -> Outward, anything else -> Local.
  const [kind, setKind] = useUrlState('kind', 'PURCHASE');
  const [fkind, setFkind] = useUrlState('fkind', 'ALL');     // ALL | INWARD | OUTWARD | LOCAL
  const [selectedId, setSelectedId] = useState(null);   // an open bill's detail page (within the inbox)

  useEffect(() => {
    apiClient.get(`${API}/voucher-types/`)
      .then((r) => setVoucherTypes((r.data.results || []).map((x) => x.label)))
      .catch(() => {});
  }, []);

  // Warehouses (with their godowns nested) for the Update-stock cascade.
  useEffect(() => {
    if (!companyId) { setLocations([]); return; }
    apiClient.get(`${API}/locations/?company=${companyId}`)
      .then((r) => setLocations(r.data || []))
      .catch(() => setLocations([]));
  }, [companyId]);

  // Add a new voucher/purchase type from the dropdown — saved in the DB and
  // shown to everyone from then on.
  const addVoucherType = useCallback(async (label) => {
    const r = await apiClient.post(`${API}/voucher-types/`, { label });
    const lbl = r.data.label;
    setVoucherTypes((prev) => (prev.includes(lbl) ? prev : [...prev, lbl].sort()));
    return lbl;
  }, []);

  const quick = useMemo(() => [
    (companies || []).find((c) => /biochem/i.test(c.label)),
    (companies || []).find((c) => /united\s*agro/i.test(c.label)),
  ].filter(Boolean), [companies]);

  useEffect(() => { if (!companyId && quick[0]) setCompanyId(quick[0].value); }, [quick, companyId]);

  const loadDrafts = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const r = await apiClient.get(`${API}/drafts/?company=${companyId}&status=${view}`);
      setDrafts(r.data || []);
    } catch { toast.error('Could not load the inbox.'); } finally { setLoading(false); }
  }, [companyId, view]);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  // How many bills arrived, how many are entered, how many are left — per folder.
  // One grouped query on the server, refreshed whenever the list is.
  const [counts, setCounts] = useState(null);
  const loadCounts = useCallback(async () => {
    if (!companyId) { setCounts(null); return; }
    try {
      const r = await apiClient.get(`${API}/counts/?company=${companyId}`);
      setCounts(r.data || null);
    } catch { /* the tally is informational — never block the inbox for it */ }
  }, [companyId]);
  useEffect(() => { loadCounts(); }, [loadCounts, drafts]);

  // Remove a single bill from the inbox (the row ✕) — deletes just this draft,
  // mirroring the per-row remove on Scan Invoice. The emailed doc stays, so a
  // re-fetch won't re-create it (deduped by file hash).
  const removeDraft = async (d) => {
    if (!window.confirm(`Remove "${d.vendor_name || d.doc_name || 'this bill'}" from the inbox?`)) return;
    try {
      await apiClient.delete(`${API}/drafts/${d.id}/`);
      toast.success('Removed from inbox.');
      loadDrafts();
    } catch { toast.error('Could not remove it.'); }
  };

  // Stop a running Fetch / Reload / Scan — the server checks a flag between PDFs
  // and bails, so a costly AI run can be halted mid-way (not just the browser).
  const stopNow = async () => {
    setStopping(true);
    try {
      await apiClient.post(`${API}/stop/`, {});
      toast('Stopping… it finishes the current PDF, then halts.', { icon: '🛑', duration: 5000 });
    } catch { toast.error('Could not send stop.'); }
  };

  const fetchNow = async ({ dateFrom = '', dateTo = '' } = {}) => {
    if (!companyId) { toast.error('Pick a company first.'); return; }
    setShowFetch(false);
    setFetching(true);
    try {
      // Reading emails + AI extraction easily exceeds the 30s default; give it
      // room (the server's gunicorn worker allows up to 120s).
      const r = await apiClient.post(`${API}/fetch/`, { company: companyId, date_from: dateFrom, date_to: dateTo }, { timeout: 180000 });
      const s = r.data || {};
      toast.success(`${s.stopped ? '🛑 Stopped — ' : ''}Fetched ${s.new_docs || 0} file(s) → ${s.bills || 0} bill(s)${s.skipped_duplicate ? ` · ${s.skipped_duplicate} already imported` : ''}`);
      // Bills are auto-routed to their company from the subject — show the split
      // so the reviewer can switch the company toggle to see them all.
      const byCo = Object.entries(s.by_company || {}).filter(([, n]) => n > 0);
      if (byCo.length > 1) toast(`Routed by subject → ${byCo.map(([c, n]) => `${c}: ${n}`).join(' · ')}`, { icon: '🏢', duration: 6000 });
      if ((s.errors || []).length) toast.error(`${s.errors.length} item(s) had problems — see the rows.`);
      loadDrafts();
    } catch (e) { toast.error(e.response?.data?.detail || 'Fetch failed.'); } finally { setFetching(false); setStopping(false); }
  };

  // Selection is per-PDF: a key is `${uid}||${filename}`.
  const attKey = (uid, name) => `${uid}||${name}`;
  const freshAtts = (e) => (e.attachments || []).filter((a) => !a.already);

  // STEP 1 — list the matching bill emails (metadata only, no OCR) and open the
  // pick modal. All companies together; nothing is imported yet.
  const listEmails = async ({ dateFrom = '', dateTo = '' } = {}) => {
    setShowFetch(false); setFetching(true);
    try {
      const r = await apiClient.post(`${API}/list-emails/`, { date_from: dateFrom, date_to: dateTo }, { timeout: 180000 });
      const emails = (r.data?.emails) || [];
      setPickEmails(emails);
      // Pre-tick every PDF that isn't already scanned.
      const keys = new Set();
      emails.forEach((e) => freshAtts(e).forEach((a) => keys.add(attKey(e.uid, a.name))));
      setPickSel(keys);
      setPickOpen(true);
      if (!emails.length) toast('No matching bill emails for that date.', { icon: '📭' });
    } catch (e) { toast.error(e.response?.data?.detail || 'Could not list emails.'); }
    finally { setFetching(false); }
  };

  const togglePdf = (uid, name) => setPickSel((prev) => { const n = new Set(prev); const k = attKey(uid, name); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleEmail = (e, on) => setPickSel((prev) => {
    const n = new Set(prev);
    freshAtts(e).forEach((a) => { const k = attKey(e.uid, a.name); on ? n.add(k) : n.delete(k); });
    return n;
  });

  // STEP 2 — read ONLY the ticked PDFs into the review list (each routed to its
  // company by filename). The list + review card are unchanged.
  const scanSelected = async () => {
    if (!pickSel.size) { toast.error('Tick at least one PDF.'); return; }
    const byUid = {};
    pickSel.forEach((k) => { const i = k.indexOf('||'); const uid = k.slice(0, i); const name = k.slice(i + 2); (byUid[uid] = byUid[uid] || []).push(name); });
    const selections = Object.entries(byUid).map(([uid, names]) => ({ uid, names }));
    setScanning(true);
    try {
      const r = await apiClient.post(`${API}/scan-emails/`, { selections, company: companyId }, { timeout: 300000 });
      const s = r.data || {};
      toast.success(`${s.stopped ? '🛑 Stopped — ' : ''}Scanned ${s.scanned || 0} email(s) → ${s.bills || 0} bill(s)${s.skipped_duplicate ? ` · ${s.skipped_duplicate} already imported` : ''}`);
      const byCo = Object.entries(s.by_company || {}).filter(([, n]) => n > 0);
      if (byCo.length > 1) toast(`Routed by filename → ${byCo.map(([c, n]) => `${c}: ${n}`).join(' · ')}`, { icon: '🏢', duration: 6000 });
      if ((s.errors || []).length) toast.error(`${s.errors.length} item(s) had problems.`);
      setPickOpen(false);
      loadDrafts();
    } catch (e) { toast.error(e.response?.data?.detail || 'Scan failed.'); }
    finally { setScanning(false); setStopping(false); }
  };

  const approveAll = async () => {
    if (!companyId) { toast.error('Pick a company first.'); return; }
    if (!window.confirm('Post every bill that needs no decision? Bills missing a vendor / voucher type / category / product mapping are left for you, and possible duplicates are left too so you choose Merge or Create new per bill. Nothing is merged automatically.')) return;
    setApprovingAll(true);
    try {
      const r = await apiClient.post(`${API}/approve-all/`, { company: companyId }, { timeout: 180000 });
      const s = r.data || {};
      const dup = s.skipped_duplicate || 0;
      const inc = s.skipped_incomplete || 0;
      toast.success(`Posted ${s.approved || 0} clean bill(s)`);
      if (dup) toast(`${dup} possible duplicate(s) left for you to Merge or Create new`, { icon: '⚠️' });
      if (inc) toast.error(`${inc} left — fill their vendor / voucher / category / product lines`);
      loadDrafts();
    } catch (e) { toast.error(e.response?.data?.detail || 'Approve all failed.'); } finally { setApprovingAll(false); }
  };

  const clearAll = async () => {
    if (!companyId) { toast.error('Pick a company first.'); return; }
    if (!window.confirm('Delete ALL pending bills currently in this inbox? (use this to wipe junk pulled before the subject filter was set)')) return;
    try {
      const r = await apiClient.post(`${API}/clear/`, { company: companyId });
      toast.success(`Cleared ${r.data.deleted || 0} pending`);
      loadDrafts();
    } catch { toast.error('Clear failed.'); }
  };

  const shortName = (label) => /biochem/i.test(label) ? 'SS Biochem' : /united\s*agro/i.test(label) ? 'United Agro' : label;

  return (
    <MainLayout>
    {/* ===== The NEW Email page: pick which emails to scan ===== */}
    {pickOpen && (
      <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-3 sm:p-6 overflow-auto"
        onClick={() => !scanning && setPickOpen(false)}>
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl my-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-3 px-5 py-3.5 border-b border-slate-100">
            <div>
              <h3 className="font-semibold text-slate-800">Pick emails to scan</h3>
              <p className="text-xs text-slate-500 mt-0.5">All bill emails (SS + UAI together). Tick the ones you want, then Scan — each PDF is routed to its company by filename. Nothing else imports.</p>
            </div>
            <button onClick={() => setPickOpen(false)} className="text-slate-400 hover:text-slate-700 shrink-0"><X size={18} /></button>
          </div>
          <div className="px-5 py-2.5 border-b border-slate-100 flex items-center gap-3 text-sm">
            {(() => {
              const allFresh = pickEmails.flatMap((e) => freshAtts(e).map((a) => attKey(e.uid, a.name)));
              const allOn = allFresh.length > 0 && allFresh.every((k) => pickSel.has(k));
              return (
                <>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={allOn}
                      onChange={() => setPickSel(allOn ? new Set() : new Set(allFresh))} className="w-4 h-4" />
                    <span className="text-slate-600"><b>{pickSel.size}</b> PDF{pickSel.size === 1 ? '' : 's'} selected</span>
                  </label>
                  <button onClick={() => setPickSel(new Set(allFresh))} disabled={allFresh.length === 0 || allOn}
                    className="px-2.5 py-1 rounded-md border border-slate-200 text-slate-600 text-xs font-medium hover:bg-slate-50 disabled:opacity-40">
                    Select all{allFresh.length ? ` (${allFresh.length})` : ''}
                  </button>
                  <button onClick={() => setPickSel(new Set())} disabled={pickSel.size === 0}
                    className="px-2.5 py-1 rounded-md border border-slate-200 text-slate-600 text-xs font-medium hover:bg-slate-50 disabled:opacity-40">
                    Clear all
                  </button>
                </>
              );
            })()}
            <button onClick={scanSelected} disabled={scanning || pickSel.size === 0}
              className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
              {scanning ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Scan selected ({pickSel.size})
            </button>
          </div>
          <div className="max-h-[62vh] overflow-auto divide-y divide-slate-100">
            {pickEmails.length === 0 && <div className="p-10 text-center text-sm text-slate-500">No matching bill emails.</div>}
            {pickEmails.map((e) => {
              const kindCls = e.kind === 'freight' ? 'bg-teal-50 text-teal-700' : e.kind === 'expense' ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700';
              const fresh = freshAtts(e);
              const selN = fresh.filter((a) => pickSel.has(attKey(e.uid, a.name))).length;
              const headOn = fresh.length > 0 && selN === fresh.length;
              return (
                <div key={e.uid} className={`px-5 py-3 ${e.already ? 'opacity-60' : ''}`}>
                  <div className="flex gap-3">
                    <input type="checkbox" checked={headOn} ref={(el) => { if (el) el.indeterminate = selN > 0 && !headOn; }}
                      disabled={fresh.length === 0} onChange={(ev) => toggleEmail(e, ev.target.checked)} className="mt-1 w-4 h-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-800 truncate">{e.subject || '(no subject)'}</div>
                      <div className="text-[11px] text-slate-400 truncate">{e.from}</div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${kindCls}`}>{e.kind}</span>
                        {e.already && <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">✓ all scanned</span>}
                      </div>
                      {/* Per-PDF picker — tick only the PDFs you want to push. */}
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        {(e.attachments || []).map((a, i) => {
                          const on = pickSel.has(attKey(e.uid, a.name));
                          return (
                            <label key={i} title={a.already ? 'Already scanned' : a.name}
                              className={`inline-flex items-center gap-1.5 text-[11px] rounded-md border px-1.5 py-1 cursor-pointer
                                ${a.already ? 'opacity-50 cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
                                  : on ? 'border-indigo-300 bg-indigo-50 text-indigo-800' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-200'}`}>
                              <input type="checkbox" checked={on} disabled={a.already} onChange={() => togglePdf(e.uid, a.name)} className="w-3.5 h-3.5" />
                              <span className="text-[8px] font-bold text-red-600 bg-red-50 rounded px-1">PDF</span>
                              <span className="truncate max-w-[150px]">{a.name}</span>
                              {a.company_tag && <span className="text-[9px] font-bold text-slate-400">{a.company_tag}</span>}
                              {a.already && <span className="text-[8px] font-bold uppercase text-slate-400">done</span>}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <div className="text-[11px] text-slate-400 whitespace-nowrap shrink-0">{selN}/{(e.attachments || []).length} PDF</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    )}
    <div className="w-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div className="flex items-center gap-2">
          <span className="p-2 rounded-lg bg-indigo-50 text-indigo-600"><Mail size={20} /></span>
          <div>
            <h1 className="text-lg sm:text-xl font-semibold text-slate-800">Email Bill Inbox</h1>
            <p className="text-xs text-slate-500">Bills emailed by vendors → read by AI → review → create Vendor Bill. Separate from Scan Invoice.</p>
          </div>
        </div>
        <button onClick={() => setShowSettings(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50">
          <Settings size={15} /> Settings
        </button>
      </div>

      {/* Company toggle + Fetch */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        {quick.map((c) => {
          const active = String(companyId) === String(c.value);
          return (
            <button key={c.value} type="button" onClick={() => setCompanyId(c.value)} title={c.label}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${active ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300'}`}>
              {shortName(c.label)}
            </button>
          );
        })}
        <span className="w-px h-5 bg-slate-200 mx-1" />
        <div className="relative">
          <button onClick={() => setShowFetch((v) => !v)} disabled={fetching}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
            {fetching ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Fetch now
          </button>
          {showFetch && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setShowFetch(false)} />
              <div className="absolute z-40 top-11 left-0 w-64 bg-white border border-slate-200 rounded-xl shadow-xl p-3">
                <div className="text-xs font-semibold text-slate-700 mb-2">Fetch emails from a date</div>
                <label className="text-[11px] text-slate-500 block">Date
                  <input type="date" value={fetchFrom} onChange={(e) => setFetchFrom(e.target.value)}
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm mt-0.5" /></label>
                <p className="text-[10px] text-slate-400 mt-1.5">Lists that day's bill emails so you can pick which to scan. Leave blank or use “All” to list everything. Nothing is imported until you Scan.</p>
                <div className="flex items-center gap-2 mt-2.5">
                  <button onClick={() => listEmails({ dateFrom: fetchFrom, dateTo: fetchFrom })} disabled={fetching}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
                    <RefreshCw size={14} /> Fetch
                  </button>
                  <button onClick={() => { setFetchFrom(''); setFetchTo(''); listEmails({}); }} disabled={fetching}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs hover:bg-slate-50">
                    All
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        {/* STOP — halts a running Fetch / Reload / Scan server-side so it stops
            burning AI calls. Shown only while a run is in flight. */}
        {(fetching || scanning) && (
          <button onClick={stopNow} disabled={stopping}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 disabled:opacity-60 animate-pulse">
            {stopping ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />} {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
        <button onClick={loadDrafts} className="text-xs text-slate-500 hover:text-slate-700 underline">refresh list</button>
        {view === 'PENDING' && !selectedId && (
          <>
            <button onClick={approveAll} disabled={approvingAll || !companyId || drafts.length === 0}
              className="ml-auto inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              {approvingAll ? <Loader2 size={15} className="animate-spin" /> : <CheckCheck size={15} />} Approve all
            </button>
            <button onClick={clearAll} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-200 text-rose-600 text-sm hover:bg-rose-50">
              <X size={14} /> Clear junk
            </button>
          </>
        )}
      </div>

      {(() => {
        const selectedDraft = selectedId ? drafts.find((d) => String(d.id) === String(selectedId)) : null;
        // ── Detail "page" (within the inbox): the full review of one bill ──
        if (selectedDraft) {
          return (
            <div className="space-y-3">
              <button onClick={() => setSelectedId(null)}
                className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 font-medium">
                <RotateCcw size={15} className="-scale-x-100" /> Back to list
              </button>
              <DraftCard key={selectedDraft.id} draft={selectedDraft} companyId={companyId}
                companies={companies} onCompanyChange={(id) => setCompanyId(id)}
                onDone={() => { setSelectedId(null); loadDrafts(); }}
                voucherTypes={voucherTypes} addVoucherType={addVoucherType} locations={locations}
                customerNames={customerNames} />
            </div>
          );
        }
        // ── List view: To review / Approved × Purchase bills / Freight ──
        // A bill belongs to exactly one folder. Freight is decided by the draft's
        // own flag; the other three by the category the subject set (Packing rides
        // with Purchase, Lab Expense with Expense, so nothing falls outside).
        const folderOf = (d) => {
          if (d.is_freight_bill) return 'FREIGHT';
          const c = (d.category || '').toUpperCase();
          if (c === 'FRUIT') return 'FRUIT';
          if (c === 'EXPENSES' || c === 'LAB_EXPENSE') return 'EXPENSE';
          return 'PURCHASE';
        };
        const shown = drafts.filter((d) => folderOf(d) === kind
          && (kind !== 'FREIGHT' || fkind === 'ALL' || (d.freight_kind || 'LOCAL') === fkind));
        return (
          <>
            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <div className="flex items-center gap-1">
                {[['PENDING', 'To review'], ['APPROVED', 'Approved']].map(([v, label]) => (
                  <button key={v} onClick={() => { setSelectedId(null); setView(v); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${view === v ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="w-px h-5 bg-slate-200" />
              {/* Which document type — purchase bills vs freight (they arrive separately). */}
              <div className="inline-flex bg-slate-100 border border-slate-200 rounded-lg p-0.5 gap-0.5">
                {[['PURCHASE', '🧾 Purchase'], ['EXPENSE', '💡 Expense'], ['FRUIT', '🍎 Fruit'], ['FREIGHT', '🚚 Freight']].map(([k, label]) => (
                  <button key={k} onClick={() => { setSelectedId(null); setKind(k); setFkind('ALL'); }}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${kind === k ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                    {label}
                    {counts?.[k]?.remaining > 0 && (
                      <span className="ml-1.5 inline-block min-w-[18px] text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-700">
                        {counts[k].remaining}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {/* Freight only: Inward (SRA) / Outward (Z) / Local (everything else). */}
              {kind === 'FREIGHT' && (
                <div className="inline-flex bg-teal-50 border border-teal-200 rounded-lg p-0.5 gap-0.5">
                  {[['ALL', 'All'], ['INWARD', '↙ Inward'], ['OUTWARD', '↗ Outward'], ['LOCAL', '🚚 Local']].map(([k, label]) => {
                    const n = k === 'ALL' ? counts?.FREIGHT?.remaining : counts?.FREIGHT_SUB?.[k]?.remaining;
                    return (
                      <button key={k} onClick={() => { setSelectedId(null); setFkind(k); }}
                        className={`px-2.5 py-1.5 rounded-md text-xs font-semibold transition ${fkind === k ? 'bg-white text-teal-800 shadow-sm' : 'text-teal-600 hover:text-teal-800'}`}>
                        {label}
                        {n > 0 && <span className="ml-1 text-[10px] font-bold text-teal-700">{n}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {counts?.TOTAL?.fetched > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-[12.5px]">
                <span className="text-slate-600"><b className="text-slate-800 tabular-nums">{counts.TOTAL.fetched}</b> fetched</span>
                <span className="text-emerald-700"><b className="tabular-nums">{counts.TOTAL.entered}</b> entered</span>
                <span className="text-amber-700"><b className="tabular-nums">{counts.TOTAL.remaining}</b> remaining</span>
                <span className="text-slate-400 hidden sm:inline">·</span>
                <span className="text-slate-500">
                  this folder: <b className="text-slate-700 tabular-nums">{counts?.[kind]?.fetched || 0}</b> fetched,{' '}
                  <b className="text-slate-700 tabular-nums">{counts?.[kind]?.entered || 0}</b> entered,{' '}
                  <b className="text-slate-700 tabular-nums">{counts?.[kind]?.remaining || 0}</b> remaining
                </span>
              </div>
            )}
            {loading ? (
              <div className="flex items-center justify-center py-16 text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading…</div>
            ) : shown.length === 0 ? (
              <div className="text-center py-16 text-slate-400 text-sm border border-dashed border-slate-200 rounded-xl">
                {kind === 'FREIGHT'
                  ? <>No {fkind === 'ALL' ? '' : `${fkind.toLowerCase()} `}freight bills here. Inward is SRA…, Outward is Z…, everything else is Local.</>
                  : (view === 'PENDING'
                    ? <>No {kind.toLowerCase()} bills waiting for review. Click <b>Fetch now</b> to pull the latest emails.</>
                    : <>No approved {kind.toLowerCase()} bills yet.</>)}
              </div>
            ) : view === 'APPROVED' ? (
              <div className="space-y-2">
                {shown.map((d) => (
                  <ApprovedRow key={d.id} draft={d} onDone={loadDrafts} />
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {shown.map((d) => (
                  <DraftRow key={d.id} draft={d} onOpen={() => setSelectedId(d.id)} onRemove={() => removeDraft(d)} />
                ))}
              </div>
            )}
          </>
        );
      })()}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
    </MainLayout>
  );
}

function ApprovedRow({ draft, onDone }) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  // Open the created record — a goods Vendor Bill, or a Freight Advice. Uses
  // navigate (pushes history) so the target's Back button returns HERE.
  const openRecord = () => {
    // Each kind lives on its own page. Local Freight has a list but no detail
    // route, so it opens the list — better than a dead click.
    if (draft.created_bill) { navigate(`/purchase/bills/${draft.created_bill}`); return; }
    if (draft.created_freight) { navigate(`/freight/purchase/${draft.created_freight}`); return; }
    // Fall back to the TYPE, not just the tracked record: rows approved before the
    // tracking existed have no record id, and a click that does nothing reads as a
    // broken page. Local has a list but no detail route, so it opens the list too.
    const k = draft.is_freight_bill ? (draft.freight_kind || '') : '';
    if (draft.created_outward_freight || k === 'OUTWARD') { navigate('/freight/outward'); return; }
    if (draft.created_local_freight || k === 'LOCAL') { navigate('/freight/local'); return; }
    if (k === 'INWARD') navigate('/freight/inward');
  };
  // What this draft actually produced — shown on the row and used for the label.
  const made = draft.created_bill_no
    || draft.created_outward_freight_no || draft.created_local_freight_no || '';
  const fk = draft.is_freight_bill ? (draft.freight_kind || '') : '';
  const revert = async () => {
    const warn = (draft.is_freight_bill && draft.created_bill_no)
      ? `Revert this freight bill? It detaches the freight bill from ${draft.created_bill_no} and puts it back in "To review". The goods bill is NOT deleted.`
      : draft.merged
        ? `This bill (${draft.created_bill_no || ''}) was MERGED into an existing bill. Reverting removes the item lines this added and unposts any stock it posted, but it CANNOT restore the bill's earlier amounts/lines. Continue?`
        : `Revert ${draft.created_bill_no || 'this bill'}? This deletes the created Vendor Bill (and unposts any stock it posted) and puts the bill back in "To review".`;
    if (!window.confirm(warn)) return;
    setBusy(true);
    try {
      await apiClient.post(`${API}/drafts/${draft.id}/revert/`, {});
      toast.success('Reverted — back in “To review”.');
      onDone();
    } catch (e) { toast.error(e.response?.data?.detail || 'Revert failed.'); } finally { setBusy(false); }
  };
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-3 flex items-center gap-3 flex-wrap">
      <FileText size={15} className="text-slate-400 shrink-0" />
      <button type="button" onClick={openRecord} title="Open the bill"
        className="min-w-0 text-left flex-1 group">
        <div className="text-sm font-medium text-slate-700 group-hover:text-indigo-700 truncate">
          {draft.matched_vendor_name || draft.vendor_name || 'Vendor'} · {draft.invoice_no || '—'}
        </div>
        <div className="text-[11px] text-slate-400 truncate">
          {fk ? 'Freight' : 'Bill'} <span className="text-indigo-600 group-hover:underline">{made || '—'}</span>{draft.merged ? ' · merged into existing' : ''} · {draft.doc_name}{draft.received_at ? ` · 📅 ${dt(draft.received_at)}` : ''}
        </div>
      </button>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {fk && (
          <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 border ${
            fk === 'INWARD' ? 'text-sky-700 bg-sky-50 border-sky-200'
            : fk === 'OUTWARD' ? 'text-violet-700 bg-violet-50 border-violet-200'
            : 'text-teal-700 bg-teal-50 border-teal-200'}`}>
            {fk === 'INWARD' ? '↙ Inward' : fk === 'OUTWARD' ? '↗ Outward' : '🚚 Local'} freight
          </span>
        )}
        <span className="text-[11px] font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">Approved</span>
        <button onClick={revert} disabled={busy}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-rose-200 text-rose-600 text-sm hover:bg-rose-50 disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Revert
        </button>
      </div>
    </div>
  );
}

function DraftCard({ draft, companyId, companies = [], onCompanyChange, onDone, voucherTypes = [], addVoucherType, locations = [], customerNames = [] }) {
  const [f, setF] = useState({
    vendor_name: draft.vendor_name || '', vendor_gstin: draft.vendor_gstin || '',
    invoice_no: draft.invoice_no || '', invoice_date: draft.invoice_date || '', due_date: draft.due_date || '',
    subtotal: draft.subtotal || 0, tax_amount: draft.tax_amount || 0, total_amount: draft.total_amount || 0,
    tds_amount: draft.tds_amount || 0,
    matched_vendor: draft.matched_vendor || null,
    // Must be seeded from the draft: saveEdits sends it on EVERY save, so a
    // missing initial value would blank the freight sub-folder on any edit.
    freight_kind: draft.freight_kind || '',
    customer_name: draft.customer_name || '',
    matched_vendor_name: draft.matched_vendor_name || '',
    voucher_type: draft.voucher_type || '', category: draft.category || '',
    update_stock: !!draft.update_stock, warehouse: draft.warehouse || null, godown: draft.godown || null,
    // A BUNDLE is always a goods bill (its freight is the bundle card), so never
    // open it in freight-advice mode — even if a stray tick once saved otherwise.
    is_freight_bill: !!draft.is_freight_bill && !draft.is_bundle, freight_amount: draft.freight_amount || 0,
    freight_invoice_no: draft.freight_invoice_no || '', freight_invoice_date: draft.freight_invoice_date || '',
    freight_ref_no: draft.freight_ref_no || '', freight_linked_bill_no: draft.freight_linked_bill_no || '',
    // One freight slip → many goods bills (covered_bills). The reviewer builds this list.
    freight_covered_bills: draft.freight_covered_bills || [],
    freight_covered_bills_detail: draft.freight_covered_bills_detail || [],
    transporter: draft.transporter || null,
    transporter_name: draft.transporter_name || '',
    // Bundled purchase-freight (freight slip rode in the same PDF as this goods bill).
    is_bundle: !!draft.is_bundle,
    bundle_freight_amount: draft.bundle_freight_amount || 0,
    bundle_freight_tds: draft.bundle_freight_tds || 0,
    bundle_freight_roundoff: draft.bundle_freight_roundoff || 0,
    bundle_freight_no: draft.bundle_freight_no || '',
    bundle_freight_date: draft.bundle_freight_date || '',
    bundle_transporter_name: draft.bundle_transporter_name || '',
    bundle_vehicle_no: draft.bundle_vehicle_no || '',
    bundle_bank_name: draft.bundle_bank_name || '',
    bundle_bank_acc: draft.bundle_bank_acc || '',
    bundle_bank_ifsc: draft.bundle_bank_ifsc || '',
    // DC (branch-transfer) details — reviewer confirms; dc_value is reference only.
    is_dc: !!draft.is_dc,
    dc_no: draft.dc_no || '', dc_from: draft.dc_from || '', dc_to: draft.dc_to || '',
    dc_material: draft.dc_material || '', dc_value: draft.dc_value || 0,
    // An existing shared freight to link this bill to on approve (one slip, many bills).
    link_freight: draft.link_freight || null,
    link_freight_no: draft.link_freight_no || '',
    link_freight_transporter: draft.link_freight_transporter || '',
    // Extra charges on the bill (freight/loading/packing/round-off) — editable.
    charges: Array.isArray(draft.charges) ? draft.charges.map((c) => ({ ...c })) : [],
  });
  // "Link to existing freight" picker (one transporter slip covering several bills).
  const [lfq, setLfq] = useState('');
  const [lfopen, setLfopen] = useState(false);
  const [lfres, setLfres] = useState([]);
  useEffect(() => {
    if (!lfopen || !lfq.trim()) { setLfres([]); return undefined; }
    const t = setTimeout(async () => {
      try {
        const r = await apiClient.get(`/api/purchase/freight/search/?q=${encodeURIComponent(lfq.trim())}`);
        setLfres(r.data.results || []);
      } catch (e) {
        // A failed search must SAY so. This used to swallow the error and render an
        // empty list, so a deleted /freight/search/ endpoint looked like "no freight
        // found" for a day. Never let a broken request pass for an empty result.
        setLfres([]);
        toast.error(e?.response?.status === 404
          ? 'Freight search is unavailable (endpoint missing). Tell IT.'
          : 'Could not search freight. Check your connection and try again.');
      }
    }, 250);
    return () => clearTimeout(t);
  }, [lfq, lfopen]);
  const pickLinkFreight = (fa) => {
    setF((p) => ({ ...p, link_freight: fa.id, link_freight_no: fa.advice_no, link_freight_transporter: fa.transporter_name }));
    setLfopen(false); setLfq('');
    saveEdits({ link_freight: fa.id }).then(() => toast.success(`Linked to freight ${fa.advice_no}`)).catch(() => toast.error('Could not link the freight.'));
  };
  const unlinkFreight = () => {
    setF((p) => ({ ...p, link_freight: null, link_freight_no: '', link_freight_transporter: '' }));
    saveEdits({ link_freight: null }).catch(() => {});
  };
  const [lines, setLines] = useState(Array.isArray(draft.lines) ? draft.lines : []);
  // Once freight has been enabled (via the toggle), keep BOTH tabs clickable for
  // the rest of the review — so you can flip Goods<->Freight to verify before
  // confirming without the Freight tab locking you back out.
  const [freightUnlocked, setFreightUnlocked] = useState(!!draft.is_freight_bill && !draft.is_bundle);
  useEffect(() => { if (f.is_freight_bill) setFreightUnlocked(true); }, [f.is_freight_bill]);
  const [busy, setBusy] = useState(false);
  const [vq, setVq] = useState('');
  const [vres, setVres] = useState([]);
  const [vopen, setVopen] = useState(false);
  const [creatingVendor, setCreatingVendor] = useState(false);
  const [trq, setTrq] = useState('');
  const [trres, setTrres] = useState([]);
  const [tropen, setTropen] = useState(false);
  const [creatingTr, setCreatingTr] = useState(false);
  const [blq, setBlq] = useState('');       // freight → bill manual link search
  const [blres, setBlres] = useState([]);
  const [existingBill, setExistingBill] = useState(null);   // the duplicate bill to merge into
  const [mergeConfirmed, setMergeConfirmed] = useState(false);   // must confirm before Merge enables
  const [pOpen, setPOpen] = useState(null);   // index of the line whose product picker is open
  const [pAnchor, setPAnchor] = useState(null);   // {top,left} — fixed position so it escapes the table's scroll clip
  const [pq, setPq] = useState('');
  const [pres, setPres] = useState([]);
  const [preview, setPreview] = useState(null);   // { url, type } — this bill's photo, shown inline
  const [previewErr, setPreviewErr] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  // Manual freight bill (uploaded separately from the emailed goods bill).
  const [freightDocUrl, setFreightDocUrl] = useState(draft.freight_doc_url || null);
  const [freightDocName, setFreightDocName] = useState(draft.freight_doc_name || '');
  const [freightPreview, setFreightPreview] = useState(null);   // { url, type }
  const [freightUploading, setFreightUploading] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (!vopen || !vq.trim()) { setVres([]); return undefined; }
    const t = setTimeout(async () => {
      try {
        const r = await apiClient.get(`${API}/vendors/?company=${companyId}&q=${encodeURIComponent(vq.trim())}`);
        setVres(r.data.results || []);
      } catch { setVres([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [vq, vopen, companyId]);

  // Freight → bill manual link: search purchase bills to link this freight to.
  useEffect(() => {
    if (!blq.trim()) { setBlres([]); return undefined; }
    const t = setTimeout(async () => {
      try {
        const r = await apiClient.get(`${API}/bill-search/?q=${encodeURIComponent(blq.trim())}`);
        setBlres(r.data || []);
      } catch { setBlres([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [blq]);

  const linkBill = async (b) => {
    try {
      await apiClient.patch(`${API}/drafts/${draft.id}/`, { freight_linked_bill: b.id });
      setF((p) => ({ ...p, freight_linked_bill_no: b.bill_no }));
      setBlq(''); setBlres([]);
      toast.success(`Freight will link to bill ${b.bill_no} on approve.`);
    } catch (e) { toast.error(e.response?.data?.detail || 'Could not link the bill.'); }
  };
  // One freight slip covering MANY goods bills — add/remove from freight_covered_bills.
  const addCoveredBill = async (b) => {
    if ((f.freight_covered_bills || []).includes(b.id)) { setBlq(''); setBlres([]); return; }
    const ids = [...(f.freight_covered_bills || []), b.id];
    try {
      const r = await apiClient.patch(`${API}/drafts/${draft.id}/`, { freight_covered_bills: ids });
      setF((p) => ({ ...p, freight_covered_bills: ids,
        freight_covered_bills_detail: r.data.freight_covered_bills_detail || p.freight_covered_bills_detail }));
      setBlq(''); setBlres([]);
      toast.success(`Added bill ${b.bill_no} — covered by this freight.`);
    } catch (e) { toast.error(errText(e) || 'Could not add the bill.'); }
  };
  const removeCoveredBill = async (id) => {
    const ids = (f.freight_covered_bills || []).filter((x) => x !== id);
    try {
      const r = await apiClient.patch(`${API}/drafts/${draft.id}/`, { freight_covered_bills: ids });
      setF((p) => ({ ...p, freight_covered_bills: ids,
        freight_covered_bills_detail: r.data.freight_covered_bills_detail || (p.freight_covered_bills_detail || []).filter((d) => d.id !== id) }));
    } catch (e) { toast.error(errText(e) || 'Could not remove the bill.'); }
  };
  const unlinkBill = async () => {
    try {
      await apiClient.patch(`${API}/drafts/${draft.id}/`, { freight_linked_bill: null });
      setF((p) => ({ ...p, freight_linked_bill_no: '' }));
    } catch { toast.error('Could not unlink.'); }
  };

  useEffect(() => {
    if (!tropen || !trq.trim()) { setTrres([]); return undefined; }
    const t = setTimeout(async () => {
      try {
        const r = await apiClient.get(`${API}/transporters/?q=${encodeURIComponent(trq.trim())}`);
        setTrres(r.data.results || []);
      } catch { setTrres([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [trq, tropen]);

  useEffect(() => {
    if (pOpen === null || !pq.trim()) { setPres([]); return undefined; }
    const t = setTimeout(async () => {
      try {
        const r = await apiClient.get(`${API}/products/?q=${encodeURIComponent(pq.trim())}`);
        setPres(r.data.results || []);
      } catch { setPres([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [pq, pOpen]);

  // Load the existing (duplicate) bill so the reviewer can SEE it before merging.
  useEffect(() => {
    if (!draft.existing_bill_id) { setExistingBill(null); return; }
    let alive = true;
    apiClient.get(`${API}/drafts/${draft.id}/existing-bill/`)
      .then((r) => { if (alive && r.data && r.data.exists) setExistingBill(r.data); })
      .catch(() => {});
    return () => { alive = false; };
  }, [draft.existing_bill_id, draft.id]);

  const toggleFile = async () => {
    if (preview) { setPreview(null); setPreviewErr(''); return; }   // keep cached blob for instant re-open
    setPreviewErr('');
    const cached = docBlobCache.get(draft.doc_id);
    if (cached) { setPreview(cached); return; }                     // already downloaded → instant
    setPreviewLoading(true);
    try {
      // Big PDF scans over a slow link can take a while — don't fall back to the
      // 30s default (which showed as 'timeout of 30000ms exceeded').
      const r = await apiClient.get(`${API}/docs/${draft.doc_id}/file/`, { responseType: 'blob', timeout: 180000 });
      if (!r.data || r.data.size === 0) { setPreviewErr('The bill file is empty or missing on the server.'); return; }
      const obj = { url: URL.createObjectURL(r.data), type: r.data.type || '' };
      docBlobCache.set(draft.doc_id, obj);   // download once, reuse for every row of this PDF
      setPreview(obj);
    } catch (e) {
      setPreviewErr(e.response?.status === 404 ? 'Bill file not found on the server.'
        : (e.code === 'ECONNABORTED' ? 'The bill is taking too long to download — try again, or use "open in tab".'
          : (e.message || 'Could not load the bill photo.')));
    } finally { setPreviewLoading(false); }
  };
  const openInTab = () => { if (preview) window.open(`${preview.url}#page=${viewPage}`, '_blank'); };

  // Load the uploaded freight bill as an auth blob → object URL for inline preview.
  const loadFreightPreview = async (url) => {
    const u = url || freightDocUrl;
    if (!u) return;
    try {
      const r = await apiClient.get(u, { responseType: 'blob', timeout: 180000 });
      setFreightPreview({ url: URL.createObjectURL(r.data), type: r.data.type || '' });
    } catch { toast.error('Could not load the freight bill.'); }
  };
  const uploadFreightDoc = async (file) => {
    if (!file) return;
    setFreightUploading(true);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await apiClient.post(`${API}/drafts/${draft.id}/freight-doc/`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000,
      });
      setFreightDocUrl(r.data.freight_doc_url); setFreightDocName(r.data.freight_doc_name);
      // Merge the details the AI read off the freight slip.
      setF((p) => ({ ...p, is_freight_bill: true,
        transporter: r.data.transporter || p.transporter,
        transporter_name: r.data.transporter_name || p.transporter_name,
        freight_invoice_no: r.data.freight_invoice_no || p.freight_invoice_no,
        freight_invoice_date: r.data.freight_invoice_date || p.freight_invoice_date,
        freight_amount: (Number(r.data.freight_amount) || 0) || p.freight_amount,
        tds_amount: (Number(r.data.tds_amount) || 0) || p.tds_amount,
        freight_ref_no: r.data.freight_ref_no || p.freight_ref_no,
        freight_linked_bill_no: r.data.freight_linked_bill_no || p.freight_linked_bill_no,
      }));
      loadFreightPreview(r.data.freight_doc_url);
      toast.success('Freight bill read — details filled below.');
    } catch (e) { toast.error(e.response?.data?.detail || 'Upload failed.'); }
    finally { setFreightUploading(false); }
  };

  // ---- pages of this bill -------------------------------------------------
  // The reader's pick, corrected by the reviewer. Saved on every toggle (the
  // server also strips the page off any other draft of the same document, so a
  // page can only ever belong to one bill).
  // Customer picker for OUTWARD freight — same shape as the transporter one, so
  // the card reads as one design instead of a native browser dropdown.
  const [custopen, setCustopen] = useState(false);
  const [custq, setCustq] = useState('');
  const [pageSel, setPageSel] = useState(() => (draft.pages || []).map(Number).sort((a, b) => a - b));
  // The page the viewer below is showing. Starts on this bill's OWN first page,
  // because opening a 30-page PDF at page 1 and scrolling to 17 every time is
  // the thing being complained about.
  const [viewPage, setViewPage] = useState(() => ((draft.pages || []).map(Number).sort((a, b) => a - b)[0]) || 1);
  const autoPages = useRef((draft.pages || []).map(Number).sort((a, b) => a - b));
  const pagesEdited = pageSel.join(',') !== autoPages.current.join(',');

  // "3–4" for a run, "3, 6" when split — the way a person reads page numbers.
  const pageLabel = (ns) => {
    if (!ns.length) return '—';
    const out = []; let a = ns[0], b = ns[0];
    for (let i = 1; i <= ns.length; i++) {
      if (ns[i] === b + 1) { b = ns[i]; continue; }
      out.push(a === b ? String(a) : `${a}–${b}`);
      a = b = ns[i];
    }
    return out.join(', ');
  };

  const pushPages = (next) => {
    setPageSel(next);
    // No list refetch here: a reload on every tick would fight the clicking. The
    // server is the authority — it strips the page from whichever draft held it,
    // and the other cards show that on their next load.
    saveEdits({ pages: next })
      .catch((e) => {
        // Say WHAT failed. A bare message sent us hunting for a bug that wasn't
        // there: the real cause was the dev server restarting mid-request.
        const code = e?.response?.status;
        toast.error(
          !code ? 'Could not save — the server did not respond. Try again.'
          : code === 404 ? 'This bill is no longer in the inbox — reload the page.'
          : `Could not save the page selection (error ${code}).`);
      });
  };
  const togglePage = (n) => pushPages(
    pageSel.includes(n) ? pageSel.filter((x) => x !== n) : [...pageSel, n].sort((a, b) => a - b));
  const resetPages = () => pushPages([...autoPages.current]);

  // ---- move this bill to another folder -----------------------------------
  // The reader guesses the folder from the subject and the file name, and it can
  // guess wrong — "sometimes you might have fetched it incorrectly". Moving is one
  // save: the folder decides is_freight_bill + category, and for freight the
  // sub-folder decides freight_kind (which is what sends it to the Inward,
  // Outward or Local page on approve).
  const moveTo = (folder, sub) => {
    const payload = folder === 'FREIGHT'
      ? { is_freight_bill: true, freight_kind: sub || f.freight_kind || 'LOCAL' }
      : { is_freight_bill: false, freight_kind: '',
          category: folder === 'FRUIT' ? 'FRUIT' : folder === 'EXPENSE' ? 'EXPENSES' : (f.category && f.category !== 'FRUIT' && f.category !== 'EXPENSES' && f.category !== 'LAB_EXPENSE' ? f.category : 'RM') };
    setF((p) => ({ ...p, ...payload }));
    saveEdits(payload)
      .then(() => { toast.success(`Moved to ${sub ? `${folder} · ${sub}` : folder}.`); onDone && onDone(); })
      .catch(() => toast.error('Could not move this bill.'));
  };

  // The bill already exists (e.g. imported from Tally) and only its PDF was
  // missing. Attach the document to it and change nothing else - Merge would
  // overwrite that bill's amounts and lines with what the AI read.
  const [attaching, setAttaching] = useState(false);
  const attachToExisting = async () => {
    setAttaching(true);
    try {
      const r = await apiClient.post(`${API}/drafts/${draft.id}/attach/`, {});
      toast.success(`PDF attached to bill ${r.data?.bill_no || draft.duplicate_of} — bill unchanged.`);
      onDone && onDone();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not attach the PDF.');
    } finally { setAttaching(false); }
  };

  const saveEdits = async (override = {}) => {
    const payload = {
      vendor_name: f.vendor_name, vendor_gstin: f.vendor_gstin, invoice_no: f.invoice_no,
      invoice_date: f.invoice_date || null, due_date: f.due_date || null, subtotal: f.subtotal, tax_amount: f.tax_amount,
      total_amount: f.total_amount, tds_amount: f.tds_amount, matched_vendor: f.matched_vendor,
      voucher_type: f.voucher_type, category: f.category,
      update_stock: f.update_stock, warehouse: f.warehouse, godown: f.godown,
      is_freight_bill: f.is_freight_bill, freight_amount: f.freight_amount,
      freight_invoice_no: f.freight_invoice_no, freight_invoice_date: f.freight_invoice_date || null,
      freight_ref_no: f.freight_ref_no,
      bundle_freight_amount: f.bundle_freight_amount, bundle_freight_tds: f.bundle_freight_tds,
      bundle_freight_roundoff: f.bundle_freight_roundoff,
      link_freight: f.link_freight,
      pages: pageSel,
      freight_kind: f.freight_kind || '',
      customer_name: f.customer_name || '',
      bundle_freight_no: f.bundle_freight_no, bundle_freight_date: f.bundle_freight_date || null,
      bundle_transporter_name: f.bundle_transporter_name, bundle_vehicle_no: f.bundle_vehicle_no,
      bundle_bank_name: f.bundle_bank_name, bundle_bank_acc: f.bundle_bank_acc, bundle_bank_ifsc: f.bundle_bank_ifsc,
      charges: f.charges,
      transporter: f.transporter,
      is_dc: f.is_dc,
      dc_no: f.dc_no, dc_from: f.dc_from, dc_to: f.dc_to, dc_material: f.dc_material, dc_value: f.dc_value,
      ...override,
    };
    const r = await apiClient.patch(`${API}/drafts/${draft.id}/`, payload);
    return r.data;
  };

  // First word of the bill's text — a good default search so the picker opens
  // with related matches instead of a blank list.
  const kw = (s) => (s || '').trim().split(/\s+/)[0] || '';
  // Godowns of the currently-picked warehouse (client-side cascade).
  const godowns = (locations.find((w) => String(w.id) === String(f.warehouse))?.godowns) || [];

  // Save the per-line product decisions back to the draft (persists across
  // refresh). A line is "resolved" once it's mapped to a product or marked to
  // be created — until then it blocks Approve/Merge, so nothing is guessed.
  const saveLines = async (next) => {
    setLines(next);
    try { await apiClient.patch(`${API}/drafts/${draft.id}/`, { lines: next }); }
    catch { toast.error('Could not save the product choice.'); }
  };
  const setLine = (i, patch) => { const next = lines.map((l, j) => (j === i ? { ...l, ...patch } : l)); saveLines(next); };
  // Add a blank item line the scan missed — the reviewer fills it in and maps /
  // creates its product (or flags it a charge). `manual` keeps the row visible
  // while still empty (otherwise blank lines are hidden). Remove undoes a mistake.
  const addItemLine = () => saveLines([...lines, { description: '', qty: '', uom: '', rate: '', amount: '', manual: true }]);
  const removeLine = (i) => saveLines(lines.filter((_, j) => j !== i));
  const mapProduct = (i, prod) => {
    setLine(i, { product_id: prod.id, product_name: prod.name, product_action: 'map' });
    setPOpen(null); setPq('');
  };
  // Create the item master NOW (not deferred to Approve) and map this line to it,
  // so it shows in Masters and the same item auto-maps on the next drafts.
  const createProduct = async (i) => {
    const desc = (lines[i].description || '').trim();
    const name = ((lines[i].product_name || '').trim() || desc);
    if (!name) { toast.error('No product name on the line to create.'); return; }
    try {
      const r = await apiClient.post(`${API}/products/create/`, {
        company: companyId, name, uom: lines[i].uom || '', description: desc,
      });
      // Remember a NEWLY-created product on the line, so reverting this bill can
      // delete it again. Reusing an existing product leaves this unset (never deleted).
      setLine(i, { product_id: r.data.id, product_name: r.data.name, product_action: 'map', product_created: r.data.created ? r.data.id : null });
      toast.success(r.data.created ? `Product "${r.data.name}" created & mapped.` : `Mapped to existing product "${r.data.name}".`);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not create the product.');
    }
  };
  // Anchor the picker below the clicked button, in viewport coords, so `position:fixed`
  // lifts it out of the item-lines table's overflow container (which was clipping it).
  const anchorAt = (ev) => {
    if (!ev || !ev.currentTarget) return;
    const r = ev.currentTarget.getBoundingClientRect();
    setPAnchor({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 296)) });
  };
  const resetProduct = (i, ev) => { anchorAt(ev); setLine(i, { product_id: null, product_name: '', product_action: '' }); setPOpen(i); setPq(kw(lines[i]?.description)); };
  const openProduct = (i, desc, ev) => {
    const open = pOpen === i ? null : i;
    if (open !== null) anchorAt(ev);
    setPOpen(open); setPq(open === null ? '' : kw(desc));
  };
  const openVendor = () => { if (!vopen) setVq(kw(f.vendor_name)); setVopen((o) => !o); };

  // Short SS/UAI badge for a company id (for the selected-vendor pill).
  const coTag = (id) => {
    const c = (companies || []).find((x) => String(x.value) === String(id));
    const nm = (c?.label || '').toLowerCase();
    if (nm.includes('biochem') || nm.includes('bio chem')) return 'SS';
    if (nm.includes('united agro')) return 'UAI';
    return (c?.label || '').split(/\s+/)[0] || '';
  };

  // Pick a vendor from the (cross-company) results. If it belongs to a DIFFERENT
  // company than the draft, move the draft to that company too, so the bill books
  // under the right company (vendors are per-company).
  const pickVendor = async (v) => {
    set('matched_vendor', v.id); set('matched_vendor_name', v.name); setVopen(false); setVq('');
    const cross = v.company_id && String(v.company_id) !== String(draft.company);
    try {
      if (cross) {
        await apiClient.patch(`${API}/drafts/${draft.id}/`, { company: v.company_id, matched_vendor: v.id });
        toast.success(`Vendor saved · draft moved to ${v.company_tag || 'its company'}`);
        onCompanyChange && onCompanyChange(v.company_id);
      } else {
        await saveEdits({ matched_vendor: v.id });
        toast.success('Vendor saved');
      }
    } catch { toast.error('Could not save the vendor.'); }
  };

  // Correct the buyer company when the email routing guessed wrong. Changing it
  // re-scopes the vendor picker (vendors are per-company) and follows the draft
  // to the right tab so it stays open for review.
  const changeCompany = async (newId) => {
    if (!newId || String(newId) === String(draft.company)) return;
    try {
      const r = await apiClient.patch(`${API}/drafts/${draft.id}/`, { company: newId });
      const d = r.data || {};
      // Reflect the server's re-resolved vendor in the card's local state: it may
      // have auto-linked the matching vendor in the new company, or cleared one
      // that belonged to the old company.
      setF((p) => ({ ...p, matched_vendor: d.matched_vendor || null, matched_vendor_name: d.matched_vendor_name || '' }));
      toast.success(d.matched_vendor
        ? `Company updated — vendor auto-linked: ${d.matched_vendor_name}`
        : 'Company updated — pick the vendor (now scoped to this company).');
      onCompanyChange && onCompanyChange(newId);   // parent switches tab + reloads
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not change the company.');
    }
  };

  // A freight/transport line that isn't mapped to a real product is auto-tracked
  // as a charge — it needs no product decision and never blocks approve.
  const isFreightLine = (l) => !l.product_id && FREIGHT_LINE_RE.test((l.description || '').trim());
  // A line is a CHARGE (not a product) when the operator flipped its toggle, or
  // it's an untouched freight line (auto-detected). Charges book on the bill as
  // charges, never products.
  const lineIsCharge = (l) => l.is_charge === true || (l.is_charge == null && isFreightLine(l));
  const resolved = (l) => lineIsCharge(l) || l.product_action === 'create' || !!l.product_id;
  const itemLines = lines.filter((l) => l && (l.description || '').trim());
  const unresolvedCount = itemLines.filter((l) => !resolved(l)).length;

  // Vendor + voucher type + category + a decision on every item line are all
  // required before a bill is written. A freight bill needs NOTHING extra — it can
  // go straight to Inward Freight with no vendor/transporter (e.g. an inward
  // delivery challan). Pick a transporter only if there's one to pay.
  const missing = () => {
    if (f.is_freight_bill) {
      return '';
    }
    if (!f.matched_vendor) return 'Pick a vendor first.';
    if (!f.voucher_type) return 'Pick a voucher type first.';
    if (!f.category) return 'Pick a category first.';
    if (!f.warehouse) return 'Pick a warehouse first.';
    if (unresolvedCount > 0) return `Map or create a product for ${unresolvedCount} item line${unresolvedCount > 1 ? 's' : ''} first.`;
    if (f.update_stock && !f.warehouse) return 'Pick a warehouse (Update stock is on).';
    if (f.update_stock && !f.godown) return 'Pick a godown (Update stock is on).';
    return '';
  };
  const gate = missing();

  const createVendor = async () => {
    const name = (f.vendor_name || '').trim();
    if (!name) { toast.error('No vendor name on the bill to create from.'); return; }
    setCreatingVendor(true);
    try {
      const r = await apiClient.post(`${API}/vendors/create/`, { company: companyId, name, gstin: f.vendor_gstin });
      set('matched_vendor', r.data.id); set('matched_vendor_name', r.data.name);
      await saveEdits({ matched_vendor: r.data.id });
      const extra = r.data.applied > 1 ? ` · applied to ${r.data.applied} bills from this vendor` : '';
      toast.success((r.data.existing ? `Linked existing vendor: ${r.data.name}` : `Vendor created: ${r.data.name}`) + extra);
      // Reload so other pending bills from the same vendor now show it as matched.
      if (r.data.applied > 1) onDone();
    } catch (e) { toast.error(e.response?.data?.detail || 'Could not create the vendor.'); }
    finally { setCreatingVendor(false); }
  };

  // Transporter picker (freight bills).
  const openTransporter = () => { if (!tropen) setTrq(kw((f.is_bundle || f.is_freight_bill) ? f.bundle_transporter_name : f.vendor_name)); setTropen((o) => !o); };
  const pickTransporter = (t) => {
    // Set both name fields so it works for a freight bill and a bundle (each reads
    // its own name field); the FK is what Approve uses to link (no name-guessing).
    set('transporter', t.id); set('transporter_name', t.name); set('bundle_transporter_name', t.name); setTropen(false); setTrq('');
    saveEdits({ transporter: t.id }).then(() => toast.success('Transporter saved')).catch((e) => toast.error(errText(e) || 'Could not save the transporter.'));
  };
  const createTransporter = async () => {
    // For a freight bill the transporter is its OWN party — use the transporter
    // name. On a freight bill the bill's GSTIN belongs to the transporter, so
    // carry it; on a goods bill that GSTIN is the goods supplier's, so drop it.
    const name = (((f.is_bundle || f.is_freight_bill) ? f.bundle_transporter_name : '') || f.transporter_name || f.vendor_name || '').trim();
    if (!name) { toast.error('Enter the transporter name first.'); return; }
    setCreatingTr(true);
    try {
      const r = await apiClient.post(`${API}/transporters/create/`, { company: companyId, name, gstin: f.is_freight_bill ? (f.vendor_gstin || '') : '' });
      set('transporter', r.data.id); set('transporter_name', r.data.name); set('bundle_transporter_name', r.data.name);
      await saveEdits({ transporter: r.data.id });
      toast.success(r.data.existing ? `Linked transporter: ${r.data.name}` : `Transporter created: ${r.data.name}`);
    } catch (e) { toast.error(e.response?.data?.detail || 'Could not create the transporter.'); }
    finally { setCreatingTr(false); }
  };
  const toggleFreightBill = (v) => {
    // Non-destructive: only flips the mode. The goods total (total_amount) and the
    // freight amount (freight_amount) are SEPARATE fields, so toggling never
    // mutates the goods total — it's preserved exactly when you switch back.
    setF((p) => ({ ...p, is_freight_bill: v }));
    saveEdits({ is_freight_bill: v }).catch(() => {});
  };

  // Freight copies the operator queues on the review card, uploaded to the
  // Freight Advice once it's approved (see doAction).
  const pendingFreightRef = useRef([]);

  const doAction = async (action) => {
    if (gate) { toast.error(gate); return; }
    setBusy(true);
    try {
      await saveEdits();
      const r = await apiClient.post(`${API}/drafts/${draft.id}/${action}/`, {});
      // Manually-attached freight copies land on the Freight Advice now that it
      // exists (r.data.bill_id is the FA id for a freight approve). The emailed
      // bill is auto-attached server-side; these are extra copies.
      if (r.data.freight && r.data.bill_id && pendingFreightRef.current.length) {
        try { await uploadPendingFiles('FREIGHT', r.data.bill_id, pendingFreightRef.current); }
        catch { toast.error('Freight Advice created, but a manual copy failed to upload — add it on the freight page.'); }
      }
      toast.success(r.data.freight
        ? `Freight Advice created: ${r.data.bill_no || ''}`
        : (f.is_freight_bill
          ? `Freight bill attached to bill ${r.data.bill_no || ''}`
          : (r.data.merged ? `Merged into ${r.data.bill_no || 'existing bill'}` : `Vendor Bill created: ${r.data.bill_no || ''}`)));
      onDone();
    } catch (e) { toast.error(errText(e) || `${action} failed.`); } finally { setBusy(false); }
  };
  const approve = () => doAction('approve');
  const merge = () => doAction('merge');

  const skip = async () => {
    setBusy(true);
    try { await apiClient.post(`${API}/drafts/${draft.id}/skip/`, {}); toast('Skipped'); onDone(); }
    catch { toast.error('Failed.'); } finally { setBusy(false); }
  };

  const inp = 'border border-slate-300 rounded-lg px-2 py-1.5 text-sm w-full';
  const lbl = 'text-[11px] uppercase tracking-wide text-slate-400 font-semibold';
  const adj = (Number(f.total_amount) || 0) - (Number(f.subtotal) || 0) - (Number(f.tax_amount) || 0);
  // Same state (company GSTIN state == vendor GSTIN state) -> CGST + SGST;
  // different state -> IGST. tax_amount stays the single combined value either
  // way — only the boxes split (same as Scan Invoice). Reacts as the GSTIN edits.
  const stateOf = (g) => { const s = String(g || '').trim(); return /^\d{2}/.test(s) ? s.slice(0, 2) : ''; };
  const interstate = (() => { const c = stateOf(draft.company_gstin), v = stateOf(f.vendor_gstin); return !!(c && v && c !== v); })();
  const halfTax = () => { const n = Number(f.tax_amount) || 0; return n ? String(n / 2) : ''; };
  const numCls = 'w-28 text-right tabular-nums border border-slate-300 rounded px-2 py-1 text-sm';

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Source + preview toggle */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-100 bg-slate-50/60">
        <button onClick={toggleFile} className="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:underline font-medium">
          {previewLoading ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />} {draft.doc_name || 'attachment'}
          <span className="text-[11px] text-slate-400">{preview ? '(hide)' : '(view bill)'}</span>
        </button>
        <span className="ml-auto flex items-center gap-1.5">
          {/* Wrong folder? Move it — no need to re-fetch or re-read the email. */}
          <select
            value={f.is_freight_bill ? 'FREIGHT' : ((f.category === 'FRUIT' && 'FRUIT') || ((f.category === 'EXPENSES' || f.category === 'LAB_EXPENSE') && 'EXPENSE') || 'PURCHASE')}
            onChange={(e) => moveTo(e.target.value)}
            title="Move this bill to another folder"
            className="text-[11px] border border-slate-300 bg-white rounded-md px-1.5 py-1 text-slate-600 hover:border-slate-400">
            <option value="PURCHASE">🧾 Purchase</option>
            <option value="EXPENSE">💡 Expense</option>
            <option value="FRUIT">🍎 Fruit</option>
            <option value="FREIGHT">🚚 Freight</option>
          </select>
          {f.is_freight_bill && (
            <select value={f.freight_kind || 'LOCAL'} onChange={(e) => moveTo('FREIGHT', e.target.value)}
              title="Inward (SRA…) · Outward (Z…) · Local (anything else)"
              className="text-[11px] border border-teal-300 bg-white rounded-md px-1.5 py-1 text-teal-700 hover:border-teal-400">
              <option value="INWARD">↙ Inward</option>
              <option value="OUTWARD">↗ Outward</option>
              <option value="LOCAL">🚚 Local</option>
            </select>
          )}
          {/* DC — only for a LOCAL freight: tags the created LocalFreight as an
              internal branch-transfer delivery challan (e.g. SLP→NKP). */}
          {f.is_freight_bill && (f.freight_kind || 'LOCAL') === 'LOCAL' && (
            <label className={`flex items-center gap-1 text-[11px] font-medium cursor-pointer select-none rounded-md px-1.5 py-1 border ${f.is_dc ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-slate-300 text-slate-500'}`}
              title="Delivery Challan — internal branch transfer (e.g. SLP→NKP)">
              <input type="checkbox" checked={!!f.is_dc}
                onChange={(e) => {
                  const on = e.target.checked; set('is_dc', on);
                  // Server auto-fills the DC goods details on toggle — pull them back so the reviewer just confirms.
                  saveEdits({ is_dc: on }).then((d) => {
                    if (d && on) setF((p) => ({ ...p, dc_no: d.dc_no || p.dc_no, dc_from: d.dc_from || p.dc_from, dc_to: d.dc_to || p.dc_to, dc_material: d.dc_material || p.dc_material, dc_value: d.dc_value || p.dc_value }));
                  }).catch(() => {});
                }}
                className="w-3.5 h-3.5 rounded border-amber-400 text-amber-600 focus:ring-amber-500" />
              DC
            </label>
          )}
          {/* DC goods details — auto-filled from the parse, reviewer confirms. These
              are kept for reference on the Local Freight record; the goods value is
              NEVER booked (only the freight amount is). */}
          {f.is_freight_bill && (f.freight_kind || 'LOCAL') === 'LOCAL' && f.is_dc && (
            <span className="flex flex-wrap items-center gap-1 text-[11px]">
              <input value={f.dc_from || ''} onChange={(e) => set('dc_from', e.target.value)} onBlur={() => saveEdits().catch(() => {})} placeholder="From"
                title="From (sending party / warehouse)" className="w-24 border border-amber-200 bg-amber-50/40 rounded px-1 py-0.5" />
              <span className="text-amber-500">→</span>
              <input value={f.dc_to || ''} onChange={(e) => set('dc_to', e.target.value)} onBlur={() => saveEdits().catch(() => {})} placeholder="To"
                title="To (receiving party / warehouse)" className="w-24 border border-amber-200 bg-amber-50/40 rounded px-1 py-0.5" />
              <input value={f.dc_material || ''} onChange={(e) => set('dc_material', e.target.value)} onBlur={() => saveEdits().catch(() => {})} placeholder="Material"
                title="Material / product (branch transfer)" className="w-24 border border-amber-200 bg-amber-50/40 rounded px-1 py-0.5" />
              <input value={f.dc_value || ''} onChange={(e) => set('dc_value', e.target.value)} onBlur={() => saveEdits().catch(() => {})} placeholder="Goods ₹"
                title="Goods value — reference only, NOT booked" className="w-20 border border-amber-200 bg-amber-50/40 rounded px-1 py-0.5" />
            </span>
          )}
          <span className="text-[11px] text-slate-400 truncate max-w-[220px]" title={`${draft.subject} · ${draft.from_addr}`}>{draft.from_addr}</span>
        </span>
      </div>

      <div className="p-4">
        {/* Already booked: the same vendor's invoice is already a bill. Approving
            would make a SECOND bill and count the purchase twice - the server now
            refuses, but say it here first so nobody is surprised by the refusal. */}
        {draft.duplicate_of && (
          <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2.5 text-[12.5px] text-rose-800">
            <b>Already booked</b> — invoice <b>{draft.invoice_no}</b> from this vendor is bill{' '}
            <b>{draft.duplicate_of}</b>. Approving would count the purchase twice.
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <button type="button" onClick={attachToExisting} disabled={attaching}
                className="inline-flex items-center gap-1 text-[12px] font-semibold bg-white border border-rose-300 text-rose-700 rounded-md px-2.5 py-1 hover:bg-rose-100 disabled:opacity-60">
                {attaching ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
                Attach this PDF to bill {draft.duplicate_of}
              </button>
              <span className="text-[11.5px] text-rose-700/80">
                if the bill was missing its document — the bill itself is not changed.
                Otherwise just remove this card with ✕.
              </span>
            </div>
          </div>
        )}
        {/* PAGES OF THIS BILL — one emailed PDF normally holds several bills, so each
            one keeps only its own page(s). The reader picks them; this is where the
            reviewer confirms or corrects. Same control for a goods, expense or
            freight bill — only where the pages end up differs. Hidden for a
            single-page file, where there is nothing to choose. */}
        {(draft.doc_page_count || 0) > 1 && (
          <div className="mb-4 rounded-lg border border-teal-200 bg-teal-50/60 px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-2 mb-2">
              <span className="text-[10px] font-semibold tracking-wider uppercase text-teal-700">Pages of this bill</span>
              <span className="text-[11px] text-slate-500 flex-1 min-w-0">
                {draft.doc_page_count} pages — tap a number to see it below; tick ✓ to put it on{' '}
                {f.is_freight_bill ? 'this freight slip' : (f.invoice_no || 'this bill')}.
              </span>
              <span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 border ${
                !pageSel.length ? 'border-amber-300 bg-amber-50 text-amber-700'
                : pagesEdited ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                : 'border-slate-300 bg-white text-slate-500'}`}>
                {!pageSel.length ? 'nothing picked' : pagesEdited ? 'edited' : 'auto'}
              </span>
            </div>
            {/* A tight strip of page numbers. The old version drew a picture tile per
                page, so a 30-page PDF filled most of the screen before the bill's own
                fields. Tap a number to VIEW that page below; the tick box chooses
                whether the page belongs to this bill — looking must never change what
                the bill stores. */}
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: draft.doc_page_count }, (_, i) => i + 1).map((n) => {
                const on = pageSel.includes(n);
                const heldBy = (draft.pages_taken || {})[String(n)];
                const showing = viewPage === n;
                return (
                  <span key={n}
                    title={on ? `Page ${n} — on this bill` : heldBy ? `Page ${n} — on ${heldBy}` : `Page ${n} — not on any bill`}
                    className={`inline-flex items-center rounded-md border text-[11px] leading-none overflow-hidden ${
                      on ? 'border-teal-500 bg-white' : heldBy ? 'border-slate-200 bg-slate-50 opacity-70' : 'border-amber-300 bg-amber-50'}
                      ${showing ? 'ring-2 ring-indigo-400' : ''}`}>
                    {/* A real picture of the page, so you can SEE which one holds the
                        bill instead of tapping through 31 numbers. Kept deliberately
                        tiny — ~2.7 KB each, lazy so only the ones on screen are
                        fetched, and the server draws each page once then caches it. */}
                    <button type="button" onClick={() => { setViewPage(n); if (!preview) toggleFile(); }}
                      className={`relative block hover:opacity-80 ${showing ? '' : ''}`}>
                      <img
                        src={`${API}/docs/${draft.doc_id}/page/${n}/thumb/`}
                        alt={`Page ${n}`} loading="lazy" width={34} height={44}
                        className="block w-[34px] h-[44px] object-cover object-top bg-white"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                      <span className={`absolute bottom-0 inset-x-0 text-center text-[9px] font-bold tabular-nums leading-[11px] ${
                        on ? 'bg-teal-600 text-white' : heldBy ? 'bg-slate-500/80 text-white' : 'bg-amber-500/90 text-white'}`}>
                        {n}
                      </span>
                    </button>
                    <button type="button" onClick={() => togglePage(n)} aria-pressed={on}
                      title={on ? 'Remove this page from the bill' : 'Add this page to the bill'}
                      className={`w-4 h-[44px] grid place-items-center text-[9px] font-bold border-l ${
                        on ? 'bg-teal-600 border-teal-600 text-white' : 'bg-white border-slate-200 text-slate-300 hover:text-slate-500'}`}>
                      ✓
                    </button>
                  </span>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-slate-600">
              <span className="flex-1 min-w-0">
                {pageSel.length
                  ? <>Stores <b className="font-mono text-teal-700">page {pageLabel(pageSel)}</b> — {pageSel.length} page{pageSel.length > 1 ? 's' : ''} cut out of the PDF.</>
                  : <span className="text-amber-700 font-semibold">No page picked — this bill would be saved with no document.</span>}
              </span>
              <button type="button" onClick={resetPages}
                className="text-[11px] border border-slate-300 rounded-md px-2 py-1 bg-white hover:border-slate-400">
                Back to auto
              </button>
            </div>
          </div>
        )}

        {/* Bill TYPE — a MANUAL selector at the top of every card. Auto-detect (from
            the email subject) sets it; you can change it here per bill, always. Hidden
            only for a BUNDLE (always a goods bill with attached freight). */}
        {!f.is_bundle && (
        <div className="mb-3 flex items-center gap-3 flex-wrap">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Type</span>
          <div className="inline-flex bg-slate-100 border border-slate-200 rounded-lg p-0.5 gap-0.5">
            <button type="button" onClick={() => { setFreightUnlocked(true); toggleFreightBill(false); }}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold transition ${!f.is_freight_bill ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              🧾 Goods bill
            </button>
            <button type="button" onClick={() => { setFreightUnlocked(true); toggleFreightBill(true); }}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold transition inline-flex items-center gap-1.5 ${f.is_freight_bill ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              🚚 Freight bill
            </button>
          </div>
          <span className="text-[11px] text-slate-400">{f.is_freight_bill ? '→ creates ONLY a Freight Advice; no products / stock' : 'goods / expense bill — auto-detected; change here if wrong'}</span>
        </div>
        )}
        {previewErr && (
          <div className="mb-3 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">⚠ {previewErr}</div>
        )}
        {previewLoading && !preview && (
          <div className="mb-3 border border-slate-200 rounded-lg bg-slate-50 flex items-center justify-center h-40 text-slate-500 text-sm">
            <Loader2 size={18} className="animate-spin mr-2" /> Loading bill… (large PDFs take a moment the first time)
          </div>
        )}
        {preview && (
          <div className="mb-3 border border-slate-200 rounded-lg overflow-hidden bg-slate-100 relative">
            <button onClick={openInTab} className="absolute top-1.5 right-1.5 z-10 text-[11px] bg-white/90 border border-slate-200 rounded px-1.5 py-0.5 hover:bg-white">open in tab ↗</button>
            {(preview.type.includes('pdf') || /\.pdf$/i.test(draft.doc_name || '')) ? (
              /* #page= tells the browser's PDF viewer where to open. keyed on the page
                 so picking another number reloads the frame at it. */
              <iframe key={viewPage} src={`${preview.url}#page=${viewPage}&view=FitH`}
                title={draft.doc_name || 'bill'} className="w-full h-[460px]"
                onError={() => setPreviewErr('Could not display the PDF inline — use "open in tab".')} />
            ) : (
              <img src={preview.url} alt={draft.doc_name || 'bill'} className="block w-full max-h-[460px] object-contain mx-auto"
                onError={() => { setPreviewErr('Could not display this file as an image — use "open in tab" (it may be a different file type).'); setPreview(null); }} />
            )}
          </div>
        )}

        {/* Bundled purchase-freight: the freight slip rode in this PDF with the
            goods bill. Approve merges the goods bill AND attaches this freight. */}
        {((f.is_bundle && !['EXPENSES', 'LAB_EXPENSE', 'MACHINERY'].includes(f.category)) || f.is_freight_bill) && (
          <div className="mb-4 rounded-xl border border-teal-200 bg-teal-50/60 p-3.5">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wide bg-teal-100 text-teal-700 rounded px-2 py-0.5">🚚 {f.is_bundle ? 'Freight (bundled)'
                  : f.freight_kind === 'OUTWARD' ? 'Outward freight details'
                  : f.freight_kind === 'LOCAL' ? 'Local freight details'
                  : 'Inward freight details'}</span>
              <span className="text-[12px] text-teal-800">{f.is_bundle
                  ? (f.freight_kind === 'LOCAL' ? 'rode in this PDF — creates a Local Freight record on Approve' : 'rode in this PDF — attaches to this bill on Approve')
                  : f.freight_kind === 'OUTWARD' ? 'goods sent OUT to a customer — creates a record on Outward Freight'
                  : f.freight_kind === 'LOCAL' ? 'creates a record on Local Freight — lorry no required'
                  : 'creates a Freight Advice in Inward Freight — no goods bill, no vendor needed'}</span>
              {f.is_bundle && (
                <select value={f.freight_kind === 'LOCAL' ? 'LOCAL' : 'INWARD'}
                  onChange={(e) => { const v = e.target.value === 'LOCAL' ? 'LOCAL' : ''; set('freight_kind', v); saveEdits({ freight_kind: v }).catch(() => {}); }}
                  title="Inward = attaches to this bill · Local = creates its own Local Freight record"
                  className="ml-auto text-[11px] border border-teal-300 bg-white rounded-md px-1.5 py-0.5 text-teal-700">
                  <option value="INWARD">↙ Inward (on bill)</option>
                  <option value="LOCAL">🚚 Local (own record)</option>
                </select>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" onBlur={() => saveEdits().catch(() => {})}>
              <div className={`${lbl} col-span-2 relative`}>Transporter
                <input className={`${inp} normal-case`} value={f.bundle_transporter_name || ''} onChange={(e) => set('bundle_transporter_name', e.target.value)} placeholder="from the slip" />
                {/* Pick/Create like the vendor — shows whether it's already in the
                    master, and links the FK so Approve never makes a duplicate. */}
                <div className="flex items-center gap-1.5 mt-1 normal-case">
                  {f.transporter
                    ? <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> in master</span>
                    : <span className="text-[11px] text-amber-600">not linked — pick or create</span>}
                  <button type="button" onClick={openTransporter} className="inline-flex items-center gap-1 text-[11px] font-medium border border-amber-400 text-amber-700 bg-amber-50 rounded-md px-2 py-0.5 hover:bg-amber-100"><Search size={11} /> {f.transporter ? 'change' : 'Pick'}</button>
                  <button type="button" onClick={createTransporter} disabled={creatingTr} className="inline-flex items-center gap-1 text-[11px] font-medium border border-teal-300 text-teal-700 bg-teal-50 rounded-md px-2 py-0.5 hover:bg-teal-100 disabled:opacity-50">{creatingTr ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Create</button>
                </div>
                {tropen && (
                  <div className="absolute z-40 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg text-xs normal-case">
                    <input autoFocus value={trq} onChange={(e) => setTrq(e.target.value)} placeholder="Search transporters…" className="w-full border-b px-2 py-1.5 text-xs outline-none" />
                    <div className="max-h-44 overflow-auto py-1">
                      {trres.map((t) => (<button type="button" key={t.id} onClick={() => pickTransporter(t)} className="block w-full text-left px-2 py-1 hover:bg-blue-50 truncate">{t.name}{t.gstin ? <span className="text-slate-400"> · {t.gstin}</span> : null}</button>))}
                      {trq.trim() && trres.length === 0 && (<div className="px-2 py-1.5"><div className="text-slate-400 mb-1">No transporter match.</div><button type="button" onClick={() => { setTropen(false); createTransporter(); }} className="inline-flex items-center gap-1 text-teal-600 font-medium"><Plus size={11} /> Create “{f.bundle_transporter_name}”</button></div>)}
                    </div>
                  </div>
                )}
              </div>
              {/* OUTWARD is the SALES side: the goods went to a CUSTOMER and the
                  transporter above is merely who gets paid. Asked for here because
                  the Outward Freight record stores the customer, and leaving it to
                  the slip alone left it blank or, worse, named the carrier. */}
              {f.freight_kind === 'OUTWARD' && (
                <div className={`${lbl} col-span-2 relative`}>Customer (goods sent to)
                  <input className={`${inp} normal-case`} value={f.customer_name || ''}
                    onChange={(e) => set('customer_name', e.target.value)}
                    placeholder="who received the goods" />
                  <div className="flex items-center gap-1.5 mt-1 normal-case">
                    {(f.customer_name || '').trim()
                      ? <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> set</span>
                      : <span className="text-[11px] text-amber-600">not on the slip — pick or type</span>}
                    <button type="button" onClick={() => { setCustopen((v) => !v); setCustq(''); }}
                      className="inline-flex items-center gap-1 text-[11px] font-medium border border-amber-400 text-amber-700 bg-amber-50 rounded-md px-2 py-0.5 hover:bg-amber-100">
                      <Search size={11} /> {(f.customer_name || '').trim() ? 'change' : 'Pick'}
                    </button>
                  </div>
                  {custopen && (
                    <div className="absolute z-40 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg text-xs normal-case">
                      <input autoFocus value={custq} onChange={(e) => setCustq(e.target.value)}
                        placeholder="Search customers…" className="w-full border-b px-2 py-1.5 text-xs outline-none" />
                      <div className="max-h-44 overflow-auto py-1">
                        {(customerNames || [])
                          .filter((c) => !custq.trim() || c.toLowerCase().includes(custq.trim().toLowerCase()))
                          .slice(0, 40)
                          .map((c) => (
                            <button type="button" key={c}
                              onClick={() => { set('customer_name', c); setCustopen(false); saveEdits({ customer_name: c }).catch(() => {}); }}
                              className="block w-full text-left px-2 py-1 hover:bg-blue-50 truncate">{c}</button>
                          ))}
                        {custq.trim() && !(customerNames || []).some((c) => c.toLowerCase().includes(custq.trim().toLowerCase())) && (
                          <div className="px-2 py-1.5 text-slate-400">No customer match — type the name above.</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <label className={lbl}>Freight (gross)
                <input className={inp} value={f.bundle_freight_amount || ''} onChange={(e) => set('bundle_freight_amount', e.target.value)} /></label>
              <label className={lbl}>TDS deducted
                <input className={inp} value={f.bundle_freight_tds || ''} onChange={(e) => set('bundle_freight_tds', e.target.value)} /></label>
              <label className={lbl}>Round-off
                <input className={inp} value={f.bundle_freight_roundoff || ''} onChange={(e) => set('bundle_freight_roundoff', e.target.value)} placeholder="+ / −" /></label>
              {/* Live: freight − TDS − round-off. Shown here so it never changes at
                  Approve — what you see is exactly what's booked as payable. */}
              <label className={lbl}>Payable
                <input readOnly tabIndex={-1}
                  className={`${inp} bg-slate-50 font-semibold text-teal-800`}
                  value={money((Number(f.bundle_freight_amount) || 0) - (Number(f.bundle_freight_tds) || 0) - (Number(f.bundle_freight_roundoff) || 0))} /></label>
              <label className={lbl}>Freight bill no
                <input className={`${inp} normal-case`} value={f.bundle_freight_no || ''} onChange={(e) => set('bundle_freight_no', e.target.value)} placeholder="G.C. no" /></label>
              <label className={lbl}>Freight date
                <input type="date" className={`${inp} normal-case`} value={f.bundle_freight_date || ''} onChange={(e) => set('bundle_freight_date', e.target.value)} /></label>
              <label className={`${lbl} col-span-2`}>Vehicle / LR no
                <input className={`${inp} normal-case`} value={f.bundle_vehicle_no || ''} onChange={(e) => set('bundle_vehicle_no', e.target.value)} /></label>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2" onBlur={() => saveEdits().catch(() => {})}>
              <label className={lbl}>Bank / beneficiary
                <input className={`${inp} normal-case`} value={f.bundle_bank_name || ''} onChange={(e) => set('bundle_bank_name', e.target.value)} placeholder="from slip / cheque" /></label>
              <label className={lbl}>A/c no
                <input className={`${inp} normal-case`} value={f.bundle_bank_acc || ''} onChange={(e) => set('bundle_bank_acc', e.target.value)} /></label>
              <label className={lbl}>IFSC
                <input className={`${inp} normal-case`} value={f.bundle_bank_ifsc || ''} onChange={(e) => set('bundle_bank_ifsc', e.target.value)} /></label>
            </div>
            <p className="mt-1 text-[11px] text-slate-400">🏦 Saved to the transporter for freight payments.</p>
            {f.is_bundle
              ? <p className="mt-2 text-[11px] text-teal-700/80">Approve merges the goods bill into its existing bill and attaches this freight (shows on the bill’s “Freight attached” card).</p>
              : <p className="mt-2 text-[11px] text-teal-700/80">Approve → {
                  f.freight_kind === 'OUTWARD' ? 'creates the record on Outward Freight. The transporter is required (it is who you pay).'
                  : f.freight_kind === 'LOCAL' ? 'creates the record on Local Freight. The lorry number is required.'
                  : 'creates the Freight Advice and moves it to Inward Freight. A transporter/amount is optional.'}</p>}
          </div>
        )}

        {/* Two-column: bill details + item lines on the left, decisions + totals on the right */}
        <div className="grid lg:grid-cols-[1fr_300px] gap-4">
          {/* LEFT */}
          <div className="min-w-0">
            {/* Buyer company — auto-detected from the email, editable. Drives which
                vendors the picker shows, so a wrong company hides the real vendor. */}
            <div className="mb-3">
              <div className={`${lbl} mb-1`}>Company (buyer)</div>
              <select className={`${inp} normal-case`} value={draft.company || ''}
                onChange={(e) => changeCompany(e.target.value)}>
                {(companies || []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              <p className="text-[10px] text-slate-400 mt-0.5">The buyer this bill belongs to. Auto-detected from the email — fix it here if wrong (it re-scopes the vendor list).</p>
            </div>

            {/* Link to an EXISTING shared freight — one transporter slip covering
                several goods bills. Only for a plain goods bill (a bundle makes its
                own freight; a freight bill IS the freight). */}
            {!f.is_freight_bill && !f.is_bundle && (
            <div className="mb-3 rounded-lg border border-teal-200 bg-teal-50/60 p-2.5 relative">
              {f.link_freight ? (
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[12px] text-teal-800">🚚 Linked to freight <b>{f.link_freight_no}</b>{f.link_freight_transporter ? ` · ${f.link_freight_transporter}` : ''} <span className="text-teal-600">— this bill joins that shared slip on approve.</span></span>
                  <button onClick={unlinkFreight} className="text-[11px] text-slate-500 hover:text-rose-600 underline shrink-0">unlink</button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-[12px] font-medium text-teal-800">🚚 This bill's freight is on a slip already in the system?</span>
                    <button type="button" onClick={() => setLfopen((o) => !o)} className="text-[11px] font-medium border border-teal-300 text-teal-700 bg-white rounded-md px-2 py-0.5 hover:bg-teal-50 shrink-0"><Search size={11} className="inline -mt-0.5" /> Link to existing freight</button>
                  </div>
                  {lfopen && (
                    <div className="mt-1">
                      <input autoFocus className={`${inp} normal-case`} value={lfq} onChange={(e) => setLfq(e.target.value)} placeholder="Search freight no / transporter / amount…" />
                      {lfres.length > 0 && (
                        <div className="mt-1 bg-white border border-slate-200 rounded-lg shadow-sm max-h-56 overflow-auto">
                          {lfres.map((fa) => (
                            <div key={fa.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-slate-50 last:border-0">
                              <div className="min-w-0">
                                <div className="text-[12px] font-semibold text-slate-800 truncate">{fa.advice_no} · {fa.transporter_name || '—'}{fa.freight_no ? <span className="text-slate-400"> · no {fa.freight_no}</span> : null}</div>
                                <div className="text-[11px] text-slate-500 truncate">{fa.freight_date ? new Date(fa.freight_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : ''}{fa.lorry_no ? ` · ${fa.lorry_no}` : ''} · already covers {fa.covered_count} bill{fa.covered_count === 1 ? '' : 's'}</div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-[12px] tabular-nums font-medium text-slate-700">{money(fa.base_amount)}</span>
                                <button onClick={() => pickLinkFreight(fa)} className="text-[11px] font-medium bg-teal-600 text-white rounded-md px-2 py-1 hover:bg-teal-700">Merge into this</button>
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
            {/* Goods-bill header fields. A FREIGHT bill uses the rich "Inward freight
                details" card above instead, so this whole grid is goods-only. */}
            {!f.is_freight_bill && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4" onBlur={() => saveEdits().catch(() => {})}>
              <label className={`${lbl} col-span-2`}>Vendor name (from bill)
                <input className={`${inp} normal-case`} value={f.vendor_name} onChange={(e) => set('vendor_name', e.target.value)} /></label>
              <label className={lbl}>GSTIN
                <input className={`${inp} normal-case`} value={f.vendor_gstin} onChange={(e) => set('vendor_gstin', e.target.value)} /></label>
              <label className={lbl}>Invoice no
                <input className={`${inp} normal-case`} value={f.invoice_no} onChange={(e) => set('invoice_no', e.target.value)} /></label>
              <label className={`${lbl} col-span-2 sm:col-span-1`}>Invoice date
                <input type="date" className={`${inp} normal-case`} value={f.invoice_date || ''} onChange={(e) => set('invoice_date', e.target.value)} /></label>
              {/* Payment due date — auto-filled from the invoice's printed due
                  date if read, else left blank to compute from the vendor's
                  credit days at Approve; editable. */}
              {!f.is_freight_bill && (
                <label className={`${lbl} col-span-2 sm:col-span-1`}>Due date
                  <input type="date" className={`${inp} normal-case`} value={f.due_date || ''}
                    min={f.invoice_date || undefined}
                    onChange={(e) => {
                      const v = e.target.value;
                      // A due date before the invoice date is invalid — reject it.
                      if (v && f.invoice_date && v < f.invoice_date) { toast.error('Due date cannot be before the invoice date.'); return; }
                      set('due_date', v);
                    }} /></label>
              )}
              {/* Destination WAREHOUSE — which warehouse this bill's goods are for.
                  Auto-suggested from the bill's ship-to town, company-scoped (same
                  list the Update-stock picker uses); editable. Carries onto the bill. */}
              {/* Shown for freight too: Local stores it as the factory and Outward as
                  its warehouse, and with the picker hidden both were always saved
                  empty. Not marked required on a freight bill — a slip may not say. */}
              {(
                <label className={`${lbl} col-span-2 sm:col-span-1`}>Warehouse {!f.is_freight_bill && <span className="text-rose-500">*</span>}
                  <select className={`${inp} normal-case ${(f.warehouse || f.is_freight_bill) ? '' : 'border-amber-400 bg-amber-50'}`} value={f.warehouse || ''}
                    onChange={(e) => { const v = e.target.value || null; setF((p) => ({ ...p, warehouse: v, godown: null })); saveEdits({ warehouse: v, godown: null }).catch(() => {}); }}>
                    <option value="">— select warehouse —</option>
                    {(locations || []).map((w) => <option key={w.id} value={w.id}>{w.name}{w.code ? ` · ${w.code}` : ''}</option>)}
                  </select>
                  {draft.ship_to_address ? <span className="block text-[10px] text-slate-400 normal-case truncate" title={draft.ship_to_address}>📍 ship-to: {draft.ship_to_address}</span> : null}
                </label>
              )}
              {/* The Goods / Freight choice lives in the single TYPE toggle at the top
                  of the card — no duplicate control here. */}
            </div>
            )}

            {/* Item lines + extra charges — GOODS BILL ONLY. A freight bill books a
                single payable figure (no products, no charges), so both blocks are
                hidden when "separate freight bill" is on. */}
            {!f.is_freight_bill && (<>
            <div className="flex items-center gap-2 mb-1.5">
              <span className={lbl}>Item lines</span>
              <span className="h-px flex-1 bg-slate-100" />
              {f.is_freight_bill
                ? <span className="text-[11px] font-semibold text-teal-600">no products needed</span>
                : unresolvedCount > 0
                  ? <span className="text-[11px] font-semibold text-amber-600">{unresolvedCount} need a product</span>
                  : itemLines.length > 0 ? <span className="text-[11px] font-semibold text-emerald-600">all products set</span> : null}
              {!f.is_freight_bill && (
                <button type="button" onClick={addItemLine}
                  className="text-[11px] font-semibold text-indigo-600 hover:underline shrink-0">+ Add item</button>
              )}
            </div>
            {!lines.some((l) => l && ((l.description || '').trim() || l.manual)) ? (
              <div className="text-xs text-slate-400 border border-dashed border-slate-200 rounded-lg px-3 py-4 text-center">
                No item lines were read from this bill. It still posts with the header totals below.
              </div>
            ) : (
              <div className="border border-slate-200 rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10.5px] uppercase tracking-wide text-slate-400 bg-gradient-to-r from-primary-50/70 to-sky-50/40">
                      <th className="text-left font-semibold px-3 py-2">Item on bill</th>
                      <th className="text-left font-semibold px-3 py-2">Product in master</th>
                      <th className="text-right font-semibold px-3 py-2">Qty</th>
                      <th className="text-right font-semibold px-3 py-2">Rate</th>
                      <th className="text-right font-semibold px-3 py-2">Amount</th>
                      <th className="w-6 px-1 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => {
                      if (!l || (!(l.description || '').trim() && !l.manual)) return null;
                      return (
                        <tr key={i} className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2.5">
                            {/* Editable scanned item name (as it reads on the bill). Edit
                                to correct the AI's reading; it also seeds the master name
                                on Create if you haven't set one. */}
                            <textarea
                              value={l.description || ''}
                              ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                              onChange={(e) => { const v = e.target.value; setLines((prev) => prev.map((x, j) => (j === i ? { ...x, description: v } : x))); }}
                              onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }}
                              onBlur={(e) => { const v = e.target.value; saveLines(lines.map((x, j) => (j === i ? { ...x, description: v } : x))); }}
                              rows={1}
                              title="Edit the item name as it appears on the bill"
                              className="w-full font-medium text-slate-700 text-[11px] leading-snug border border-slate-200 bg-white rounded px-1.5 py-1 resize-none overflow-hidden focus:outline-none focus:ring-1 focus:ring-slate-300"
                            />
                            <div className="flex items-center gap-2 px-1.5 mt-0.5 text-[11px] text-slate-400 tabular-nums">
                              {l.hsn ? <span>HSN {l.hsn}</span> : null}
                              {!lineIsCharge(l) ? (
                                <label className="flex items-center gap-1" title="Batch number printed on the bill - saved with the stock when Update stock is on">
                                  Batch
                                  <input
                                    value={l.batch || ''}
                                    onChange={(e) => { const v = e.target.value; setLines((prev) => prev.map((x, j) => (j === i ? { ...x, batch: v } : x))); }}
                                    onBlur={(e) => { const v = e.target.value.trim(); saveLines(lines.map((x, j) => (j === i ? { ...x, batch: v } : x))); }}
                                    placeholder="-"
                                    className="w-24 text-[11px] text-slate-600 border border-slate-200 bg-white rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-slate-300"
                                  />
                                </label>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 relative w-[150px] max-w-[150px]">
                            {/* Charge vs product toggle — mirrors Scan Invoice. Off = a
                                product is created/mapped; on = the amount books as a bill
                                charge (Freight / Other), no product, never blocks approve. */}
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <button type="button" role="switch" aria-checked={!lineIsCharge(l)}
                                onClick={() => { const on = !lineIsCharge(l); setLine(i, { is_charge: on, charge_type: on ? (l.charge_type || (isFreightLine(l) ? 'FREIGHT' : 'OTHER')) : (l.charge_type || '') }); }}
                                title={lineIsCharge(l) ? 'Charge only — no product created; the amount still books on the bill' : 'A product will be created / mapped for this line'}
                                className={`relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors ${!lineIsCharge(l) ? 'bg-indigo-600' : 'bg-teal-500'}`}>
                                <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${!lineIsCharge(l) ? 'translate-x-4' : 'translate-x-1'}`} />
                              </button>
                              <span className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">{lineIsCharge(l) ? 'Charge' : 'Product'}</span>
                            </div>
                            {lineIsCharge(l) ? (
                              <select value={l.charge_type || (isFreightLine(l) ? 'FREIGHT' : 'OTHER')}
                                onChange={(e) => setLine(i, { charge_type: e.target.value })}
                                className="w-full border border-slate-300 rounded px-1.5 py-1 text-[11px] bg-white focus:outline-none focus:ring-1 focus:ring-teal-400"
                                title="Freight charges feed the bill's Freight card; others book as Other charges.">
                                <option value="FREIGHT">Freight charge</option>
                                <option value="OTHER">Other charge</option>
                                {l.charge_type && !['FREIGHT', 'OTHER'].includes(l.charge_type) && <option value={l.charge_type}>{l.charge_type}</option>}
                              </select>
                            ) : resolved(l) ? (
                              l.product_action === 'create' ? (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Will create:</span>
                                  {/* Editable master name — defaults to the scanned name; edit it to
                                      create a clean master. The bill line keeps the vendor's text. */}
                                  <input
                                    value={l.product_name ?? ''}
                                    onChange={(e) => { const v = e.target.value; setLines((prev) => prev.map((x, j) => (j === i ? { ...x, product_name: v } : x))); }}
                                    onBlur={(e) => { const v = e.target.value; saveLines(lines.map((x, j) => (j === i ? { ...x, product_name: v } : x))); }}
                                    placeholder="Master product name"
                                    title="Name this product will be created as in the master (edit to clean it up)"
                                    className="border border-emerald-200 rounded px-1.5 py-0.5 text-[11px] w-full bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                  />
                                  <button onClick={(e) => resetProduct(i, e)} className="text-[11px] text-slate-500 hover:text-slate-700 underline">change</button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="inline-flex items-center gap-1 text-[12px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                    {l.product_name || 'Mapped'}
                                  </span>
                                  <button onClick={(e) => resetProduct(i, e)} className="text-[11px] text-slate-500 hover:text-slate-700 underline">change</button>
                                </div>
                              )
                            ) : (
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <button onClick={(e) => openProduct(i, l.description, e)}
                                  className="inline-flex items-center gap-1 text-[11px] font-medium border border-amber-300 text-amber-700 bg-amber-50 rounded-md px-1.5 py-0.5 hover:bg-amber-100">
                                  <Search size={11} /> Map…
                                </button>
                                <button onClick={() => createProduct(i)}
                                  className="inline-flex items-center gap-1 text-[11px] font-medium border border-indigo-300 text-indigo-700 bg-indigo-50 rounded-md px-1.5 py-0.5 hover:bg-indigo-100">
                                  <Plus size={11} /> Create
                                </button>
                              </div>
                            )}
                            {pOpen === i && (
                              <>
                              <div className="fixed inset-0 z-40" onClick={() => setPOpen(null)} />
                              <div className="z-50 w-72 bg-white border border-slate-200 rounded-lg shadow-xl"
                                style={{ position: 'fixed', top: pAnchor?.top ?? 0, left: pAnchor?.left ?? 0 }}>
                                <input autoFocus value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Search products…" className="w-full border-b px-2 py-1.5 text-xs outline-none" />
                                <div className="max-h-52 overflow-auto text-xs py-1">
                                  {pres.map((p) => (
                                    <button key={p.id} onClick={() => mapProduct(i, p)} className="block w-full text-left px-2 py-1 hover:bg-blue-50 truncate">
                                      {p.name}{p.sku ? <span className="text-slate-400"> · {p.sku}</span> : null}
                                    </button>
                                  ))}
                                  {pq.trim() && pres.length === 0 && <div className="px-2 py-1 text-slate-400">No product match — use <b>Create</b>.</div>}
                                  {!pq.trim() && <div className="px-2 py-1 text-slate-400">Type to search the product master…</div>}
                                </div>
                              </div>
                              </>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <input value={l.qty ?? ''} inputMode="decimal"
                                onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                                onBlur={(e) => saveLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                                title={l.qty_assumed ? 'No quantity found on the bill — check this' : undefined}
                                className={`w-14 text-right tabular-nums bg-white rounded px-1 py-0.5 border focus:outline-none focus:ring-1 focus:ring-indigo-400 ${l.qty_assumed ? 'border-amber-400 bg-amber-50' : 'border-slate-200'}`} />
                              <input value={l.uom ?? ''} placeholder="uom"
                                onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, uom: e.target.value } : x)))}
                                onBlur={(e) => saveLines(lines.map((x, j) => (j === i ? { ...x, uom: e.target.value } : x)))}
                                className="w-11 text-left text-[11px] normal-case border border-slate-200 bg-white rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <input value={l.rate ?? ''} inputMode="decimal"
                              onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))}
                              onBlur={(e) => saveLines(lines.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))}
                              className="w-20 text-right tabular-nums border border-slate-200 bg-white rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <input value={l.amount ?? ''} inputMode="decimal"
                              onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                              onBlur={(e) => saveLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                              className="w-24 text-right tabular-nums border border-slate-200 bg-white rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                          </td>
                          <td className="px-1 py-2.5 text-center align-middle">
                            <button type="button" title="Remove this line" onClick={() => removeLine(i)}
                              className="text-slate-300 hover:text-red-500"><X size={13} /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Extra charges the vendor put on the bill — editable (freight / loading /
                packing / round-off). They book on the bill; nothing is dropped. */}
            <div className="mt-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={lbl}>Extra charges on the bill</span>
                <span className="h-px flex-1 bg-slate-100" />
                <button type="button"
                  onClick={() => setF((p) => ({ ...p, charges: [...(p.charges || []), { label: '', amount: 0 }] }))}
                  className="text-[11px] font-semibold text-indigo-600 hover:underline">+ Add charge</button>
              </div>
              {(f.charges || []).length === 0 ? (
                <div className="text-[11px] text-slate-400">None. Use “+ Add charge” for freight / loading / packing / round-off.</div>
              ) : (
                <div className="space-y-1.5" onBlur={() => saveEdits().catch(() => {})}>
                  {(f.charges || []).map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input value={c.label || ''} placeholder="e.g. Loading Charges"
                        onChange={(e) => setF((p) => ({ ...p, charges: p.charges.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))}
                        className="flex-1 border border-slate-200 rounded px-2 py-1 text-xs normal-case focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                      <input value={c.amount ?? ''} inputMode="decimal" placeholder="0.00"
                        onChange={(e) => setF((p) => ({ ...p, charges: p.charges.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) }))}
                        className="w-28 text-right tabular-nums border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                      <button type="button" title="Remove charge"
                        onClick={() => { const next = (f.charges || []).filter((_, j) => j !== i); setF((p) => ({ ...p, charges: next })); saveEdits({ charges: next }).catch(() => {}); }}
                        className="text-slate-300 hover:text-rose-500 p-1"><X size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            </>)}

            {/* Existing (duplicate) bill this would merge into — shown so you can
                SEE it and confirm before Merge unlocks. Only when a duplicate exists. */}
            {draft.existing_bill_id && (
              <div className="mt-4 border border-amber-300 bg-amber-50/60 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <GitMerge size={14} className="text-amber-600" />
                  <span className="text-xs font-semibold text-amber-700">Existing bill this Merge would update</span>
                </div>
                {existingBill ? (
                  <>
                    <div className="text-sm font-medium text-slate-700">{existingBill.bill_no} · {existingBill.vendor_name}</div>
                    <div className="text-[11px] text-slate-500 mb-2">
                      Invoice {existingBill.vendor_invoice_no || '—'} · {existingBill.bill_date || '—'} · {existingBill.status}
                      {' '}· Taxable {money(existingBill.subtotal)} + GST {money(existingBill.tax_amount)} = <b className="text-slate-700">{money(existingBill.total_amount)}</b>
                    </div>
                    {existingBill.lines && existingBill.lines.length > 0 ? (
                      <div className="border border-amber-200 rounded overflow-x-auto bg-white">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-[10px] uppercase tracking-wide text-slate-400 bg-amber-50/70">
                              <th className="text-left font-semibold px-2 py-1">Product</th>
                              <th className="text-right font-semibold px-2 py-1">Qty</th>
                              <th className="text-right font-semibold px-2 py-1">Rate</th>
                              <th className="text-right font-semibold px-2 py-1">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {existingBill.lines.map((l, i) => (
                              <tr key={i} className="border-t border-amber-100">
                                <td className="px-2 py-1 text-slate-700">{l.product}</td>
                                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{l.qty}{l.uom ? ` ${l.uom}` : ''}</td>
                                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{money(l.rate)}</td>
                                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{money(l.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-400">This bill currently has no item lines.</div>
                    )}
                    <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                      {mergeConfirmed ? (
                        <span className="inline-flex items-center gap-1 text-[12px] font-medium text-emerald-700"><Check size={13} /> Confirmed — Merge is enabled on the right</span>
                      ) : (
                        <>
                          <button onClick={() => setMergeConfirmed(true)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-medium hover:bg-amber-700">
                            <Check size={13} /> Confirm this is the same bill
                          </button>
                          <span className="text-[11px] text-amber-700/80">Merge stays locked until you confirm.</span>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-slate-400 flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Loading the existing bill…</div>
                )}
              </div>
            )}
          </div>

          {/* RIGHT — vendor, classify, totals, decision */}
          <aside className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-3 self-start">
            {/* Transporter (freight bill) */}
            {f.is_freight_bill && (
              <div className="relative">
                <p className="text-[11px] text-teal-600">🚚 Transporter &amp; amounts are in the <b>{
                  f.freight_kind === 'OUTWARD' ? 'Outward freight details'
                  : f.freight_kind === 'LOCAL' ? 'Local freight details'
                  : 'Inward freight details'}</b> card above. Approve moves this to {
                  f.freight_kind === 'OUTWARD' ? 'Outward Freight'
                  : f.freight_kind === 'LOCAL' ? 'Local Freight'
                  : 'Inward Freight'} — no vendor needed.</p>
                {/* One freight slip can cover MANY goods bills — the reviewer adds
                    each covered bill here. On approve they become the advice's
                    covered_bills (referenced, never copied in). MANUAL pick. INWARD
                    only — covered_bills lives on the Inward Freight advice. */}
                {(f.freight_kind === 'INWARD' || !f.freight_kind) && (
                <div className="mt-2 border-t border-teal-100 pt-2">
                  <div className={`${lbl} mb-1`}>Bills this freight covers{(f.freight_covered_bills_detail || []).length ? ` (${f.freight_covered_bills_detail.length})` : ''}</div>
                  {f.freight_ref_no && (
                    <p className="text-[11px] text-slate-500 mb-1">Written on the slip: <b>{f.freight_ref_no}</b> — search and add each bill it covers.</p>
                  )}
                  {/* Legacy single-link (older drafts) — kept so it still approves. */}
                  {f.freight_linked_bill_no && (f.freight_covered_bills_detail || []).length === 0 && (
                    <div className="flex items-center justify-between gap-2 rounded border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 mb-1.5">
                      <span className="text-[12px] text-emerald-800">🔗 Links to bill <b>{f.freight_linked_bill_no}</b> on approve.</span>
                      <button onClick={unlinkBill} className="text-[11px] text-slate-500 hover:text-rose-600 underline">unlink</button>
                    </div>
                  )}
                  {/* The covered bills — removable chips (one freight → many bills). */}
                  {(f.freight_covered_bills_detail || []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {f.freight_covered_bills_detail.map((b) => (
                        <span key={b.id} className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 pl-2.5 pr-1 py-1 text-[12px] text-emerald-800">
                          <b>{b.bill_no || b.invoice_no || '—'}</b>
                          {b.vendor_name ? <span className="text-emerald-700/70 truncate max-w-[120px]">· {b.vendor_name}</span> : null}
                          {Number(b.total) ? <span className="text-emerald-700/70">· {money(b.total)}</span> : null}
                          <button onClick={() => removeCoveredBill(b.id)} title="Remove"
                            className="ml-0.5 w-4 h-4 inline-flex items-center justify-center rounded-full text-emerald-700 hover:bg-rose-100 hover:text-rose-600">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="relative">
                    <input className={`${inp} normal-case`} value={blq}
                      onChange={(e) => setBlq(e.target.value)}
                      placeholder={(f.freight_covered_bills_detail || []).length ? 'Add another covered bill…' : 'Search bill no, vendor or amount to add…'} />
                    {blres.length > 0 && (
                      <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-auto">
                        {blres.map((b) => (
                          <button key={b.id} onClick={() => addCoveredBill(b)}
                            className="block w-full text-left px-2.5 py-2 hover:bg-indigo-50 border-b border-slate-50 last:border-0">
                            <span className="text-[12px] font-semibold text-slate-800">{b.bill_no}{b.from_tally ? <span className="ml-1.5 text-[9px] font-semibold text-emerald-700 bg-emerald-100 rounded px-1">Tally</span> : null}</span>
                            <span className="block text-[11px] text-slate-500 truncate">{[b.vendor, b.company, money(b.total)].filter(Boolean).join(' · ')}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {blq.trim() && blres.length === 0 && (
                      <p className="text-[11px] text-amber-600 mt-1">No bill matches “{blq}”.</p>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">Approve → one Inward Freight advice covering these bills (bills aren’t copied in — just linked by number).</p>
                </div>
                )}
                {/* Manual freight bill — freight arrives as a SEPARATE email/scan,
                    so scan/upload the transporter's slip here; it gets its OWN
                    preview and attaches to the Freight Advice on approve. */}
                <div className="mt-2 border-t border-teal-100 pt-2">
                  <div className="flex items-center justify-between">
                    <div className={lbl}>Freight bill (scan / upload)</div>
                    <label className="text-[11px] text-indigo-600 font-medium cursor-pointer hover:underline">
                      {freightUploading ? 'Uploading…' : (freightDocUrl ? 'replace' : 'upload')}
                      <input type="file" accept=".pdf,image/*" className="hidden" onChange={(e) => uploadFreightDoc(e.target.files?.[0])} />
                    </label>
                  </div>
                  {freightDocUrl ? (
                    <div className="mt-1.5">
                      <div className="text-[11px] text-emerald-700 truncate mb-1">📎 {freightDocName || 'freight bill'}</div>
                      {freightPreview ? (
                        (freightPreview.type.includes('pdf') || /\.pdf$/i.test(freightDocName || '')) ? (
                          <iframe src={freightPreview.url} title="freight bill" className="w-full h-56 border border-slate-200 rounded bg-white" />
                        ) : (
                          <img src={freightPreview.url} alt="freight bill" className="w-full max-h-56 object-contain border border-slate-200 rounded bg-slate-50" />
                        )
                      ) : (
                        <button onClick={() => loadFreightPreview()} className="text-[11px] text-indigo-600 hover:underline">view freight bill ↓</button>
                      )}
                    </div>
                  ) : (
                    <p className="text-[10px] text-slate-400 mt-1">Scan/upload the transporter's slip — it shows here and attaches to the Freight Advice.</p>
                  )}
                </div>
              </div>
            )}

            {/* Vendor (goods bill) */}
            {!f.is_freight_bill && (
            <div className="relative">
              <div className={`${lbl} mb-1`}>Vendor</div>
              {f.matched_vendor ? (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="inline-flex items-center gap-1 text-[12px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 max-w-full truncate">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" /> <span className="truncate">{f.matched_vendor_name || 'Selected'}</span>
                    {coTag(draft.company) ? <span className="shrink-0 text-[9px] font-bold px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">{coTag(draft.company)}</span> : null}
                  </span>
                  <button onClick={openVendor} className="text-[11px] text-slate-500 hover:text-slate-700 underline">change</button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button onClick={openVendor}
                    className="inline-flex items-center gap-1 text-[12px] font-medium border border-amber-400 text-amber-700 bg-amber-50 rounded-md px-2 py-1 hover:bg-amber-100">
                    <Search size={12} /> Pick vendor
                  </button>
                  <button onClick={createVendor} disabled={creatingVendor}
                    className="inline-flex items-center gap-1 text-[12px] font-medium border border-indigo-300 text-indigo-700 bg-indigo-50 rounded-md px-2 py-1 hover:bg-indigo-100 disabled:opacity-50">
                    {creatingVendor ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Create
                  </button>
                </div>
              )}
              {vopen && (
                <div className="absolute z-30 top-14 left-0 w-72 bg-white border border-slate-200 rounded-lg shadow-lg">
                  <input autoFocus value={vq} onChange={(e) => setVq(e.target.value)} placeholder="Search vendors…" className="w-full border-b px-2 py-1.5 text-xs outline-none" />
                  <div className="max-h-52 overflow-auto text-xs py-1">
                    {vres.map((v) => (
                      <button key={v.id} onClick={() => pickVendor(v)}
                        className="flex w-full items-center gap-1.5 text-left px-2 py-1 hover:bg-blue-50">
                        {v.company_tag ? <span className={`shrink-0 text-[9px] font-bold px-1 py-0.5 rounded ${v.company_id && String(v.company_id) === String(draft.company) ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>{v.company_tag}</span> : null}
                        <span className="truncate">{v.name}{v.gstin ? <span className="text-slate-400"> · {v.gstin}</span> : null}</span>
                      </button>
                    ))}
                    {vq.trim() && vres.length === 0 && (
                      <div className="px-2 py-1.5">
                        <div className="text-slate-400 mb-1">No vendor match.</div>
                        <button onClick={() => { setVopen(false); createVendor(); }} className="inline-flex items-center gap-1 text-indigo-600 font-medium"><Plus size={11} /> Create “{f.vendor_name}”</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            )}

            {/* Classify — goods bill only */}
            {!f.is_freight_bill && (
            <div className="grid grid-cols-1 gap-2">
              <label className={lbl}>Voucher type <span className="text-rose-500">*</span>
                <select className={`${inp} mt-0.5 normal-case ${f.voucher_type ? '' : 'border-amber-400 bg-amber-50'}`}
                  value={f.voucher_type}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__add__') {
                      const name = (window.prompt('New purchase / voucher type name:') || '').trim();
                      if (name && addVoucherType) {
                        addVoucherType(name).then((lbl) => { set('voucher_type', lbl); saveEdits({ voucher_type: lbl }).catch(() => {}); })
                          .catch(() => toast.error('Could not add the voucher type.'));
                      }
                      return;
                    }
                    set('voucher_type', v); saveEdits({ voucher_type: v }).catch(() => {});
                  }}>
                  <option value="">— select —</option>
                  {voucherTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  {f.voucher_type && !voucherTypes.includes(f.voucher_type) && <option value={f.voucher_type}>{f.voucher_type}</option>}
                  <option value="__add__">＋ Add new purchase type…</option>
                </select>
              </label>
              <label className={lbl}>Category <span className="text-rose-500">*</span>
                <select className={`${inp} mt-0.5 normal-case ${f.category ? '' : 'border-amber-400 bg-amber-50'}`}
                  value={f.category}
                  onChange={(e) => { const v = e.target.value; set('category', v); saveEdits({ category: v }).catch(() => {}); }}>
                  <option value="">— select —</option>
                  {CATEGORIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
              </label>
            </div>
            )}

            {/* Update stock (optional) — goods bill only. OFF by default; when ON, warehouse + godown required */}
            {!f.is_freight_bill && (
            <div className="border-t border-slate-200 pt-2">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer select-none">
                <input type="checkbox" checked={f.update_stock}
                  onChange={(e) => { const v = e.target.checked; setF((p) => ({ ...p, update_stock: v })); saveEdits({ update_stock: v }).catch(() => {}); }} />
                Update stock (goods received)
              </label>
              {f.update_stock && (
                <div className="grid grid-cols-1 gap-2 mt-2">
                  <select className={`${inp} normal-case ${f.warehouse ? '' : 'border-amber-400 bg-amber-50'}`}
                    value={f.warehouse || ''}
                    onChange={(e) => { const v = e.target.value || null; setF((p) => ({ ...p, warehouse: v, godown: null })); saveEdits({ warehouse: v, godown: null }).catch(() => {}); }}>
                    <option value="">— select warehouse —</option>
                    {locations.map((w) => <option key={w.id} value={w.id}>{w.name}{w.type === 'FACTORY' ? ' (Factory)' : ''}</option>)}
                  </select>
                  <select className={`${inp} normal-case ${f.godown ? '' : 'border-amber-400 bg-amber-50'}`}
                    value={f.godown || ''} disabled={!f.warehouse}
                    onChange={(e) => { const v = e.target.value || null; setF((p) => ({ ...p, godown: v })); saveEdits({ godown: v }).catch(() => {}); }}>
                    <option value="">{f.warehouse ? '— select godown —' : 'pick a warehouse first'}</option>
                    {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <p className="text-[10.5px] text-slate-400 leading-snug">Posts the received quantities to this godown when the bill is approved.</p>
                </div>
              )}
            </div>
            )}

            {/* Totals */}
            <div className="border-t border-slate-200 pt-2" onBlur={() => saveEdits().catch(() => {})}>
              {/* Tax split is goods-only. A Freight Advice stores a single payable
                  figure (no CGST/SGST breakdown), so freight shows just the total. */}
              {!f.is_freight_bill && (<>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs text-slate-500">Taxable</span>
                <input type="number" className="w-28 text-right tabular-nums border border-slate-300 rounded px-2 py-1 text-sm" value={f.subtotal} onChange={(e) => set('subtotal', e.target.value)} />
              </div>
              {interstate ? (
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs text-slate-500">IGST</span>
                  <input type="number" className={numCls} value={f.tax_amount} onChange={(e) => set('tax_amount', e.target.value)} />
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-xs text-slate-500">CGST</span>
                    <input type="number" className={numCls} value={halfTax()} onChange={(e) => set('tax_amount', String((Number(e.target.value) || 0) * 2))} />
                  </div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-xs text-slate-500">SGST</span>
                    <input type="number" className={numCls} value={halfTax()} onChange={(e) => set('tax_amount', String((Number(e.target.value) || 0) * 2))} />
                  </div>
                </>
              )}
              {Math.abs(adj) >= 0.005 && (
                <div className="flex items-center justify-between gap-2 mb-1 text-xs text-slate-500">
                  <span>Round-off / charges</span><span className="tabular-nums">{money(adj)}</span>
                </div>
              )}
              {/* TDS the bill deducts (read from the bill if present; editable). */}
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs text-slate-500">TDS <span className="text-slate-400">(deducted)</span></span>
                <input type="number" className={numCls} value={f.tds_amount} onChange={(e) => set('tds_amount', e.target.value)} />
              </div>
              </>)}
              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">{f.is_freight_bill ? 'Freight payable' : 'Bill total'}</span>
                {f.is_freight_bill ? (
                  // Mirrors the "Inward freight details" card above (gross − TDS − round-off).
                  <span className="w-32 text-right tabular-nums font-semibold text-teal-800 text-base">{money((Number(f.bundle_freight_amount) || 0) - (Number(f.bundle_freight_tds) || 0) - (Number(f.bundle_freight_roundoff) || 0))}</span>
                ) : (
                  <input type="number" className="w-32 text-right tabular-nums font-semibold text-slate-800 border border-slate-300 rounded px-2 py-1 text-base" value={f.total_amount} onChange={(e) => set('total_amount', e.target.value)} />
                )}
              </div>
            </div>

            {/* Duplicate decision — you choose, nothing is auto-merged */}
            {draft.existing_bill_id && (
              <div className="border border-amber-300 bg-amber-50 rounded-lg p-2.5">
                <div className="text-[11px] font-semibold text-amber-700 mb-1">⚠ Invoice {draft.existing_bill_no} already exists</div>
                <div className="text-[11px] text-amber-700/80">See it below the item lines. <b>Confirm</b> there to unlock <b>Merge</b>, or use <b>Create new</b> for a separate bill. Editing the invoice no clears this.</div>
              </div>
            )}

            {/* Actions */}
            <div className="space-y-2">
              {draft.existing_bill_id ? (
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={approve} disabled={busy || !!gate} title={gate || 'Post as a separate bill'}
                    className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Create new
                  </button>
                  <button onClick={merge} disabled={busy || !!gate || !mergeConfirmed}
                    title={gate || (!mergeConfirmed ? 'Confirm the existing bill below first' : `Update ${draft.existing_bill_no}`)}
                    className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50">
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <GitMerge size={14} />} Merge
                  </button>
                </div>
              ) : (
                <button onClick={approve} disabled={busy || !!gate} title={gate || (f.is_freight_bill ? 'Create the Freight Advice' : 'Create the Vendor Bill')}
                  className={`w-full inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50 ${f.is_freight_bill ? 'bg-teal-600 hover:bg-teal-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {f.is_freight_bill ? 'Approve → Freight' : 'Approve → Bill'}
                </button>
              )}
              <button onClick={skip} disabled={busy} className="w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 text-sm hover:bg-slate-100 disabled:opacity-50"><X size={14} /> Skip</button>
              {gate && <p className="text-[11px] text-amber-600 text-center">{gate}</p>}
              {!gate && draft.existing_bill_id && !mergeConfirmed && (
                <p className="text-[11px] text-amber-600 text-center">Confirm the existing bill below to enable Merge.</p>
              )}
            </div>
          </aside>
        </div>

        {draft.error_message ? <p className="text-[11px] text-rose-500 mt-2">{draft.error_message}</p> : null}
      </div>
    </div>
  );
}

function SettingsModal({ onClose }) {
  const [cfg, setCfg] = useState({ imap_host: 'imap.gmail.com', imap_port: 993, folder: 'INBOX', subject_filter: 'SCANNED', email_user: '', app_password: '', gemini_api_key: '', has_app_password: false, has_gemini_key: false });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setCfg((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    apiClient.get(`${API}/config/`).then((r) => setCfg((p) => ({ ...p, ...r.data, app_password: '', gemini_api_key: '' }))).catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    try { await apiClient.put(`${API}/config/`, cfg); toast.success('Settings saved.'); onClose(); }
    catch (e) { toast.error(e.response?.data?.detail || 'Save failed.'); } finally { setBusy(false); }
  };

  const inp = 'border border-slate-300 rounded-lg px-2 py-1.5 text-sm w-full';
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-slate-800 mb-1">Email Inbox Settings</h2>
        <p className="text-xs text-slate-500 mb-4">Gmail inbox to read bills from. Use a Gmail <b>App password</b> (enable 2-step verification, then generate a 16-char app password).</p>
        <div className="space-y-2.5">
          <label className="text-xs text-slate-500 block">Email address<input className={inp} value={cfg.email_user} onChange={(e) => set('email_user', e.target.value)} placeholder="bills@yourcompany.com" /></label>
          <label className="text-xs text-slate-500 block">Only fetch emails whose subject contains <span className="text-slate-400">(Gmail matches whole words, so use "SCANNED"; comma-separate for any-match)</span>
            <input className={inp} value={cfg.subject_filter} onChange={(e) => set('subject_filter', e.target.value)} placeholder="e.g. SCANNED" />
          </label>
          <label className="text-xs text-slate-500 block">App password {cfg.has_app_password && <span className="text-emerald-600">(set — leave blank to keep)</span>}
            <input type="password" className={inp} value={cfg.app_password} onChange={(e) => set('app_password', e.target.value)} placeholder={cfg.has_app_password ? '••••••••••••' : '16-char app password'} /></label>
          <label className="text-xs text-slate-500 block">Gemini API key {cfg.has_gemini_key && <span className="text-emerald-600">(set — leave blank to keep)</span>}
            <input type="password" className={inp} value={cfg.gemini_api_key} onChange={(e) => set('gemini_api_key', e.target.value)} placeholder="leave blank to use the server's key" /></label>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-slate-500 block col-span-2">IMAP host<input className={inp} value={cfg.imap_host} onChange={(e) => set('imap_host', e.target.value)} /></label>
            <label className="text-xs text-slate-500 block">Port<input type="number" className={inp} value={cfg.imap_port} onChange={(e) => set('imap_port', e.target.value)} /></label>
          </div>
          <label className="text-xs text-slate-500 block">Folder<input className={inp} value={cfg.folder} onChange={(e) => set('folder', e.target.value)} /></label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-600">Cancel</button>
          <button onClick={save} disabled={busy} className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
