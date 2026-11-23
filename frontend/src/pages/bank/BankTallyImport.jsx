// "Import from Tally" — the cash-side mirror of the Purchase → Bills
// "Import from Zoho" flow (pages/purchase/zoho/shared.jsx): upload the Tally
// Payment/Receipt Register .xlsx → PREVIEW (counts + party ledgers that don't
// match an existing master) → resolve each unmatched name (Map to existing /
// Create new / Skip, with live master search) → IMPORT. Backed by the three
// actions on POST /api/bank/import-tally/.
import { useEffect, useRef, useState } from 'react';
import { DownloadCloud, Loader2, X, CheckCircle2, XCircle, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui';
import apiClient from '../../utils/api.js';
import useApiData from '../../hooks/useApiData.js';
import { getApiErrorMessage } from '../../utils/formHelpers.js';

const KIND_LABEL = { vendor: 'Vendors (payments)', customer: 'Customers (receipts)' };

/** Shared skip-reason breakdown, shown on both the Preview and Import result panels. */
function SkipBreakdown({ reasons, samples }) {
  if (!reasons) return null;
  const total = Object.values(reasons).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return (
    <div className="mt-2 text-xs text-slate-500">
      <p className="font-medium text-slate-600">Why {total} voucher(s) were skipped:</p>
      <ul className="list-disc pl-5 space-y-0.5">
        {reasons.no_party > 0 && <li>{reasons.no_party} had no party ledger Tally would name</li>}
        {reasons.no_bank_leg > 0 && <li>{reasons.no_bank_leg} had no bank/cash ledger leg</li>}
        {reasons.no_bank_leg_in_tally > 0 && <li>{reasons.no_bank_leg_in_tally} had no leg belonging to a real Tally bank ledger (an internal journal/provisioning entry, not a bank transaction)</li>}
        {reasons.zero_amount > 0 && <li>{reasons.zero_amount} had a zero amount</li>}
        {reasons.no_date > 0 && <li>{reasons.no_date} had an unreadable date</li>}
      </ul>
      {samples && Object.keys(samples).length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-slate-400">Show a few examples</summary>
          <pre className="mt-1 bg-white border border-slate-200 rounded p-2 overflow-x-auto text-[11px]">{JSON.stringify(samples, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
const shortCo = (name) => {
  const n = (name || '').toLowerCase();
  if (n.includes('biochem')) return 'SS Bio';
  if (n.includes('united agro')) return 'UAI';
  return (name || '').split(' ')[0] || '';
};

/** Per-name picker: map the Tally name to an existing master, create it, or skip. */
function MapControl({ dec, onSet, kind, options, companyId }) {
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
        const r = await apiClient.post('/api/bank/import-tally/', { action: 'search', kind, q: q.trim(), company: companyId || undefined });
        setResults(r.data?.results || []);
      } catch { setResults([]); } finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, kind, companyId]);

  const action = dec?.action;   // undefined → default (Create new)
  const label = action === 'skip' ? '✕ Skip' : action === 'map' ? `↳ ${dec.name || 'Mapped'}` : '➕ Create new';
  const cls = action === 'map' ? 'border-blue-400 text-blue-700 bg-blue-50'
    : action === 'skip' ? 'border-slate-300 text-slate-500 bg-slate-50'
      : 'border-emerald-300 text-emerald-700 bg-emerald-50';
  const list = q.trim() ? results : (options || []);

  return (
    <div className="relative shrink-0 w-[54%]" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className={`border rounded px-1.5 py-0.5 text-xs w-full text-left truncate ${cls}`}>{label} ▾</button>
      {open && (
        <div className="absolute z-30 right-0 mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search existing master…"
            className="w-full border-b border-slate-200 px-2 py-1.5 text-xs outline-none" />
          <div className="max-h-56 overflow-auto py-1 text-xs">
            <button type="button" onClick={() => { onSet({ action: 'create' }); setOpen(false); }} className="block w-full text-left px-2 py-1 hover:bg-slate-50 text-emerald-600">➕ Create new</button>
            <button type="button" onClick={() => { onSet({ action: 'skip' }); setOpen(false); }} className="block w-full text-left px-2 py-1 hover:bg-slate-50 text-slate-500">✕ Skip</button>
            {list.length > 0 && <div className="px-2 py-0.5 text-[10px] uppercase text-slate-400">{q.trim() ? 'Master results' : 'Suggested matches'}</div>}
            {searching && <div className="px-2 py-1 text-slate-400">Searching…</div>}
            {list.map((o) => (
              <button type="button" key={o.id} onClick={() => { onSet({ action: 'map', id: o.id, name: o.name }); setOpen(false); }}
                className="flex items-center gap-1.5 w-full text-left px-2 py-1 hover:bg-blue-50">
                <span className="truncate flex-1">↳ {o.name}</span>
                {o.company && <span className="shrink-0 text-[8px] font-semibold uppercase rounded px-1 py-0.5 bg-slate-100 text-slate-500">{shortCo(o.company)}</span>}
              </button>
            ))}
            {q.trim() && !searching && list.length === 0 && <div className="px-2 py-1 text-slate-400">No match — use Create new.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function BankTallyImport({ onImported }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [companyId, setCompanyId] = useState('');
  const { data: companies } = useApiData('/api/companies/');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [decisions, setDecisions] = useState({});   // 'kind:name' -> {action,id,name}
  const [tab, setTab] = useState('vendor');
  const [q, setQ] = useState('');
  const [result, setResult] = useState(null);
  // Source: 'connector' pulls the Day Book live from Tally (needs the office
  // gateway on port 9000); 'file' uploads a Payment/Receipt Register .xlsx.
  const [src, setSrc] = useState('connector');
  const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayStr());

  // Lets Cancel actually stop an in-flight preview/import instead of just
  // hiding the dialog while relayJson's retry loop keeps polling underneath.
  const abortRef = useRef(null);
  const isCancelError = (e) => e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError';

  const keyOf = (u) => `${u.kind}:${u.name.toLowerCase()}`;
  const close = () => { abortRef.current?.abort(); setOpen(false); setFile(null); setPreview(null); setDecisions({}); setResult(null); setQ(''); };
  const onFile = (e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setPreview(null); setResult(null); } };
  const cancelRun = () => { abortRef.current?.abort(); };

  // Connector mode parks the Tally read for the office agent and the endpoint
  // answers 202 until it's back — retry the identical request under one spinner.
  const relayJson = async (payload, signal) => {
    const started = Date.now();
    for (;;) {
      const res = await apiClient.post('/api/bank/import-tally/', payload,
        { timeout: 600000, signal, validateStatus: (s) => s === 200 || s === 202 });
      if (res.status === 200) return res;
      if (Date.now() - started > 300000) {
        throw new Error('Tally didn’t respond in time. On the office PC open Tally with the gateway on (port 9000), then try again.');
      }
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 3000);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new DOMException('aborted', 'AbortError')); }, { once: true });
      });
    }
  };

  const runPreview = async () => {
    if (src === 'file' && !file) { toast.error('Choose a Tally register .xlsx first.'); return; }
    if (src === 'connector' && !companyId) { toast.error('Pick a company first.'); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setResult(null);
    try {
      let r;
      if (src === 'connector') {
        r = await relayJson({ action: 'preview', source: 'connector', company: companyId, from, to }, controller.signal);
      } else {
        const fd = new FormData();
        fd.append('action', 'preview'); fd.append('file', file);
        if (companyId) fd.append('company', companyId);
        r = await apiClient.post('/api/bank/import-tally/', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000, signal: controller.signal });
      }
      setPreview(r.data); setDecisions({}); setQ('');
      setTab((r.data.unmatched || []).some((u) => u.kind === 'vendor') ? 'vendor' : 'customer');
    } catch (e) {
      if (!isCancelError(e)) toast.error(getApiErrorMessage(e));
    } finally { setBusy(false); abortRef.current = null; }
  };

  const runImport = async () => {
    if (src === 'file' && !file) return;
    if (src === 'connector' && !companyId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    const t = toast.loading('Importing from Tally…');
    try {
      let r;
      if (src === 'connector') {
        r = await relayJson({ action: 'import', source: 'connector', company: companyId, from, to, decisions }, controller.signal);
      } else {
        const fd = new FormData();
        fd.append('action', 'import'); fd.append('file', file);
        if (companyId) fd.append('company', companyId);
        fd.append('decisions', JSON.stringify(decisions));
        r = await apiClient.post('/api/bank/import-tally/', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000, signal: controller.signal });
      }
      setResult(r.data);
      const n = (r.data.payments || 0) + (r.data.receipts || 0);
      if (n > 0) { toast.success(`${n} vouchers imported`, { id: t }); onImported?.(); }
      else toast('No new vouchers imported', { id: t, icon: 'ℹ️' });
    } catch (e) {
      if (isCancelError(e)) { toast.dismiss(t); }
      else { const msg = getApiErrorMessage(e); toast.error(msg, { id: t }); setResult({ error: msg }); }
    } finally { setBusy(false); abortRef.current = null; }
  };

  const unmatched = preview?.unmatched || [];
  const counts = { vendor: unmatched.filter((u) => u.kind === 'vendor').length, customer: unmatched.filter((u) => u.kind === 'customer').length };
  const qn = q.trim().toLowerCase();
  const rows = unmatched.filter((u) => u.kind === tab && (!qn || u.name.toLowerCase().includes(qn)));
  const decidedCount = Object.values(decisions).filter((d) => d?.action).length;
  const skipCount = Object.values(decisions).filter((d) => d?.action === 'skip').length;
  const mapCount = Object.values(decisions).filter((d) => d?.action === 'map').length;

  const setAllShown = (action) => setDecisions((p) => {
    const n = { ...p }; rows.forEach((u) => { n[keyOf(u)] = { action }; }); return n;
  });

  return (
    <>
      <Button variant="outline" icon={DownloadCloud} responsiveLabel onClick={() => { setOpen(true); setPreview(null); setResult(null); }} title="Import from Tally">Import Tally</Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 print:hidden" onClick={close}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[90dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-slate-800">Import from Tally</h3>
              <button onClick={close} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-3">Pull Payments &amp; Receipts <b>live from Tally</b> (pick company + dates) or <b>upload</b> a Tally Payment/Receipt Register export. Run <b>Preview</b> to see which party ledgers aren’t in your master, resolve each (<b>Map</b> to an existing customer/vendor, <b>Create</b> new, or <b>Skip</b>), then <b>Import</b>. Voucher numbers already imported are skipped.</p>

            {/* Source toggle + inputs + preview */}
            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
              <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs">
                <button type="button" onClick={() => { setSrc('connector'); setPreview(null); setResult(null); }}
                  className={`px-3 py-1 rounded-md font-medium transition ${src === 'connector' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:text-slate-800'}`}>Live from Tally</button>
                <button type="button" onClick={() => { setSrc('file'); setPreview(null); setResult(null); }}
                  className={`px-3 py-1 rounded-md font-medium transition ${src === 'file' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:text-slate-800'}`}>Upload file</button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {src === 'file' ? (
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Tally register file (.xlsx)</label>
                    <label className="flex items-center gap-2 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white cursor-pointer hover:bg-slate-50">
                      <DownloadCloud size={15} className="text-slate-400 shrink-0" />
                      <span className="truncate text-slate-600">{file ? file.name : 'Choose file…'}</span>
                      <input type="file" accept=".xlsx,.xls" className="hidden" onChange={onFile} />
                    </label>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">From</label>
                      <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">To</label>
                      <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white" />
                    </div>
                  </div>
                )}
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Company{src === 'connector' ? <span className="text-rose-500"> *</span> : null}</label>
                  <select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setPreview(null); }}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white">
                    <option value="">{src === 'connector' ? 'Select company…' : 'Auto-detect from file'}</option>
                    {(companies || []).map((c) => <option key={c.id} value={c.id}>{c.legal_name || c.name || c.company_code}</option>)}
                  </select>
                </div>
              </div>
              {src === 'connector' && (
                <p className="text-[11px] text-slate-400">Pulls Payments &amp; Receipts from the Tally Day Book for the period. Tally must be open with the gateway on (port 9000).</p>
              )}
              <div className="flex items-center justify-end">
                <button onClick={runPreview} disabled={busy || (src === 'file' ? !file : !companyId)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                  {busy && !result ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Preview
                </button>
              </div>
            </div>

            {/* Preview result */}
            {preview && !result && (
              <div className="mb-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm mb-2">
                  <p className="font-semibold text-slate-700">
                    {preview.company_name}
                    {!preview.company_exists && <span className="ml-1.5 text-[10px] font-semibold rounded px-1.5 py-0.5 bg-amber-100 text-amber-700">will be created</span>}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {preview.record_count} voucher(s) · {preview.payments} payments · {preview.receipts} receipts ·{' '}
                    <span className="text-emerald-700">{preview.matched_count} matched</span> ·{' '}
                    <span className={preview.unmatched_count ? 'text-amber-700 font-medium' : 'text-slate-500'}>{preview.unmatched_count} unmatched</span>
                  </p>
                  <SkipBreakdown reasons={preview.skip_reasons} samples={preview.skip_samples} />
                </div>

                {preview.record_count === 0 ? (
                  <p className="text-xs text-slate-500 px-1">
                    Nothing to import for this range{preview.total_seen > 0 ? ' — see the skip breakdown above' : ''}.
                  </p>
                ) : preview.unmatched_count === 0 ? (
                  <p className="text-xs text-emerald-700 px-1">✓ Every party matches an existing master — safe to Import.</p>
                ) : (
                  <>
                    <p className="text-xs text-amber-700 mb-1.5">⚠ {preview.unmatched_count} name(s) aren’t in your master. Unresolved names are <b>created</b> on import — or Map / Skip them here.</p>
                    <div className="flex gap-0.5 mb-2 bg-slate-100 rounded-lg p-0.5">
                      {['vendor', 'customer'].map((k) => (
                        <button key={k} type="button" onClick={() => { setTab(k); setQ(''); }}
                          className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === k ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                          {KIND_LABEL[k]} ({counts[k]})
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names…"
                        className="flex-1 min-w-[140px] border border-slate-300 rounded px-2 py-1 text-xs" />
                      <button type="button" onClick={() => setAllShown('create')} className="text-[11px] rounded px-2 py-1 border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50">Create all shown</button>
                      <button type="button" onClick={() => setAllShown('skip')} className="text-[11px] rounded px-2 py-1 border bg-white text-slate-500 border-slate-200 hover:bg-slate-50">Skip all shown</button>
                    </div>
                    <div className="text-[10px] text-slate-400 mb-1">Showing {Math.min(rows.length, 200)} of {rows.length}{qn ? ` (filtered)` : ''}{rows.length > 200 ? ' — refine search to see the rest' : ''}</div>
                    <div className="max-h-64 overflow-auto rounded border border-slate-200 bg-white divide-y divide-slate-100">
                      {rows.length === 0 && <div className="px-2 py-4 text-center text-xs text-slate-400">No unmatched {tab === 'vendor' ? 'vendors' : 'customers'} 🎉</div>}
                      {rows.slice(0, 200).map((u) => (
                        <div key={keyOf(u)} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                          <span className="text-slate-700 truncate flex-1" title={u.name}>{u.name}</span>
                          <MapControl dec={decisions[keyOf(u)]} onSet={(obj) => setDecisions((p) => ({ ...p, [keyOf(u)]: obj }))}
                            kind={u.kind} options={u.options} companyId={preview.company_id} />
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Import result */}
            {result && (
              <div className="mb-3 rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm">
                {result.error ? (
                  <span className="text-red-600 flex items-center gap-1"><XCircle size={16} /> {result.error}</span>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-medium">
                      <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={16} /> {result.payments || 0} payments</span>
                      <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={16} /> {result.receipts || 0} receipts</span>
                      {result.duplicates > 0 && <span className="text-slate-500">{result.duplicates} already imported</span>}
                      {result.skipped > 0 && <span className="text-amber-600">{result.skipped} skipped</span>}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">created: {result.vendors || 0} vendors · {result.customers || 0} customers · {result.accounts || 0} bank accounts</p>
                    {result.errors?.length > 0 && <ul className="mt-2 text-xs text-slate-500 list-disc pl-5 space-y-0.5">{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
                    <SkipBreakdown reasons={result.skip_reasons} samples={result.skip_samples} />
                  </>
                )}
              </div>
            )}

            {/* Footer */}
            <div className="flex justify-between items-center mt-2">
              <span className="text-[11px] text-slate-400">
                {preview && !result && preview.unmatched_count > 0
                  ? `${mapCount} mapped · ${skipCount} skip · ${preview.unmatched_count - decidedCount} will be created`
                  : ''}
              </span>
              <div className="flex gap-2">
                {busy ? (
                  <button onClick={cancelRun} className="px-4 py-2 rounded-lg text-sm font-medium border border-red-300 text-red-600 hover:bg-red-50">Cancel</button>
                ) : (
                  <button onClick={close} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">Close</button>
                )}
                <button onClick={runImport} disabled={busy || (src === 'file' ? !file : !companyId) || !!result}
                  title={(src === 'file' && !file) ? 'Choose a file first' : (src === 'connector' && !companyId) ? 'Pick a company first' : 'Import'}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                  {busy && result === null && preview ? <Loader2 className="w-4 h-4 animate-spin" /> : <DownloadCloud size={15} />} Import
                </button>
              </div>
            </div>
            {!preview && !result && <p className="text-[11px] text-slate-400 mt-2 text-right">Tip: run <b>Preview</b> first to map names — or just <b>Import</b> to auto-create everything.</p>}
          </div>
        </div>
      )}
    </>
  );
}
