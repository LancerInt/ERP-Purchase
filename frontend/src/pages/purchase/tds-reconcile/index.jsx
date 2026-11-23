// TDS Reconciliation — bill-wise & vendor-wise Tally-vs-ERP TDS check for EVERY
// vendor/bill (Purchase / Expense / Freight). Surfaces any bill where TDS was due
// but is missing or mismatched — e.g. a bill whose total is stored net of TDS but
// whose TdsPayable link broke, so the ledger TDS column reads blank. ONE TDS figure
// per bill (Tally's actual), with the ERP-expected beside it for verification only.
// Backed by GET /api/purchase/tds-bills/.
import { useEffect, useState } from 'react';
import { Loader2, Percent, AlertTriangle, FileText, Users } from 'lucide-react';
import CustomSelect from '@/components/ui/CustomSelect';
import { CTRL_H } from '@/components/common/controls';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlState } from '../../../hooks/useUrlState.js';

const fmtFull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtINR = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

// Default window = current financial year (Apr–Mar).
const fyWindow = () => {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
};

const SECTION_CLS = {
  '194Q': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  '194C': 'bg-sky-50 text-sky-700 border-sky-200',
  '194C(6)': 'bg-slate-50 text-slate-600 border-slate-200',
  '206AA': 'bg-rose-50 text-rose-700 border-rose-200',
};

// Per-bill reconciliation verdict → badge styling + label.
const STATUS_CLS = {
  MATCHED: { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Matched' },
  MISSING_IN_ERP: { cls: 'bg-rose-50 text-rose-700 border-rose-200', label: 'Missing in ERP' },
  TDS_DUE_NONE: { cls: 'bg-rose-50 text-rose-700 border-rose-200', label: 'Due · none' },
  UNDER_DEDUCTED: { cls: 'bg-amber-50 text-amber-700 border-amber-200', label: 'Under-deducted' },
  NOT_DUE: { cls: 'bg-slate-50 text-slate-500 border-slate-200', label: 'Not due' },
};

const REGIME_OPTS = [
  { value: '', label: 'All regimes' },
  { value: 'PURCHASE', label: 'Purchase · 194Q' },
  { value: 'EXPENSE', label: 'Expense · 194C' },
  { value: 'FREIGHT', label: 'Freight · 194C' },
];

function StatusBadge({ status }) {
  const s = STATUS_CLS[status] || { cls: 'bg-slate-50 text-slate-600 border-slate-200', label: status };
  return <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 whitespace-nowrap ${s.cls}`}>{s.label}</span>;
}

export default function TdsReconcile() {
  const win = fyWindow();
  // Filters live in the URL so Back / refresh / sharing restore them.
  const [view, setView] = useUrlState('view', 'bill');            // 'bill' | 'vendor'
  const [from, setFrom] = useUrlState('from', win.from);
  const [to, setTo] = useUrlState('to', win.to);
  const [company, setCompany] = useUrlState('company', '');
  const [regime, setRegime] = useUrlState('regime', '');
  const [onlyMissing, setOnlyMissing] = useUrlState('only_missing', '');   // '' off | 'true' on
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const { options: companyOptions } = useLookup('/api/companies/');

  useEffect(() => {
    let cancelled = false; setLoading(true); setError(null);
    const p = new URLSearchParams({ view, from, to });
    if (company) p.set('company', company);
    if (regime) p.set('regime', regime);
    if (onlyMissing) p.set('only_missing', 'true');
    apiClient.get(`/api/purchase/tds-bills/?${p.toString()}`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load TDS reconciliation.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view, from, to, company, regime, onlyMissing]);

  const isBill = view === 'bill';

  return (
    <MainLayout>
      <PageHeader
        title="TDS Reconciliation"
        subtitle="Every vendor & bill — Tally's actual TDS vs the ERP's expected. Surfaces bills where TDS was due but is missing or mismatched."
        breadcrumbs={[{ label: 'Purchase' }, { label: 'TDS Reconciliation' }]}
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {/* Bill / Vendor toggle */}
        <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
          <button onClick={() => setView('bill')}
            className={`flex items-center gap-1.5 px-3 text-sm ${CTRL_H} ${isBill ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
            <FileText size={14} /> Bill-wise
          </button>
          <button onClick={() => setView('vendor')}
            className={`flex items-center gap-1.5 px-3 text-sm ${CTRL_H} ${!isBill ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
            <Users size={14} /> Vendor-wise
          </button>
        </div>

        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="From date"
          className={`border border-slate-300 rounded-lg px-2 text-sm bg-white ${CTRL_H}`} />
        <span className="text-slate-400 text-sm">→</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="To date"
          className={`border border-slate-300 rounded-lg px-2 text-sm bg-white ${CTRL_H}`} />

        <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)} title="Company"
          className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[170px] ${CTRL_H}`}>
          <option value="">All companies</option>
          {(companyOptions || []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </CustomSelect>

        <CustomSelect value={regime} onChange={(e) => setRegime(e.target.value)} title="TDS regime"
          className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[160px] ${CTRL_H}`}>
          {REGIME_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </CustomSelect>

        <label className={`flex items-center gap-1.5 px-3 text-sm rounded-lg border cursor-pointer ${CTRL_H} ${onlyMissing ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>
          <input type="checkbox" checked={onlyMissing === 'true'} onChange={(e) => setOnlyMissing(e.target.checked ? 'true' : '')} className="sr-only" />
          <AlertTriangle size={14} /> Only mismatches
        </label>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading…</div>
      ) : error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 p-4 text-sm">{error}</div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <div className="rounded-xl border border-teal-200 bg-teal-50 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-teal-600">Tally deducted</div>
              <div className="text-xl font-bold mt-1 text-teal-700" title={fmtFull(data.tally_total)}>{fmtINR(data.tally_total)}</div>
            </div>
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-500">ERP expected</div>
              <div className="text-xl font-bold mt-1 text-indigo-700" title={fmtFull(data.erp_total)}>{fmtINR(data.erp_total)}</div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-600">Difference</div>
              <div className="text-xl font-bold mt-1 text-amber-700" title={fmtFull(data.difference_total)}>{fmtINR(data.difference_total)}</div>
            </div>
            <div className={`rounded-xl border p-4 ${data.missing_count > 0 ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'}`}>
              <div className={`text-[11px] font-semibold uppercase tracking-wide ${data.missing_count > 0 ? 'text-rose-500' : 'text-slate-500'}`}>Mismatched bills</div>
              <div className={`text-xl font-bold mt-1 ${data.missing_count > 0 ? 'text-rose-700' : 'text-slate-900'}`}>{data.missing_count}</div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
              <Percent size={16} className="text-slate-400" />
              <h3 className="font-bold text-slate-800">{isBill ? 'Bill-wise TDS' : 'Vendor TDS'}</h3>
              <span className="text-xs text-slate-400">· {isBill ? `${data.bill_count} bills` : `${(data.rows || []).length} vendors`}</span>
            </div>
            <div className="overflow-x-auto">
              {isBill ? (
                <table className="w-full text-sm">
                  <thead className="text-slate-500 text-xs uppercase tracking-wide bg-slate-50">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Date</th>
                      <th className="text-left px-3 py-2 font-medium">Bill No</th>
                      <th className="text-left px-3 py-2 font-medium">Vendor</th>
                      <th className="text-left px-3 py-2 font-medium">Section</th>
                      <th className="text-right px-3 py-2 font-medium">Billed value</th>
                      <th className="text-right px-3 py-2 font-medium text-teal-600">Tally TDS</th>
                      <th className="text-right px-3 py-2 font-medium text-indigo-600">ERP expected</th>
                      <th className="text-center px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.rows || []).length === 0 && (
                      <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">No bills for this filter.</td></tr>
                    )}
                    {(data.rows || []).map((r, i) => (
                      <tr key={r.bill_id || i} className="border-t border-slate-100 hover:bg-slate-50" title={r.reason}>
                        <td className="px-3 py-2 text-slate-500 tabular-nums whitespace-nowrap">{r.date}</td>
                        <td className="px-3 py-2 text-slate-700 whitespace-nowrap">{r.vendor_invoice_no || r.bill_no}</td>
                        <td className="px-3 py-2 text-slate-800">{r.vendor}</td>
                        <td className="px-3 py-2">
                          <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${SECTION_CLS[r.section] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>{r.section}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums" title={fmtFull(r.billed_value)}>{fmtINR(r.billed_value)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-teal-700" title={fmtFull(r.tally_tds)}>
                          {fmtINR(r.tally_tds)}
                          {!r.tds_linked && Number(r.tally_tds) > 0 && <span className="ml-1 text-[10px] text-rose-500" title="Deducted in Tally but not linked in ERP">⚠</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-indigo-700" title={fmtFull(r.erp_expected_tds)}>{fmtINR(r.erp_expected_tds)}</td>
                        <td className="px-3 py-2 text-center"><StatusBadge status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-slate-500 text-xs uppercase tracking-wide bg-slate-50">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Vendor</th>
                      <th className="text-left px-3 py-2 font-medium">PAN</th>
                      <th className="text-left px-3 py-2 font-medium">Section</th>
                      <th className="text-right px-3 py-2 font-medium">Bills</th>
                      <th className="text-right px-3 py-2 font-medium text-teal-600">Tally TDS</th>
                      <th className="text-right px-3 py-2 font-medium text-indigo-600">ERP expected</th>
                      <th className="text-right px-3 py-2 font-medium text-amber-600">Difference</th>
                      <th className="text-center px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.rows || []).length === 0 && (
                      <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">No vendors for this filter.</td></tr>
                    )}
                    {(data.rows || []).map((r, i) => (
                      <tr key={r.vendor_id || i} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-3 py-2 text-slate-800">{r.vendor}</td>
                        <td className="px-3 py-2 text-slate-500 tabular-nums">{r.pan}</td>
                        <td className="px-3 py-2">
                          <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${SECTION_CLS[r.section] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>{r.section}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.bills}
                          {r.missing_bills > 0 && <span className="ml-1 text-[11px] text-rose-600 font-semibold">({r.missing_bills}⚠)</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-teal-700" title={fmtFull(r.tally_tds)}>{fmtINR(r.tally_tds)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-indigo-700" title={fmtFull(r.erp_expected_tds)}>{fmtINR(r.erp_expected_tds)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-700" title={fmtFull(r.difference)}>{fmtINR(r.difference)}</td>
                        <td className="px-3 py-2 text-center"><StatusBadge status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <p className="px-4 py-2 text-[11px] text-slate-400 border-t border-slate-100">
              <b>Tally TDS</b> = the actual deduction (linked TDS Payable, or the bill's own figure when the link is missing). <b>ERP expected</b> = engine's computed TDS (194Q 0.1% over ₹50L · 194C 1%/2% ≥₹30k · 206AA 5%) — for verification only, never added on top. <b className="text-rose-500">Missing in ERP</b> = Tally deducted but the ledger link broke (run <code>relink_tds_to_bills</code> to fix the data). Reporting only.
            </p>
          </div>
        </>
      )}
    </MainLayout>
  );
}
