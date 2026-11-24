// Stock → product movement history: opening balance + each receipt (with date,
// GRN no, vendor, qty) that builds this product's on-hand, with running balance.
import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import { useGlobalCompany } from '../../../hooks/useGlobalCompany.js';
import apiClient from '../../../utils/api.js';

const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export default function StockProductDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { company } = useGlobalCompany();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

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

  const columns = [
    { key: 'date', label: 'Date', sortable: true, render: (v) => fmtDate(v) },
    { key: 'type', label: 'Type', sortable: true,
      render: (v) => <span className={`inline-block text-[10px] font-semibold rounded px-1.5 py-0.5 border ${v === 'Opening' ? 'bg-slate-50 text-slate-600 border-slate-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>{v}</span> },
    { key: 'reference', label: 'Reference', sortable: true },
    { key: 'vendor', label: 'Vendor', sortable: true, render: (v) => v || '—' },
    { key: 'qty_in', label: 'Qty In', align: 'right', render: (v) => fmtQty(v) },
    { key: 'uom', label: 'UOM', render: (v) => v || '—' },
    { key: 'balance', label: 'Balance', align: 'right',
      render: (v) => <span className="font-semibold text-indigo-700">{fmtQty(v)}</span> },
  ];

  return (
    <MainLayout>
      <PageHeader
        compact
        title={data?.product || 'Stock'}
        subtitle="Movement history — opening balance + receipts that build on-hand"
        breadcrumbs={[
          { label: 'Purchase', href: '/purchase/dashboard' },
          { label: 'Stock', href: '/purchase/stock' },
          { label: data?.product || 'Product' },
        ]}
      />

      {data && (
        <div className="mb-3 flex items-center gap-4 text-sm">
          {data.sku && <span className="text-slate-500">SKU: <span className="font-medium text-slate-700">{data.sku}</span></span>}
          <span className="text-slate-500">On hand: <span className="font-semibold text-indigo-700">{fmtQty(data.on_hand)}</span></span>
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
    </MainLayout>
  );
}
