// Stock — on-hand quantity per product, derived from purchase receipts.
// Simple reporting page (refer: this is a lean version; correct the design as needed).
import { useState, useEffect, useCallback } from 'react';
import { Package, Search } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';

const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export default function Stock() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState('0');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (search.trim()) p.set('search', search.trim());
      const { data } = await apiClient.get(`/api/purchase/stock/?${p.toString()}`);
      setRows(data.items || []);
      setTotal(data.total_qty || '0');
    } catch (e) {
      setError('Failed to load stock.');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  return (
    <MainLayout>
      <PageHeader
        title="Stock"
        subtitle="On-hand quantity per product — received through purchase receipts"
        breadcrumbs={[{ label: 'Purchase' }, { label: 'Stock' }]}
      />

      <div className="mb-3 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product…"
            className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
        </div>
        <div className="ml-auto text-sm text-slate-500">
          <span className="font-semibold text-slate-700">{rows.length}</span> products
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400 text-sm">Loading…</div>
        ) : error ? (
          <div className="p-8 text-center text-rose-600 text-sm">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-slate-400">
            <Package size={28} className="mx-auto mb-2 opacity-50" />
            <p className="text-sm">No stock yet — record a purchase Receipt to build stock.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Product</th>
                <th className="text-left px-4 py-2.5 font-semibold">Category</th>
                <th className="text-left px-4 py-2.5 font-semibold">SKU</th>
                <th className="text-right px-4 py-2.5 font-semibold">On Hand</th>
                <th className="text-left px-4 py-2.5 font-semibold">UOM</th>
                <th className="text-right px-4 py-2.5 font-semibold">Receipts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.product_id} className="border-t border-slate-100 odd:bg-white even:bg-slate-50/60 hover:bg-indigo-50/40">
                  <td className="px-4 py-2.5 font-medium text-slate-800">{r.product}</td>
                  <td className="px-4 py-2.5">
                    {r.category ? (
                      <span className={`inline-block text-[10px] font-semibold rounded px-1.5 py-0.5 border ${
                        r.category === 'RM' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : r.category === 'PM' ? 'bg-sky-50 text-sky-700 border-sky-200'
                        : 'bg-slate-50 text-slate-600 border-slate-200'}`}>{r.category}</span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">{r.sku || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-indigo-700">{fmtQty(r.on_hand)}</td>
                  <td className="px-4 py-2.5 text-slate-600">{r.uom || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{r.receipts}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <td className="px-4 py-2.5 text-slate-700" colSpan={3}>Total received</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">{fmtQty(total)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </MainLayout>
  );
}
