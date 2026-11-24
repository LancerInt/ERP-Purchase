// Stock → product movement history: opening stock + each receipt (in) and each
// issue/used (out), with a running balance that builds this product's on-hand.
import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { MinusCircle, X } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import { useGlobalCompany } from '../../../hooks/useGlobalCompany.js';
import apiClient from '../../../utils/api.js';

const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function StockProductDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { company } = useGlobalCompany();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [issue, setIssue] = useState(null);   // { qty, date, note }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (company) p.set('company', company);
      const asOf = searchParams.get('as_of');
      if (asOf) p.set('as_of', asOf);
      const { data } = await apiClient.get(`/api/purchase/stock/${id}/?${p.toString()}`);
      setData(data);
    } catch (e) {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [id, company, searchParams]);

  useEffect(() => { load(); }, [load]);

  const saveIssue = async (e) => {
    e.preventDefault();
    try {
      await apiClient.post('/api/purchase/stock/', {
        action: 'issue', product: id, quantity: issue.qty,
        issue_date: issue.date, uom: issue.uom || '', note: issue.note || '',
      });
      toast.success('Stock usage recorded.');
      setIssue(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not record stock usage.');
    }
  };

  const TYPE_CLS = {
    'Opening Stock': 'bg-slate-50 text-slate-600 border-slate-200',
    'Receipt': 'bg-emerald-50 text-emerald-700 border-emerald-200',
    'Bill': 'bg-sky-50 text-sky-700 border-sky-200',
    'Issued': 'bg-rose-50 text-rose-700 border-rose-200',
  };
  const columns = [
    { key: 'date', label: 'Date', sortable: true, render: (v) => fmtDate(v) },
    { key: 'type', label: 'Type', sortable: true,
      render: (v) => <span className={`inline-block text-[10px] font-semibold rounded px-1.5 py-0.5 border ${TYPE_CLS[v] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>{v}</span> },
    { key: 'reference', label: 'Reference', sortable: true },
    { key: 'vendor', label: 'Vendor', sortable: true, render: (v) => v || '—' },
    { key: 'qty_in', label: 'Qty In', align: 'right',
      render: (v) => Number(v) ? <span className="text-emerald-700">{fmtQty(v)}</span> : '—' },
    { key: 'qty_out', label: 'Qty Out', align: 'right',
      render: (v) => Number(v) ? <span className="text-rose-600">{fmtQty(v)}</span> : '—' },
    { key: 'uom', label: 'UOM', render: (v) => v ? String(v).toUpperCase() : '—' },
    { key: 'balance', label: 'Balance', align: 'right',
      render: (v) => <span className="font-semibold text-indigo-700">{fmtQty(v)}</span> },
  ];

  // Default UOM for a new usage entry: the unit on the product's most recent
  // in/out movement (receipt or prior issue), else blank.
  const defaultUom = (() => {
    const withUom = (data?.moves || []).filter((m) => m.uom);
    return withUom.length ? withUom[withUom.length - 1].uom : '';
  })();

  return (
    <MainLayout>
      <PageHeader
        compact
        title={data?.product || 'Stock'}
        subtitle="Movement history — opening stock + receipts in, used out, running balance"
        breadcrumbs={[
          { label: 'Purchase', href: '/purchase/dashboard' },
          { label: 'Stock', href: '/purchase/stock' },
          { label: data?.product || 'Product' },
        ]}
        actions={{ right: (
          <button type="button"
            onClick={() => setIssue({ qty: '', date: todayISO(), uom: defaultUom, note: '' })}
            className="inline-flex items-center gap-2 px-3 h-9 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700">
            <MinusCircle size={16} /> Record usage
          </button>
        ) }}
      />

      {data && (
        <div className="mb-3 flex items-center gap-4 text-sm">
          {data.sku && <span className="text-slate-500">SKU: <span className="font-medium text-slate-700">{data.sku}</span></span>}
          <span className="text-slate-500">Used: <span className="font-semibold text-rose-600">{fmtQty(data.used)}</span></span>
          <span className="text-slate-500">On hand: <span className="font-semibold text-indigo-700">{fmtQty(data.on_hand)}</span></span>
          <span className={`inline-block text-[10px] font-semibold rounded px-1.5 py-0.5 border ${data.is_used ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
            {data.is_used ? 'Used' : 'Unused'}
          </span>
        </div>
      )}

      <DataTable
        dense
        persistKey="purchase-stock-moves"
        exportFileName={`stock-${(data?.product || 'product').replace(/[^\w-]+/g, '_')}`}
        columns={columns}
        data={data?.moves || []}
        isLoading={loading}
        pageSize={20}
        emptyMessage="No movements for this product."
      />

      {issue && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setIssue(null)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={saveIssue} className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-800">Record stock used</h3>
              <button type="button" onClick={() => setIssue(null)} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <p className="text-sm text-slate-500 mb-4">{data?.product}</p>
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
                <input type="text" value={issue.uom} onChange={(e) => setIssue({ ...issue, uom: e.target.value })}
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
