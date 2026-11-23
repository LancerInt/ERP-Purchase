import { useState, useEffect, useRef } from 'react';
import { Upload, X, Loader2, FileText, AlertTriangle } from 'lucide-react';
import { Button } from '../ui';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import useLookup from '../../hooks/useLookup.js';
import apiClient from '../../utils/api.js';
import toast from 'react-hot-toast';

/**
 * Per-party "map / create / skip" control — searches the ERP master for the same
 * company (customers or vendors) via /api/tally/import/ action=search_parties, so
 * any master can be chosen, not only the fuzzy suggestions.
 */
function PartyMapControl({ dec, onSet, kind, opts, company }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
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
      try {
        const r = await apiClient.post('/api/tally/import/', { company, action: 'search_parties', kind, q: q.trim() });
        setResults(r.data.results || []);
      } catch { setResults([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, kind, company]);
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
        <div className="absolute z-20 right-0 mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search master…"
            className="w-full border-b border-slate-200 px-2 py-1.5 text-xs outline-none" />
          <div className="max-h-56 overflow-auto py-1 text-xs">
            <button type="button" onClick={() => { onSet({ action: 'create' }); setOpen(false); }} className="block w-full text-left px-2 py-1 hover:bg-slate-50 text-indigo-600">Create new</button>
            <button type="button" onClick={() => { onSet({ action: 'skip' }); setOpen(false); }} className="block w-full text-left px-2 py-1 hover:bg-slate-50 text-slate-500">Skip (don&apos;t add)</button>
            {list.map((o) => (
              <button type="button" key={o.id} onClick={() => { onSet({ action: 'map', id: o.id, name: o.name }); setOpen(false); }}
                className="block w-full text-left px-2 py-1 hover:bg-blue-50 truncate">
                ↳ {o.name}{o.gstin ? <span className="text-slate-400"> · {o.gstin}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Import from Tally File" — the crash-proof path for Tally EDU. The operator
 * exports the Day Book as XML from Tally (Day Book → Alt+E → XML) and uploads it;
 * the ERP parses it and imports invoices/bills exactly like the live import,
 * WITHOUT ever hitting the gateway (which crashes EDU on a whole-company dump).
 */
export default function TallyFileImportButton({ what = 'sales', onDone }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [company, setCompany] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [decisions, setDecisions] = useState({});
  const { options: companies } = useLookup('/api/companies/');
  const fileRef = useRef(null);

  const rowKey = (n, kind) => `${kind}:${n}`;
  const close = () => { setOpen(false); setResult(null); setDecisions({}); setFile(null); };

  const post = async (dry) => {
    if (!file) { toast.error('Choose the Day Book XML file first'); return; }
    if (!company) { toast.error('Pick a company'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('company', company);
      fd.append('what', what);
      fd.append('dry_run', dry ? 'true' : 'false');
      if (from && to) { fd.append('from', from); fd.append('to', to); }
      const res = await apiClient.post('/api/tally/import-file/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000,
      });
      setResult(res.data);
      setDecisions({});
      if (!dry) { toast.success(res.data?.detail || 'Imported from file'); onDone?.(); }
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message || 'File import failed');
    } finally { setBusy(false); }
  };

  // Apply map/create/skip for unmatched parties (reuses the gateway resolve action),
  // then re-preview (re-uploads the file) so resolved parties drop out.
  const applyResolve = async () => {
    const rows = [
      ...(result?.unmatched_customers || []).map((n) => ({ n, kind: 'customer' })),
      ...(result?.unmatched_vendors || []).map((n) => ({ n, kind: 'vendor' })),
      ...(result?.new_products || []).map((n) => ({ n, kind: 'product' })),
    ];
    const decs = rows.map(({ n, kind }) => {
      const dec = decisions[rowKey(n, kind)] || { action: 'create' };
      if (dec.action === 'skip') return null;
      if (dec.action === 'map') return { tally_name: n, kind, action: 'map', target_id: dec.id };
      return { tally_name: n, kind, action: 'create' };
    }).filter(Boolean);
    if (!decs.length) { toast.error('Nothing to apply'); return; }
    setBusy(true);
    try {
      const res = await apiClient.post('/api/tally/import/', { company, action: 'resolve_parties', decisions: decs });
      toast.success(`Created ${(res.data.customers || 0) + (res.data.vendors || 0) + (res.data.products || 0)} · Mapped ${res.data.mapped || 0}`);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Resolve failed'); setBusy(false); return;
    }
    setBusy(false);
    await post(true);   // re-preview
  };

  const unmatchedRows = result ? [
    ...(result.unmatched_customers || []).map((n) => ({ n, kind: 'customer', opts: (result.customer_options || {})[n] || [] })),
    ...(result.unmatched_vendors || []).map((n) => ({ n, kind: 'vendor', opts: (result.vendor_options || {})[n] || [] })),
    ...(result.new_products || []).map((n) => ({ n, kind: 'product', opts: (result.product_options || {})[n] || [] })),
  ] : [];
  const sideKey = what === 'purchase' ? 'purchase' : 'sales';
  const moneyKey = what === 'purchase' ? 'payments' : 'receipts';

  return (
    <>
      <Button variant="outline" icon={Upload} responsiveLabel onClick={() => { setResult(null); setOpen(true); }}
        title="Import from a Tally Day Book file (no gateway — won't crash Tally)">
        Import from File
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[90dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-slate-800">Import {what === 'purchase' ? 'Purchase' : 'Sales'} from Tally File</h3>
              <button onClick={close} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              In Tally: <b>Day Book</b> → set the period → <b>Alt+E (Export)</b> → format <b>XML</b> → save the file, then upload it here.
              This imports without touching the Tally gateway, so it can never crash Tally.
            </p>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="col-span-2">
                <label className="block text-xs text-slate-500 mb-1">Company (in ERP)</label>
                <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)}>
                  <option value="">Select company…</option>
                  {(companies || []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-slate-500 mb-1">Day Book XML file</label>
                <input ref={fileRef} type="file" accept=".xml" onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); }}
                  className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 file:mr-3 file:rounded file:border-0 file:bg-indigo-50 file:px-2 file:py-1 file:text-indigo-700" />
                {file && <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-1"><FileText size={12} /> {file.name} ({Math.round(file.size / 1024)} KB)</p>}
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">From <span className="text-slate-400">(optional)</span></label>
                <CustomDatePicker value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">To <span className="text-slate-400">(optional)</span></label>
                <CustomDatePicker value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>

            {result && (
              <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <p className="font-semibold text-slate-700 mb-1.5">
                  {result.dry_run ? 'Preview' : 'Imported'} — {result.total_vouchers ?? 0} vouchers in file
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                  <span>{what === 'purchase' ? 'Vendor bills' : 'Sales invoices'}: <b className="text-slate-900">{result[sideKey]}</b></span>
                  <span>{what === 'purchase' ? 'Payments' : 'Receipts'}: <b className="text-slate-900">{result[moneyKey]}</b></span>
                  <span>New products: <b className="text-slate-900">{result.dry_run ? (result.new_products?.length || 0) : result.products_created}</b></span>
                  <span>Already imported: <b className="text-slate-900">{result.skipped_existing}</b></span>
                </div>
                {unmatchedRows.length > 0 && (
                  <div className="mt-2 border-t border-amber-200 pt-2">
                    <p className="text-xs font-medium text-amber-700 mb-1.5"><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />{unmatchedRows.length} unmatched — <b>Map</b> to an existing record, <b>Create</b> new, or <b>Skip</b>.</p>
                    <div className="max-h-48 overflow-auto rounded border border-slate-200 bg-white divide-y divide-slate-100">
                      {unmatchedRows.map(({ n, kind, opts }) => (
                        <div key={rowKey(n, kind)} className="flex items-center gap-2 px-2 py-1 text-xs">
                          <span className={`text-[9px] uppercase shrink-0 ${kind === 'customer' ? 'text-indigo-500' : kind === 'vendor' ? 'text-emerald-600' : 'text-amber-600'}`}>{kind[0]}</span>
                          <span className="text-slate-700 truncate flex-1" title={n}>{n}</span>
                          <PartyMapControl dec={decisions[rowKey(n, kind)]} onSet={(obj) => setDecisions((p) => ({ ...p, [rowKey(n, kind)]: obj }))}
                            kind={kind} opts={opts} company={company} />
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-end mt-1.5">
                      <Button variant="outline" onClick={applyResolve} disabled={busy} className="text-xs">
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Apply & re-preview'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end items-center gap-2 mt-2">
              <button onClick={close} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">Close</button>
              <Button variant="outline" onClick={() => post(true)} disabled={busy || !file}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Preview'}
              </Button>
              <Button variant="primary" onClick={() => post(false)} disabled={busy || !result || result.dry_run === false}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Import'}
              </Button>
            </div>
            {!result && <p className="text-[11px] text-slate-400 mt-2 text-right">Upload the file, then <b>Preview</b> before importing.</p>}
          </div>
        </div>
      )}
    </>
  );
}
