// Stock — on-hand qty per product. Stock = opening balance + receipts up to the
// selected period's end, so picking a past period recomputes stock dynamically.
// Uses the shared DataTable (same look as the Bills page) + the standard
// compact header, period filter and global company filter.
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Pencil, X, MinusCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import { PeriodNavigator, usePeriodFilter, todayISO } from '@/components/common/PeriodNavigator';
import { useGlobalCompany } from '../../../hooks/useGlobalCompany.js';
import apiClient from '../../../utils/api.js';
import { categoryChipCls } from '../../../utils/constants.js';

const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export default function Stock() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
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
  const [wh, setWh] = useState('');          // warehouse filter (id)
  const [gd, setGd] = useState('');          // godown filter (id)
  // Distinct {id,name} warehouse/godown options, built from the loaded rows so
  // the dropdowns always match what's on screen (no extra lookups needed).
  const [whOpts, setWhOpts] = useState([]);
  const [gdOpts, setGdOpts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(null);     // opening-stock editor
  const [issue, setIssue] = useState(null);   // issue / used editor

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (asOf) p.set('as_of', asOf);
      if (company) p.set('company', company);
      if (cat) p.set('category', cat);
      if (wh) p.set('warehouse', wh);
      if (gd) p.set('godown', gd);
      const { data } = await apiClient.get(`/api/purchase/stock/?${p.toString()}`);
      const items = data.items || [];
      setRows(items);
      setTotal(data.total_qty || '0');
    } catch (e) {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [asOf, company, cat, wh, gd]);

  // Build the warehouse / godown option lists from the UNFILTERED set (so a
  // filter never hides its own remaining choices). Loaded once + whenever the
  // company / period changes, not on every wh/gd pick.
  const loadOpts = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (asOf) p.set('as_of', asOf);
      if (company) p.set('company', company);
      const { data } = await apiClient.get(`/api/purchase/stock/?${p.toString()}`);
      const items = data.items || [];
      const whMap = new Map(), gdMap = new Map();
      for (const it of items) {
        if (it.warehouse_id) whMap.set(it.warehouse_id, it.warehouse || it.warehouse_id);
        if (it.godown_id) gdMap.set(it.godown_id, it.godown || it.godown_id);
      }
      setWhOpts([...whMap].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
      setGdOpts([...gdMap].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
    } catch { /* keep prior options */ }
  }, [asOf, company]);
  useEffect(() => { loadOpts(); }, [loadOpts]);

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

  const saveIssue = async (e) => {
    e.preventDefault();
    try {
      await apiClient.post('/api/purchase/stock/', {
        action: 'issue', product: issue.product_id, quantity: issue.qty,
        issue_date: issue.date, uom: issue.uom || '', note: issue.note || '',
      });
      toast.success('Stock usage recorded.');
      setIssue(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not record stock usage.');
    }
  };

  const columns = [
    { key: 'product', label: 'Product', sortable: true,
      render: (v) => <span className="font-medium text-slate-800">{v}</span> },
    { key: 'category', label: 'Category', sortable: true,
      render: (v) => v
        ? <span className={`inline-block text-[10px] font-semibold rounded px-1.5 py-0.5 border ${categoryChipCls(v)}`}>{v}</span>
        : <span className="text-slate-300">—</span> },
    { key: 'sku', label: 'SKU', sortable: true, render: (v) => v || '—' },
    { key: 'warehouse', label: 'Warehouse', sortable: true,
      render: (v) => v
        ? <span className="text-[11px] font-medium text-slate-600 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 whitespace-nowrap">{v}</span>
        : <span className="text-slate-300">—</span> },
    { key: 'godown', label: 'Godown', sortable: true,
      render: (v) => v
        ? <span className="text-[11px] font-medium text-slate-600 whitespace-nowrap">{v}</span>
        : <span className="text-slate-300">—</span> },
    { key: 'opening', label: 'Opening Stock', sortable: true, align: 'right',
      render: (v) => Number(v) ? fmtQty(v) : '—' },
    { key: 'received', label: 'Received', sortable: true, align: 'right',
      render: (v) => fmtQty(v) },
    { key: 'used', label: 'Used', sortable: true, align: 'right',
      render: (v) => Number(v) ? <span className="text-rose-600">{fmtQty(v)}</span> : '—' },
    { key: 'on_hand', label: 'On Hand', sortable: true, align: 'right',
      render: (v) => <span className="font-semibold text-indigo-700">{fmtQty(v)}</span> },
    { key: 'is_used', label: 'Usage', sortable: true, align: 'center',
      render: (v) => v
        ? <span className="inline-block text-[10px] font-semibold rounded px-1.5 py-0.5 border bg-emerald-50 text-emerald-700 border-emerald-200">Used</span>
        : <span className="inline-block text-[10px] font-semibold rounded px-1.5 py-0.5 border bg-slate-50 text-slate-500 border-slate-200">Unused</span> },
    { key: 'uom', label: 'UOM', render: (v) => v ? String(v).toUpperCase() : '—' },
    { key: '_edit', label: '', sortable: false, align: 'right',
      render: (_v, row) => (
        <div className="flex items-center justify-end gap-2">
          <button title="Record stock used / issued"
            onClick={(e) => { e.stopPropagation(); setIssue({ product_id: row.product_id, product: row.product, uom: row.uom, qty: '', date: asOf || todayISO(), note: '' }); }}
            className="text-slate-400 hover:text-rose-600"><MinusCircle size={14} /></button>
          <button title="Set opening stock"
            onClick={(e) => { e.stopPropagation(); setEdit({ product_id: row.product_id, product: row.product, uom: row.uom, qty: row.opening || '', date: asOf || todayISO() }); }}
            className="text-slate-400 hover:text-indigo-600"><Pencil size={14} /></button>
        </div>
      ) },
  ];

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Stock"
        subtitle="On-hand per product — opening stock + receipts − used. 'Unused' means nothing issued yet."
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
        <select value={wh} onChange={(e) => setWh(e.target.value)}
          className="h-9 pl-3 pr-8 rounded-lg border border-slate-300 text-sm bg-white min-w-[160px] focus:outline-none focus:ring-2 focus:ring-indigo-200">
          <option value="">All warehouses</option>
          {whOpts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={gd} onChange={(e) => setGd(e.target.value)}
          className="h-9 pl-3 pr-8 rounded-lg border border-slate-300 text-sm bg-white min-w-[150px] focus:outline-none focus:ring-2 focus:ring-indigo-200">
          <option value="">All godowns</option>
          {gdOpts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        {(wh || gd || cat) && (
          <button type="button" onClick={() => { setWh(''); setGd(''); setCat(''); }}
            className="text-xs text-slate-500 hover:text-slate-800 underline">Clear</button>
        )}
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
        onRowClick={(row) => navigate(`/purchase/stock/${row.product_id}${asOf ? `?as_of=${asOf}` : ''}`)}
      />

      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setEdit(null)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={saveOpening} className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-800">Opening Stock</h3>
              <button type="button" onClick={() => setEdit(null)} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <p className="text-sm text-slate-500 mb-4">{edit.product}</p>
            <label className="block text-xs font-medium text-slate-600 mb-1">As of date</label>
            <input type="date" required value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })}
              className="w-full h-10 px-3 mb-3 rounded-lg border border-slate-300 text-sm" />
            <div className="flex gap-2 mb-4">
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-600 mb-1">Opening quantity</label>
                <input type="number" step="any" required value={edit.qty} onChange={(e) => setEdit({ ...edit, qty: e.target.value })}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm" placeholder="0" />
              </div>
              <div className="w-24">
                <label className="block text-xs font-medium text-slate-600 mb-1">UOM</label>
                <input type="text" value={edit.uom || ''} onChange={(e) => setEdit({ ...edit, uom: e.target.value })}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm uppercase" placeholder="KG" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEdit(null)} className="px-3 h-9 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button type="submit" className="px-4 h-9 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Save</button>
            </div>
          </form>
        </div>
      )}

      {issue && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setIssue(null)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={saveIssue} className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-800">Record stock used</h3>
              <button type="button" onClick={() => setIssue(null)} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <p className="text-sm text-slate-500 mb-4">{issue.product}</p>
            <label className="block text-xs font-medium text-slate-600 mb-1">Date used</label>
            <input type="date" required value={issue.date} onChange={(e) => setIssue({ ...issue, date: e.target.value })}
              className="w-full h-10 px-3 mb-3 rounded-lg border border-slate-300 text-sm" />
            <div className="flex gap-2 mb-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-600 mb-1">Quantity used</label>
                <input type="number" step="any" min="0" required value={issue.qty} onChange={(e) => setIssue({ ...issue, qty: e.target.value })}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm" placeholder="0" />
              </div>
              <div className="w-24">
                <label className="block text-xs font-medium text-slate-600 mb-1">UOM</label>
                <input type="text" value={issue.uom || ''} onChange={(e) => setIssue({ ...issue, uom: e.target.value })}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm uppercase" placeholder="MT" />
              </div>
            </div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Note <span className="text-slate-400">(optional)</span></label>
            <input type="text" value={issue.note} onChange={(e) => setIssue({ ...issue, note: e.target.value })}
              className="w-full h-10 px-3 mb-4 rounded-lg border border-slate-300 text-sm" placeholder="e.g. issued to production" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setIssue(null)} className="px-3 h-9 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button type="submit" className="px-4 h-9 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700">Record usage</button>
            </div>
          </form>
        </div>
      )}
    </MainLayout>
  );
}
