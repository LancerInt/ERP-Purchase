// Stock — on-hand qty per product. Stock = opening balance + receipts up to the
// chosen "as of" month, so picking a past month recomputes stock dynamically.
import { useState, useEffect, useCallback } from 'react';
import { Package, Search, Pencil, X } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';

const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
// Last day of a YYYY-MM month (the "as of" date for that month).
const monthEnd = (ym) => { if (!ym) return ''; const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).toISOString().slice(0, 10); };
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function Stock() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState('0');
  const [search, setSearch] = useState('');
  const [month, setMonth] = useState('');       // '' = current / all-time
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [edit, setEdit] = useState(null);        // product row being given opening stock

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (search.trim()) p.set('search', search.trim());
      if (month) p.set('as_of', monthEnd(month));
      const { data } = await apiClient.get(`/api/purchase/stock/?${p.toString()}`);
      setRows(data.items || []);
      setTotal(data.total_qty || '0');
    } catch (e) {
      setError('Failed to load stock.');
    } finally {
      setLoading(false);
    }
  }, [search, month]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const saveOpening = async (e) => {
    e.preventDefault();
    try {
      await apiClient.post('/api/purchase/stock/', {
        product: edit.product_id,
        quantity: edit.qty,
        as_of_date: edit.date,
        uom: edit.uom || '',
      });
      toast.success('Opening stock saved.');
      setEdit(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not save opening stock.');
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Stock"
        subtitle="On-hand quantity per product — opening balance + purchase receipts"
        breadcrumbs={[{ label: 'Purchase' }, { label: 'Stock' }]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product…"
            className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-slate-600 whitespace-nowrap">Stock as of:</label>
          <input type="month" value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value)}
            className="h-10 px-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
          {month && (
            <button onClick={() => setMonth('')} className="text-xs text-slate-500 hover:text-slate-700 underline">now</button>
          )}
        </div>
        <div className="ml-auto text-sm text-slate-500"><span className="font-semibold text-slate-700">{rows.length}</span> products</div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400 text-sm">Loading…</div>
        ) : error ? (
          <div className="p-8 text-center text-rose-600 text-sm">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-slate-400">
            <Package size={28} className="mx-auto mb-2 opacity-50" />
            <p className="text-sm">No stock in this period — record a Receipt or set opening stock.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Product</th>
                <th className="text-left px-4 py-2.5 font-semibold">Category</th>
                <th className="text-left px-4 py-2.5 font-semibold">SKU</th>
                <th className="text-right px-4 py-2.5 font-semibold">Opening</th>
                <th className="text-right px-4 py-2.5 font-semibold">Received</th>
                <th className="text-right px-4 py-2.5 font-semibold">On Hand</th>
                <th className="text-left px-4 py-2.5 font-semibold">UOM</th>
                <th className="px-4 py-2.5"></th>
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
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{Number(r.opening) ? fmtQty(r.opening) : '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{fmtQty(r.received)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-indigo-700">{fmtQty(r.on_hand)}</td>
                  <td className="px-4 py-2.5 text-slate-600">{r.uom || '—'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button title="Set opening stock"
                      onClick={() => setEdit({ product_id: r.product_id, product: r.product, uom: r.uom, qty: r.opening || '', date: monthEnd(month) || new Date().toISOString().slice(0, 10) })}
                      className="text-slate-400 hover:text-indigo-600"><Pencil size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <td className="px-4 py-2.5 text-slate-700" colSpan={5}>Total on hand</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">{fmtQty(total)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Set opening stock dialog */}
      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setEdit(null)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={saveOpening}
            className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-800">Opening stock</h3>
              <button type="button" onClick={() => setEdit(null)} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <p className="text-sm text-slate-500 mb-4">{edit.product}</p>
            <label className="block text-xs font-medium text-slate-600 mb-1">As of date</label>
            <input type="date" required value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })}
              className="w-full h-10 px-3 mb-3 rounded-lg border border-slate-300 text-sm" />
            <label className="block text-xs font-medium text-slate-600 mb-1">Opening quantity</label>
            <input type="number" step="any" required value={edit.qty} onChange={(e) => setEdit({ ...edit, qty: e.target.value })}
              className="w-full h-10 px-3 mb-4 rounded-lg border border-slate-300 text-sm" placeholder="0" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEdit(null)} className="px-3 h-9 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button type="submit" className="px-4 h-9 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Save</button>
            </div>
          </form>
        </div>
      )}
    </MainLayout>
  );
}
