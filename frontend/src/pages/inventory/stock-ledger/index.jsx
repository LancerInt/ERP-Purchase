import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePagerKeys from '../../../hooks/usePagerKeys.js';
import { formatCurrency, formatDate } from '@/utils/formatters';
import toast from 'react-hot-toast';
import exportToExcel from '@/utils/exportExcel.js';
import {
  Package, Warehouse as WarehouseIcon, AlertTriangle, AlertOctagon,
  IndianRupee, Search, X, ChevronDown, ChevronRight, ArrowRight,
  Filter, SlidersHorizontal, RefreshCw, MapPin, Upload, Download, FileDown,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────
//  Stock Ledger landing — Phase 1 of the redesign:
//
//    1. KPI strip across the top  (/api/inventory/stock-report/kpis/)
//    2. Sticky filter bar with date pills, warehouse multi-select,
//       category, search and a quick-filter drawer.
//    3. Expandable hierarchy table — group by Warehouse and drill into
//       per-product opening / in / out / closing for the chosen date
//       range. (/api/inventory/stock-report/)
//
//  Per-product transaction drill-down (the existing
//  /inventory/stock-ledger/:warehouseId page) stays as it was — clicking
//  a row jumps there.
// ─────────────────────────────────────────────────────────────────────

// Count-based UOMs (whole units like Pieces / Numbers / Bags / Boxes
// / Sets) render as integers because a fractional piece doesn't make
// sense. Every other UOM is measurement-based (KG, LTR, ML, GM, MTS,
// …) and renders with 3 decimal places so the ledger always shows the
// full precision the InventoryLedger stores at.
const INTEGER_UOMS = new Set(['NOS', 'PCS', 'BAG', 'BOX', 'SET']);
const fmtQty = (v, uom) => {
  const isInt = INTEGER_UOMS.has((uom || '').trim().toUpperCase());
  return Number(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: isInt ? 0 : 3,
    maximumFractionDigits: isInt ? 0 : 3,
  });
};
const fmtAmt = (v) => formatCurrency(v);
const fmtInt = (v) => Number(v || 0).toLocaleString('en-IN');
const fmtDate = (v) => v ? formatDate(v) : '—';

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoOffset = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
const startOfMonth = (offsetMonths = 0) => {
  const d = new Date();
  d.setMonth(d.getMonth() + offsetMonths, 1);
  return d.toISOString().slice(0, 10);
};
const endOfMonth = (offsetMonths = 0) => {
  const d = new Date();
  d.setMonth(d.getMonth() + offsetMonths + 1, 0);
  return d.toISOString().slice(0, 10);
};

const DATE_PRESETS = [
  { v: 'today',     label: 'Today',      from: isoToday,                 to: isoToday },
  { v: 'yesterday', label: 'Yesterday',  from: () => isoOffset(-1),      to: () => isoOffset(-1) },
  { v: 'week',      label: 'This Week',  from: () => isoOffset(-6),      to: isoToday },
  { v: 'month',     label: 'This Month', from: () => startOfMonth(0),    to: isoToday },
  { v: 'last',      label: 'Last Month', from: () => startOfMonth(-1),   to: () => endOfMonth(-1) },
];

const CATEGORY_OPTIONS = [
  { v: '',                 label: 'All Categories' },
  { v: 'RAW_MATERIAL',     label: 'Raw Material' },
  { v: 'PACKING_MATERIAL', label: 'Packing Material' },
  { v: 'FINISHED_GOOD',    label: 'Finished Good' },
  { v: 'SEMI_FINISHED',    label: 'Semi Finished' },
  { v: 'TRADED_PRODUCTS',  label: 'Traded Products' },
  { v: 'CAPITAL_GOOD',     label: 'Capital Good' },
  { v: 'MACHINE_SPARES',   label: 'Machine Spares' },
  { v: 'CONSUMABLES',      label: 'Consumables' },
];

const STOCK_STATE_CHIPS = [
  { v: '',                    label: 'All Stock' },
  { v: 'only_low_stock',      label: 'Low Stock',     tone: 'amber' },
  { v: 'only_zero_stock',     label: 'Zero Stock',    tone: 'slate' },
  { v: 'only_negative_stock', label: 'Negative',      tone: 'red'   },
];

// Stockable product types — matches STOCKABLE_PRODUCT_TYPES on the
// backend. Services and Expense never have inventory, so they're never
// surfaced in the stock ledger and not selectable here.
const PRODUCT_TYPE_CHIPS = [
  { v: '',          label: 'All Stockable' },
  { v: 'GOODS',     label: 'Goods'         },
  { v: 'MACHINERY', label: 'Machinery'     },
];

const DEFAULT_FILTERS = {
  date_preset:  'month',
  from_date:    startOfMonth(0),
  to_date:      isoToday(),
  warehouse:    '',          // single warehouse UUID, '' = All
  godown:       '',          // single godown UUID,    '' = All
  product_type: '',          // '' | 'GOODS' | 'MACHINERY'
  category:     '',
  search:       '',
  stock_state:  '',          // '' | 'only_low_stock' | ...
  page:         1,
  page_size:    50,
};

export default function StockLedger() {
  const navigate = useNavigate();
  const { isHidden } = useFieldPermissions('Inventory Ledger');
  const { options: warehouseOptions } = useLookup('/api/warehouses/');
  // Filters are seeded from the URL (and written back below) so Back / refresh /
  // sharing restore the filtered view — and drilling into a warehouse / product
  // returns here with the same filters intact. A named date preset recomputes
  // its from/to window so only a custom range needs explicit dates in the URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => {
    const g = (k, d = '') => searchParams.get(k) || d;
    const f = { ...DEFAULT_FILTERS };
    f.warehouse = g('warehouse');
    f.godown = g('godown');
    f.product_type = g('product_type');
    f.category = g('category');
    f.search = g('search');
    f.stock_state = g('stock_state');
    f.date_preset = g('date_preset', DEFAULT_FILTERS.date_preset);
    const preset = DATE_PRESETS.find((p) => p.v === f.date_preset);
    if (preset) { f.from_date = preset.from(); f.to_date = preset.to(); }
    else { f.from_date = g('from_date', f.from_date); f.to_date = g('to_date', f.to_date); }
    const pg = parseInt(searchParams.get('page'), 10);
    if (pg > 0) f.page = pg;
    return f;
  });
  // Search has its own input-bound state so each keystroke updates the
  // box immediately, but the actual API refetch is debounced (400 ms)
  // so we're not hammering the backend on every letter. Pressing Enter
  // also forces an immediate apply.
  const [searchDraft, setSearchDraft] = useState(searchParams.get('search') || '');
  // Godown options narrow to the chosen warehouse so picking a Godown
  // outside the warehouse scope isn't possible. Empty warehouse =
  // surface all godowns so the filter is always usable.
  const godownEndpoint = filters.warehouse
    ? `/api/godowns/?warehouse=${filters.warehouse}`
    : '/api/godowns/';
  const { options: godownOptions } = useLookup(godownEndpoint);
  const [kpis, setKpis] = useState(null);
  const [report, setReport] = useState({ count: 0, results: [], page: 1, page_size: 50 });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Build the query-param dict from the current filter state. Skips
  // blanks so the URL only carries what the operator actually picked.
  const buildParams = (f = filters, overrides = {}) => {
    const p = { ...overrides };
    if (f.from_date) p.from_date = f.from_date;
    if (f.to_date)   p.to_date   = f.to_date;
    if (f.warehouse) p.warehouse = f.warehouse;
    if (f.godown)    p.godown    = f.godown;
    if (f.product_type) p.product_type = f.product_type;
    if (f.category) p.category = f.category;
    if (f.search)   p.search   = f.search;
    if (f.stock_state) p[f.stock_state] = 'true';
    p.page      = overrides.page      || f.page      || 1;
    p.page_size = overrides.page_size || f.page_size || 50;
    return p;
  };

  const fetchAll = (f = filters) => {
    setIsLoading(true);
    setError(null);
    const params = buildParams(f);
    Promise.all([
      apiClient.get('/api/inventory/stock-report/kpis/', { params }),
      apiClient.get('/api/inventory/stock-report/',      { params }),
    ])
      .then(([k, r]) => {
        setKpis(k.data);
        setReport(r.data);
      })
      .catch((err) => setError(err?.response?.data?.detail || err?.message || 'Failed to load'))
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    fetchAll(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the active filters into the URL (replace — a filter change isn't a
  // separate history entry; only opening a warehouse / product is). A named date
  // preset recomputes its window on reload, so only a custom range stores dates.
  useEffect(() => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
      put('warehouse', filters.warehouse, !!filters.warehouse);
      put('godown', filters.godown, !!filters.godown);
      put('product_type', filters.product_type, !!filters.product_type);
      put('category', filters.category, !!filters.category);
      put('search', filters.search, !!filters.search);
      put('stock_state', filters.stock_state, !!filters.stock_state);
      put('date_preset', filters.date_preset, !!filters.date_preset && filters.date_preset !== DEFAULT_FILTERS.date_preset);
      put('from_date', filters.from_date, filters.date_preset === 'custom' && !!filters.from_date);
      put('to_date', filters.to_date, filters.date_preset === 'custom' && !!filters.to_date);
      put('page', String(filters.page), (filters.page || 1) > 1);
      return p;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  // Debounced auto-apply for the search box. Skips no-op edits so
  // typing then deleting back to the original value doesn't re-fetch.
  useEffect(() => {
    if (searchDraft === (filters.search || '')) return;
    const handle = setTimeout(() => {
      applyFilters({ search: searchDraft });
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  // Group the flat (warehouse, product) list into warehouse buckets for
  // the hierarchy view. Keyed by warehouse_name (not the UUID) so the
  // master can hold the same name under multiple companies — e.g. two
  // "TVP" rows — and the operator still sees a single consolidated TVP
  // line with combined totals instead of duplicate rows. The bucket
  // keeps the first underlying UUID for the per-row "open detail"
  // navigation; the arrow lands on one of the backing warehouses.
  // Per-product rows inside the bucket are also collapsed by product
  // id: when both TVP-A and TVP-B carry Amino Acid Powder, their
  // opening / in / out / closing / value fold into a single line so
  // the operator doesn't see two RAW-068 rows under the same TVP.
  const grouped = useMemo(() => {
    const byWh = new Map();
    for (const row of report.results || []) {
      const key = row.warehouse_name || row.warehouse;
      if (!byWh.has(key)) {
        byWh.set(key, {
          warehouse:      row.warehouse,
          warehouse_code: row.warehouse_code,
          warehouse_name: row.warehouse_name,
          opening: 0, in: 0, out: 0, closing: 0, value: 0,
          rowsByProduct: new Map(),
        });
      }
      const g = byWh.get(key);
      g.opening += Number(row.opening_qty) || 0;
      g.in      += Number(row.in_qty)      || 0;
      g.out     += Number(row.out_qty)     || 0;
      g.closing += Number(row.closing_qty) || 0;
      g.value   += Number(row.closing_value) || 0;

      const pKey = row.product || row.product_sku || row.product_name;
      const existing = g.rowsByProduct.get(pKey);
      if (!existing) {
        g.rowsByProduct.set(pKey, {
          ...row,
          opening_qty:   Number(row.opening_qty) || 0,
          in_qty:        Number(row.in_qty)      || 0,
          out_qty:       Number(row.out_qty)     || 0,
          closing_qty:   Number(row.closing_qty) || 0,
          closing_value: Number(row.closing_value) || 0,
        });
      } else {
        existing.opening_qty   += Number(row.opening_qty) || 0;
        existing.in_qty        += Number(row.in_qty)      || 0;
        existing.out_qty       += Number(row.out_qty)     || 0;
        existing.closing_qty   += Number(row.closing_qty) || 0;
        existing.closing_value += Number(row.closing_value) || 0;
        // Keep the most recent transaction date across the merged rows.
        if (row.last_txn_at && (!existing.last_txn_at || row.last_txn_at > existing.last_txn_at)) {
          existing.last_txn_at = row.last_txn_at;
        }
      }
    }
    return Array.from(byWh.values())
      .map(g => ({ ...g, rows: Array.from(g.rowsByProduct.values()) }))
      .sort((a, b) => a.warehouse_name.localeCompare(b.warehouse_name));
  }, [report.results]);

  const applyFilters = (patch = {}) => {
    const next = { ...filters, ...patch, page: 1 };
    setFilters(next);
    fetchAll(next);
  };
  const setDatePreset = (preset) => {
    const def = DATE_PRESETS.find((p) => p.v === preset);
    if (!def) {
      applyFilters({ date_preset: 'custom', from_date: '', to_date: '' });
      return;
    }
    applyFilters({ date_preset: preset, from_date: def.from(), to_date: def.to() });
  };
  const setWarehouse = (id) => {
    // Clear the godown pick when warehouse changes — godown list
    // re-narrows to the new warehouse's godowns.
    applyFilters({ warehouse: id || '', godown: '' });
  };
  const setGodown = (id) => applyFilters({ godown: id || '' });
  const clearAll = () => {
    setFilters({ ...DEFAULT_FILTERS });
    setSearchDraft('');
    fetchAll({ ...DEFAULT_FILTERS });
  };
  const gotoPage = (page) => {
    const next = { ...filters, page };
    setFilters(next);
    fetchAll(next);
  };
  const toggleExpand = (whId) => {
    const next = new Set(expanded);
    if (next.has(whId)) next.delete(whId); else next.add(whId);
    setExpanded(next);
  };

  const totalPages = Math.max(1, Math.ceil((report.count || 0) / (filters.page_size || 50)));
  usePagerKeys({   // ← / → page the stock ledger (server-side)
    enabled: totalPages > 1,
    onPrev: () => gotoPage(Math.max(1, (filters.page || 1) - 1)),
    onNext: () => gotoPage(Math.min(totalPages, (filters.page || 1) + 1)),
  });
  const selectedWarehouseLabel = filters.warehouse
    ? warehouseOptions.find((o) => o.value === filters.warehouse)?.label || ''
    : '';
  const selectedGodownLabel = filters.godown
    ? godownOptions.find((o) => o.value === filters.godown)?.label || ''
    : '';

  // ── Stock import / export (common template) ───────────────────────────
  const fileRef = useRef(null);
  const [importing, setImporting] = useState(false);

  const downloadTemplate = async () => {
    try {
      const res = await apiClient.get('/api/inventory/adjustments/import-template/', { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = 'stock-import-template.xlsx'; a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Could not download the template.'); }
  };

  const onImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await apiClient.post('/api/inventory/adjustments/import/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const { created = 0, failed = 0, errors = [] } = res.data || {};
      if (failed || (errors && errors.length)) {
        const first = errors[0] || {};
        const detail = Object.entries(first.errors || {})
          .map(([f, m]) => `${f}: ${Array.isArray(m) ? m.join(', ') : (m && typeof m === 'object' ? JSON.stringify(m) : m)}`)
          .join(' · ');
        toast.error(`Import failed — row ${first.row}: ${detail || 'validation error'}. Nothing was imported.`,
          { duration: 8000 });
        if (import.meta.env.DEV) console.log('Stock import errors:', errors);
      } else {
        toast.success(`Imported ${created} stock row(s).`);
        fetchAll();
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed. Check the file and try again.');
    } finally { setImporting(false); }
  };

  const handleExport = async () => {
    try {
      // The on-screen table is server-paginated (50/page), so export the FULL
      // filtered set — walk every page with the active filters, not just the
      // page in view.
      const all = [];
      let page = 1;
      for (let i = 0; i < 200; i++) {  // hard cap guards against a runaway loop
        const params = buildParams(filters, { page, page_size: 1000 });
        const res = await apiClient.get('/api/inventory/stock-report/', { params });
        const results = res.data?.results || [];
        all.push(...results);
        const count = res.data?.count || 0;
        if (results.length === 0 || all.length >= count) break;
        page += 1;
      }
      if (!all.length) { toast('No stock to export.'); return; }
      const rows = all.map((r) => ({
        product_name: r.product_name || '',
        sku_code: r.product_sku || '',
        warehouse: r.warehouse_name || '',
        godown: r.godown_name || '',
        quantity: Number(r.closing_qty || 0),
        uom: r.product_uom || '',
      }));
      exportToExcel(rows, [
        { field: 'product_name', header: 'Product Name' },
        { field: 'sku_code', header: 'SKU Code' },
        { field: 'warehouse', header: 'Warehouse' },
        { field: 'godown', header: 'Godown' },
        { field: 'quantity', header: 'Quantity' },
        { field: 'uom', header: 'UOM' },
      ], 'stock-ledger', 'Stock Ledger');
    } catch {
      toast.error('Export failed');
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Stock Ledger"
        subtitle="Point-in-time stock report — opening, in, out, closing per warehouse + product."
        breadcrumbs={[{ label: 'Inventory', href: '/inventory' }, { label: 'Stock Ledger' }]}
      />

      {/* Stock import / export — common template: Product · SKU · Warehouse · Godown · Quantity · UOM */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button onClick={downloadTemplate}
          className="inline-flex items-center gap-2 px-3 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium">
          <FileDown size={16} /> Download Template
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={importing}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 text-sm font-medium disabled:opacity-50">
          <Upload size={16} /> {importing ? 'Importing…' : 'Import'}
        </button>
        <button onClick={handleExport}
          className="inline-flex items-center gap-2 px-3 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium">
          <Download size={16} /> Export
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onImportFile} style={{ display: 'none' }} />
      </div>

      {/* ── KPI Strip ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <KpiCard
          icon={Package} tone="indigo"
          label="Products"        value={fmtInt(kpis?.total_products)}
          sub={`${fmtInt(kpis?.products_with_stock)} with stock`}
        />
        <KpiCard
          icon={WarehouseIcon} tone="blue"
          label="Total Stock Qty" value={fmtQty(kpis?.total_stock_qty)}
        />
        <KpiCard
          icon={IndianRupee} tone="emerald"
          label="Stock Value"     value={fmtAmt(kpis?.total_stock_value)}
        />
        <KpiCard
          icon={AlertTriangle} tone="amber"
          label="Low Stock"
          value={fmtInt(kpis?.low_stock_count)}
          sub={`< ${fmtInt(kpis?.low_stock_threshold)} units`}
        />
        <KpiCard
          icon={AlertOctagon} tone="red"
          label="Negative Stock"  value={fmtInt(kpis?.negative_stock_count)}
          sub={`${fmtInt(kpis?.zero_stock_count)} at zero`}
        />
      </div>

      {/* ── Sticky filter bar ────────────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-slate-50/95 backdrop-blur border border-slate-200 rounded-2xl p-3 sm:p-4 mb-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          {/* Date pills */}
          <div className="flex flex-wrap items-center gap-1 pr-2 sm:border-r border-slate-200">
            {DATE_PRESETS.map((p) => (
              <button key={p.v} onClick={() => setDatePreset(p.v)}
                className={`px-2.5 py-1 text-xs rounded-full border transition ${filters.date_preset === p.v
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : 'bg-white border-slate-300 text-slate-700 hover:border-indigo-400'}`}>
                {p.label}
              </button>
            ))}
            <span className="text-[11px] text-slate-400 px-1 hidden lg:inline">Custom</span>
            {/* Visible From/To range — applies immediately on change (the
                Advanced copy only applied on blur, which read as "not
                reflecting" when a picked date didn't refetch). */}
            <CustomDatePicker value={filters.from_date}
              onChange={(e) => applyFilters({ from_date: e.target.value, date_preset: 'custom' })}
              className="px-2 py-1 text-xs rounded border border-slate-300" title="From date" />
            <span className="text-slate-400 text-xs">→</span>
            <CustomDatePicker value={filters.to_date}
              onChange={(e) => applyFilters({ to_date: e.target.value, date_preset: 'custom' })}
              className="px-2 py-1 text-xs rounded border border-slate-300" title="To date" />
          </div>

          {/* Warehouse — single select. Dedup by name: the master can
              hold the same warehouse name across multiple companies
              (e.g. two "Office" rows), and surfacing both makes the
              filter list noisy and ambiguous. Keep the first occurrence
              per name so the dropdown reads cleanly. */}
          <div className="relative inline-flex items-center">
            <WarehouseIcon size={13} className="absolute left-2.5 text-slate-400 pointer-events-none" />
            <CustomSelect value={filters.warehouse}
              onChange={(e) => setWarehouse(e.target.value)}
              className={`pl-7 pr-3 py-1.5 text-xs rounded-lg border min-w-[170px] appearance-none ${filters.warehouse
                ? 'border-indigo-400 bg-indigo-50 text-indigo-800'
                : 'border-slate-300 bg-white text-slate-700'}`}>
              <option value="">All Warehouses</option>
              {Array.from(
                new Map(warehouseOptions.map(o => [o.label, o])).values()
              ).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </CustomSelect>
          </div>

          {/* Godown — single select, narrows to the chosen warehouse. */}
          <div className="relative inline-flex items-center">
            <MapPin size={13} className="absolute left-2.5 text-slate-400 pointer-events-none" />
            <CustomSelect value={filters.godown}
              onChange={(e) => setGodown(e.target.value)}
              className={`pl-7 pr-3 py-1.5 text-xs rounded-lg border min-w-[160px] appearance-none ${filters.godown
                ? 'border-indigo-400 bg-indigo-50 text-indigo-800'
                : 'border-slate-300 bg-white text-slate-700'}`}>
              <option value="">All Godowns</option>
              {godownOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </CustomSelect>
          </div>

          {/* Product Type pills — Goods / Machinery / All Stockable.
              Services and Expense products never have inventory so
              they aren't selectable here. */}
          <div className="flex items-center gap-1 pl-1 border-l border-slate-200">
            {PRODUCT_TYPE_CHIPS.map((c) => (
              <button key={c.v || 'all'} onClick={() => applyFilters({ product_type: c.v })}
                className={`px-2.5 py-1 text-xs rounded-full border ${filters.product_type === c.v
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : 'bg-white border-slate-300 text-slate-700 hover:border-indigo-400'}`}>
                {c.label}
              </button>
            ))}
          </div>

          {/* Category */}
          <CustomSelect value={filters.category}
            onChange={(e) => applyFilters({ category: e.target.value })}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700 min-w-[160px]">
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </CustomSelect>

          {/* Search */}
          <div className="relative flex-1 min-w-[180px] max-w-md">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="search" value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyFilters({ search: searchDraft }); }}
              placeholder="Search product name or SKU…"
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white" />
          </div>

          {/* Advanced toggle */}
          <button onClick={() => setShowAdvanced((s) => !s)}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border ${showAdvanced ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-300 text-slate-700'}`}>
            <SlidersHorizontal size={13} /> Advanced
          </button>
          <button onClick={() => fetchAll(filters)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            aria-label="Refresh" title="Refresh">
            <RefreshCw size={13} />
          </button>
          {(filters.warehouse || filters.godown || filters.product_type || filters.category || filters.search || filters.stock_state) && (
            <button onClick={clearAll}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-red-50 hover:text-red-700 hover:border-red-300">
              <X size={13} /> Clear
            </button>
          )}
        </div>

        {/* Advanced row — currently: stock-state quick filters + custom date */}
        {showAdvanced && (
          <div className="mt-3 pt-3 border-t border-slate-200 flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-slate-500 uppercase tracking-wide pr-1">Stock State</span>
              {STOCK_STATE_CHIPS.map((c) => (
                <button key={c.v || 'all'} onClick={() => applyFilters({ stock_state: c.v })}
                  className={`px-2.5 py-1 text-xs rounded-full border ${filters.stock_state === c.v
                    ? `bg-${c.tone || 'slate'}-600 border-${c.tone || 'slate'}-600 text-white`
                    : 'bg-white border-slate-300 text-slate-700'}`}>
                  {c.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-[11px] text-slate-500 uppercase tracking-wide">Custom Range</span>
              <CustomDatePicker value={filters.from_date}
                onChange={(e) => applyFilters({ from_date: e.target.value, date_preset: 'custom' })}
                className="px-2 py-1 text-xs rounded border border-slate-300" />
              <span className="text-slate-400">→</span>
              <CustomDatePicker value={filters.to_date}
                onChange={(e) => applyFilters({ to_date: e.target.value, date_preset: 'custom' })}
                className="px-2 py-1 text-xs rounded border border-slate-300" />
            </div>
          </div>
        )}

        {/* Active filter chips */}
        {(selectedWarehouseLabel || selectedGodownLabel || filters.product_type || filters.category || filters.stock_state || filters.search) && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <Filter size={12} className="text-slate-400 ml-1" />
            {selectedWarehouseLabel && (
              <Chip label={selectedWarehouseLabel} onClear={() => setWarehouse('')} />
            )}
            {selectedGodownLabel && (
              <Chip label={selectedGodownLabel} onClear={() => setGodown('')} />
            )}
            {filters.product_type && (
              <Chip label={PRODUCT_TYPE_CHIPS.find((c) => c.v === filters.product_type)?.label || filters.product_type}
                onClear={() => applyFilters({ product_type: '' })} />
            )}
            {filters.category && (
              <Chip label={CATEGORY_OPTIONS.find((o) => o.v === filters.category)?.label || filters.category}
                onClear={() => applyFilters({ category: '' })} />
            )}
            {filters.stock_state && (
              <Chip label={STOCK_STATE_CHIPS.find((c) => c.v === filters.stock_state)?.label}
                onClear={() => applyFilters({ stock_state: '' })} />
            )}
            {filters.search && (
              <Chip label={`"${filters.search}"`} onClear={() => { setSearchDraft(''); applyFilters({ search: '' }); }} />
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Grouped table ────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="px-4 sm:px-5 py-16 text-center text-slate-500 text-sm">Loading stock report…</div>
        ) : grouped.length === 0 ? (
          <div className="px-4 sm:px-5 py-16 text-center text-slate-500 text-sm">
            No matching stock rows. Try widening the date range or clearing filters.
          </div>
        ) : (
          <div className="overflow-x-auto ios-scroll">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2.5 text-left">Warehouse / Product</th>
                  <th className="px-3 py-2.5 text-right min-w-[90px]">Opening</th>
                  <th className="px-3 py-2.5 text-right min-w-[80px]">In</th>
                  <th className="px-3 py-2.5 text-right min-w-[80px]">Out</th>
                  <th className="px-3 py-2.5 text-right min-w-[100px]">Closing</th>
                  <th className="px-3 py-2.5 text-right min-w-[110px]">Value</th>
                  {!isHidden('uom') && <th className="px-3 py-2.5 text-right min-w-[60px]">UOM</th>}
                  <th className="px-3 py-2.5 text-right min-w-[110px]">Last Txn</th>
                  <th className="px-3 py-2.5 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {grouped.map((g) => {
                  const open = expanded.has(g.warehouse);
                  return (
                    <Fragment key={`g-${g.warehouse}`}>
                      <tr
                        onClick={() => toggleExpand(g.warehouse)}
                        className="bg-indigo-50/40 border-b border-indigo-100 cursor-pointer hover:bg-indigo-50">
                        <td className="px-3 py-2.5 font-semibold text-slate-800">
                          <div className="inline-flex items-center gap-2">
                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <WarehouseIcon size={14} className="text-indigo-600" />
                            <span>{g.warehouse_name}</span>
                            <span className="text-[11px] text-slate-500 font-normal">
                              {g.rows.length} {g.rows.length === 1 ? 'product' : 'products'}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{fmtQty(g.opening)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{fmtQty(g.in)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-red-700">{fmtQty(g.out)}</td>
                        <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${g.closing < 0 ? 'text-red-700' : 'text-slate-800'}`}>{fmtQty(g.closing)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{fmtAmt(g.value)}</td>
                        {!isHidden('uom') && <td className="px-3 py-2.5"></td>}
                        <td className="px-3 py-2.5"></td>
                        <td className="px-3 py-2.5 text-right">
                          <button onClick={(e) => { e.stopPropagation(); navigate(`/inventory/stock-ledger/${g.warehouse}`); }}
                            aria-label="Open warehouse detail" title="Open warehouse detail"
                            className="text-indigo-600 hover:text-indigo-800">
                            <ArrowRight size={14} />
                          </button>
                        </td>
                      </tr>
                      {open && g.rows.map((row) => (
                        <tr key={`r-${row.warehouse}-${row.product}`}
                          className="border-b border-slate-100 hover:bg-slate-50/50">
                          <td className="px-3 py-2.5 pl-10">
                            <div className="font-medium text-slate-800 text-sm">{row.product_name}</div>
                            <div className="text-[11px] text-slate-400">{row.product_sku} · {row.category || '—'}</div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{fmtQty(row.opening_qty, row.product_uom)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{fmtQty(row.in_qty, row.product_uom)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-red-700">{fmtQty(row.out_qty, row.product_uom)}</td>
                          <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${Number(row.closing_qty) < 0 ? 'text-red-700' : 'text-slate-800'}`}>{fmtQty(row.closing_qty, row.product_uom)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{fmtAmt(row.closing_value)}</td>
                          {!isHidden('uom') && <td className="px-3 py-2.5 text-right text-[11px] text-slate-500">{row.product_uom || '—'}</td>}
                          <td className="px-3 py-2.5 text-right text-[11px] text-slate-500">{fmtDate(row.last_txn_at)}</td>
                          <td className="px-3 py-2.5 text-right">
                            <button onClick={() => navigate(`/inventory/stock-ledger/product-transactions?warehouse=${row.warehouse}&product=${row.product}`)}
                              aria-label="Open product transactions" title="Open product transactions"
                              className="text-slate-400 hover:text-indigo-600">
                              <ArrowRight size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination footer */}
        {report.count > filters.page_size && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-xs text-slate-600">
            <div>
              {((filters.page - 1) * filters.page_size) + 1}
              –{Math.min(filters.page * filters.page_size, report.count)} of {fmtInt(report.count)}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => gotoPage(filters.page - 1)} disabled={filters.page <= 1}
                className="px-3 py-1 rounded border border-slate-300 disabled:opacity-40">Prev</button>
              <span>Page {filters.page} / {totalPages}</span>
              <button onClick={() => gotoPage(filters.page + 1)} disabled={filters.page >= totalPages}
                className="px-3 py-1 rounded border border-slate-300 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </MainLayout>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function KpiCard({ icon: Icon, label, value, sub, tone = 'slate' }) {
  const toneMap = {
    slate:   'bg-slate-50 border-slate-200 text-slate-700',
    indigo:  'bg-indigo-50 border-indigo-200 text-indigo-700',
    blue:    'bg-blue-50 border-blue-200 text-blue-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    amber:   'bg-amber-50 border-amber-200 text-amber-700',
    red:     'bg-red-50 border-red-200 text-red-700',
  };
  return (
    <div className={`rounded-2xl border p-3 sm:p-4 ${toneMap[tone] || toneMap.slate}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] uppercase tracking-wide font-medium">{label}</span>
        {Icon && <Icon size={14} className="opacity-70" />}
      </div>
      <div className="text-lg sm:text-xl font-semibold leading-tight">{value ?? '—'}</div>
      {sub && <div className="text-[11px] opacity-70 mt-0.5">{sub}</div>}
    </div>
  );
}

function Chip({ label, onClear }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-[11px] text-slate-700">
      {label}
      <button onClick={onClear} aria-label="Remove filter" title="Remove filter" className="text-slate-500 hover:text-red-600">
        <X size={11} />
      </button>
    </span>
  );
}

