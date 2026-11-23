import { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import DataTable from '../../../components/common/DataTable';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { ArrowLeft, ArrowRight, Search, RefreshCw } from 'lucide-react';

// Count-based UOMs (Pieces / Numbers / Bags / Boxes / Sets) render
// as integers; every other UOM (KG / LTR / ML / GM / MTS / …) renders
// at 3 decimals. Matches the formatter on the Stock Ledger index page.
const INTEGER_UOMS = new Set(['NOS', 'PCS', 'BAG', 'BOX', 'SET']);
const fmtQty = (v, uom) => {
  const isInt = INTEGER_UOMS.has((uom || '').trim().toUpperCase());
  return Number(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: isInt ? 0 : 3,
    maximumFractionDigits: isInt ? 0 : 3,
  });
};
const fmtAmt = (v) => formatCurrency(v);
const fmtDate = (v) => v ? formatDate(v) : '-';

export default function WarehouseStockLedgerDetail() {
  const { canExport } = usePermissions();
  const { warehouseId } = useParams();
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useApiData(`/api/inventory/stock-ledger/product-summary/?warehouse=${warehouseId}`);
  const [warehouseName, setWarehouseName] = useState('');
  // Search lives in the URL so drilling into a product and pressing Back
  // restores the filtered warehouse list.
  const [searchTerm, setSearchTerm] = useUrlState('q', '');

  useEffect(() => {
    if (!warehouseId) return;
    apiClient.get(`/api/warehouses/${warehouseId}/`)
      .then((res) => setWarehouseName(res.data?.name || ''))
      .catch(() => setWarehouseName(''));
  }, [warehouseId]);

  const products = useMemo(() => {
    const term = (searchTerm || '').trim().toLowerCase();
    if (!term) return data || [];
    return (data || []).filter((p) => {
      const hay = `${p.product_name || ''} ${p.product_sku || ''}`.toLowerCase();
      return hay.includes(term);
    });
  }, [data, searchTerm]);

  const summary = useMemo(() => {
    return (data || []).reduce(
      (acc, p) => ({
        totalQty: acc.totalQty + Number(p.total_qty || 0),
        totalValue: acc.totalValue + Number(p.total_value || 0),
        inQty: acc.inQty + Number(p.in_qty || 0),
        outQty: acc.outQty + Number(p.out_qty || 0),
      }),
      { totalQty: 0, totalValue: 0, inQty: 0, outQty: 0 }
    );
  }, [data]);

  const columns = [
    {
      field: 'product_name', header: 'Product', sortable: true, width: '260px',
      render: (v, row) => (
        <div>
          <p className="font-medium text-slate-800">{v || '-'}</p>
          {row.product_sku && <p className="text-xs text-slate-400 mt-0.5">{row.product_sku}</p>}
        </div>
      ),
    },
    { field: 'total_qty', header: 'Total Qty', sortable: true, width: '120px', render: (v, row) => <span className="font-semibold">{fmtQty(v, row?.uom || row?.product_uom)}</span> },
    { field: 'total_value', header: 'Stock Value', sortable: true, width: '140px', render: (v) => fmtAmt(v) },
    {
      field: 'in_qty', header: 'In Qty', sortable: true, width: '110px',
      render: (v, row) => Number(v) > 0 ? <span className="text-green-600 font-medium">+{fmtQty(v, row?.uom || row?.product_uom)}</span> : fmtQty(v, row?.uom || row?.product_uom),
    },
    {
      field: 'out_qty', header: 'Out Qty', sortable: true, width: '110px',
      render: (v, row) => Number(v) > 0 ? <span className="text-red-600 font-medium">-{fmtQty(v, row?.uom || row?.product_uom)}</span> : fmtQty(v, row?.uom || row?.product_uom),
    },
    { field: 'godown_count', header: 'Godowns', sortable: true, width: '90px', render: (v) => v ?? 0 },
    {
      field: 'last_transaction_date', header: 'Last Txn', sortable: true, width: '120px',
      render: (v) => fmtDate(v),
    },
    {
      field: 'actions', header: '', sortable: false, width: '160px',
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/inventory/stock-ledger/${warehouseId}/products/${row.product}`); }}
          className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded text-xs font-medium hover:bg-primary-100 transition"
        >
          View Transactions <ArrowRight size={12} />
        </button>
      ),
    },
  ];

  return (
    <MainLayout>
      <div className="text-sm text-slate-500 mb-3">
        <button onClick={() => navigate('/inventory/stock-ledger')} className="hover:text-slate-700">Inventory</button>
        <span className="mx-2">/</span>
        <button onClick={() => navigate('/inventory/stock-ledger')} className="hover:text-slate-700">Stock Ledger</button>
        <span className="mx-2">/</span>
        <span className="text-slate-700 font-medium">{warehouseName || 'Warehouse'}</span>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/inventory/stock-ledger'))} aria-label="Back" title="Back" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg transition">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-slate-900">{warehouseName || 'Warehouse Stock Ledger'}</h1>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <p className="text-sm text-slate-600 font-medium">Total Stock Qty</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{fmtQty(summary.totalQty)}</p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <p className="text-sm text-slate-600 font-medium">Total Stock Value</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{fmtAmt(summary.totalValue)}</p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <p className="text-sm text-slate-600 font-medium">Total In Qty</p>
          <p className="text-2xl font-bold text-green-600 mt-1">+{fmtQty(summary.inQty)}</p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <p className="text-sm text-slate-600 font-medium">Total Out Qty</p>
          <p className="text-2xl font-bold text-red-600 mt-1">-{fmtQty(summary.outQty)}</p>
        </div>
      </div>

      {/* Search */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search product or SKU..."
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>
      </div>

      {isLoading && <div className="text-center py-8 text-slate-500">Loading...</div>}
      {error && !isLoading && (
        <div className="text-center py-8">
          <p className="text-red-500 mb-3">Failed to load stock ledger.</p>
          <button onClick={() => refetch()} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )}

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <DataTable persistKey="inventory-stock-ledger-[warehouseId]"
            columns={columns}
            data={products}
            emptyMessage="No products found in this warehouse"
            exportFileName={`stock-ledger-${warehouseName || warehouseId}-products`}
            canExport={canExport('Inventory Ledger')}
            onRowClick={(row) => navigate(`/inventory/stock-ledger/${warehouseId}/products/${row.product}`)}
          />
        </div>
      </div>
    </MainLayout>
  );
}
