// Tally vs ERP comparison modal — what each source captured + the value gap.
// Shared by the Purchase Analytics and Dashboard pages. `params` is a query
// string carrying the page's company + period window.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftRight } from 'lucide-react';
import apiClient from '../../../utils/api.js';

const money = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function Row({ label, bucket, tone }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-sm">
      <span className={`font-medium ${tone || 'text-slate-700'}`}>{label}</span>
      <span className="flex items-baseline gap-3">
        <span className="text-slate-400 text-xs">{bucket?.count ?? 0} bill(s)</span>
        <span className="tabular-nums font-semibold">{money(bucket?.value)}</span>
      </span>
    </div>
  );
}

const TABS = ['Summary', 'By Month', 'By Category'];

export default function SourceCompareModal({ params, onClose }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState('Summary');
  const [data, setData] = useState(null);
  const [monthly, setMonthly] = useState(null);
  const [category, setCategory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mLoading, setMLoading] = useState(false);
  const [cLoading, setCLoading] = useState(false);
  const [error, setError] = useState(null);

  // Build a Bills-page link for a clicked cell: this period's company+window +
  // the source (tally|scan) + the purchase category, so the list shows exactly
  // the bills behind the number. `params` already carries company & from/to.
  const openBills = (source, catCode) => {
    const sp = new URLSearchParams(params);          // company, from, to, (source)
    const p = new URLSearchParams();
    if (sp.get('company')) p.set('company', sp.get('company'));
    if (sp.get('from')) p.set('from', sp.get('from'));
    if (sp.get('to')) p.set('to', sp.get('to'));
    if (source) p.set('source', source);             // 'tally' | 'scan'
    if (catCode) p.set('purchase_category', catCode);
    onClose();
    navigate(`/purchase/bills?${p.toString()}`);
  };

  useEffect(() => {
    let cancelled = false; setLoading(true); setError(null);
    apiClient.get(`/api/purchase/source-compare/?${params}`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => {
        if (!cancelled) {
          const d = e.response?.data;
          setError(d?.detail || (typeof d === 'string' ? d : JSON.stringify(d)) || `HTTP ${e.response?.status} — Failed to load.`);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [params]);

  useEffect(() => {
    if (tab !== 'By Month' || monthly) return;
    setMLoading(true);
    apiClient.get(`/api/purchase/source-compare/?${params}&type=monthly`)
      .then((r) => setMonthly(r.data))
      .catch(() => {})
      .finally(() => setMLoading(false));
  }, [tab, params, monthly]);

  useEffect(() => {
    if (tab !== 'By Category' || category) return;
    setCLoading(true);
    apiClient.get(`/api/purchase/source-compare/?${params}&type=category`)
      .then((r) => setCategory(r.data))
      .catch(() => {})
      .finally(() => setCLoading(false));
  }, [tab, params, category]);

  // reset caches when params change
  useEffect(() => { setMonthly(null); setCategory(null); }, [params]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h3 className="font-bold text-slate-800 flex items-center gap-2"><ArrowLeftRight size={16} className="text-indigo-600" /> Tally vs ERP</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200">
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px transition ${tab === t ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
              {t}
            </button>
          ))}
        </div>

        {tab === 'Summary' && (
          <>
            {loading ? (
              <div className="py-16 text-center text-slate-400">Loading…</div>
            ) : error ? (
              <div className="m-4 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 p-3 text-sm">{error}</div>
            ) : data ? (
              <>
                {data.period?.label && <p className="px-4 pt-3 text-xs text-slate-500">Period: <b>{data.period.label}</b></p>}
                {/* Two origins — every bill is one or the other, no overlap. */}
                <div className="p-2">
                  <Row label="Tally (imported from Tally)" bucket={data.tally} tone="text-indigo-700" />
                  <Row label="ERP (entered here — scan / email / manual)" bucket={data.scan} tone="text-sky-700" />
                </div>
                <div className="flex items-center justify-between px-4 py-3 border-t-2 border-slate-200 bg-slate-50 rounded-b-xl">
                  <span className="font-bold text-slate-800">Value gap (Tally vs ERP total)</span>
                  <span className="tabular-nums font-bold text-rose-700">{money(data.difference)}</span>
                </div>
              </>
            ) : null}
          </>
        )}

        {tab === 'By Month' && (
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            {mLoading ? (
              <div className="py-16 text-center text-slate-400">Loading…</div>
            ) : monthly?.months?.length ? (
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 z-10">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Month</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Total</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-semibold text-indigo-400 uppercase tracking-wider">Tally</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-semibold text-sky-400 uppercase tracking-wider">ERP</th>
                  </tr>
                </thead>
                <tbody>
                  {monthly.months.map(m => (
                    <tr key={m.month} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-700">{m.month}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-800 font-semibold">{m.total}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-indigo-700">{m.tally}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-sky-700">{m.erp}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="py-16 text-center text-slate-400">No data.</div>
            )}
            {monthly?.months?.length > 0 && (
              <p className="px-4 py-2 text-[10px] text-slate-400 border-t border-slate-100">
                Tally = imported from Tally · ERP = entered in the ERP (scanned / emailed / manual). Tally + ERP = Total — every bill is one or the other.
              </p>
            )}
          </div>
        )}

        {tab === 'By Category' && (
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            {cLoading ? (
              <div className="py-16 text-center text-slate-400">Loading…</div>
            ) : category?.rows?.length ? (
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 z-10">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Purchase category</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-semibold text-indigo-400 uppercase tracking-wider">Tally</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-semibold text-sky-400 uppercase tracking-wider">ERP</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {category.rows.map(r => (
                    <tr key={r.code} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-700">{r.label}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {r.tally > 0
                          ? <button onClick={() => openBills('tally', r.code)} className="text-indigo-700 hover:underline font-medium">{r.tally}</button>
                          : <span className="text-slate-300">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {r.erp > 0
                          ? <button onClick={() => openBills('scan', r.code)} className="text-sky-700 hover:underline font-medium">{r.erp}</button>
                          : <span className="text-slate-300">0</span>}
                      </td>
                      <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${r.diff > 0 ? 'text-amber-600' : r.diff < 0 ? 'text-rose-600' : 'text-slate-300'}`}>
                        {r.diff > 0 ? `+${r.diff}` : r.diff}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-300 bg-slate-50">
                  <tr>
                    <td className="px-4 py-2.5 font-bold text-slate-700">Total purchases</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-bold text-indigo-700">{category.total.tally}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-bold text-sky-700">{category.total.erp}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-bold text-amber-600">{category.total.diff > 0 ? `+${category.total.diff}` : category.total.diff}</td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              <div className="py-16 text-center text-slate-400">No data.</div>
            )}
            {category?.rows?.length > 0 && (
              <p className="px-4 py-2 text-[10px] text-slate-400 border-t border-slate-100">
                Purchase categories only (RM · Packing · Bought Note · Fruit · Maize). Click a count to see those bills. Diff = Tally − ERP.
              </p>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
