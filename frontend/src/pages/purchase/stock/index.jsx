// Stock — on-hand qty per product. Stock = opening balance + receipts up to the
// selected period's end, so picking a past period recomputes stock dynamically.
// Uses the shared DataTable (same look as the Bills page) + the standard
// compact header, period filter and global company filter.
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Pencil, X } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import { PeriodNavigator, usePeriodFilter, todayISO } from '@/components/common/PeriodNavigator';
import { useGlobalCompany } from '../../../hooks/useGlobalCompany.js';
import apiClient from '../../../utils/api.js';

const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

const CAT_CLS = {
  RM: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  PM: 'bg-sky-50 text-sky-700 border-sky-200',
};

export default function Stock() {
  const [searchParams] = useSearchParams();
  const period = usePeriodFilter(searchParams.get('period') || 'all', {
    anchor: searchParams.get('anchor'),
    customFrom: searchParams.get('cfrom'),
    customTo: searchParams.get('cto'),
  });
  const asOf = period.range?.to || null;

  const { company } = useGlobalCompany();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState('0');
  const [cat, setCat] = useState('');
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (asOf) p.set('as_of', asOf);
      if (company) p.set('company', company);
      if (cat) p.set('category', cat);
      const { data } = await apiClient.get(`/api/purchase/stock/?${p.toString()}`);
      setRows(data.items || []);
      setTotal(data.total_qty || '0');
    } catch (e) {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [asOf, company, cat]);

  useEffect(() => { load(); }, [load]);

  const saveOpening = async (e) => {
    e.preventDefault();
    try {
      await apiClient.post('/api/purchase/stock/', {
        product: edit.product_id, quantity: edit.qty, as_of_date: edit.date, uom: edit.uom || '',
      });
      toast.success('Opening stock saved.');
      setEdit(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not save opening stock.');
    }
  };

  const columns = [
    { key: 'product', label: 'Product', sortable: true,
      render: (v) => <span className="font-medium text-slate-800">{v}</span> },
    { key: 'category', label: 'Category', sortable: true,
      render: (v) => v
        ? <span className={`inline-block text-[10px] font-semibold rounded px-1.5 py-0.5 border ${CAT_CLS[v] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>{v}</span>
        : <span className="text-slate-300">—</span> },
    { key: 'sku', label: 'SKU', sortable: true, render: (v) => v || '—' },
    { key: 'opening', label: 'Opening', sortable: true, align: 'right',
      render: (v) => Number(v) ? fmtQty(v) : '—' },
    { key: 'received', label: 'Received', sortable: true, align: 'right',
      render: (v) => fmtQty(v) },
    { key: 'on_hand', label: 'On Hand', sortable: true, align: 'right',
      render: (v) => <span className="font-semibold text-indigo-700">{fmtQty(v)}</span> },
    { key: 'uom', label: 'UOM', render: (v) => v || '—' },
    { key: '_edit', label: '', sortable: false, align: 'right',
      render: (_v, row) => (
        <button title="Set opening stock"
          onClick={(e) => { e.stopPropagation(); setEdit({ product_id: row.product_id, product: row.product, uom: row.uom, qty: row.opening || '', date: asOf || todayISO() }); }}
          className="text-slate-400 hover:text-indigo-600"><Pencil size={14} /></button>
      ) },
  ];

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Stock"
        subtitle="On-hand quantity per product — opening balance + purchase receipts"
        breadcrumbs={[{ label: 'Purchase', href: '/purchase/dashboard' }, { label: 'Stock' }]}
      />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <PeriodNavigator allowAll {...period.navProps} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}
          className="h-9 pl-3 pr-8 rounded-lg border border-slate-300 text-sm bg-white min-w-[130px] focus:outline-none focus:ring-2 focus:ring-indigo-200">
          <option value="">All categories</option>
          <option value="RM">RM</option>
          <option value="PM">PM</option>
        </select>
      </div>

      <DataTable
        dense
        persistKey="purchase-stock"
        exportFileName="stock"
        columns={columns}
        data={rows}
        isLoading={loading}
        pageSize={15}
        emptyMessage="No stock in this period — record a Receipt or set opening stock."
        footerExtra={<span className="text-sm font-semibold text-slate-700">Total on hand: {fmtQty(total)}</span>}
      />

      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setEdit(null)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={saveOpening} className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5">
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
