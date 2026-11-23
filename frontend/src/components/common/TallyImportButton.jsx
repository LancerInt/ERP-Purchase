import { useState, useEffect, useRef, Fragment } from 'react';
import { DownloadCloud, X, Loader2, Undo2, Ban, AlertTriangle } from 'lucide-react';
import { Button } from '../ui';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import useLookup from '../../hooks/useLookup.js';
import apiClient from '../../utils/api.js';
import toast from 'react-hot-toast';
import { confirm } from '@/components/common/confirm';

/**
 * Per-party "map / create / skip" control. The map picker searches the EXISTING
 * ERP master (customers or vendors of the same company) via /api/tally/import/
 * action=search_parties — so any master record can be chosen, not just the
 * auto-suggested fuzzy matches (shown when the search box is empty).
 */
function PartyMapControl({ dec, onSet, kind, opts, company, tallyCompany }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open || !q.trim()) { setResults([]); return undefined; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiClient.post('/api/tally/import/', {
          company, tally_company: tallyCompany || undefined,
          action: 'search_parties', kind, q: q.trim(),
        });
        setResults(res.data.results || []);
      } catch { setResults([]); } finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, kind, company, tallyCompany]);

  const action = dec?.action || 'create';
  const label = action === 'skip' ? 'Skip' : action === 'map' ? `↳ ${dec.name || 'Mapped'}` : 'Create new';
  const list = q.trim() ? results : (opts || []);

  return (
    <div className="relative shrink-0 w-[54%]" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className={`border rounded px-1.5 py-0.5 text-xs w-full text-left truncate ${action === 'map' ? 'border-blue-400 text-blue-700 bg-blue-50' : 'border-slate-300 text-slate-700'}`}>
        {label} ▾
      </button>
      {open && (
        // z-50 so the open list sits above the rows below it and above the
        // modal's own sticky bits, not tucked behind them.
        <div className="absolute z-50 right-0 mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search master customers / vendors…"
            className="w-full border-b border-slate-200 px-2 py-1.5 text-xs outline-none" />
          <div className="max-h-56 overflow-auto py-1 text-xs">
            <button type="button" onClick={() => { onSet({ action: 'create' }); setOpen(false); }} className="block w-full text-left px-2 py-1 hover:bg-slate-50 text-indigo-600">Create new</button>
            <button type="button" onClick={() => { onSet({ action: 'skip' }); setOpen(false); }} className="block w-full text-left px-2 py-1 hover:bg-slate-50 text-slate-500">Skip (don&apos;t add)</button>
            {list.length > 0 && <div className="px-2 py-0.5 text-[10px] uppercase text-slate-400">{q.trim() ? 'Master results' : 'Suggested matches'}</div>}
            {searching && <div className="px-2 py-1 text-slate-400">Searching…</div>}
            {list.map((o) => (
              <button type="button" key={o.id} onClick={() => { onSet({ action: 'map', id: o.id, name: o.name }); setOpen(false); }}
                className="block w-full text-left px-2 py-1 hover:bg-blue-50 truncate">
                ↳ {o.name}{o.gstin ? <span className="text-slate-400"> · {o.gstin}</span> : null}
              </button>
            ))}
            {q.trim() && !searching && list.length === 0 && <div className="px-2 py-1 text-slate-400">No master match — use Create new.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

/**
 * "Import from Tally" button + modal. Two modes via `what`:
 *   - "transactions" (default) → sales & purchase vouchers + receipts/payments
 *     → creates invoices / bills. Needs a date range.
 *   - "parties" → customer & vendor ledgers → creates Customers / Vendors.
 * Preview first (writes nothing), then Import. Idempotent on the backend.
 */
export default function TallyImportButton({
  onDone, what = 'transactions', action = 'import',
  // Optional: preset the date range + customise the trigger (used by the
  // Purchase Analytics "Import this day" rows). initialCompany pre-selects it.
  initialFrom = null, initialTo = null, initialCompany = null,
  triggerLabel = null, triggerClassName = null,
  // For what='parties': restrict to one side — 'customer' (Customers page) or
  // 'vendor' (Vendors page). Omit to import both.
  partyKind = null,
  // Opt-in (Bills page only): also show "Creditors" and "TDS" tabs that import
  // the Sundry-Creditors group balances + TDS Payable — so every Tally import
  // lives in one popup. Off everywhere else, so the Sales/Customer/Vendor
  // imports are untouched.
  purchaseBalances = false,
  // Revert variant that wipes only PAYMENTS for the period (bills untouched).
  paymentsOnly = false,
  // Lock the revert to a specific category (e.g. 'FREIGHT'). When set, the
  // category picker is hidden and this value is always sent.
  defaultCategory = null,
}) {
  const parties = what === 'parties';
  const revert = action === 'revert';
  // ── Tab inside the modal: Transactions | Opening Balances ─────────────
  // Opening balances are a DIFFERENT read — Tally's LEDGER MASTERS, not its
  // vouchers — turning each debtor's opening into an opening receivable and
  // each creditor's into an opening payable. Only one date applies (the backend
  // uses `from` as the as-of date), so the To field is hidden on that tab.
  // Run it BEFORE the voucher import: a receipt that belongs against last
  // year's balance has nothing to land on otherwise, and the import invents an
  // OPEN-RCPT carrier to hold it — the artefact behind Kriya's Rs 34 L and
  // Sumitomo's Rs 14.03 Cr phantoms.
  const [mode, setMode] = useState(what);
  const opening = mode === 'opening';
  const isSales = mode === 'sales';
  const isPurchase = mode === 'purchase';
  // Creditors and TDS are group mirrors whose closing = FY-start opening +
  // movements, so their movements MUST run from 1-Apr — the operator only picks
  // the AS-OF (closing) date. We send just `to`; the backend defaults `from` to
  // the FY start. (Letting the operator set `from` here silently dropped every
  // month before it AND rebuilt TDS from a partial window — a real foot-gun.)
  // Freight is period-based with no opening, so it keeps a true From/To range.
  const isCreditors = mode === 'creditors';
  const isTds = mode === 'tds_payable';
  const isFreight = mode === 'freight_inward';
  const isFreightVouchers = mode === 'freight_vouchers';
  const isExpenseVouchers = mode === 'expense_vouchers';
  const isReconciliation = mode === 'reconciliation';
  // Creditors/TDS: a single AS-OF date (bound to `to`; from pinned to 1-Apr).
  const asOfOnly = isCreditors || isTds;
  const showTabs = !parties && !revert;
  const sideLabel = isPurchase ? 'purchase' : 'sales';
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(initialFrom || monthStart());
  const [to, setTo] = useState(initialTo || today());
  const [company, setCompany] = useState(initialCompany || '');
  const [tallyCompany, setTallyCompany] = useState('');
  // Revert-only: narrow the wash-out to one purchase category (blank = all).
  const [category, setCategory] = useState(defaultCategory || '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  // Per-party decision, keyed 'c:<name>' / 'v:<name>' -> 'create' | 'skip'
  // | 'map:<existingId>'. Default (unset) is 'create'.
  const [decisions, setDecisions] = useState({});
  const [resolveTab, setResolveTab] = useState('parties');   // 'parties' | 'products' | 'vtypes'
  // Per new voucher type: { action: 'create'|'skip', import_as, turnover }.
  // Unset = undecided: a voucher type is a standing rule for every future
  // import, so it is never created by default -- someone picks.
  const [vtDecisions, setVtDecisions] = useState({});
  // Changed / Deleted in Tally: { <change id>: 'update'|'keep'|'remove' }.
  const [vcDecisions, setVcDecisions] = useState({});
  const [connectorProgress, setConnectorProgress] = useState(null);
  const [reconData, setReconData] = useState(null);
  const [reconLoading, setReconLoading] = useState(false);
  const { options: companies } = useLookup('/api/companies/');
  // Cancel support: a fresh job id per run() call, and the AbortController for
  // whichever request is currently in flight. Refs, not state — Cancel needs
  // to reach the CURRENT run without waiting on a re-render, and neither value
  // is ever shown on screen.
  const jobIdRef = useRef(null);
  const abortRef = useRef(null);

  // Pre-fill the Tally company name from the ERP company's stored value, so the
  // operator sees/uses the EXACT Tally name (which differs from the ERP legal
  // name) without typing it. Only fills a blank field — never clobbers an edit.
  useEffect(() => {
    if (!open || !company || tallyCompany) return;
    apiClient.get(`/api/companies/${company}/`)
      .then((r) => { if (r.data?.tally_company_name) setTallyCompany(r.data.tally_company_name); })
      .catch(() => {});
  }, [open, company]);

  // POST to the import endpoint. In connector mode the cloud backend can't
  // reach the office Tally, so it parks the read for the on-prem connector and
  // replies 202 {queued}. We silently retry the IDENTICAL request under the
  // normal loading spinner until the connector has posted the data back and the
  // same call completes — so from the user's side it's just one Import click
  // that takes a little longer, no separate "waiting" UI. Direct (local) mode
  // returns 200 on the first call and this loop is a no-op.
  const relayPost = async (payload, signal) => {
    const started = Date.now();
    for (;;) {
      const res = await apiClient.post('/api/tally/import/', payload, { timeout: 600000, signal });
      if (res.status !== 202) return res;
      if (Date.now() - started > 300000) {
        throw new Error('The connector didn’t respond in time. On the office PC, make sure Tally is open with the gateway on, then click "Sync Tally Now".');
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  };

  const run = async (dry) => {
    console.log('[TallyImport] run called', { mode, what, action, company, dry });
    if (!company) { toast.error('Pick a company first'); return; }
    setBusy(true);
    // A fresh job id + AbortController per run — Cancel (see requestCancel)
    // aborts THIS controller and tells the server about THIS job id, so an
    // old run's leftover refs can never cancel a newer one.
    const jobId = crypto.randomUUID();
    jobIdRef.current = jobId;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const payload = {
        company, tally_company: tallyCompany || undefined, dry_run: dry, what: mode, action,
        job_id: jobId,
      };
      if (asOfOnly) { payload.to = to; }               // from -> backend defaults to 1-Apr (FY start)
      else if (!parties) { payload.from = from; payload.to = to; }
      if (revert && isPurchase && category) { payload.category = category; }
      if (revert && isPurchase && paymentsOnly) { payload.payments_only = true; }
      if (parties && partyKind) { payload.party_kind = partyKind; }   // customers-only / vendors-only
      // A real (non-dry) import can process thousands of vouchers (fetch +
      // per-voucher bill/PO/GRN + outstanding reconcile) and easily run for
      // minutes — the default 30s client timeout aborts it mid-flight and the
      // UI wrongly shows a failure. Give it a long ceiling.
      const res = await relayPost(payload, controller.signal);
      if (res.data?.cancelled) {
        toast('Import cancelled — records created before that point were kept.');
      } else if (res.data?.processing === true) {
        // Layer 3: real import is running in a background thread on the server,
        // or queued for the local connector (connector_mode).
        const bgJobId = res.data.job_id;
        const isConnector = res.data.connector_mode;
        const pollStart = Date.now();
        const timeoutMs = isConnector ? 900000 : 600000;  // 15 min for connector, 10 min for server
        setConnectorProgress(isConnector ? { status: 'PENDING', vouchers: 0, batches: 0 } : null);
        toast(isConnector
          ? 'Import queued — waiting for local connector to fetch from Tally…'
          : 'Import started — processing in background…', { duration: 4000 });
        for (;;) {
          if (controller.signal.aborted) break;
          await new Promise((r) => setTimeout(r, 3000));
          if (controller.signal.aborted) break;
          const st = await apiClient.get('/api/tally/import-status/', {
            params: { job_id: bgJobId },
            signal: controller.signal,
          });
          if (st.data.connector_mode) {
            setConnectorProgress({
              status: st.data.status,
              vouchers: st.data.vouchers_processed || 0,
              batches: st.data.batches_received || 0,
              months: st.data.months_processed || 0,
            });
          }
          if (st.data.status === 'DONE') {
            const d = st.data.result || {};
            setResult(d);
            setDecisions({});
            setVtDecisions({});
            setVcDecisions({});
            const hasParties = (d.unmatched_customers?.length || 0) + (d.unmatched_vendors?.length || 0) > 0;
            setResolveTab(hasParties ? 'parties'
              : d.new_products?.length ? 'products'
              : (d.new_voucher_types?.length || d.skipped_voucher_types?.length) ? 'vtypes'
              : d.changed_vouchers?.length ? 'changed'
              : d.deleted_vouchers?.length ? 'deleted' : 'parties');
            setConnectorProgress(null);
            toast.success('Imported from Tally');
            onDone?.();
            break;
          }
          if (st.data.status === 'FAILED') {
            setConnectorProgress(null);
            throw new Error(st.data.error || 'Import failed on the server');
          }
          if (Date.now() - pollStart > timeoutMs) {
            setConnectorProgress(null);
            throw new Error(isConnector
              ? 'The local connector didn’t finish in time. Check that Tally is open and the connector is running.'
              : 'Import timed out after 10 minutes');
          }
        }
      } else {
        setResult(res.data);
        setDecisions({});   // fresh list -> every party defaults to "Create new"
        setVtDecisions({});
        setVcDecisions({});
        const d = res.data || {};
        const hasParties = (d.unmatched_customers?.length || 0) + (d.unmatched_vendors?.length || 0) > 0;
        setResolveTab(hasParties ? 'parties'
          : d.new_products?.length ? 'products'
          : (d.new_voucher_types?.length || d.skipped_voucher_types?.length) ? 'vtypes'
          : d.changed_vouchers?.length ? 'changed'
          : d.deleted_vouchers?.length ? 'deleted' : 'parties');
        if (!dry) {
          let msg = 'Tally import reverted';
          if (revert && isPurchase) {
            msg = `Reverted: ${d.purchase ?? 0} deleted · ${d.detached ?? 0} detached · ${d.payments ?? 0} payments`;
          }
          toast.success(revert ? msg : parties ? (partyKind === 'transporter' ? 'Transporters imported' : partyKind === 'expense_party' ? 'Expense parties imported' : 'Customers & vendors imported') : 'Imported from Tally',
            revert ? { duration: 6000 } : undefined);
          onDone?.();
        }
      }
    } catch (e) {
      setResult(null);
      if (e.code === 'ERR_CANCELED' || e.name === 'CanceledError') {
        toast('Import cancelled.');
      } else {
        toast.error(e.response?.data?.detail || e.message || 'Tally import failed');
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  // Stop a running Preview/Import: confirm (it's a real, sometimes-partial
  // action, not a harmless dismiss), then abort the browser-side wait AND tell
  // the server to stop at its next between-voucher check (see TallyImportJob /
  // action=cancel_job) — closing the modal alone used to leave both silently
  // running, discoverable only as a toast popping up minutes later or, worse,
  // an import that finished writing after everyone thought it was dismissed.
  const requestCancel = async () => {
    const ok = await confirm({
      title: 'Cancel import?',
      message: 'This stops the import that’s currently running. Anything already created will stay — nothing further will be processed.',
      confirmLabel: 'Cancel import',
      cancelLabel: 'Keep running',
      isDangerous: true,
    });
    if (!ok) return false;
    abortRef.current?.abort();
    const jobId = jobIdRef.current;
    if (jobId) {
      try {
        await apiClient.post('/api/tally/import/', { action: 'cancel_job', job_id: jobId });
      } catch {
        // Best-effort — the local abort above already stops the browser side
        // regardless of whether this reaches the server.
      }
    }
    return true;
  };

  const loadReconciliation = async () => {
    if (!company) { toast.error('Pick a company first'); return; }
    setReconLoading(true);
    try {
      const res = await apiClient.post('/api/tally/import/', {
        company, tally_company: tallyCompany || undefined,
        dry_run: true, what: 'reconciliation',
      });
      setReconData(res.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to load reconciliation');
    } finally {
      setReconLoading(false);
    }
  };

  const setDec = (key, val) => setDecisions((prev) => ({ ...prev, [key]: val }));

  // Apply each unmatched party's decision: map to an existing master, create
  // a new one (enriched from Tally), or skip. Then re-Preview so the newly
  // resolved parties drop out and more vouchers become importable.
  const applyResolve = async () => {
    const rows = [
      ...(result?.unmatched_customers || []).map((n) => ({ name: n, kind: 'customer', key: 'c:' + n })),
      ...(result?.unmatched_vendors || []).map((n) => ({ name: n, kind: 'vendor', key: 'v:' + n })),
      ...(result?.new_products || []).map((n) => ({ name: n, kind: 'product', key: 'p:' + n })),
    ];
    const decs = rows.map((r) => {
      const dec = decisions[r.key] || { action: 'create' };
      if (dec.action === 'skip') return null;
      if (dec.action === 'map') return { tally_name: r.name, kind: r.kind, action: 'map', target_id: dec.id };
      return { tally_name: r.name, kind: r.kind, action: 'create' };
    }).filter(Boolean);
    if (!decs.length) { toast.error('Nothing to apply — every party is set to Skip'); return; }
    setBusy(true);
    try {
      const res = await relayPost({
        company, tally_company: tallyCompany || undefined,
        action: 'resolve_parties', decisions: decs,
      });
      toast.success(`Created ${(res.data.customers || 0) + (res.data.vendors || 0) + (res.data.products || 0)} · Mapped ${res.data.mapped || 0}`);
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message || 'Failed to resolve parties');
      setBusy(false);
      return;
    }
    setBusy(false);
    await run(true);   // refresh the preview with the resolved parties matched
  };

  // Save the Create / Skip decisions on the Voucher types tab, then re-preview:
  // a created type's vouchers now show in the counts, a skipped one drops out.
  const applyVoucherTypes = async ({ repreview = true } = {}) => {
    const rows = result?.new_voucher_types || [];
    const decs = rows.map((r) => {
      const d = vtDecisions[r.vtype];
      if (!d?.action) return null;
      return {
        vtype: r.vtype, base_type: r.base_type, action: d.action,
        // Decided by the ERP from Tally's own voucher type, not by the user.
        import_as: r.suggest_as,
        counts_in_turnover: d.turnover ?? r.suggest_turnover,
      };
    }).filter(Boolean);
    if (!decs.length) {
      if (repreview) toast.error('Choose Create or Skip for at least one voucher type');
      return !repreview;
    }
    setBusy(true);
    try {
      const res = await relayPost({ company, action: 'resolve_voucher_types', decisions: decs });
      toast.success(`Voucher types: created ${res.data.created || 0}, skipped ${res.data.skipped || 0}`);
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message || 'Failed to save voucher types');
      setBusy(false);
      return false;
    }
    setBusy(false);
    if (repreview) await run(true);
    return true;
  };

  // Apply ONE tab's decisions (Changed in Tally, or Deleted in Tally). Each
  // tab has its own button and sends only its own rows. A row refused on the
  // server (money against it) is reported and changes nothing.
  const applyVoucherChanges = async (which, { repreview = true } = {}) => {
    const rows = which === 'changed' ? (result?.changed_vouchers || []) : (result?.deleted_vouchers || []);
    const decs = rows.filter((r) => vcDecisions[r.id]).map((r) => ({ id: r.id, action: vcDecisions[r.id] }));
    if (!decs.length) {
      if (repreview) toast.error('Choose an action for at least one row');
      return !repreview;
    }
    setBusy(true);
    let ok = true;
    try {
      const res = await relayPost({ company, action: 'apply_voucher_changes', decisions: decs });
      const r = res.data || {};
      toast.success(`Updated ${r.updated || 0}, removed ${r.removed || 0}, kept ${r.kept || 0}`);
      (r.refused || []).forEach((x) => toast.error(`${x.number}: ${x.reason}`, { duration: 8000 }));
      ok = !(r.refused || []).length;
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message || 'Failed to apply');
      setBusy(false);
      return false;
    }
    setBusy(false);
    if (repreview) await run(true);
    return ok;
  };

  // How many rows on the three review tabs still have no choice. Import stays
  // disabled until this is 0, so nothing can be left behind by mistake.
  const waiting = (() => {
    if (!result || result.dry_run === false) return { vt: 0, ch: 0, dl: 0, all: 0 };
    const vt = (result.new_voucher_types || []).filter((r) => !vtDecisions[r.vtype]?.action).length;
    const ch = (result.changed_vouchers || []).filter((r) => !vcDecisions[r.id]).length;
    const dl = (result.deleted_vouchers || []).filter((r) => !vcDecisions[r.id]).length;
    return { vt, ch, dl, all: vt + ch + dl };
  })();

  // Import: first save every choice made on the review tabs that was not yet
  // applied with the tab's own button, then import. A created voucher type's
  // vouchers therefore come in on this same import. If the server refuses a
  // row (money against it), stop and re-preview instead of importing.
  const importAll = async () => {
    if (waiting.all) return;
    const ok = (await applyVoucherTypes({ repreview: false }))
      && (await applyVoucherChanges('changed', { repreview: false }))
      && (await applyVoucherChanges('deleted', { repreview: false }));
    if (!ok) { await run(true); return; }
    await run(false);
  };

  // Undo a Skip: forget the rule so the type is asked about again.
  const undoVoucherTypeSkip = async (vtype) => {
    setBusy(true);
    try {
      await relayPost({ company, action: 'reset_voucher_type', vtype });
      toast.success(`"${vtype}" will be asked about again`);
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message || 'Failed to undo');
      setBusy(false);
      return;
    }
    setBusy(false);
    await run(true);
  };

  // While busy, closing (X, the Close/Cancel button, or the backdrop) goes
  // through the SAME confirm-and-stop flow as the dedicated Cancel button —
  // there's no other way to dismiss the modal that leaves the run going
  // unnoticed in the background. "Keep running" leaves the modal open exactly
  // as it was.
  const close = async () => {
    if (busy) {
      const cancelled = await requestCancel();
      if (!cancelled) return;
    }
    setOpen(false); setResult(null); setDecisions({}); setConnectorProgress(null);
  };

  return (
    <>
      <Button variant="outline" icon={revert ? Undo2 : DownloadCloud} responsiveLabel
        onClick={() => {
          setResult(null);
          setMode(what);        // always reopen on the default tab
          // Re-apply presets each time it opens (a day row may reopen it for a
          // different date after a prior import).
          if (initialFrom) setFrom(initialFrom);
          if (initialTo) setTo(initialTo);
          if (initialCompany) setCompany(initialCompany);
          setOpen(true);
        }}
        title={revert ? (defaultCategory === 'FREIGHT' ? 'Revert freight import' : paymentsOnly ? 'Revert payments for a period' : 'Revert Tally import') : 'Import from Tally'}
        className={triggerClassName || (revert ? (defaultCategory === 'FREIGHT' ? 'text-amber-600 border-amber-200 hover:bg-amber-50' : 'text-rose-600 border-rose-200 hover:bg-rose-50') : undefined)}>
        {triggerLabel || (revert ? (defaultCategory === 'FREIGHT' ? 'Revert Freight' : paymentsOnly ? 'Revert Payments' : 'Revert Tally') : 'Import from Tally')}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl p-5 max-h-[90dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-slate-800">
                {revert ? (defaultCategory === 'FREIGHT' ? 'Revert Freight Import'
                  : paymentsOnly ? 'Revert Purchase Payments' : `Revert ${isPurchase ? 'Purchase' : 'Sales'} Tally Import`)
                  : parties ? (partyKind === 'customer' ? 'Import Customers from Tally'
                    : partyKind === 'vendor' ? 'Import Vendors from Tally'
                    : partyKind === 'transporter' ? 'Import Transporters from Tally'
                    : partyKind === 'expense_party' ? 'Import Expense Parties from Tally'
                    : 'Import Customers & Vendors from Tally')
                  : opening ? 'Import Opening Balances from Tally'
                  : isCreditors ? 'Import Creditors from Tally'
                  : isTds ? 'Import TDS Payable from Tally'
                  : isFreightVouchers ? 'Import Freight Bills from Tally'
                  : isExpenseVouchers ? 'Import Expense Bills from Tally'
                  : isFreight ? 'Import Freight Inward from Tally'
                  : isSales ? 'Import Sales from Tally'
                  : isPurchase ? 'Import Purchase from Tally'
                  : 'Import from Tally'}
              </h3>
              <button onClick={close} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              {revert
                ? (defaultCategory === 'FREIGHT'
                    ? "Deletes freight bills (FRT-), freight advice records and freight snapshots for this company in the period. Purchase bills and payments are NOT touched. Can't be undone — run Preview first."
                    : paymentsOnly
                    ? "Deletes ALL payments in the period for this company (every payment — Tally, bank or on-account, any bill). Bills are NOT touched — only their paid amount/status is reset (bills that had a payment go back to OPEN). Can't be undone — run Preview first."
                    : isPurchase
                    ? "Keeps ONLY what you scanned. FIRST deletes ALL payments in the period for this company (Tally, bank or on-account, any bill). Then DELETES every bill that has NO scan and NO attached copy — Tally, Zoho, OPENING carriers, or hand-keyed. Any bill WITH a scan or an attached copy is KEPT; if it also carried a Tally link, that link + narration is stripped (it becomes a plain Scan). Also wipes ALL bank payments, all inward/outward/local freight and the TDS Payable register (full, no-category revert). Can't be undone — run Preview first."
                    : `Deletes the ${sideLabel} records that were imported from Tally in this period (invoices + receipts) and reverses the paid status. Auto-created products are kept. This can't be undone — run Preview first.`)
                : parties
                ? (partyKind === 'customer'
                    ? 'Pulls the customer (Sundry Debtors) ledgers from Tally and creates them here. Vendors and existing ones are skipped.'
                    : partyKind === 'vendor'
                    ? 'Pulls the vendor (Sundry Creditors) ledgers from Tally and creates them here. Customers and existing ones are skipped.'
                    : partyKind === 'transporter'
                    ? 'Pulls transporter ledgers from Tally (Sundry Creditors → Transport sub-group) and creates them here. Existing ones are skipped.'
                    : partyKind === 'expense_party'
                    ? 'Pulls expense party ledgers from Tally (Sundry Creditors → Service / Labour / Security sub-groups) and creates them here. Existing ones are skipped.'
                    : 'Pulls the customer (Sundry Debtors) and vendor (Sundry Creditors) ledgers from Tally and creates them here. Existing ones are skipped.')
                : opening
                ? "Reads Tally’s ledger masters and carries each party’s OPENING BALANCE across — debtors become opening receivables, creditors opening payables — so Outstanding matches Tally. Run this BEFORE importing vouchers. Idempotent: re-running skips ones already brought in."
                : isCreditors
                ? "Reads Tally’s Sundry Creditors ledgers and rebuilds the Creditors group summary (and TDS Payable) for this company — closing = opening + movements. Replaces this company’s current figures. Shows on the Creditors page."
                : isTds
                ? "Reads Tally’s TDS Payable ledgers and rebuilds the TDS Payable figures for this company. Replaces this company’s current figures. Shows on the Creditors → TDS page."
                : isFreightVouchers
                ? "Pulls transporter freight bills (Journal vouchers that credit a Transport-subgroup vendor) and their payments from Tally for the period. Each freight bill is automatically linked to its goods purchase bill where possible."
                : isExpenseVouchers
                ? "Pulls expense journal bills (Journal vouchers with Direct or Indirect Expense ledger legs) and their payments from Tally for the period. Creates expense bills categorised by Direct/Indirect and expense sub-category."
                : isReconciliation
                ? "Compares each vendor's ERP closing (opening + bills − payments) against the imported Creditor Balance from Tally. Shows vendors with gaps. Requires a Creditors import first. Does NOT need Tally open."
                : isFreight
                ? "Reads Tally’s Freight Inward Charges ledgers for the period and rebuilds the Freight figures for this company. Replaces this company’s current figures. Shows on the Creditors page."
                : isSales
                  ? 'Pulls Sales invoices (with products & quantities) and Receipts from Tally for the period — creates invoices and marks them paid in Receivables.'
                  : isPurchase
                    ? 'Pulls Purchase bills (with products & quantities) and Payments Made from Tally for the period — creates bills and marks them paid.'
                    : 'Pulls sales & purchase vouchers (with products, quantities, receipts & payments) from Tally for the period and creates invoices / bills.'}
              {!revert && !isReconciliation && ' Tally must be open with the gateway on (port 9000).'}
            </p>

            {showTabs && (
              <div className="flex gap-1 mb-4 border-b border-slate-200">
                {[
                  { k: what, label: what === 'purchase' ? 'Purchase Vouchers' : what === 'sales' ? 'Sales Vouchers' : 'Vouchers' },
                  { k: 'opening', label: 'Opening Balances' },
                  ...(purchaseBalances ? [
                    { k: 'freight_vouchers', label: 'Freight' },
                    { k: 'expense_vouchers', label: 'Expenses' },
                    { k: 'reconciliation', label: 'Reconciliation' },
                  ] : []),
                ].map((t) => (
                  <button key={t.k} type="button"
                    onClick={() => { setMode(t.k); setResult(null); setDecisions({}); if (t.k !== 'reconciliation') setReconData(null); }}
                    className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 transition ${
                      mode === t.k
                        ? 'border-blue-600 text-blue-700'
                        : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="col-span-2">
                <label className="block text-xs text-slate-500 mb-1">Company (in ERP)</label>
                {/* SS / UAI quick toggle — the two companies are kept SEPARATE:
                    pick one and the import/update touches only THAT company's
                    customers, read from its own Tally company. Run once per
                    company (SS with SS loaded in Tally, UAI with UAI loaded). */}
                {(() => {
                  const quick = [
                    (companies || []).find((c) => /biochem/i.test(c.label)),
                    (companies || []).find((c) => /united\s*agro/i.test(c.label)),
                  ].filter(Boolean);
                  if (!quick.length) return null;
                  const shortName = (label) => /biochem/i.test(label) ? 'SS Biochem'
                    : /united\s*agro/i.test(label) ? 'United Agro' : label;
                  return (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {quick.map((c) => {
                        const active = String(company) === String(c.value);
                        return (
                          <button key={c.value} type="button"
                            onClick={() => { setCompany(c.value); setTallyCompany(''); }}
                            title={c.label}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${active
                              ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                              : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}>
                            {shortName(c.label)}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
                <CustomSelect value={company} onChange={(e) => { setCompany(e.target.value); setTallyCompany(''); }}>
                  <option value="">Select company…</option>
                  {(companies || []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              {!revert && !isReconciliation && (
                <div className="col-span-2">
                  <label className="block text-xs text-slate-500 mb-1">
                    Tally company name <span className="text-slate-400">(optional — defaults to the ERP company)</span>
                  </label>
                  <input value={tallyCompany} onChange={(e) => setTallyCompany(e.target.value)} placeholder="e.g. Test"
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                </div>
              )}
              {isReconciliation ? null : opening ? (
                <div>
                  <label className="block text-xs text-slate-500 mb-1">
                    As of <span className="text-slate-400">(snapshot date — usually 1-Apr; opening is a single point, so no end date)</span>
                  </label>
                  <CustomDatePicker value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
              ) : asOfOnly ? (
                <div className="col-span-2">
                  <label className="block text-xs text-slate-500 mb-1">
                    As of <span className="text-slate-400">(closing date — movements run from 1-Apr, the FY start)</span>
                  </label>
                  <CustomDatePicker value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              ) : (!parties) && (
                <>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">From</label>
                    <CustomDatePicker value={from} onChange={(e) => setFrom(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">To</label>
                    <CustomDatePicker value={to} onChange={(e) => setTo(e.target.value)} />
                  </div>
                </>
              )}
            </div>

            {/* Revert-only extras: quick FY / month period presets and a purchase
                category filter, so the wash-out can be scoped to e.g. only FREIGHT
                or only EXPENSES for a single month. */}
            {revert && isPurchase && (
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="col-span-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-500 mr-1">Quick period:</span>
                  {(() => {
                    // Indian FY: Apr 1 → Mar 31. "This FY" = FY-start → today.
                    const d = new Date();
                    const fyStartYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
                    const fyStart = `${fyStartYear}-04-01`;
                    const months = Array.from({ length: 12 }, (_, i) => {
                      const m = (3 + i) % 12;                 // Apr=3 … Mar=2
                      const y = fyStartYear + (m < 3 ? 1 : 0);
                      const first = new Date(y, m, 1);
                      const last = new Date(y, m + 1, 0);
                      const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
                      return { label: first.toLocaleString('en', { month: 'short' }) + ' ' + String(y).slice(2), from: iso(first), to: iso(last) };
                    });
                    return (
                      <>
                        <button type="button" onClick={() => { setFrom(fyStart); setTo(today()); }}
                          className="px-2 py-1 rounded border border-slate-200 text-xs text-slate-700 hover:border-indigo-300 hover:text-indigo-600">
                          FY {String(fyStartYear).slice(2)}-{String(fyStartYear + 1).slice(2)}
                        </button>
                        <CustomSelect value="" onChange={(e) => {
                          const mo = months.find((x) => x.label === e.target.value);
                          if (mo) { setFrom(mo.from); setTo(mo.to); }
                        }}>
                          <option value="">Pick month…</option>
                          {months.map((m) => <option key={m.label} value={m.label}>{m.label}</option>)}
                        </CustomSelect>
                      </>
                    );
                  })()}
                </div>
                {!defaultCategory && (
                <div className="col-span-2">
                  <label className="block text-xs text-slate-500 mb-1">Category <span className="text-slate-400">(blank = all purchase, expense & freight)</span></label>
                  <CustomSelect value={category} onChange={(e) => setCategory(e.target.value)}>
                    <option value="">All Categories</option>
                    <option value="RM">RM Purchase</option>
                    <option value="MAIZE">Maize Purchase</option>
                    <option value="BOUGHT_NOTE">Bought Note</option>
                    <option value="PACKING">Packing Material</option>
                    <option value="FRUIT">Fruit Purchase</option>
                    <option value="FREIGHT">Freight / Transport</option>
                    <option value="EXPENSES">Expenses</option>
                    <option value="LAB_EXPENSE">Lab Expense</option>
                    <option value="MACHINERY">Machinery / Capital</option>
                    <option value="BRANCH">Branch Transfer</option>
                  </CustomSelect>
                </div>
                )}
              </div>
            )}

            {isReconciliation && (
              <ReconciliationPanel
                data={reconData} loading={reconLoading}
                onLoad={loadReconciliation} onClose={close}
                company={company} tallyCompany={tallyCompany}
                from={from} to={to}
              />
            )}

            {!isReconciliation && result && (
              <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <p className="font-semibold text-slate-700 mb-1.5">
                  {result.action === 'revert'
                    ? (result.dry_run ? 'Would delete:' : 'Reverted:')
                    : result.what === 'creditors'
                    ? `${result.dry_run ? 'Preview (nothing saved)' : 'Imported'} — ${result.ledgers ?? 0} creditor ledgers`
                    : result.what === 'tds_payable'
                    ? `${result.dry_run ? 'Preview (nothing saved)' : 'Imported'} — ${result.legs ?? result.rows ?? 0} TDS entries`
                    : result.what === 'freight_inward'
                    ? `${result.dry_run ? 'Preview (nothing saved)' : 'Imported'} — ₹${result.grand_total ?? 0} freight (${result.legs ?? 0} entries)`
                    : `${result.dry_run ? 'Preview' : 'Imported'} — ${result.total_ledgers ?? result.total_vouchers ?? 0} ${(result.what === 'parties' || result.what === 'opening') ? 'ledgers' : 'vouchers'} found`}
                </p>
                {result.what === 'creditors' ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    <span>Creditor ledgers: <b className="text-slate-900">{result.ledgers ?? 0}</b></span>
                    <span>Groups: <b className="text-slate-900">{(result.groups || []).length || result.group_count || 0}</b></span>
                    {result.tds && <span>TDS entries (also refreshed): <b className="text-slate-900">{result.tds.legs ?? result.tds.rows ?? 0}</b></span>}
                    {result.grand_total != null && <span>Grand total: <b className="text-slate-900">{result.grand_total} {result.grand_side || ''}</b></span>}
                    <span className="col-span-2 text-slate-500">{result.dry_run ? 'Preview only — press Import to save.' : 'Saved. Open the Creditors page to view.'}</span>
                  </div>
                ) : result.what === 'tds_payable' ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    <span>TDS entries: <b className="text-slate-900">{result.legs ?? result.rows ?? 0}</b></span>
                    <span className="col-span-2 text-slate-500">{result.dry_run ? 'Preview only — press Import to save.' : 'Saved. Open the Creditors → TDS page to view.'}</span>
                  </div>
                ) : result.what === 'freight_vouchers' ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    <span>Freight bills: <b className="text-slate-900">{result.transport_bills ?? 0}</b></span>
                    <span>Payments settled: <b className="text-slate-900">{result.payments ?? 0}</b></span>
                    <span>Already up to date: <b className="text-slate-900">{result.skipped_existing ?? 0}</b></span>
                    {result.errors?.length > 0 && (
                      <div className="col-span-2 rounded border border-red-200 bg-red-50 p-2">
                        <p className="text-xs font-medium text-red-700 mb-1">{result.errors.length} row(s) skipped with errors:</p>
                        <div className="max-h-24 overflow-y-auto text-[11px] text-red-800 font-mono space-y-0.5">
                          {result.errors.map((e, i) => <div key={i}>{e}</div>)}
                        </div>
                      </div>
                    )}
                    <span className="col-span-2 text-slate-500">{result.dry_run ? 'Preview only — press Import to save.' : 'Freight bills imported. Open Bills to view.'}</span>
                  </div>
                ) : result.what === 'expense_vouchers' ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    <span>Expense bills: <b className="text-slate-900">{result.expense_bills ?? 0}</b></span>
                    <span>Direct-pay (cash): <b className="text-slate-900">{result.expense_bills_cash ?? 0}</b></span>
                    <span>Vendor payments: <b className="text-slate-900">{result.payments ?? 0}</b></span>
                    <span>Already up to date: <b className="text-slate-900">{result.skipped_existing ?? 0}</b></span>
                    {result.errors?.length > 0 && (
                      <div className="col-span-2 rounded border border-red-200 bg-red-50 p-2">
                        <p className="text-xs font-medium text-red-700 mb-1">{result.errors.length} row(s) skipped with errors:</p>
                        <div className="max-h-24 overflow-y-auto text-[11px] text-red-800 font-mono space-y-0.5">
                          {result.errors.map((e, i) => <div key={i}>{e}</div>)}
                        </div>
                      </div>
                    )}
                    <span className="col-span-2 text-slate-500">{result.dry_run ? 'Preview only — press Import to save.' : 'Expense bills imported. Open Bills to view.'}</span>
                  </div>
                ) : result.what === 'freight_inward' ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    <span>Freight total: <b className="text-slate-900">₹{result.grand_total ?? 0}</b></span>
                    <span>Freight entries: <b className="text-slate-900">{result.legs ?? 0}</b></span>
                    <span className="col-span-2 text-slate-500">{result.dry_run ? 'Preview only — press Import to save.' : 'Saved. Open the Creditors → Freight page to view.'}</span>
                  </div>
                ) : result.what === 'opening' ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    <span>Opening receivables: <b className="text-slate-900">{result.opening_receivables ?? 0}</b></span>
                    <span>Opening payables: <b className="text-slate-900">{result.opening_payables ?? 0}</b></span>
                    <span>Already present (skipped): <b className="text-slate-900">{result.skipped_existing ?? 0}</b></span>
                    <span>Unmatched parties: <b className={(result.unmatched || []).length ? 'text-amber-700' : 'text-slate-900'}>{(result.unmatched || []).length}</b></span>
                    {(result.unmatched || []).length > 0 && (
                      <div className="col-span-2 mt-1 rounded border border-amber-200 bg-amber-50 p-2">
                        <p className="text-[11px] text-amber-800 mb-1">
                          These Tally parties have an opening balance but no matching master here, so their
                          opening was <b>skipped</b>. Create or map them, then run this again.
                        </p>
                        <div className="max-h-32 overflow-y-auto text-[11px] text-amber-900">
                          {(result.unmatched || []).map((n) => <div key={n} className="truncate">• {n}</div>)}
                        </div>
                      </div>
                    )}
                  </div>
                ) : result.action === 'revert' ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    {result.what === 'purchase' ? (
                      <>
                        <span>Non-scanned bills deleted: <b className="text-slate-900">{result.purchase}</b></span>
                        <span>Scan bills detached (scan kept): <b className="text-slate-900">{result.detached ?? 0}</b></span>
                        <span>Payments deleted (all in period): <b className="text-slate-900">{result.payments}</b></span>
                        <span>Freight deleted (in+out+local): <b className="text-slate-900">{result.freight ?? 0}</b></span>
                        <span>Freight snapshot rows: <b className="text-slate-900">{result.freight_snapshots ?? 0}</b></span>
                        <span>TDS entries deleted: <b className="text-slate-900">{result.tds ?? 0}</b></span>
                        <span>Bank payments deleted: <b className="text-slate-900">{result.bank_payments ?? 0}</b></span>
                      </>
                    ) : (
                      <>
                        <span>Invoices deleted: <b className="text-slate-900">{result.sales}</b></span>
                        <span>Receipts reversed: <b className="text-slate-900">{result.receipts}</b></span>
                      </>
                    )}
                  </div>
                ) : result.what === 'parties' ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    {partyKind !== 'vendor' && partyKind !== 'transporter' && partyKind !== 'expense_party' && <span>Customers {result.dry_run ? 'to create' : 'created'}: <b className="text-slate-900">{result.customers}</b></span>}
                    {partyKind !== 'customer' && <span>{partyKind === 'transporter' ? 'Transporters' : partyKind === 'expense_party' ? 'Expense parties' : 'Vendors'} {result.dry_run ? 'to create' : 'created'}: <b className="text-slate-900">{result.vendors}</b></span>}
                    {partyKind !== 'vendor' && (result.updated_customers ?? 0) > 0 && (
                      <span className="col-span-2 text-emerald-700">Existing customers {result.dry_run ? 'to update' : 'updated'} from Tally (GSTIN / address / contact / terms): <b>{result.updated_customers}</b></span>
                    )}
                    <span>Already up to date: <b className="text-slate-900">{result.skipped_existing}</b></span>
                    <span>{partyKind ? 'Other-side / non-party ledgers' : 'Non-party ledgers'}: <b className="text-slate-900">{result.skipped_other}</b></span>
                    {result.skipped_protected > 0 && (
                      <span className="col-span-2 text-slate-500">Greenstar / T.Stanes kept as production: <b className="text-slate-900">{result.skipped_protected}</b></span>
                    )}
                    {(result.skipped_empty ?? 0) > 0 && (
                      <span className="col-span-2 text-slate-500">Empty Tally ledgers (no entries) skipped: <b className="text-slate-900">{result.skipped_empty}</b></span>
                    )}
                  </div>
                ) : result.what === 'sales' ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    <span>Sales invoices: <b className="text-slate-900">{result.sales}</b></span>
                    <span>Receipts (paid): <b className="text-slate-900">{result.receipts}</b></span>
                    <span>New products: <b className="text-slate-900">{result.dry_run ? (result.new_products?.length || 0) : result.products_created}</b></span>
                    <span>Already imported: <b className="text-slate-900">{result.skipped_existing}</b></span>
                  </div>
                ) : result.what === 'purchase' ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    <span>Vendor bills: <b className="text-slate-900">{result.bills?.created ?? result.purchase ?? 0}{result.bills?.updated ? ` (+${result.bills.updated} updated)` : ''}</b></span>
                    {(result.transport_bills ?? result.bills?.transport_bills ?? 0) > 0 && (
                      <span>Transport freight bills: <b className="text-slate-900">{result.transport_bills ?? result.bills?.transport_bills}</b></span>
                    )}
                    <span>Payments: <b className="text-slate-900">{result.payments_count ?? result.payments ?? 0}</b></span>
                    {(result.payments_topped_up ?? 0) > 0 && (
                      <span>Payments corrected (leftover added): <b className="text-slate-900">{result.payments_topped_up}</b></span>
                    )}
                    {(result.payable_adjustments?.journal_contra ?? 0) > 0 && (
                      <span>Vendor adjustments (journal/contra): <b className="text-slate-900">{result.payable_adjustments.journal_contra}</b>
                        {result.payable_adjustments.amount && <> · ₹{result.payable_adjustments.amount}</>}
                      </span>
                    )}
                    <span>Debit/Credit notes: <b className="text-slate-900">{result.notes_count ?? 0}</b></span>
                    <span>Already imported: <b className="text-slate-900">{result.bills?.unchanged ?? result.skipped_existing ?? 0}</b></span>
                    {(result.bills?.cancelled ?? 0) > 0 && <span>Cancelled (deleted in Tally): <b className="text-amber-700">{result.bills.cancelled}</b></span>}
                    {(result.bills?.no_vendor ?? 0) > 0 && <span>Unresolved vendors: <b className="text-amber-700">{result.bills.no_vendor}</b></span>}
                    {result.bills?.charge_ledgers && Object.keys(result.bills.charge_ledgers).length > 0 && (
                      <div className="col-span-2 mt-1 rounded border border-slate-200 bg-white p-2">
                        <p className="text-[11px] font-semibold text-slate-500 mb-1">Charge ledgers (outside Purchase Accounts):</p>
                        <div className="max-h-24 overflow-y-auto text-[11px] text-slate-600">
                          {Object.entries(result.bills.charge_ledgers).map(([nm, [amt, n]]) => (
                            <div key={nm} className="flex justify-between"><span className="truncate mr-2">{nm}</span><span className="text-slate-800 whitespace-nowrap">₹{Number(amt).toLocaleString('en-IN')} ({n})</span></div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                    <span>Sales invoices: <b className="text-slate-900">{result.sales}</b></span>
                    <span>Vendor bills: <b className="text-slate-900">{result.purchase}</b></span>
                    {(result.transport_bills ?? 0) > 0 && (
                      <span>Transport freight bills: <b className="text-slate-900">{result.transport_bills}</b></span>
                    )}
                    <span>Receipts: <b className="text-slate-900">{result.receipts}</b></span>
                    <span>Payments: <b className="text-slate-900">{result.payments}</b></span>
                    {(result.payments_topped_up ?? 0) > 0 && (
                      <span>Payments corrected (leftover added): <b className="text-slate-900">{result.payments_topped_up}</b></span>
                    )}
                    {(result.payable_adjustments?.journal_contra ?? 0) > 0 && (
                      <span>Vendor adjustments (journal/contra): <b className="text-slate-900">{result.payable_adjustments.journal_contra}</b></span>
                    )}
                    <span>New products: <b className="text-slate-900">{result.dry_run ? (result.new_products?.length || 0) : result.products_created}</b></span>
                    <span>Already imported: <b className="text-slate-900">{result.skipped_existing}</b></span>
                  </div>
                )}
                {/* ── Mirror check: month by month, Tally vs what we created ──
                    Purely informational — the import never blocks on it. A month
                    that doesn't tie is visible the day it happens instead of
                    surfacing weeks later as a variance nobody can trace. */}
                {result.mirror?.length > 0 && (
                  <div className={`mt-3 rounded-lg border p-2 ${result.mirror_ok ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
                    <p className={`text-xs font-semibold mb-1.5 ${result.mirror_ok ? 'text-emerald-800' : 'text-rose-800'}`}>
                      {result.mirror_ok
                        ? '✓ Every month matches Tally to the rupee'
                        : '✗ Some months do NOT match Tally — check these before relying on the figures'}
                    </p>
                    <table className="w-full text-[11px]">
                      <thead className="text-slate-500">
                        <tr><th className="text-left font-medium">Month</th><th className="text-right font-medium">Vch</th>
                          <th className="text-right font-medium">Tally</th><th className="text-right font-medium">Imported</th>
                          <th className="text-right font-medium">Difference</th></tr>
                      </thead>
                      <tbody>
                        {result.mirror.map((r) => (
                          <tr key={r.month} className={r.ok ? 'text-slate-700' : 'text-rose-700 font-semibold'}>
                            <td>{r.month}</td>
                            <td className="text-right">{r.vouchers}</td>
                            <td className="text-right tabular-nums">{r.tally}</td>
                            <td className="text-right tabular-nums">{r.erp}</td>
                            <td className="text-right tabular-nums">{r.ok ? '✓' : r.diff}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Debit/Credit notes are counted separately from the value
                    mirror above, which only measures sales vouchers: SS Biochem
                    lost 13 of Tally's 60 notes (nine in August alone) while
                    every month of that mirror still read green. */}
                {result.notes_mirror?.length > 0 && (
                  <div className={`mt-2 rounded-lg border p-2 ${result.notes_mirror_ok ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
                    <p className={`text-xs font-semibold mb-1.5 ${result.notes_mirror_ok ? 'text-emerald-800' : 'text-rose-800'}`}>
                      {result.notes_mirror_ok
                        ? '✓ Every debit/credit note in Tally was imported'
                        : '✗ Some debit/credit notes were NOT imported — resolve the parties listed below, then re-import'}
                    </p>
                    <table className="w-full text-[11px]">
                      <thead className="text-slate-500">
                        <tr><th className="text-left font-medium">Month</th><th className="text-right font-medium">Notes in Tally</th>
                          <th className="text-right font-medium">Imported</th><th className="text-right font-medium">Missing</th></tr>
                      </thead>
                      <tbody>
                        {result.notes_mirror.map((r) => (
                          <tr key={r.month} className={r.ok ? 'text-slate-700' : 'text-rose-700 font-semibold'}>
                            <td>{r.month}</td>
                            <td className="text-right">{r.tally}</td>
                            <td className="text-right">{r.erp}</td>
                            <td className="text-right">{r.ok ? '✓' : r.missing}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Voucher types we did not import. Usually correct — Contra,
                    Stock Journal and Payroll are not sales — but a voucher type
                    named something we don't recognise lands here too, and used
                    to disappear without a word: United Agro's "GST Rent" is in
                    Tally's Sales Register and its GSTR-1, and left April
                    Rs 11,800 short with nothing on screen to explain it. */}
                {result.skipped_types?.length > 0 && (
                  <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <p className="text-xs font-semibold text-slate-700 mb-1">
                      Not imported — {result.skipped_types.length} voucher type{result.skipped_types.length > 1 ? 's' : ''}
                      <span className="font-normal text-slate-500"> · check nothing here belongs in sales</span>
                    </p>
                    <div className="max-h-28 overflow-y-auto">
                      <table className="w-full text-[11px]">
                        <tbody>
                          {result.skipped_types.map((t) => (
                            <tr key={t.vtype} className="text-slate-600">
                              <td className="truncate pr-2">{t.vtype}</td>
                              <td className="text-right tabular-nums w-12">{t.count}</td>
                              <td className="text-right tabular-nums w-28">₹{t.value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Legs Tally says ARE debtors, but whose name matches no ERP
                    customer. A spelling gap, not an accounting one — and the
                    most damaging kind, because the money is real and simply
                    vanishes from Amount Received and Outstanding together.

                    JN87/26-27 (30-Apr, Rs 10,625): Tally's ledger reads
                    "T.Stanes And Company Ltd - Coimbatore", the ERP master
                    "T.Stanes And Company Ltd., - Coimbatore". One comma. Four
                    months lost a journal apiece this way.

                    Shown apart from the non-customer list because the remedy
                    differs: those are correctly refused; THESE need a party
                    mapping, or the master renamed to match Tally. */}
                {result.adjustments?.unresolved_customer_legs
                  && Object.keys(result.adjustments.unresolved_customer_legs).length > 0 && (
                  <div className="mt-2 rounded-lg border border-rose-300 bg-rose-50 p-2">
                    <p className="text-xs font-semibold text-rose-900 mb-1">
                      {Object.keys(result.adjustments.unresolved_customer_legs).length} debtor
                      {Object.keys(result.adjustments.unresolved_customer_legs).length > 1 ? 's' : ''} in Tally with no matching customer here — money DROPPED
                      <span className="font-normal text-rose-700"> · map the name on the Mappings page, then re-import</span>
                    </p>
                    <div className="max-h-28 overflow-y-auto">
                      <table className="w-full text-[11px]">
                        <tbody>
                          {Object.entries(result.adjustments.unresolved_customer_legs)
                            .sort((a, b) => Number(b[1]?.amount || 0) - Number(a[1]?.amount || 0))
                            .map(([name, info]) => (
                            <tr key={name} className="text-rose-800">
                              <td className="truncate pr-2">{name}</td>
                              <td className="truncate pr-2 text-rose-600">{info?.group || '(no group)'}</td>
                              <td className="text-right tabular-nums w-28">₹{info?.amount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Credit/debit legs the adjustments importer judged NOT to be a
                    customer, by the ledger's own Tally group.
                    
                    Usually right — a journal crediting a bank, an expense or a
                    loan is not a customer paying. But when a real DEBTOR is
                    turned away, the money vanishes from Amount Received AND
                    from Outstanding at once, and nothing said so.

                    SS Biochem lost one journal a month this way: JN87/26-27
                    (30-Apr, Rs 10,625) and JN619/26-27 (12-Aug, Rs 35,876)
                    among them — Rs 93,195 missing from Received across Apr–Aug
                    and, cumulatively, Rs 85,777 too much Outstanding. It took
                    six months of hand-comparison against Tally to find. The
                    importer knew all along which ledgers it dropped and what
                    group each sat in; it simply never showed anyone. */}
                {result.adjustments?.non_customer_legs
                  && Object.keys(result.adjustments.non_customer_legs).length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
                    <p className="text-xs font-semibold text-amber-900 mb-1">
                      {Object.keys(result.adjustments.non_customer_legs).length} credit/debit leg
                      {Object.keys(result.adjustments.non_customer_legs).length > 1 ? 's' : ''} not counted as customer money
                      <span className="font-normal text-amber-700"> · anything here that IS a debtor is missing from Amount Received and Outstanding</span>
                    </p>
                    <div className="max-h-28 overflow-y-auto">
                      <table className="w-full text-[11px]">
                        <tbody>
                          {Object.entries(result.adjustments.non_customer_legs)
                            .sort((a, b) => Number(b[1]?.amount || 0) - Number(a[1]?.amount || 0))
                            .map(([name, info]) => (
                            <tr key={name} className="text-amber-800">
                              <td className="truncate pr-2">{name}</td>
                              <td className="truncate pr-2 text-amber-600">{info?.group || '(no group)'}</td>
                              <td className="text-right tabular-nums w-28">₹{info?.amount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Dropped because the voucher names NO party. Every other skip
                    path can ask the operator to map a name; this one cannot,
                    because there is no name — so it used to return in silence and
                    the voucher vanished with nothing on screen. The number and
                    date are enough to find it in Tally. */}
                {result.no_party_vouchers?.length > 0 && (
                  <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2">
                    <p className="text-xs font-semibold text-rose-800 mb-1">
                       {result.no_party_vouchers.length} voucher{result.no_party_vouchers.length > 1 ? 's' : ''} with no party name — dropped
                      <span className="font-normal text-rose-600"> · nothing to map; fix the party on the voucher in Tally, then re-import</span>
                    </p>
                    <div className="max-h-28 overflow-y-auto">
                      <table className="w-full text-[11px]">
                        <tbody>
                          {result.no_party_vouchers.map((r, i) => (
                            <tr key={i} className="text-rose-700">
                              <td className="truncate pr-2">{r.vtype}</td>
                              <td className="truncate pr-2">{r.number}</td>
                              <td className="pr-2 whitespace-nowrap">{r.date}</td>
                              <td className="text-right tabular-nums w-28">{r.amount ? `₹${r.amount}` : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Where the ERP's document-derived balance disagrees with
                    Tally's Bills Outstanding. REPORTED, never applied — that
                    report omits credit balances and mixes in supplier advances,
                    and overwriting from it is what kept undoing corrections and
                    leaving balances with no document behind them. */}
                {result.outstanding_check?.diffs?.length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
                    <p className="text-xs font-semibold text-amber-800 mb-1">
                      {result.outstanding_check.diffs.length} bill{result.outstanding_check.diffs.length > 1 ? 's' : ''} where Tally&apos;s Bills Outstanding disagrees
                      <span className="font-normal text-amber-700"> · net ₹{result.outstanding_check.diff_total} · nothing was changed</span>
                    </p>
                    <div className="max-h-32 overflow-y-auto">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="text-amber-700">
                            <th className="text-left font-medium">Party</th>
                            <th className="text-left font-medium">Bill</th>
                            <th className="text-right font-medium w-24">ERP</th>
                            <th className="text-right font-medium w-24">Tally</th>
                            <th className="text-right font-medium w-24">Diff</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.outstanding_check.diffs.map((d, i) => (
                            <tr key={i} className="text-amber-800">
                              <td className="truncate pr-2">{d.party}</td>
                              <td className="truncate pr-2">{d.doc}</td>
                              <td className="text-right tabular-nums">{d.erp}</td>
                              <td className="text-right tabular-nums">{d.tally}</td>
                              <td className="text-right tabular-nums font-medium">{d.diff}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-1 text-[10px] text-amber-700">
                      A bill Tally settled by journal, or a credit balance, will show here — Bills Outstanding cannot represent either.
                    </p>
                  </div>
                )}

                {/* Imported fine, but Tally will DROP these from GSTR-1. */}
                {result.no_hsn?.length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
                    <p className="text-xs font-semibold text-amber-800 mb-1">
                       {result.no_hsn.length} invoice{result.no_hsn.length > 1 ? 's' : ''} with no HSN/SAC —
                      these will NOT appear in your GSTR-1. Add the HSN on the stock item in Tally, then re-import.
                    </p>
                    <div className="max-h-28 overflow-y-auto text-[11px] text-amber-900">
                      {result.no_hsn.map((r, i) => (
                        <div key={i} className="truncate">• {r.voucher} · {r.date} · {r.party} · ₹{r.value}</div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Voucher didn't balance on Tally's own terms — read wrongly. */}
                {result.unbalanced?.length > 0 && (
                  <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2">
                    <p className="text-xs font-semibold text-rose-800 mb-1">
                      ✗ {result.unbalanced.length} voucher{result.unbalanced.length > 1 ? 's' : ''} did not add up
                      (goods + GST − TDS + round-off ≠ invoice total) — imported, but worth opening in Tally.
                    </p>
                    <div className="max-h-28 overflow-y-auto text-[11px] text-rose-900">
                      {result.unbalanced.map((r, i) => (
                        <div key={i} className="truncate">• {r.voucher} · {r.date} · {r.party} · off by ₹{r.diff}</div>
                      ))}
                    </div>
                  </div>
                )}

                {/* A receipt that named NO bill is spread oldest-first across the
                    party's open bills. That is a GUESS, and when it is wrong the
                    party total still looks right while the per-bill picture is
                    wrong -- which no total-level check can see. Tally receipt 264
                    (27-Oct-2026, Rs 24,62,460) is "Agst Ref TS-130/26-27" on
                    T.Stanes Coimbatore yet arrived with no allocation, so it was
                    spread over two bills of the Coimbatore - Exp master and hid
                    for five weeks behind a matching combined total. Shown here so
                    it is linked by hand the same day instead. */}
                {result.receipts_allocated_without_bill_ref?.length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
                    <p className="text-xs font-semibold text-amber-900 mb-1">
                      <AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />
                      {result.receipts_allocated_without_bill_ref.length} receipt(s) came with
                      no bill reference — the money was applied oldest-bill-first.
                      Check these against Tally and re-link if they landed wrong.
                    </p>
                    <div className="max-h-28 overflow-y-auto text-[11px] text-amber-900">
                      {result.receipts_allocated_without_bill_ref.map((r, i) => (
                        <div key={i} className="truncate">
                          • {r.voucher} · {r.date} · {r.party} → {(r.applied_to || [])
                            .map((b) => `${b.bill} ₹${b.amount}`).join(', ')}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* A GSTIN belongs to the TAXPAYER, not the ledger, so it matches
                    the master we BUY from as readily as the one we sell to. Binding
                    a sale there hides it from debtors completely. The importer now
                    refuses and the party drops into the Map / Create / Skip list
                    above; this says why, so the choice is an informed one. */}
                {result.gstin_matched_a_supplier?.length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
                    <p className="text-xs font-semibold text-amber-900 mb-1">
                      <AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />
                      {result.gstin_matched_a_supplier.length} party matched a SUPPLIER
                      master by GSTIN only — not used. Map it to the right customer above.
                    </p>
                    <div className="max-h-28 overflow-y-auto text-[11px] text-amber-900">
                      {result.gstin_matched_a_supplier.map((r, i) => (
                        <div key={i} className="truncate">
                          • {r.tally_name} → would have used “{r.erp_name}” ({r.group})
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {(result.unmatched_customers?.length > 0 || result.unmatched_vendors?.length > 0 || result.new_products?.length > 0
                  || result.new_voucher_types?.length > 0 || result.skipped_voucher_types?.length > 0
                  || result.changed_vouchers?.length > 0 || result.deleted_vouchers?.length > 0) && (() => {
                  const partyRows = [
                    ...(result.unmatched_customers || []).map((n) => ({ name: n, kind: 'customer', key: 'c:' + n, opts: (result.customer_options || {})[n] || [] })),
                    ...(result.unmatched_vendors || []).map((n) => ({ name: n, kind: 'vendor', key: 'v:' + n, opts: (result.vendor_options || {})[n] || [] })),
                  ];
                  const productRows = (result.new_products || []).map((n) => ({ name: n, kind: 'product', key: 'p:' + n, opts: (result.product_options || {})[n] || [] }));
                  const rows = resolveTab === 'products' ? productRows : partyRows;
                  const vtRows = result.new_voucher_types || [];
                  const vtSkipped = result.skipped_voucher_types || [];
                  const vcChanged = result.changed_vouchers || [];
                  const purchaseDeleted = (result.purchase_deleted_vouchers || []).map((b) => ({
                    id: 'pb:' + b.id,
                    kind: 'deleted',
                    doc_type: 'vendor_bill',
                    doc_label: 'Vendor Bill',
                    number: b.bill_no,
                    date: b.bill_date,
                    party: b.vendor_name,
                    old_total: b.total_amount,
                    new_total: '',
                    money: '0',
                    diff: [],
                    blocked: 'Purchase bills deleted in Tally stay live in ERP — verify with accountant before removing.',
                    effect: '',
                  }));
                  const vcDeleted = [...(result.deleted_vouchers || []), ...purchaseDeleted];
                  return (
                    <div className="mt-2 border-t border-amber-200 pt-2">
                      <p className="text-xs font-medium text-amber-700 mb-1.5">
                        {parties
                          ? <><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />{partyRows.length + productRows.length} <b>possible duplicate(s)</b> — a similar name or the same GSTIN already exists. <b>Map</b> to the existing record, <b>Create</b> new, or <b>Skip</b>.</>
                          : <><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />{partyRows.length + productRows.length} unmatched — <b>Map</b> to an existing master record, <b>Create</b> new, or <b>Skip</b>.</>}
                      </p>
                      {/* Parties / Products switch */}
                      <div className="flex gap-0.5 mb-1.5 bg-slate-100 rounded-lg p-0.5">
                        <button type="button" onClick={() => setResolveTab('parties')}
                          className={`flex-1 rounded-md py-1 text-xs font-medium transition ${resolveTab === 'parties' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                          Customers / Vendors ({partyRows.length})
                        </button>
                        <button type="button" onClick={() => setResolveTab('products')}
                          className={`flex-1 rounded-md py-1 text-xs font-medium transition ${resolveTab === 'products' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                          Products ({productRows.length})
                        </button>
                        <button type="button" onClick={() => setResolveTab('vtypes')}
                          className={`flex-1 rounded-md py-1 text-xs font-medium transition ${resolveTab === 'vtypes' ? 'bg-white shadow-sm text-slate-800' : vtRows.length ? 'text-rose-600' : 'text-slate-500 hover:text-slate-700'}`}>
                          Voucher types ({vtRows.length})
                        </button>
                        <button type="button" onClick={() => setResolveTab('changed')}
                          className={`flex-1 rounded-md py-1 text-xs font-medium transition ${resolveTab === 'changed' ? 'bg-white shadow-sm text-slate-800' : vcChanged.length ? 'text-rose-600' : 'text-slate-500 hover:text-slate-700'}`}>
                          Changed in Tally ({vcChanged.length})
                        </button>
                        <button type="button" onClick={() => setResolveTab('deleted')}
                          className={`flex-1 rounded-md py-1 text-xs font-medium transition ${resolveTab === 'deleted' ? 'bg-white shadow-sm text-slate-800' : vcDeleted.length ? 'text-amber-600' : 'text-slate-500 hover:text-slate-700'}`}>
                          Deleted in Tally ({vcDeleted.length})
                        </button>
                      </div>
                      {(resolveTab === 'changed' || resolveTab === 'deleted') ? (
                        <VoucherChangePanel which={resolveTab}
                          rows={resolveTab === 'changed' ? vcChanged : vcDeleted}
                          warnings={result.voucher_change_warnings || []}
                          dec={vcDecisions}
                          setDec={(id, a) => setVcDecisions((p) => ({ ...p, [id]: p[id] === a ? undefined : a }))}
                          // Bulk-set every row in THIS tab to one action at once;
                          // a null clears them. A blocked row can only ever be
                          // "keep", so "Update all"/"Remove all" leaves those on
                          // keep instead of a disallowed action. Individual rows
                          // can still be toggled afterwards for exceptions.
                          setAll={(a) => {
                            const rws = resolveTab === 'changed' ? vcChanged : vcDeleted;
                            setVcDecisions((p) => {
                              const next = { ...p };
                              for (const r of rws) {
                                next[r.id] = !a ? undefined : ((a !== 'keep' && r.blocked) ? 'keep' : a);
                              }
                              return next;
                            });
                          }}
                          onApply={() => applyVoucherChanges(resolveTab)} busy={busy} />
                      ) : resolveTab === 'vtypes' ? (
                        <VoucherTypePanel rows={vtRows} skipped={vtSkipped} dec={vtDecisions}
                          setDec={(k, v) => setVtDecisions((p) => ({ ...p, [k]: { ...(p[k] || {}), ...v } }))}
                          onApply={() => applyVoucherTypes()} onUndo={undoVoucherTypeSkip} busy={busy} />
                      ) : (<>
                      {/* NO `overflow-auto` here. Each row's Map/Create/Skip
                          dropdown is absolutely positioned, and an overflow on
                          this container clipped it — the list opened INSIDE the
                          box and you could not read or reach the options. The
                          modal itself already scrolls (max-h-[90dvh]), so a long
                          unmatched list stays reachable; the dropdown now
                          escapes the row and sits above everything. Applies to
                          the Products tab too — same container. */}
                      <div className="rounded border border-slate-200 bg-white divide-y divide-slate-100">
                        {rows.length === 0 && (
                          <div className="px-2 py-4 text-center text-xs text-slate-400">No unmatched {resolveTab === 'products' ? 'products' : 'customers / vendors'}</div>
                        )}
                        {rows.map((r) => (
                          // `relative` + a descending z-index per row so an open
                          // dropdown paints OVER the rows beneath it rather than
                          // being covered by the next row's own stacking context.
                          <div key={r.key} className="relative flex items-center gap-2 px-2 py-1 text-xs">
                            <span className={`text-[9px] uppercase tracking-wide shrink-0 ${r.kind === 'customer' ? 'text-indigo-500' : r.kind === 'vendor' ? 'text-emerald-600' : 'text-amber-600'}`}>{r.kind[0]}</span>
                            <span className="text-slate-700 truncate flex-1" title={r.name}>{r.name}</span>
                            <PartyMapControl dec={decisions[r.key]} onSet={(obj) => setDec(r.key, obj)}
                              kind={r.kind} opts={r.opts} company={company} tallyCompany={tallyCompany} />
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center justify-between mt-1.5">
                        <span className="text-[11px] text-slate-400">Applies both tabs. Created records pull GST / address from Tally.</span>
                        <Button variant="outline" onClick={applyResolve} disabled={busy} className="text-xs">
                          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Apply & re-preview'}
                        </Button>
                      </div>
                      </>)}
                    </div>
                  );
                })()}
                {result.errors?.length > 0 && (
                  <div className="mt-1 rounded border border-red-200 bg-red-50 p-2">
                    <p className="text-xs font-medium text-red-700 mb-1">{result.errors.length} row(s) skipped with errors:</p>
                    <div className="max-h-28 overflow-y-auto text-[11px] text-red-800 space-y-0.5">
                      {result.errors.map((e, i) => <div key={i} className="font-mono">{e}</div>)}
                    </div>
                  </div>
                )}
              </div>
            )}

            {!isReconciliation && (
            <div className="flex justify-end items-center gap-2 mt-2">
              <button onClick={close}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition flex items-center gap-1.5 ${
                  busy
                    ? 'border-red-300 text-red-700 bg-red-50 hover:bg-red-100'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                {busy && <Ban size={14} />}
                {busy ? 'Cancel Import' : 'Close'}
              </button>
              <Button variant="outline" onClick={() => run(true)} disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Preview'}
              </Button>
              <Button variant="primary" onClick={() => (revert ? run(false) : importAll())}
                disabled={busy || !result || result.dry_run === false || (!revert && waiting.all > 0)}
                className={revert ? 'bg-rose-600 hover:bg-rose-700 border-rose-600' : undefined}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (revert ? 'Delete' : 'Import')}
              </Button>
            </div>
            )}
            {busy && connectorProgress && (
              <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span className="font-medium">
                    {connectorProgress.status === 'PENDING' && 'Waiting for local connector…'}
                    {connectorProgress.status === 'RUNNING' && (
                      connectorProgress.vouchers > 0
                        ? `Processing: ${connectorProgress.vouchers.toLocaleString()} vouchers (${connectorProgress.months} months)`
                        : 'Connector fetching from Tally…'
                    )}
                  </span>
                </div>
                {connectorProgress.batches > 0 && (
                  <div className="mt-1 text-[11px] text-blue-600">
                    {connectorProgress.batches} batch{connectorProgress.batches !== 1 ? 'es' : ''} received
                  </div>
                )}
              </div>
            )}
            {!isReconciliation && !result && <p className="text-[11px] text-slate-400 mt-2 text-right">Run <b>Preview</b> first to see what will import.</p>}
            {!isReconciliation && !revert && waiting.all > 0 && (
              <p className="text-[11px] text-rose-600 mt-2 text-right">
                Choose for every row first:{' '}
                {[['Voucher types', waiting.vt], ['Changed in Tally', waiting.ch], ['Deleted in Tally', waiting.dl]]
                  .filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ')}.
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}


function ReconciliationPanel({ data, loading, onLoad, onClose, company, tallyCompany, from, to }) {
  const [expandedVendor, setExpandedVendor] = useState(null);
  const [rematching, setRematching] = useState(false);
  const [rematchResult, setRematchResult] = useState(null);

  const runRematch = async () => {
    if (!company) { toast.error('Pick a company first'); return; }
    setRematching(true);
    try {
      const res = await apiClient.post('/api/tally/import/', {
        company, tally_company: tallyCompany || undefined,
        dry_run: false, what: 'rematch_creditors',
      });
      setRematchResult(res.data);
      toast.success(`Re-matched ${res.data.matched} of ${res.data.unmapped_total} unmapped vendors`);
      onLoad();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Re-match failed');
    } finally {
      setRematching(false);
    }
  };
  const fmt = (v) => {
    const n = parseFloat(v || 0);
    const abs = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n < 0 ? `(${abs})` : abs;
  };
  const sign = (v) => {
    const n = parseFloat(v || 0);
    if (n > 1) return 'Cr';
    if (n < -1) return 'Dr';
    return '';
  };

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">
        Compares each vendor's ERP-computed closing (opening + bills − payments − debit notes + credit notes)
        against Tally's Sundry Creditors closing. Vendors that match within ₹1 are hidden.
        Requires a Creditors import first.
      </p>

      <div className="flex items-center gap-2 mb-3">
        <Button variant="outline" onClick={onLoad} disabled={loading} className="text-xs">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Load Gaps'}
        </Button>
        <Button variant="outline" onClick={runRematch} disabled={rematching || loading} className="text-xs">
          {rematching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Re-match Vendors'}
        </Button>
        <button onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50 transition">
          Close
        </button>
      </div>
      {rematchResult && (
        <div className="text-xs text-slate-600 mb-2 p-2 rounded bg-emerald-50 border border-emerald-200">
          Re-matched <b>{rematchResult.matched}</b> of {rematchResult.unmapped_total} unmapped.
          {rematchResult.still_unmapped > 0 && <> Still unmapped: <b>{rematchResult.still_unmapped}</b></>}
        </div>
      )}

      {data && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="flex items-center gap-4 mb-3">
            <span className="text-xs text-slate-600">
              <b className="text-slate-800">{data.total_vendors}</b> Tally vendors
            </span>
            <span className="text-xs text-emerald-700">
              <b>{data.matched}</b> matched
            </span>
            <span className="text-xs text-rose-700">
              <b>{data.gaps?.length || 0}</b> with gaps
            </span>
            {(data.erp_only_count || 0) > 0 && (
              <span className="text-xs text-amber-700">
                <b>{data.erp_only_count}</b> ERP-only
              </span>
            )}
            {(data.non_vendor_skipped || 0) > 0 && (
              <span className="text-xs text-slate-400">
                <b>{data.non_vendor_skipped}</b> non-vendor skipped
              </span>
            )}
          </div>

          {(!data.gaps || data.gaps.length === 0) ? (
            <div className="text-center py-4 text-xs text-slate-400">
              {data.total_vendors === 0
                ? 'No Creditor Balance data found. Run "Creditors" import first.'
                : 'All Vendors match Tally within ₹1. No gaps found.'}
            </div>
          ) : (
            <div className="max-h-[50vh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-100">
                  <tr className="text-slate-500">
                    <th className="text-left py-1.5 px-2 font-medium">Vendor</th>
                    <th className="text-left py-1.5 px-1 font-medium w-28">Group</th>
                    <th className="text-right py-1.5 px-2 font-medium">Tally Closing</th>
                    <th className="text-right py-1.5 px-2 font-medium">ERP Closing</th>
                    <th className="text-right py-1.5 px-2 font-medium">Gap</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.gaps.map((g, i) => {
                    const gap = parseFloat(g.gap);
                    const expanded = expandedVendor === i;
                    return (
                      <Fragment key={g.vendor_id || i}>
                        <tr
                          className={`hover:bg-white cursor-pointer ${g.erp_only ? 'bg-amber-50/50' : ''} ${!g.vendor_id ? 'bg-rose-50/50' : ''}`}
                          onClick={() => setExpandedVendor(expanded ? null : i)}
                        >
                          <td className="py-1.5 px-2 font-medium text-slate-800 truncate max-w-[200px]" title={g.vendor_name}>
                            {g.vendor_name}
                            {g.erp_only && <span className="ml-1 text-[9px] uppercase text-amber-600 font-semibold">ERP only</span>}
                            {!g.vendor_id && <span className="ml-1 text-[9px] uppercase text-rose-500 font-semibold">Unmapped</span>}
                            {g.suggested_match && (
                              <div className="text-[9px] text-indigo-600 truncate" title={g.suggested_match}>
                                → may be: {g.suggested_match}
                              </div>
                            )}
                          </td>
                          <td className="py-1.5 px-1 text-slate-500 truncate max-w-[110px]" title={g.parent_group}>
                            {(g.parent_group || '').replace(/^Sundry Creditors[-\s]*/i, '')}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-slate-600">
                            {fmt(g.tally_closing)} <span className="text-[10px] text-slate-400">{sign(g.tally_closing)}</span>
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-slate-600">
                            {fmt(g.erp_closing)} <span className="text-[10px] text-slate-400">{sign(g.erp_closing)}</span>
                          </td>
                          <td className={`py-1.5 px-2 text-right tabular-nums font-semibold ${gap > 0 ? 'text-rose-700' : 'text-blue-700'}`}>
                            {fmt(g.gap)}
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={5} className="bg-white px-3 py-2">
                              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
                                <div className="font-medium text-slate-500 col-span-2 mb-1">ERP Breakdown</div>
                                <div className="flex justify-between"><span className="text-slate-500">Opening</span><span className="tabular-nums">{fmt(g.erp_opening)}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">+ Bills (gross)</span><span className="tabular-nums">{fmt(g.erp_bills)}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">− Payments</span><span className="tabular-nums">{fmt(g.erp_payments)}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">− Debit Notes</span><span className="tabular-nums">{fmt(g.erp_dn_dr)}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">+ Credit Notes</span><span className="tabular-nums">{fmt(g.erp_dn_cr)}</span></div>
                                <div className="flex justify-between font-semibold border-t border-slate-200 pt-1 mt-1">
                                  <span>= ERP Closing</span><span className="tabular-nums">{fmt(g.erp_closing)}</span>
                                </div>
                                <div className="font-medium text-slate-500 col-span-2 mt-2 mb-1">Tally</div>
                                <div className="flex justify-between"><span className="text-slate-500">Debit (Dr)</span><span className="tabular-nums">{fmt(g.tally_debit)}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">Credit (Cr)</span><span className="tabular-nums">{fmt(g.tally_credit)}</span></div>
                                <div className="flex justify-between font-semibold border-t border-slate-200 pt-1 mt-1">
                                  <span>= Tally Closing</span><span className="tabular-nums">{fmt(g.tally_closing)}</span>
                                </div>
                                {g.tally_as_of && (
                                  <div className="col-span-2 text-[10px] text-slate-400 mt-1">As of {g.tally_as_of}</div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <MissingBillsPanel company={company} from={from} to={to} />
    </div>
  );
}


function MissingBillsPanel({ company, from: initFrom, to: initTo }) {
  const [source, setSource] = useState('');
  const [serverPath, setServerPath] = useState('');
  const [mbFrom, setMbFrom] = useState(initFrom || '2026-04-01');
  const [mbTo, setMbTo] = useState(initTo || '2026-09-30');
  const [downloading, setDownloading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [importResult, setImportResult] = useState(null);

  const isGdrive = /drive\.google\.com|docs\.google\.com/i.test(source);
  const effectivePath = serverPath || source;

  const downloadToServer = async () => {
    if (!source.trim()) { toast.error('Paste a Google Drive link first'); return; }
    setDownloading(true);
    try {
      const res = await apiClient.post('/api/purchase/stream-missing-bills-download/', {
        gdrive_url: source.trim(),
      }, { timeout: 600000 });
      setServerPath(res.data.path);
      toast.success('Downloaded to server');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const scan = async () => {
    if (!company) { toast.error('Pick a company first'); return; }
    const p = serverPath || source.trim();
    if (!p) { toast.error('Enter a Google Drive link or server file path'); return; }
    if (isGdrive && !serverPath) { toast.error('Download the file to server first'); return; }
    setScanning(true);
    setScanResult(null);
    setImportResult(null);
    try {
      const res = await apiClient.post('/api/purchase/stream-missing-bills/', {
        path: p, company, from: mbFrom, to: mbTo,
      }, { timeout: 600000 });
      setScanResult(res.data);
      if (res.data.to_create?.length)
        toast.success(`${res.data.to_create.length} missing bill(s) found`);
      else
        toast.success('No missing bills — everything is imported');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const doImport = async () => {
    if (!scanResult?.to_create?.length) return;
    const guids = scanResult.to_create.map((r) => r.guid);
    setImporting(true);
    setImportResult(null);
    const p = serverPath || source.trim();
    try {
      const res = await apiClient.post('/api/purchase/stream-missing-bills-apply/', {
        path: p, company, from: mbFrom, to: mbTo, guids,
      }, { timeout: 600000 });
      setImportResult(res.data);
      toast.success(`Created ${res.data.created} bill(s)`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const fmt = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="mt-4 pt-4 border-t border-slate-200">
      <p className="text-xs font-semibold text-slate-700 mb-1">Missing Bills (from Day Book file)</p>
      <p className="text-[11px] text-slate-500 mb-2">
        Paste a Google Drive share link to your Day Book XML, or a server path like <code className="text-[10px] bg-slate-100 px-1 rounded">/tmp/daybook.xml</code>.
      </p>
      <div className="flex gap-2 items-end mb-2">
        <div className="flex-1">
          <label className="block text-[10px] text-slate-500 mb-0.5">Google Drive link or server path</label>
          <input value={source} onChange={(e) => { setSource(e.target.value); setServerPath(''); setScanResult(null); setImportResult(null); }}
            placeholder="https://drive.google.com/file/d/…/view  or  /tmp/daybook.xml"
            className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        {isGdrive && !serverPath && (
          <Button variant="outline" onClick={downloadToServer} disabled={downloading} className="text-xs whitespace-nowrap">
            {downloading ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> Downloading…</> : 'Download to Server'}
          </Button>
        )}
      </div>
      {serverPath && (
        <p className="text-[10px] text-emerald-600 mb-2">✓ Downloaded to: <code className="bg-slate-100 px-1 rounded">{serverPath}</code></p>
      )}
      <div className="flex gap-2 items-end mb-3">
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">From</label>
          <input type="date" value={mbFrom} onChange={(e) => setMbFrom(e.target.value)}
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-[10px] text-slate-500 mb-0.5">To</label>
          <input type="date" value={mbTo} onChange={(e) => setMbTo(e.target.value)}
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
        </div>
        <Button variant="outline" onClick={scan} disabled={scanning || (isGdrive && !serverPath)} className="text-xs whitespace-nowrap">
          {scanning ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> Scanning…</> : 'Find Missing'}
        </Button>
      </div>

      {scanResult && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm mb-2">
          <div className="flex flex-wrap gap-3 mb-2 text-xs">
            <span className="text-slate-600">Scanned: <b>{scanResult.total_scanned?.toLocaleString()}</b></span>
            <span className="text-emerald-700">Already in ERP: <b>{scanResult.already_in_erp}</b></span>
            <span className="text-rose-700">Missing: <b>{scanResult.to_create?.length || 0}</b></span>
            {scanResult.no_vendor > 0 && <span className="text-amber-600">No vendor: <b>{scanResult.no_vendor}</b></span>}
            {scanResult.dup_skipped > 0 && <span className="text-slate-500">Likely dups: <b>{scanResult.dup_skipped}</b></span>}
          </div>

          {scanResult.by_type && Object.keys(scanResult.by_type).length > 0 && (
            <div className="text-[11px] text-slate-500 mb-2">
              {Object.entries(scanResult.by_type).sort((a, b) => b[1] - a[1]).map(([t, c]) => (
                <span key={t} className="inline-block mr-3">{t}: <b>{c}</b></span>
              ))}
            </div>
          )}

          {scanResult.to_create?.length > 0 && (
            <>
              <div className="max-h-[35vh] overflow-auto mb-2">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100">
                    <tr className="text-slate-500">
                      <th className="text-left py-1 px-2 font-medium">Date</th>
                      <th className="text-left py-1 px-2 font-medium">Voucher No</th>
                      <th className="text-left py-1 px-2 font-medium">Type</th>
                      <th className="text-left py-1 px-2 font-medium">Vendor</th>
                      <th className="text-right py-1 px-2 font-medium">Gross</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {scanResult.to_create.map((r, i) => (
                      <tr key={r.guid || i} className="hover:bg-white">
                        <td className="py-1 px-2 tabular-nums">{r.date}</td>
                        <td className="py-1 px-2 font-mono text-[11px]">{r.tally_number || r.invoice_no}</td>
                        <td className="py-1 px-2 text-slate-600">{r.vtype}</td>
                        <td className="py-1 px-2 truncate max-w-[180px]" title={r.vendor_name}>{r.vendor_name}</td>
                        <td className="py-1 px-2 text-right tabular-nums">₹{fmt(r.gross)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={doImport} disabled={importing || !!importResult}
                  className="text-xs bg-indigo-600 text-white hover:bg-indigo-700">
                  {importing ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> Importing…</>
                    : `Import ${scanResult.to_create.length} Bill(s)`}
                </Button>
                {importResult && (
                  <span className="text-xs text-emerald-700">
                    ✓ Created {importResult.created}, failed {importResult.failed}
                  </span>
                )}
              </div>
            </>
          )}

          {scanResult.to_create?.length === 0 && (
            <p className="text-xs text-emerald-700 py-2">All purchase vouchers are already imported — nothing missing.</p>
          )}
        </div>
      )}
    </div>
  );
}


// The "Voucher types" tab. A NEW sales-side voucher type -- one the ERP has not
// seen before -- has its vouchers HELD out of the import until someone decides
// here, once, for this company:
//   Create -> import its vouchers as Tally's own base type says (decided by
//             the ERP, shown only). "Counts in turnover" is the only judgment asked:
//             rent is a Sales-type voucher for GST but is not turnover.
//   Skip   -> never import its vouchers. Listed below with Undo.
// GST is not asked: each voucher's own CGST/SGST/IGST lines decide it.
// What a new type imports as is DECIDED BY THE ERP from Tally's own base type
// (Sales -> sales invoice, Credit Note -> credit note ...). Shown, not chosen.
const VT_LABEL = {
  sales: 'Sales invoice', credit_note: 'Credit note',
  debit_note: 'Debit note', receipt: 'Receipt',
};

function VoucherTypePanel({ rows, skipped, dec, setDec, onApply, onUndo, busy }) {
  const held = rows.reduce((a, r) => a + r.count, 0);
  return (
    <div>
      {rows.length > 0 && (
        <p className="text-[11px] text-rose-700 mb-1.5">
          <AlertTriangle size={12} className="inline align-[-2px] mr-1" />
          {rows.length} new voucher type{rows.length > 1 ? 's' : ''}, {held} voucher{held === 1 ? '' : 's'}
          {' '}<b>NOT imported</b> until you choose <b>Create</b> or <b>Skip</b>. Decided once, remembered for every future import.
        </p>
      )}
      <div className="rounded border border-slate-200 bg-white divide-y divide-slate-100">
        {rows.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-slate-400">No new voucher types</div>
        )}
        {rows.map((r) => {
          const d = dec[r.vtype] || {};
          const as = r.suggest_as;   // from Tally's own voucher type; not a user choice
          const turnover = d.turnover ?? r.suggest_turnover;
          return (
            <div key={r.vtype} className="px-2 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800 truncate flex-1" title={r.vtype}>{r.vtype}</span>
                <span className="text-[10px] text-slate-400 shrink-0">
                  {r.base_type ? `Tally type: ${r.base_type}` : 'Tally type unknown'} · {r.count} vch · ₹{r.value}
                </span>
                <div className="flex rounded-md border border-slate-200 overflow-hidden shrink-0">
                  {['create', 'skip'].map((a) => (
                    <button key={a} type="button" onClick={() => setDec(r.vtype, { action: a })}
                      className={`px-2 py-0.5 text-[11px] font-medium ${d.action === a
                        ? (a === 'create' ? 'bg-emerald-600 text-white' : 'bg-slate-600 text-white')
                        : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                      {a === 'create' ? 'Create' : 'Skip'}
                    </button>
                  ))}
                </div>
              </div>
              {d.action === 'create' && (
                <div className="flex items-center gap-3 mt-1 pl-1">
                  <span className="text-[11px] text-slate-500">
                    Imports as <b className="text-slate-700">{VT_LABEL[as] || as}</b>
                    {r.base_type ? ` (Tally type: ${r.base_type})` : ''}
                  </span>
                  {as === 'sales' && (
                    <label className="text-[11px] text-slate-600 flex items-center gap-1">
                      <input type="checkbox" checked={!!turnover}
                        onChange={(e) => setDec(r.vtype, { turnover: e.target.checked })} />
                      Counts in turnover
                    </label>
                  )}
                  <span className="text-[10px] text-slate-400">GST: read from each voucher</span>
                </div>
              )}
              {r.examples?.length > 0 && (
                <div className="mt-0.5 pl-1 text-[10px] text-slate-400 truncate">
                  e.g. {r.examples.map((x) => `${x.number} · ${x.date} · ${x.party} · ₹${x.value}`).join('  |  ')}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {rows.length > 0 && (
        <div className="flex justify-end mt-1.5">
          <Button variant="outline" onClick={onApply} disabled={busy} className="text-xs">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save & re-preview'}
          </Button>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] text-slate-500 mb-0.5">Skipped, never imported:</p>
          {skipped.map((r) => (
            <div key={r.vtype} className="flex items-center gap-2 text-[11px] px-1">
              <span className="text-slate-600 truncate flex-1">{r.vtype}{r.count ? ` · ${r.count} vch held back this run` : ''}</span>
              <button type="button" onClick={() => onUndo(r.vtype)} disabled={busy}
                className="text-indigo-600 hover:underline">Undo</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// "Changed in Tally" / "Deleted in Tally". A voucher the ERP already holds
// that Tally has since edited or deleted is listed here, ERP value beside
// Tally's, and nothing changes until someone chooses. Each tab has its OWN
// apply button and applies only its own rows.
//   Changed -> Update (take Tally's figures) or Keep (leave the ERP as it is)
//   Deleted -> Remove (hide it everywhere; reversible) or Keep
// A row with money against it that Update/Remove would strand is BLOCKED and
// says why. Voucher numbers are never compared: Auto Renumber moves them.
function VoucherChangePanel({ which, rows, warnings, dec, setDec, setAll, onApply, busy }) {
  const isChanged = which === 'changed';
  const acts = isChanged ? [['update', 'Update', 'bg-emerald-600'], ['keep', 'Keep', 'bg-slate-600']]
    : [['remove', 'Remove', 'bg-rose-600'], ['keep', 'Keep', 'bg-slate-600']];
  const chosen = rows.filter((r) => dec[r.id]).length;
  // A bulk action is "active" when every row already matches it — a blocked row
  // counts as matching when it's on "keep" (the only choice it has).
  const bulkActive = (a) => rows.length > 0 && rows.every((r) =>
    dec[r.id] === ((a !== 'keep' && r.blocked) ? 'keep' : a));
  return (
    <div>
      <p className="text-[11px] text-slate-600 mb-1.5">
        {isChanged
          ? <>Already imported, but <b>edited in Tally since</b>. <b>Update</b> takes Tally's figures; <b>Keep</b> leaves the ERP as it is and is not asked again unless Tally changes it once more.</>
          : <>In the ERP but <b>no longer in Tally</b> for this period: deleted, cancelled or made optional there. <b>Remove</b> hides it from every page and total (it can be restored); <b>Keep</b> leaves it.</>}
      </p>
      {!isChanged && warnings.map((w, i) => (
        <p key={i} className="text-[11px] text-rose-700 mb-1.5"><AlertTriangle size={12} className="inline align-[-2px] mr-1" />{w}</p>
      ))}
      {/* Bulk apply — set every row at once, then override individuals. */}
      {rows.length > 0 && setAll && (
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] font-medium text-slate-500">Apply to all {rows.length}:</span>
          {acts.map(([a, label, on]) => (
            <button key={a} type="button" onClick={() => setAll(a)}
              className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition ${
                bulkActive(a) ? `${on} border-transparent text-white` : 'border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}>
              {label} all
            </button>
          ))}
          {chosen > 0 && (
            <button type="button" onClick={() => setAll(null)}
              className="ml-auto text-[11px] text-slate-400 underline hover:text-slate-600">Clear</button>
          )}
        </div>
      )}
      <div className="rounded border border-slate-200 bg-white divide-y divide-slate-100">
        {rows.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-slate-400">
            {isChanged ? 'Nothing changed in Tally since it was imported' : 'Nothing deleted in Tally'}
          </div>
        )}
        {rows.map((r) => (
          <div key={r.id} className="px-2 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold text-slate-800 shrink-0">{r.number}</span>
              <span className="text-[10px] uppercase tracking-wide text-indigo-600 shrink-0">{r.kind === 'restored' ? 'Back in Tally' : r.doc_label}</span>
              <span className="text-slate-500 truncate flex-1" title={r.party}>{r.party} · {r.date}</span>
              <div className="flex rounded-md border border-slate-200 overflow-hidden shrink-0">
                {acts.map(([a, label, on]) => {
                  const off = r.blocked && a !== 'keep';
                  return (
                    <button key={a} type="button" disabled={off} onClick={() => setDec(r.id, a)}
                      title={off ? r.blocked : undefined}
                      className={`px-2 py-0.5 text-[11px] font-medium ${dec[r.id] === a ? `${on} text-white` : 'bg-white text-slate-600 hover:bg-slate-50'} ${off ? 'opacity-40 cursor-not-allowed' : ''}`}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            {isChanged && r.diff?.length > 0 && (
              <table className="w-full mt-1 text-[11px]">
                <thead><tr className="text-slate-400"><th className="text-left font-normal">Field</th><th className="text-right font-normal">ERP has</th><th className="text-right font-normal">Tally now</th></tr></thead>
                <tbody>
                  {r.diff.map(([k, a, b]) => (
                    <tr key={k}><td className="text-slate-500">{k}</td>
                      <td className="text-right tabular-nums text-rose-600 line-through decoration-1">{a}</td>
                      <td className="text-right tabular-nums text-emerald-700 font-medium">{b}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {!isChanged && (
              <div className="mt-0.5 text-[11px] text-slate-500">Amount ₹{r.old_total}</div>
            )}
            {r.blocked
              ? <div className="mt-1 text-[11px] text-rose-700 font-medium">{r.blocked}</div>
              : r.effect && <div className="mt-1 text-[11px] text-slate-500">{r.effect}</div>}
          </div>
        ))}
      </div>
      {rows.length > 0 && (
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[11px] text-slate-400">Applies this tab only · {chosen} of {rows.length} chosen</span>
          <Button variant="outline" onClick={onApply} disabled={busy || !chosen} className="text-xs">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (isChanged ? 'Apply changes' : 'Apply removals')}
          </Button>
        </div>
      )}
    </div>
  );
}

