import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo, useEffect } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import DataTable from '../../../components/common/DataTable';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { ArrowLeft, ChevronLeft, ChevronRight, Trash2, RefreshCw } from 'lucide-react';
import { confirm } from '@/components/common/confirm';
import usePagerKeys from '../../../hooks/usePagerKeys.js';

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

// Walk per (godown, batch) group in chronological order to derive running balance.
// Warehouse + product are fixed at this level so they're not part of the key.
function withRunningBalance(rows) {
  const groups = new Map();
  const ascending = [...rows].sort((a, b) => {
    const da = `${a.transaction_date} ${a.created_at || ''}`;
    const db = `${b.transaction_date} ${b.created_at || ''}`;
    return da < db ? -1 : da > db ? 1 : 0;
  });
  const enriched = ascending.map((r) => {
    const key = [r.godown, r.batch || ''].join('|');
    const opening = Number(groups.get(key) || 0);
    const inQty = Number(r.quantity_in || 0);
    const outQty = Number(r.quantity_out || 0);
    const closing = opening + inQty - outQty;
    groups.set(key, closing);
    const cost = Number(r.cost || 0);
    return {
      ...r,
      _openingQty: opening,
      _inQty: inQty,
      _outQty: outQty,
      _closingQty: closing,
      _value: closing * cost,
    };
  });
  return enriched.reverse();
}

const TYPE_LABELS = {
  RECEIPT: 'Receipt',
  DISPATCH: 'Release Dispatch',
  ADJUSTMENT: 'Adjustment',
  ISSUE: 'Issue',
  TRANSFER: 'Transfer',
  PRODUCTION_IN: 'Production In',
  PRODUCTION_OUT: 'Production Out',
  SALES_RETURN: 'Sales Return',
  JOB_WORK_OUT: 'Job Work Out',
  JOB_WORK_IN: 'Job Work In',
};
const TYPE_BADGE = {
  RECEIPT: 'bg-green-50 text-green-700 border-green-200',
  DISPATCH: 'bg-red-50 text-red-700 border-red-200',
  ADJUSTMENT: 'bg-amber-50 text-amber-700 border-amber-200',
  TRANSFER: 'bg-blue-50 text-blue-700 border-blue-200',
};

// Map a ledger row's `source_document_type` to the detail-page route
// for that source document. Returns null when the source type doesn't
// have a corresponding detail page, in which case the Source cell
// renders as plain text instead of a link. Kept here (not derived from
// transaction_type) because two different transaction types can share
// a source — e.g. WarehouseShifting posts both an IN and an OUT row.
const SOURCE_ROUTE = {
  StockAdjustment:        (id) => `/inventory/adjustments/${id}`,
  WarehouseShifting:      (id) => `/inventory/shifting/${id}`,
  JobWorkOrder:           (id) => `/inventory/job-work/${id}`,
  StockTransferDC:        (id) => `/inventory/transfers/${id}`,
  StockTransferReceipt:   (id) => `/inventory/transfers/${id}`,
  SalesReturnAdvice:      (id) => `/inventory/returns/${id}`,
  SalesDispatchChallan:   (id) => `/sales/dispatch-challan/${id}`,
  PurchaseReceiptAdvice:  (id) => `/purchase/receipts/${id}`,
  RECEIPT:                (id) => `/purchase/receipts/${id}`,
};

const PAGE_SIZE = 25;

export default function ProductStockLedgerDetail() {
  const { canExport } = usePermissions();
  // The component is reached two ways:
  //   /inventory/stock-ledger/product-transactions?warehouse=…&product=…
  //     (Stock Ledger index navigates here as query-string params)
  //   /inventory/stock-ledger/:warehouseId/products/:productId
  //     (the older path-segment route; warehouse-detail drill-down)
  // Read whichever the current URL supplied so the page works under
  // both. If neither is present every fetch below would hit the API
  // with empty filters and return the *entire* ledger — that's the
  // "I'm seeing transactions from multiple products" bug you'd get.
  const params = useParams();
  const [searchParams] = useSearchParams();
  const warehouseId = params.warehouseId || searchParams.get('warehouse') || '';
  const productId = params.productId || searchParams.get('product') || '';
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useApiData(
    `/api/inventory/stock-ledger/?warehouse=${warehouseId}&product=${productId}`
  );
  const [deletingId, setDeletingId] = useState(null);

  const handleDelete = async (row) => {
    if (!row?.id) return;
    if (!(await confirm({ message: `Reverse this ${row.transaction_type || 'ledger'} entry?\n\n` +
      `This posts a counter-entry. The original row stays visible for audit; ` +
      `closing balance returns to its pre-entry value.`, isDangerous: true }))) return;
    setDeletingId(row.id);
    try {
      await apiClient.post(`/api/inventory/stock-ledger/${row.id}/reverse/`);
      toast.success('Ledger entry reversed');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  };

  const handleHide = async (row) => {
    if (!row?.id) return;
    if (!(await confirm({ message: `Hide this row from the ledger?\n\n` +
      `This is allowed because the row is part of a closed reversal pair (sum = 0), ` +
      `so the closing balance won't change. The other side of the pair stays hidden too if you hide it as well.` }))) return;
    setDeletingId(row.id);
    try {
      await apiClient.post(`/api/inventory/stock-ledger/${row.id}/hide/`);
      toast.success('Row hidden');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  };
  const { options: godownOptions } = useLookup(`/api/godowns/?warehouse=${warehouseId}`);

  const [warehouseName, setWarehouseName] = useState('');
  const [product, setProduct] = useState({ name: '', sku: '', uom: '' });

  // Domain filters live in the URL so drilling into a source document and
  // pressing Back restores the filtered ledger (warehouse/product are already
  // in the URL as path/query params).
  const { values: filters, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    godown: '',
    batch: '',
    transaction_type: '',
    date_from: '',
    date_to: '',
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (warehouseId) {
      apiClient.get(`/api/warehouses/${warehouseId}/`)
        .then((res) => setWarehouseName(res.data?.name || ''))
        .catch(() => setWarehouseName(''));
    }
    if (productId) {
      apiClient.get(`/api/products/${productId}/`)
        .then((res) => setProduct({
          name: res.data?.product_name || res.data?.name || '',
          sku: res.data?.sku_code || res.data?.sku || '',
          uom: res.data?.uom || '',
        }))
        .catch(() => setProduct({ name: '', sku: '', uom: '' }));
    }
  }, [warehouseId, productId]);

  const rowsWithBalance = useMemo(() => withRunningBalance(data || []), [data]);

  const filtered = useMemo(() => {
    const term = (searchTerm || '').trim().toLowerCase();
    return rowsWithBalance.filter((r) => {
      if (filters.godown && String(r.godown) !== String(filters.godown)) return false;
      if (filters.batch && (r.batch || '') !== filters.batch) return false;
      if (filters.transaction_type && r.transaction_type !== filters.transaction_type) return false;
      if (filters.date_from && r.transaction_date < filters.date_from) return false;
      if (filters.date_to && r.transaction_date > filters.date_to) return false;
      if (term) {
        const hay = `${r.batch || ''} ${r.godown_name || ''} ${r.remarks || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [rowsWithBalance, filters, searchTerm]);

  useEffect(() => { setPage(1); }, [filters.godown, filters.batch, filters.transaction_type, filters.date_from, filters.date_to, searchTerm]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Now that DataTable no longer re-paginates the slice, its own key handler
  // is dormant (one page) and this outer pager is the only one — so it takes
  // the arrows.
  usePagerKeys({
    enabled: totalPages > 1,
    onPrev: () => setPage((p) => Math.max(1, p - 1)),
    onNext: () => setPage((p) => Math.min(totalPages, p + 1)),
  });
  const paginated = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
  );

  // Summary across the *unfiltered* rows so the cards show real warehouse-level
  // totals for this product, not just whatever the filter narrowed to.
  const summary = useMemo(() => {
    let inQty = 0, outQty = 0;
    for (const r of rowsWithBalance) {
      inQty += Number(r._inQty || 0);
      outQty += Number(r._outQty || 0);
    }
    const seen = new Set();
    let totalQty = 0, totalValue = 0;
    for (const r of rowsWithBalance) {
      const key = [r.godown, r.batch || ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      totalQty += Number(r._closingQty || 0);
      totalValue += Number(r._value || 0);
    }
    return { totalQty, totalValue, inQty, outQty };
  }, [rowsWithBalance]);

  const batchOptions = useMemo(() => {
    const set = new Set();
    (data || []).forEach((r) => { if (r.batch) set.add(r.batch); });
    return [...set].sort().map((b) => ({ value: b, label: b }));
  }, [data]);

  const txnTypeOptions = useMemo(() => {
    const set = new Set();
    (data || []).forEach((r) => { if (r.transaction_type) set.add(r.transaction_type); });
    return [...set].sort().map((t) => ({ value: t, label: TYPE_LABELS[t] || t }));
  }, [data]);

  const columns = [
    {
      field: 'transaction_date', header: 'Date', sortable: true, width: '110px',
      render: (v) => v ? formatDate(v) : '-',
    },
    {
      field: 'product_name', header: 'Product', sortable: true, width: '180px',
      render: (v, row) => {
        const name = v || product.name || '-';
        const sku = row.product_sku || product.sku || '';
        return (
          <div className="leading-tight">
            <div className="font-medium text-slate-800">{name}</div>
            {sku && <div className="text-[11px] text-slate-500">{sku}</div>}
          </div>
        );
      },
    },
    {
      field: 'transaction_type', header: 'Type', sortable: true, width: '180px',
      render: (v, row) => {
        if (!v) return '-';
        const label = TYPE_LABELS[v] || v.replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
        const cls = TYPE_BADGE[v] || 'bg-slate-50 text-slate-700 border-slate-200';
        return (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>{label}</span>
            {row.reversal_of && (
              <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium border bg-purple-50 text-purple-700 border-purple-200" title="This row cancels an earlier entry">Reversal</span>
            )}
            {row.is_reversed && !row.reversal_of && (
              <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium border bg-slate-100 text-slate-500 border-slate-300" title="This entry has been reversed by a later row">Reversed</span>
            )}
          </div>
        );
      },
    },
    { field: 'godown_name', header: 'Godown', sortable: true, width: '140px', render: (v) => v || '-' },
    { field: 'batch', header: 'Batch', sortable: true, width: '120px', render: (v) => v || '-' },
    { field: '_openingQty', header: 'Opening', sortable: true, width: '100px', render: (v) => fmtQty(v, product.uom) },
    {
      field: '_inQty', header: 'In', sortable: true, width: '90px',
      render: (v) => v > 0 ? <span className="text-green-600 font-medium">+{fmtQty(v, product.uom)}</span> : '-',
    },
    {
      field: '_outQty', header: 'Out', sortable: true, width: '90px',
      render: (v) => v > 0 ? <span className="text-red-600 font-medium">-{fmtQty(v, product.uom)}</span> : '-',
    },
    { field: '_closingQty', header: 'Closing', sortable: true, width: '110px', render: (v) => <span className="font-semibold">{fmtQty(v, product.uom)}</span> },
    { field: '_value', header: 'Value (₹)', sortable: true, width: '130px', render: (v) => fmtAmt(v) },
    {
      field: 'source_no', header: 'Source', sortable: true, width: '160px',
      render: (_, row) => {
        const label = row.source_no || '-';
        if (label === '-') return <span className="text-slate-400">-</span>;
        const routeFn = SOURCE_ROUTE[row.source_document_type];
        if (!routeFn || !row.source_document_id) {
          return <span className="text-slate-600">{label}</span>;
        }
        const href = routeFn(row.source_document_id);
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); navigate(href); }}
            className="text-primary-600 hover:text-primary-700 hover:underline font-medium"
            title={`Open ${row.source_document_type}`}
          >
            {label}
          </button>
        );
      },
    },
    {
      field: 'actions', header: '', sortable: false, width: '90px',
      render: (_, row) => {
        const locked = row.is_reversed || !!row.reversal_of;
        if (locked) {
          return (
            <button
              onClick={(e) => { e.stopPropagation(); handleHide(row); }}
              disabled={deletingId === row.id}
              className="p-1.5 text-slate-500 hover:bg-slate-100 rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Hide row"
              title="Hide this row from the ledger (closed reversal pair sums to zero)"
            >
              <Trash2 size={15} />
            </button>
          );
        }
        return (
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete(row); }}
            disabled={deletingId === row.id}
            className="p-1.5 text-red-500 hover:bg-red-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Reverse entry"
            title="Reverse entry (posts counter-entry, keeps audit trail)"
          >
            <Trash2 size={15} />
          </button>
        );
      },
    },
  ];

  const resetFilters = () => {
    clearFilters();
    setSearchTerm('');
  };

  return (
    <MainLayout>
      <div className="text-sm text-slate-500 mb-3">
        <button onClick={() => navigate('/inventory/stock-ledger')} className="hover:text-slate-700">Inventory</button>
        <span className="mx-2">/</span>
        <button onClick={() => navigate('/inventory/stock-ledger')} className="hover:text-slate-700">Stock Ledger</button>
        <span className="mx-2">/</span>
        <button onClick={() => navigate(`/inventory/stock-ledger/${warehouseId}`)} className="hover:text-slate-700">{warehouseName || 'Warehouse'}</button>
        <span className="mx-2">/</span>
        <span className="text-slate-700 font-medium">{product.name || 'Product'}</span>
      </div>

      <div className="flex items-center gap-3 mb-2">
        <button onClick={() => navigate(`/inventory/stock-ledger/${warehouseId}`)} aria-label="Back" title="Back" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg transition">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{product.name || 'Product Stock Ledger'}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {product.sku && <span className="font-medium text-slate-600">{product.sku}</span>}
            {product.sku && warehouseName && <span className="mx-2">·</span>}
            {warehouseName && <span>at <span className="font-medium text-slate-600">{warehouseName}</span></span>}
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4 mt-4">
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <p className="text-sm text-slate-600 font-medium">Current Stock Qty</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{fmtQty(summary.totalQty, product.uom)}</p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <p className="text-sm text-slate-600 font-medium">Stock Value</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{fmtAmt(summary.totalValue)}</p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <p className="text-sm text-slate-600 font-medium">Total In Qty</p>
          <p className="text-2xl font-bold text-green-600 mt-1">+{fmtQty(summary.inQty, product.uom)}</p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <p className="text-sm text-slate-600 font-medium">Total Out Qty</p>
          <p className="text-2xl font-bold text-red-600 mt-1">-{fmtQty(summary.outQty, product.uom)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search godown, batch, remarks…"
            className="md:col-span-3 lg:col-span-4 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
          <CustomSelect value={filters.godown} onChange={(e) => setFilterValue('godown', e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm">
            <option value="">All Godowns</option>
            {godownOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </CustomSelect>
          <CustomSelect value={filters.batch} onChange={(e) => setFilterValue('batch', e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm">
            <option value="">All batches</option>
            {batchOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </CustomSelect>
          <CustomSelect value={filters.transaction_type} onChange={(e) => setFilterValue('transaction_type', e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm">
            <option value="">All Types</option>
            {txnTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </CustomSelect>
          <CustomDatePicker value={filters.date_from} onChange={(e) => setFilterValue('date_from', e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          <CustomDatePicker value={filters.date_to} onChange={(e) => setFilterValue('date_to', e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          <button type="button" onClick={resetFilters} className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50">Reset</button>
        </div>
      </div>

      {isLoading && <div className="text-center py-8 text-slate-500">Loading...</div>}
      {error && !isLoading && (
        <div className="text-center py-8">
          <p className="text-red-500 mb-3">Failed to load transactions.</p>
          <button onClick={() => refetch()} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )}

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          {/* pageSize matches the slice this page already made. Without it
              DataTable defaulted to 10 and paginated the 25 rows AGAIN, so the
              screen carried two pagers — an inner "1 of 3" and the outer one
              below — and the arrow keys drove the inner one. */}
          <DataTable persistKey="inventory-stock-ledger-product-transactions"
            columns={columns}
            pageSize={PAGE_SIZE}
            data={paginated}
            emptyMessage="No transactions found for this product"
            exportFileName={`stock-ledger-${product.name || productId}`}
            canExport={canExport('Inventory Ledger')}
          />
        </div>

        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
            <span className="text-slate-600">
              Showing <span className="font-medium">{(page - 1) * PAGE_SIZE + 1}</span>–
              <span className="font-medium">{Math.min(page * PAGE_SIZE, filtered.length)}</span> of{' '}
              <span className="font-medium">{filtered.length}</span>
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <span className="text-slate-600">Page {page} of {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
