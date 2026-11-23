import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Loader2, ArrowRight, Zap, Check, Eye } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import { confirm } from '@/components/common/confirm';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';

// Import Data · Ledger — triage inbox + pending-approval queue.
//   Inbox   : scanned/imported docs auto-classified → Route (or Auto-route all)
//             creates each as a DRAFT bill on its destination.
//   Pending : the auto-routed DRAFT bills, verified + approved HERE (per-bill or
//             Approve All). Approval flips DRAFT→OPEN; the bill then shows on the
//             Bills page. Nothing hits the live Bills totals until approved.
const TYPES = ['Purchase', 'Expense', 'Freight-Inward', 'Freight-Local', 'Payment', 'Sales Invoice', 'Receipt'];
const DEST = {
  Purchase: 'Purchase Bills', Expense: 'Expense Bills',
  'Freight-Inward': 'Freight Inward', 'Freight-Local': 'Local Freight',
  Payment: 'Payments Made', 'Sales Invoice': 'Sales Invoices', Receipt: 'Receipts',
};
// Full class strings (not interpolated) so Tailwind's JIT doesn't purge them.
const SRC_CHIP = { Scan: 'bg-indigo-50 text-indigo-600', Tally: 'bg-emerald-50 text-emerald-600', Bank: 'bg-sky-50 text-sky-600' };
const srcChip = (s) => SRC_CHIP[s] || 'bg-slate-100 text-slate-500';
const fmtAmt = (a) => '₹' + Number(a || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ImportLedger() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('inbox');

  const [rows, setRows] = useState([]);
  const [picks, setPicks] = useState({});
  const [routing, setRouting] = useState(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [pending, setPending] = useState([]);
  const [pendLoading, setPendLoading] = useState(false);
  const [approving, setApproving] = useState(null);   // id | 'all'

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

  const loadPending = useCallback(async () => {
    setPendLoading(true);
    try {
      const { data } = await apiClient.get('/api/import/pending/');
      setPending(data.rows || []);
    } catch { /* keep prior */ }
    finally { setPendLoading(false); }
  }, []);

  useEffect(() => { loadInbox(); loadPending(); }, [loadInbox, loadPending]);

  // Route ONE item → DRAFT on its page; leaves the inbox. needs_vendor /
  // needs_merge open the scan review; already_done just drops the row.
  const doRoute = useCallback(async (row, type) => {
    setRouting(row.id);
    try {
      const { data } = await apiClient.post(`/api/import/route/${row.id}/`, { type });
      if (data.needs_vendor) { toast('Map the vendor to finish routing.', { icon: '✍️' }); navigate(data.review_path); return; }
      if (data.needs_merge) { toast('A matching bill exists — choose merge or separate.', { icon: '⚠️' }); navigate(data.review_path); return; }
      if (data.already_done) { toast('Already a complete bill — removed.', { icon: '✓' }); setRows((rs) => rs.filter((r) => r.id !== row.id)); return; }
      toast.success(`Routed to ${data.routed_to} — pending approval`);
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      loadPending();
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setRouting(null); }
  }, [navigate, loadPending]);

  // Auto-route every CLEAN item at once → each becomes a DRAFT in Pending.
  const autoRouteAll = useCallback(async () => {
    if (!(await confirm({
      message: 'Auto-route all clean items? Each becomes a DRAFT bill in Pending Approval (needs-vendor / duplicate items stay in the inbox). Nothing is finalised until you approve.',
      confirmLabel: 'Auto-route all',
    }))) return;
    setAutoBusy(true);
    try {
      const { data } = await apiClient.post('/api/import/auto-route/', {});
      toast.success(`Routed ${data.routed} → Pending. ${data.skipped} left in inbox${data.errors ? `, ${data.errors} error(s)` : ''}.`);
      await Promise.all([loadInbox(), loadPending()]);
      if (data.routed > 0) setTab('pending');
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setAutoBusy(false); }
  }, [loadInbox, loadPending]);

  // Approve DRAFT bills (flip DRAFT→OPEN via the existing bills approve-all).
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
      setPending((ps) => ps.filter((p) => !ids.includes(p.id)));
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setApproving(null); }
  }, []);

  const TabBtn = ({ id, label, n, tone }) => (
    <button onClick={() => setTab(id)}
      className={`pb-2 border-b-2 text-sm ${tab === id ? 'border-indigo-500 text-indigo-600 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
      {label} {n > 0 && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ml-1 ${tone}`}>{n}</span>}
    </button>
  );

  return (
    <MainLayout>
      <PageHeader title="Triage Inbox" subtitle="Triage incoming documents, route them, and approve the results" />

      <div className="flex gap-6 border-b border-slate-200 mb-3 px-1">
        <TabBtn id="inbox" label="📥 Inbox" n={rows.length} tone="bg-rose-50 text-rose-600" />
        <TabBtn id="pending" label="⏳ Pending Approval" n={pending.length} tone="bg-amber-50 text-amber-600" />
      </div>

      {/* ───────── INBOX ───────── */}
      {tab === 'inbox' && (
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
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white text-[11px] uppercase tracking-wider text-slate-500 text-left border-b border-slate-100">
                  <th className="px-3 py-2.5">Src</th><th className="px-3 py-2.5">Date</th><th className="px-3 py-2.5">Party</th>
                  <th className="px-3 py-2.5 text-right">Amount</th><th className="px-3 py-2.5">Type (auto · confirm)</th><th className="px-3 py-2.5">Route</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const t = picks[r.id] || '';
                  return (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5"><span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${srcChip(r.source)}`}>{r.source}</span></td>
                      <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{r.date || '—'}</td>
                      <td className="px-3 py-2.5 font-medium text-slate-800">{r.party}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{fmtAmt(r.amount)}</td>
                      <td className="px-3 py-2.5">
                        <select value={t} onChange={(e) => setPicks((p) => ({ ...p, [r.id]: e.target.value }))}
                          className={`border ${t ? 'border-slate-300' : 'border-amber-400 bg-amber-50'} rounded px-2 py-1 text-xs`}>
                          <option value="">— classify —</option>
                          {TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2.5">
                        <button disabled={!t || routing === r.id} onClick={() => doRoute(r, t)}
                          className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg ${t ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}>
                          {routing === r.id ? <><Loader2 size={11} className="animate-spin" /> Routing…</> : <>Route → {t ? (DEST[t] || '—') : ''} <ArrowRight size={11} /></>}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ───────── PENDING APPROVAL ───────── */}
      {tab === 'pending' && (
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
          {pendLoading ? (
            <div className="flex items-center justify-center py-16 text-slate-400 gap-2"><Loader2 size={16} className="animate-spin" /> Loading…</div>
          ) : pending.length === 0 ? (
            <div className="py-16 text-center text-slate-400 text-sm">Nothing pending — run “Auto-route all” on the Inbox.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white text-[11px] uppercase tracking-wider text-slate-500 text-left border-b border-slate-100">
                  <th className="px-3 py-2.5">Date</th><th className="px-3 py-2.5">Party</th><th className="px-3 py-2.5">Bill No</th>
                  <th className="px-3 py-2.5 text-right">Amount</th><th className="px-3 py-2.5">Destination</th><th className="px-3 py-2.5">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pending.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{p.date || '—'}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-800">{p.party}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-500">{p.reference || '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{fmtAmt(p.amount)}</td>
                    <td className="px-3 py-2.5 text-slate-600">{p.dest_label}</td>
                    <td className="px-3 py-2.5 flex items-center gap-2">
                      <button onClick={() => navigate(`/purchase/bills/${p.id}`)}
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
      )}
    </MainLayout>
  );
}
