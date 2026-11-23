import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  RefreshCw, Loader2, Boxes, ArrowDownRight, ArrowUpRight,
  SlidersHorizontal, X, Plus, Trash2, AlertTriangle, ArrowLeft,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '../../../utils/formatters.js';
import useLookup from '../../../hooks/useLookup.js';

// Pivot view of Production Stock:
//   * three panes stacked top-to-bottom — Consumed (inputs, amber),
//     Produced/Received (outputs, emerald), Adjustments (opening
//     seeds + manual corrections, slate).
//   * each pane is a horizontally-scrolling table: Product (sticky
//     left) → Opening (sticky left) → one column per day in the
//     window → Closing (sticky right) → Row Total (sticky right).
//   * clicking a day cell opens a drill-down modal listing the raw
//     movement rows behind that (product, godown, day).
// Batch traceability lives OUTSIDE the cells — the row header shows a
// discreet "N batches" chip when a product spans multiple batches;
// the drill-down modal carries the batch numbers, timestamps and
// source-document refs.

const labelClass = 'block text-xs font-medium text-slate-600 mb-1';
const isoToday = () => new Date().toISOString().slice(0, 10);
const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const fmt3 = (n) => {
  const v = Number(n || 0);
  if (v === 0) return '0';
  return v.toLocaleString('en-IN', { maximumFractionDigits: 3 });
};
const fmt0 = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

// Header helpers — every day column gets a two-line label
// (weekday abbreviation + zero-padded day number), a subtle stripe
// on odd-numbered days for scan rhythm, and a thin left rule on
// Mondays so week boundaries are visible at a glance.
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const parseIsoLocal = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const isMonday = (iso) => parseIsoLocal(iso).getDay() === 1;
const isOddDay = (iso) => Number(iso.slice(-2)) % 2 === 1;
const dayHeader = (iso) => {
  const d = parseIsoLocal(iso);
  return { wk: WEEKDAY[d.getDay()], num: String(d.getDate()).padStart(2, '0') };
};

// Pane tone table — background/text for the pane header + the
// primary cell colour. Adjustments intentionally use neutral slate
// so they don't compete with the two accented panes above.
const TONE = {
  emerald: { headBg: 'bg-emerald-50', headText: 'text-emerald-800', cell: 'text-emerald-700', Icon: ArrowDownRight },
  amber:   { headBg: 'bg-amber-50',   headText: 'text-amber-800',   cell: 'text-amber-700',   Icon: ArrowUpRight },
  slate:   { headBg: 'bg-slate-100',  headText: 'text-slate-700',   cell: 'text-slate-700',   Icon: SlidersHorizontal },
};

// Sticky-column widths (kept as constants so header/body/footer
// stay in lockstep and every calculated offset lines up).
const W_PROD    = 240;
const W_OPEN    = 100;
const W_CLOSE   = 100;
const W_TOTAL   = 130;
const W_DAY     = 72;

export default function ProductionStockPage() {
  const navigate = useNavigate();
  const [warehouseId, setWarehouseId] = useState('');
  const [godownId, setGodownId] = useState('');
  const [productId, setProductId] = useState('');
  // Default window: last 30 days (matches previous version's behaviour
  // so existing users see a familiar span the first time this loads).
  const [dateFrom, setDateFrom] = useState(() => isoDaysAgo(30));
  const [dateTo, setDateTo] = useState(isoToday());
  // RANGE → From + To inputs. SINGLE → one Date input that drives
  // both bounds (pivot renders exactly one day column). Switching to
  // SINGLE snaps To = From so the fetch fires immediately without
  // waiting on a second edit.
  const [dateMode, setDateMode] = useState('RANGE');
  const setSingleDate = (v) => { setDateFrom(v); setDateTo(v); };
  const [view, setView] = useState('BOTH'); // BOTH | CONSUMED | PRODUCED | ADJUSTMENTS
  const [data, setData] = useState({ days: [], consumed: [], produced: [], adjustments: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drillDown, setDrillDown] = useState(null);

  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  const warehouses = useMemo(() => {
    // De-dup same-named warehouses across companies — the pivot
    // filters by NAME on the backend so keeping duplicates would
    // just clutter the picker.
    const seen = new Set();
    const out = [];
    (warehousesRaw || []).forEach((w) => {
      const k = (w.name || '').trim().toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ value: w.id, label: w.name });
    });
    return out;
  }, [warehousesRaw]);

  const { raw: godownsRaw } = useLookup(
    warehouseId ? `/api/godowns/?warehouse=${warehouseId}` : '/api/godowns/'
  );
  const godowns = useMemo(() =>
    (godownsRaw || []).map((g) => ({ value: g.id, label: g.godown_name || g.name || 'Godown' })),
  [godownsRaw]);

  const { raw: catalogRaw } = useLookup('/api/purchase/items/');
  const products = useMemo(() =>
    (catalogRaw || [])
      .filter((it) => it.item_type === 'PRODUCT')
      .map((it) => ({ value: it.item_id, label: `${it.item_name}${it.item_code ? `  (${it.item_code})` : ''}` }))
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())),
  [catalogRaw]);

  const load = async () => {
    if (!dateFrom || !dateTo) return;
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (warehouseId) params.set('warehouse', warehouseId);
      if (godownId) params.set('godown', godownId);
      if (productId) params.set('product', productId);
      params.set('date_from', dateFrom);
      params.set('date_to', dateTo);
      const res = await apiClient.get(`/api/inventory/production-stock/pivot/?${params.toString()}`);
      setData(res.data || { days: [], consumed: [], produced: [], adjustments: [] });
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [warehouseId, godownId, productId, dateFrom, dateTo]);

  const showConsumed    = view === 'BOTH' || view === 'CONSUMED';
  const showProduced    = view === 'BOTH' || view === 'PRODUCED';
  const showAdjustments = view === 'BOTH' || view === 'ADJUSTMENTS';
  const totalRows =
    (data.consumed?.length || 0) +
    (data.produced?.length || 0) +
    (data.adjustments?.length || 0);

  return (
    <MainLayout>
      <PageHeader
        title="Production Stock"
        subtitle="Pivot view — Opening + daily activity + Closing per product, across the picked window."
        breadcrumbs={[{ label: 'Inventory' }, { label: 'Production Stock' }]}
        actions={{
          right: (
            <button
              type="button"
              onClick={() => navigate('/inventory/production-stock/adjust')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700"
              title="Post an opening balance seed or a manual adjustment"
            >
              <Plus size={14} /> Adjust stock
            </button>
          ),
        }}
      />

      {/* Filter bar — 2-col grid on phones so each control gets half
          the width, 3-col small tablet, 4-col big tablet. The mode +
          view toggles + clear button row stack below on mobile. */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
          <div className="min-w-0">
            <label className={labelClass}>Warehouse</label>
            <CustomSelect value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setGodownId(''); }}>
              <option value="">All Warehouses</option>
              {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
            </CustomSelect>
          </div>
          <div className="min-w-0">
            <label className={labelClass}>Godown</label>
            <CustomSelect value={godownId} onChange={(e) => setGodownId(e.target.value)}>
              <option value="">All Godowns</option>
              {godowns.map((g) => (<option key={g.value} value={g.value}>{g.label}</option>))}
            </CustomSelect>
          </div>
          <div className="min-w-0 col-span-2 sm:col-span-1">
            <label className={labelClass}>Product</label>
            <CustomSelect value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">All Products</option>
              {products.map((p) => (<option key={p.value} value={p.value}>{p.label}</option>))}
            </CustomSelect>
          </div>
          {dateMode === 'RANGE' ? (
            <>
              <div className="min-w-0">
                <label className={labelClass}>From date</label>
                <CustomDatePicker value={dateFrom} onChange={(e) => setDateFrom(e?.target?.value ?? '')} />
              </div>
              <div className="min-w-0">
                <label className={labelClass}>To date</label>
                <CustomDatePicker value={dateTo} onChange={(e) => setDateTo(e?.target?.value ?? '')} />
              </div>
            </>
          ) : (
            <div className="min-w-0 col-span-2 sm:col-span-1">
              <label className={labelClass}>Date</label>
              <CustomDatePicker
                value={dateFrom}
                onChange={(e) => setSingleDate(e?.target?.value ?? '')}
              />
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex p-0.5 rounded-lg bg-slate-100 gap-0.5">
            {[
              { v: 'RANGE',  label: 'Range' },
              { v: 'SINGLE', label: 'Single day' },
            ].map((m) => (
              <button
                key={m.v}
                type="button"
                onClick={() => {
                  setDateMode(m.v);
                  if (m.v === 'SINGLE') setSingleDate(dateFrom || isoToday());
                }}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-md ${dateMode === m.v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="inline-flex p-0.5 rounded-lg bg-slate-100 gap-0.5 overflow-x-auto max-w-full">
            {['BOTH', 'CONSUMED', 'PRODUCED', 'ADJUSTMENTS'].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${view === v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
              >
                {v === 'BOTH' ? 'All' : v[0] + v.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          {(warehouseId || godownId || productId) && (
            <button
              onClick={() => { setWarehouseId(''); setGodownId(''); setProductId(''); }}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 rounded-lg hover:bg-slate-100"
              title="Clear warehouse / godown / product filters"
            >
              Clear filters
            </button>
          )}
          <div className="flex-1 hidden sm:block" />
          <button
            onClick={load}
            disabled={loading}
            className="ml-auto sm:ml-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
          >
            {loading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-slate-500">
          <Loader2 className="inline animate-spin mr-2" size={18} /> Loading…
        </div>
      ) : error ? (
        <div className="text-center py-8 text-red-500">{error}</div>
      ) : totalRows === 0 ? (
        <div className="text-center py-16 text-slate-500 bg-white rounded-lg border border-slate-200">
          <Boxes size={36} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm">No Production Stock activity in the selected window.</p>
          <p className="text-xs mt-1 text-slate-400">
            Widen the date range or clear filters — rows appear as Purchase Receipts get approved
            and Production Entries consume / produce material.
          </p>
        </div>
      ) : (
        <div className="space-y-4 sm:space-y-5">
          {showConsumed && (
            <PivotPane
              title="Consumed (used as raw material)"
              subtitle="Raw materials that went OUT as inputs to production entries"
              rows={data.consumed}
              days={data.days}
              tone="amber"
              onCellClick={(row, day) => setDrillDown({ row, day, pane: 'consumed' })}
            />
          )}
          {showProduced && (
            <PivotPane
              title="Produced / Received"
              subtitle="Purchase receipts + production outputs (semi-finished consumption shown as −Used)"
              rows={data.produced}
              days={data.days}
              tone="emerald"
              onCellClick={(row, day) => setDrillDown({ row, day, pane: 'produced' })}
            />
          )}
          {showAdjustments && (
            <PivotPane
              title="Adjustments"
              subtitle="Opening balance seeds + manual corrections (signed by direction)"
              rows={data.adjustments}
              days={data.days}
              tone="slate"
              onCellClick={(row, day) => setDrillDown({ row, day, pane: 'adjustments' })}
              headRight={(
                <button
                  type="button"
                  onClick={() => navigate('/inventory/production-stock/adjust')}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-white text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50"
                >
                  <Plus size={12} /> New adjustment
                </button>
              )}
            />
          )}
        </div>
      )}

      {drillDown && (
        <DrillDownModal
          row={drillDown.row}
          day={drillDown.day}
          pane={drillDown.pane}
          onClose={() => setDrillDown(null)}
          onDeleted={() => load()}
        />
      )}
    </MainLayout>
  );
}

// ─────────────────────────────────────────────────────────────────────
// One pivot pane — a bordered card with a coloured head and a
// horizontally-scrolling table underneath. Every column is one of:
//   - sticky Product (240px, always on the left edge)
//   - sticky Opening (100px, offset by W_PROD)
//   - N day columns (72px each) — this is what scrolls
//   - sticky Closing (100px, offset by W_TOTAL)
//   - sticky Row Total (130px, always on the right edge)
// The bottom footer is a Column Total per day + a Grand total.
// ─────────────────────────────────────────────────────────────────────

function PivotPane({ title, subtitle, rows, days, tone, onCellClick, headRight }) {
  // ColumnTotals + Grand computed unconditionally so the hook order
  // stays stable regardless of whether the pane is empty.
  const colTotals = useMemo(() => {
    const map = {};
    days.forEach((d) => {
      map[d] = { kg: 0, ltr: 0, count: 0, used_kg: 0, used_ltr: 0, used_count: 0 };
    });
    (rows || []).forEach((r) => {
      Object.entries(r.days || {}).forEach(([d, cell]) => {
        if (!map[d]) return;
        map[d].kg    += Number(cell.kg || 0);
        map[d].ltr   += Number(cell.ltr || 0);
        map[d].count += Number(cell.count || 0);
        map[d].used_kg    += Number(cell.used_kg || 0);
        map[d].used_ltr   += Number(cell.used_ltr || 0);
        map[d].used_count += Number(cell.used_count || 0);
      });
    });
    return map;
  }, [rows, days]);

  const grand = useMemo(() => {
    const g = { kg: 0, ltr: 0, count: 0, used_kg: 0, used_ltr: 0, used_count: 0 };
    (rows || []).forEach((r) => {
      g.kg    += Number(r.total?.kg || 0);
      g.ltr   += Number(r.total?.ltr || 0);
      g.count += Number(r.total?.count || 0);
      g.used_kg    += Number(r.total?.used_kg || 0);
      g.used_ltr   += Number(r.total?.used_ltr || 0);
      g.used_count += Number(r.total?.used_count || 0);
    });
    return g;
  }, [rows]);

  if (!rows || rows.length === 0) {
    return (
      <section>
        <PaneHead title={title} subtitle={subtitle} count="0 products" tone={tone} headRight={headRight} />
        <div className="text-center py-8 text-xs text-slate-400 italic bg-white rounded-b-lg border border-t-0 border-slate-200">
          Nothing to show for this pane in the selected window.
        </div>
      </section>
    );
  }

  return (
    <section>
      <PaneHead
        title={title}
        subtitle={subtitle}
        count={`${rows.length} product${rows.length === 1 ? '' : 's'} · ${days.length} day${days.length === 1 ? '' : 's'}`}
        tone={tone}
        headRight={headRight}
      />
      <div className="bg-white border border-slate-200 border-t-0 rounded-b-lg overflow-hidden">
        {/* Scroll hint — the point of the view IS the day columns.
            Below md, only Product stays pinned so Opening / Closing /
            Row Total scroll with the days (avoids sticky-column
            collision on narrow viewports). On md+ all four columns
            are sticky so the ledger reads Opening | days | Closing |
            Total without any column ever slipping mid-scroll. */}
        <div className="md:hidden px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
          <span>Product stays pinned — swipe to scroll through days.</span>
          <span aria-hidden="true">→</span>
        </div>
        <div className="overflow-x-auto">
          <table
            className="text-xs"
            style={{
              borderCollapse: 'separate',
              borderSpacing: 0,
              fontVariantNumeric: 'tabular-nums',
              // Force the table to its intrinsic width so day cells
              // always render at W_DAY and horizontal scrolling kicks
              // in — otherwise `w-full` shrinks the table to viewport
              // width and squeezes day cells behind sticky columns.
              minWidth: W_PROD + W_OPEN + days.length * W_DAY + W_CLOSE + W_TOTAL,
              width: '100%',
            }}
          >
            <thead>
              <tr>
                <th
                  className="text-left px-3 py-2 font-medium text-slate-500 uppercase tracking-wide text-[10px] border-b border-slate-200 sticky bg-white z-30"
                  style={{ left: 0, width: W_PROD, minWidth: W_PROD }}
                >
                  Product
                </th>
                <th
                  className="text-right px-2 py-2 font-medium text-slate-500 uppercase tracking-wide text-[10px] border-b border-l border-slate-200 md:sticky bg-slate-50 z-30"
                  style={{ left: W_PROD, width: W_OPEN, minWidth: W_OPEN }}
                >
                  Opening
                </th>
                {days.map((d) => {
                  const dh = dayHeader(d);
                  const stripe = isOddDay(d);
                  const wkStart = isMonday(d);
                  return (
                    <th
                      key={d}
                      className={`text-right px-2 py-2 font-medium text-slate-500 uppercase tracking-wide text-[10px] border-b border-slate-200 ${stripe ? 'bg-slate-50' : 'bg-white'} ${wkStart ? 'border-l border-slate-200' : ''}`}
                      style={{ width: W_DAY, minWidth: W_DAY }}
                    >
                      <div className="text-[9px] opacity-70">{dh.wk}</div>
                      <div className="text-[11px] font-semibold text-slate-800">{dh.num}</div>
                    </th>
                  );
                })}
                <th
                  className="text-right px-2 py-2 font-medium text-slate-500 uppercase tracking-wide text-[10px] border-b border-l-2 border-slate-300 md:sticky bg-slate-50 z-30"
                  style={{ right: W_TOTAL, width: W_CLOSE, minWidth: W_CLOSE }}
                >
                  Closing
                </th>
                <th
                  className="text-right px-2 py-2 font-medium text-slate-500 uppercase tracking-wide text-[10px] border-b border-l border-slate-200 md:sticky bg-slate-100 z-30"
                  style={{ right: 0, width: W_TOTAL, minWidth: W_TOTAL }}
                >
                  Row Total
                </th>
              </tr>
            </thead>

            <tbody>
              {rows.map((r) => (
                <PivotRow
                  key={`${r.godown_id}-${r.product_id}`}
                  row={r}
                  days={days}
                  tone={tone}
                  onCellClick={onCellClick}
                />
              ))}
            </tbody>

            <tfoot>
              <tr>
                <td
                  className="text-left px-3 py-3 text-[10px] uppercase tracking-wide text-slate-500 font-semibold border-t-2 border-slate-300 sticky bg-slate-100 z-30"
                  style={{ left: 0, width: W_PROD, minWidth: W_PROD }}
                >
                  Column Total
                </td>
                <td
                  className="text-right px-2 py-3 border-t-2 border-l border-slate-300 md:sticky bg-slate-100 z-30"
                  style={{ left: W_PROD, width: W_OPEN, minWidth: W_OPEN }}
                />
                {days.map((d) => {
                  const ct = colTotals[d];
                  const stripe = isOddDay(d);
                  const wkStart = isMonday(d);
                  return (
                    <td
                      key={d}
                      className={`text-right px-2 py-3 border-t-2 border-slate-300 ${stripe ? 'bg-slate-100' : 'bg-slate-50'} ${wkStart ? 'border-l border-slate-200' : ''}`}
                      style={{ width: W_DAY, minWidth: W_DAY }}
                    >
                      <ColTotalCell ct={ct} tone={tone} />
                    </td>
                  );
                })}
                <td
                  className="text-right px-2 py-3 border-t-2 border-l-2 border-slate-300 md:sticky bg-slate-100 z-30"
                  style={{ right: W_TOTAL, width: W_CLOSE, minWidth: W_CLOSE }}
                />
                <td
                  className="text-right px-2 py-3 border-t-2 border-l border-slate-300 md:sticky bg-slate-200 z-30 font-semibold"
                  style={{ right: 0, width: W_TOTAL, minWidth: W_TOTAL }}
                >
                  <TotalStack t={grand} tone={tone} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </section>
  );
}

function PaneHead({ title, subtitle, count, tone, headRight }) {
  const t = TONE[tone] || TONE.slate;
  const Icon = t.Icon;
  return (
    <div className={`p-3 rounded-t-lg ${t.headBg} ${t.headText} flex items-center gap-2 border border-slate-200 border-b-0`}>
      <Icon size={18} />
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-[11px] opacity-80">{subtitle}</p>
      </div>
      <span className="ml-auto text-xs font-medium opacity-80">{count}</span>
      {headRight}
    </div>
  );
}

function PivotRow({ row, days, tone, onCellClick }) {
  const isProdPane = tone === 'emerald';
  const batchChip = (() => {
    const bs = row.batches || [];
    if (bs.length === 0) return null;
    if (bs.length === 1) {
      return (
        <span className="inline-block px-1.5 py-0.5 rounded text-[9px] bg-slate-100 text-slate-600 font-mono">
          {bs[0]}
        </span>
      );
    }
    return (
      <span
        className="inline-block px-1.5 py-0.5 rounded text-[9px] bg-slate-100 text-slate-600"
        title={bs.join(', ')}
      >
        {bs.length} batches
      </span>
    );
  })();

  return (
    <tr className="group">
      <td
        className="text-left px-0 py-0 sticky bg-white z-20 border-b border-slate-100"
        style={{ left: 0, width: W_PROD, minWidth: W_PROD }}
      >
        {/* Row-scoped drill-down: clicking the Product cell opens the
            same modal as a day cell, but with day=null so every
            movement for this (product, godown) in the window shows —
            not just one day. Trash + correction affordances live in
            the modal, so this is the entry point for delete/correct
            when the operator doesn't know which specific day to click. */}
        <button
          type="button"
          onClick={() => onCellClick && onCellClick(row, null)}
          className="w-full text-left px-3 py-2 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
          title="Click to view every movement for this product/godown in the window (delete / correction available inside)."
        >
          <div className="flex items-center flex-wrap gap-1">
            <span className="font-medium text-slate-800 truncate group-hover:text-primary-700">
              {row.product_name}
            </span>
            {row.product_code && <span className="text-[10px] text-slate-400">{row.product_code}</span>}
            {row.sg_applicable && (
              <span className="inline-block px-1.5 py-0.5 rounded text-[9px] bg-amber-100 text-amber-800">SG</span>
            )}
            {batchChip}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">
            {row.godown_name}{row.warehouse_name ? ` · ${row.warehouse_name}` : ''}
          </div>
        </button>
      </td>

      <td
        className="text-right px-2 py-2 md:sticky bg-slate-50 z-20 border-b border-l border-slate-100"
        style={{ left: W_PROD, width: W_OPEN, minWidth: W_OPEN }}
      >
        <QtyStack v={row.opening} muted />
      </td>

      {days.map((d) => {
        const cell = row.days?.[d];
        const stripe = isOddDay(d);
        const wkStart = isMonday(d);
        return (
          <td
            key={d}
            className={`text-right px-2 py-2 border-b border-slate-100 ${stripe ? 'bg-slate-50' : 'bg-white'} ${wkStart ? 'border-l border-slate-200' : ''}`}
            style={{ width: W_DAY, minWidth: W_DAY }}
          >
            {cell ? (
              <button
                type="button"
                onClick={() => onCellClick && onCellClick(row, d)}
                className="w-full text-right hover:bg-slate-100 rounded px-1 py-0.5 -mx-1 -my-0.5"
              >
                <CellContent cell={cell} tone={tone} isProdPane={isProdPane} />
              </button>
            ) : (
              <span className="text-slate-300">—</span>
            )}
          </td>
        );
      })}

      <td
        className="text-right px-2 py-2 md:sticky bg-slate-50 z-20 border-b border-l-2 border-slate-300"
        style={{ right: W_TOTAL, width: W_CLOSE, minWidth: W_CLOSE }}
      >
        <QtyStack v={row.closing} />
      </td>
      <td
        className="text-right px-2 py-2 md:sticky bg-slate-100 z-20 border-b border-l border-slate-200 font-semibold"
        style={{ right: 0, width: W_TOTAL, minWidth: W_TOTAL }}
      >
        <TotalStack t={row.total} tone={tone} />
      </td>
    </tr>
  );
}

// One activity cell — the tone drives the primary colour, and the
// Produced pane additionally renders a small amber "−used" sub-line
// when the same product was drawn as a semi-finished input the same
// day (e.g. Humic Liquid produced then partly consumed for granules).
function CellContent({ cell, tone, isProdPane }) {
  const t = TONE[tone] || TONE.slate;
  const bits = [];
  if (Number(cell.kg)    !== 0) bits.push(<QtyLine key="kg"  v={cell.kg}    u="kg"  cls={t.cell} />);
  if (Number(cell.ltr)   !== 0) bits.push(<QtyLine key="ltr" v={cell.ltr}   u="L"   cls={t.cell} />);
  if (Number(cell.count) !== 0) bits.push(<QtyLine key="ct"  v={cell.count} u="pcs" cls={t.cell} isCount />);
  if (isProdPane) {
    if (Number(cell.used_kg)    > 0) bits.push(<QtyLine key="ukg"  v={-Math.abs(Number(cell.used_kg))}    u="kg"  cls="text-amber-700" />);
    if (Number(cell.used_ltr)   > 0) bits.push(<QtyLine key="ultr" v={-Math.abs(Number(cell.used_ltr))}   u="L"   cls="text-amber-700" />);
    if (Number(cell.used_count) > 0) bits.push(<QtyLine key="uct"  v={-Math.abs(Number(cell.used_count))} u="pcs" cls="text-amber-700" isCount />);
  }
  return bits.length
    ? <div className="flex flex-col items-end gap-0.5">{bits}</div>
    : <span className="text-slate-300">—</span>;
}

function QtyLine({ v, u, cls, isCount }) {
  const val = Number(v || 0);
  const shown = isCount ? fmt0(Math.abs(val)) : fmt3(Math.abs(val));
  const sign = val < 0 ? '−' : '';
  return (
    <span className={`text-[11px] leading-tight ${cls}`}>
      <span className="font-medium">{sign}{shown}</span>{' '}
      <span className="text-slate-400 text-[9px]">{u}</span>
    </span>
  );
}

function QtyStack({ v, muted }) {
  if (!v) return <span className="text-slate-300">—</span>;
  const bits = [];
  if (Number(v.kg)    !== 0) bits.push({ q: fmt3(Math.abs(v.kg)),    sign: Number(v.kg)    < 0 ? '−' : '', u: 'kg' });
  if (Number(v.ltr)   !== 0) bits.push({ q: fmt3(Math.abs(v.ltr)),   sign: Number(v.ltr)   < 0 ? '−' : '', u: 'L' });
  if (Number(v.count) !== 0) bits.push({ q: fmt0(Math.abs(v.count)), sign: Number(v.count) < 0 ? '−' : '', u: 'pcs' });
  if (!bits.length) return <span className={muted ? 'text-slate-400' : 'text-slate-400'}>0</span>;
  return (
    <div className="flex flex-col items-end gap-0.5">
      {bits.map((b, i) => (
        <span
          key={i}
          className={`text-[11px] leading-tight ${muted ? 'text-slate-500' : 'text-slate-800'}`}
        >
          <span className="font-medium">{b.sign}{b.q}</span>{' '}
          <span className="text-slate-400 text-[9px]">{b.u}</span>
        </span>
      ))}
    </div>
  );
}

// Row / Grand total block — primary values in the pane's tone, with
// a divided sub-block underneath for the semi-finished −used lines
// when present. Signs matter: adjustments' totals can be negative,
// so we always render the absolute value + explicit sign.
function TotalStack({ t, tone }) {
  if (!t) return <span className="text-slate-300">—</span>;
  const c = TONE[tone] || TONE.slate;
  const rows = [];
  if (Number(t.kg)    !== 0) rows.push({ q: fmt3(Math.abs(t.kg)),    sign: Number(t.kg)    < 0 ? '−' : '', u: 'kg' });
  if (Number(t.ltr)   !== 0) rows.push({ q: fmt3(Math.abs(t.ltr)),   sign: Number(t.ltr)   < 0 ? '−' : '', u: 'L' });
  if (Number(t.count) !== 0) rows.push({ q: fmt0(Math.abs(t.count)), sign: Number(t.count) < 0 ? '−' : '', u: 'pcs' });
  const hasUsed = tone === 'emerald' && (
    Number(t.used_kg) > 0 || Number(t.used_ltr) > 0 || Number(t.used_count) > 0
  );
  if (!rows.length && !hasUsed) return <span className="text-slate-300">—</span>;
  return (
    <div className="flex flex-col items-end gap-0.5">
      {rows.map((r, i) => (
        <span key={i} className={`text-[11px] leading-tight ${c.cell}`}>
          <span className="font-semibold">{r.sign}{r.q}</span>{' '}
          <span className="text-slate-400 text-[9px] font-normal">{r.u}</span>
        </span>
      ))}
      {hasUsed && (
        <div className="pt-0.5 mt-0.5 border-t border-slate-200 flex flex-col items-end gap-0.5 w-full">
          {Number(t.used_kg)    > 0 && <span className="text-[10px] text-amber-700">−{fmt3(t.used_kg)}  <span className="text-slate-400 text-[9px]">kg</span></span>}
          {Number(t.used_ltr)   > 0 && <span className="text-[10px] text-amber-700">−{fmt3(t.used_ltr)}  <span className="text-slate-400 text-[9px]">L</span></span>}
          {Number(t.used_count) > 0 && <span className="text-[10px] text-amber-700">−{fmt0(t.used_count)} <span className="text-slate-400 text-[9px]">pcs</span></span>}
        </div>
      )}
    </div>
  );
}

function ColTotalCell({ ct, tone }) {
  if (!ct) return <span className="text-slate-300">—</span>;
  const c = TONE[tone] || TONE.slate;
  const rows = [];
  if (Number(ct.kg)    !== 0) rows.push({ q: fmt3(Math.abs(ct.kg)),    sign: Number(ct.kg)    < 0 ? '−' : '', u: 'kg' });
  if (Number(ct.ltr)   !== 0) rows.push({ q: fmt3(Math.abs(ct.ltr)),   sign: Number(ct.ltr)   < 0 ? '−' : '', u: 'L' });
  if (Number(ct.count) !== 0) rows.push({ q: fmt0(Math.abs(ct.count)), sign: Number(ct.count) < 0 ? '−' : '', u: 'pcs' });
  const hasUsed = tone === 'emerald' && (
    Number(ct.used_kg) > 0 || Number(ct.used_ltr) > 0 || Number(ct.used_count) > 0
  );
  if (!rows.length && !hasUsed) return <span className="text-slate-300">—</span>;
  return (
    <div className="flex flex-col items-end gap-0.5">
      {rows.map((r, i) => (
        <span key={i} className={`text-[11px] leading-tight font-semibold ${c.cell}`}>
          {r.sign}{r.q}{' '}
          <span className="text-slate-400 text-[9px] font-normal">{r.u}</span>
        </span>
      ))}
      {hasUsed && (
        <>
          {Number(ct.used_kg)    > 0 && <span className="text-[10px] text-amber-700">−{fmt3(ct.used_kg)}  <span className="text-slate-400 text-[9px]">kg</span></span>}
          {Number(ct.used_ltr)   > 0 && <span className="text-[10px] text-amber-700">−{fmt3(ct.used_ltr)}  <span className="text-slate-400 text-[9px]">L</span></span>}
          {Number(ct.used_count) > 0 && <span className="text-[10px] text-amber-700">−{fmt0(ct.used_count)} <span className="text-slate-400 text-[9px]">pcs</span></span>}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Drill-down modal — shows the raw movement rows behind one clicked
// (product, godown, day) cell. Reads from the existing list endpoint
// on ProductionStockMovementViewSet and filters client-side by the
// pane-specific source_type so the modal contents match the pivot cell.
// ─────────────────────────────────────────────────────────────────────

function DrillDownModal({ row, day, pane, onClose, onDeleted }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Two-stage delete flow. `stage` is either null (browsing rows) or
  // an object { movement, preview, previewLoading, previewError,
  // reason, deleting } representing the row being confirmed.
  const [stage, setStage] = useState(null);

  const fetchRows = () => {
    setLoading(true); setError(null);
    const params = new URLSearchParams({
      product: row.product_id,
      warehouse: row.warehouse_id,
      godown: row.godown_id,
      page_size: '200',
    });
    if (day) {
      params.set('date_from', day);
      params.set('date_to', day);
    }
    return apiClient.get(`/api/inventory/production-stock/?${params.toString()}`)
      .then((res) => {
        let all = res.data?.results || res.data || [];
        if (day) all = all.filter((m) => (m.movement_date || '') === day);
        if (pane === 'consumed') {
          all = all.filter((m) => m.source_type === 'PRODUCTION_ENTRY_INPUT');
        } else if (pane === 'produced') {
          all = all.filter((m) => m.source_type === 'PRODUCTION_ENTRY_OUTPUT' || m.source_type === 'PURCHASE_RECEIPT');
        } else if (pane === 'adjustments') {
          all = all.filter((m) => m.source_type === 'OPENING' || m.source_type === 'ADJUSTMENT');
        }
        setRows(all);
      })
      .catch((err) => setError(getApiErrorMessage(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.product_id, row.warehouse_id, row.godown_id, day, pane]);

  // Trash click: fetch delete-preview so the confirmation panel has
  // the safety verdict + before/after closing balances. The panel
  // decides whether to show a Delete button or a "Post correction"
  // hand-off based on preview.safe_to_delete.
  const openDeleteStage = async (m) => {
    setStage({ movement: m, preview: null, previewLoading: true, previewError: null, reason: '', deleting: false });
    try {
      const res = await apiClient.get(`/api/inventory/production-stock/${m.id}/delete-preview/`);
      setStage((s) => (s && s.movement.id === m.id
        ? { ...s, preview: res.data, previewLoading: false }
        : s));
    } catch (err) {
      setStage((s) => (s && s.movement.id === m.id
        ? { ...s, previewLoading: false, previewError: getApiErrorMessage(err) }
        : s));
    }
  };

  const doDelete = async () => {
    if (!stage || !stage.preview?.safe_to_delete) return;
    setStage((s) => ({ ...s, deleting: true }));
    try {
      await apiClient.post(
        `/api/inventory/production-stock/${stage.movement.id}/soft-delete/`,
        { reason: stage.reason || '' },
      );
      toast.success('Entry deleted. Closing balance updated.');
      setStage(null);
      // Reload movement list AND parent pivot so numbers realign.
      await fetchRows();
      if (onDeleted) onDeleted();
    } catch (err) {
      setStage((s) => (s ? { ...s, deleting: false } : null));
      toast.error(getApiErrorMessage(err));
    }
  };

  const goCorrect = () => {
    if (!stage) return;
    navigate(`/inventory/production-stock/adjust?correct_from=${stage.movement.id}`);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[85dvh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-200 flex items-start justify-between">
          <div className="flex items-center gap-2">
            {stage && (
              <button
                onClick={() => setStage(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
                title="Back to movement list"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <div>
              <h3 className="text-sm font-semibold text-slate-800">
                {row.product_name}
                {row.product_code && <span className="ml-2 text-xs text-slate-400">{row.product_code}</span>}
              </h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {row.godown_name}{row.warehouse_name ? ` · ${row.warehouse_name}` : ''}
                {day
                  ? ` · ${formatDate(day)}`
                  : ' · all movements (any date)'}
                <span className="ml-2 uppercase tracking-wide text-[10px] text-slate-400">
                  {stage ? 'Confirm delete' : pane}
                </span>
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-auto p-4 flex-1">
          {stage ? (
            <DeleteConfirmPanel
              stage={stage}
              onReasonChange={(v) => setStage((s) => ({ ...s, reason: v }))}
              onCancel={() => setStage(null)}
              onDelete={doDelete}
              onCorrect={goCorrect}
            />
          ) : loading ? (
            <div className="text-center py-10 text-xs text-slate-500">
              <Loader2 className="inline animate-spin mr-1" size={14} /> Loading…
            </div>
          ) : error ? (
            <div className="text-center py-4 sm:py-5 text-red-500 text-sm">{error}</div>
          ) : (rows || []).length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400 italic">
              No movement rows for this cell.
            </div>
          ) : (
            <MovementTable rows={rows} onDelete={openDeleteStage} />
          )}
        </div>
      </div>
    </div>
  );
}

// Which source types the operator can soft-delete from here. Auto-posted
// rows (Purchase Receipt / Production Entry) get reversed by cancelling
// their source document — never by touching the ledger directly.
const DELETABLE_SOURCES = new Set(['OPENING', 'ADJUSTMENT']);

function DeleteConfirmPanel({ stage, onReasonChange, onCancel, onDelete, onCorrect }) {
  const { movement: m, preview, previewLoading, previewError, reason, deleting } = stage;

  if (previewLoading) {
    return (
      <div className="text-center py-10 text-xs text-slate-500">
        <Loader2 className="inline animate-spin mr-1" size={14} /> Checking impact…
      </div>
    );
  }
  if (previewError) {
    return <div className="text-center py-4 sm:py-5 text-red-500 text-sm">{previewError}</div>;
  }
  if (!preview) return null;

  const safe = preview.safe_to_delete;
  const cur = preview.current_closing || {};
  const after = preview.if_deleted_closing || {};

  const goesNegative = (v) => Number(v || 0) < 0;

  const renderQty = (v, unit) => {
    const n = Number(v || 0);
    if (n === 0) return null;
    const abs = unit === 'pcs' ? fmt0(Math.abs(n)) : fmt3(Math.abs(n));
    return (
      <span className={`inline-block mr-2 text-[12px] tabular-nums ${goesNegative(n) ? 'text-red-600 font-semibold' : 'text-slate-700'}`}>
        {n < 0 ? '−' : ''}{abs} <span className="text-slate-400 text-[10px]">{unit}</span>
      </span>
    );
  };

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      {/* Movement summary card */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[12px]">
        <div className="grid grid-cols-2 gap-2">
          <div><span className="text-slate-500">Type:</span> <span className="font-medium text-slate-800">{m.source_type_display || m.source_type}</span></div>
          <div><span className="text-slate-500">Direction:</span> <span className={`font-medium ${m.direction === 'IN' ? 'text-emerald-700' : 'text-amber-700'}`}>{m.direction}</span></div>
          <div><span className="text-slate-500">Date:</span> <span className="font-medium text-slate-800">{m.movement_date ? formatDate(m.movement_date) : '—'}</span></div>
          <div><span className="text-slate-500">Batch:</span> <span className="font-mono text-[11px]">{m.batch_no || <em className="text-slate-400">unbatched</em>}</span></div>
        </div>
        <div className="mt-2 pt-2 border-t border-slate-200">
          <span className="text-slate-500 text-[10px] uppercase tracking-wide mr-2">Qty</span>
          {renderQty(m.qty_kg, 'kg')}
          {renderQty(m.qty_litres, 'L')}
          {renderQty(m.qty_count, 'pcs')}
        </div>
        {m.remarks && <div className="mt-2 text-[11px] text-slate-500 italic">"{m.remarks}"</div>}
      </div>

      {/* Before → After */}
      <div className="rounded-lg border border-slate-200 p-3">
        <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-2">Closing balance impact</div>
        <div className="grid grid-cols-2 gap-4 text-[12px]">
          <div>
            <div className="text-slate-500 text-[10px] mb-1">Current</div>
            <div>{renderQty(cur.kg, 'kg')}{renderQty(cur.ltr, 'L')}{renderQty(cur.count, 'pcs')}</div>
          </div>
          <div>
            <div className="text-slate-500 text-[10px] mb-1">If deleted</div>
            <div>{renderQty(after.kg, 'kg')}{renderQty(after.ltr, 'L')}{renderQty(after.count, 'pcs')}</div>
          </div>
        </div>
        {(goesNegative(after.kg) || goesNegative(after.ltr) || goesNegative(after.count)) && (
          <div className="mt-2 text-[11px] text-red-600 flex items-center gap-1">
            <AlertTriangle size={12} /> Closing would go negative for this product / godown / batch.
          </div>
        )}
      </div>

      {safe ? (
        <>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[12px] text-emerald-800 flex items-start gap-2">
            <Trash2 size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Safe to delete.</div>
              <div className="opacity-90">
                No subsequent movements depend on this row. Soft-delete flips
                <code className="px-1 bg-white/60 rounded font-mono text-[11px] mx-1">is_active=False</code>
                and the row disappears from the pivot; the original stays in
                the DB for audit.
              </div>
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Reason <span className="text-slate-400 font-normal">(recommended — becomes part of the audit trail)</span>
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              placeholder="e.g. Typo — wrong quantity entered"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={deleting}
              className="px-3 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-60"
            >
              {deleting ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />}
              {deleting ? 'Deleting…' : 'Delete entry'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Delete blocked.</div>
              <div className="opacity-90">{preview.block_reason}</div>
              {(preview.downstream_sample || []).length > 0 && (
                <div className="mt-2 text-[11px]">
                  <div className="opacity-80">Depending rows (first {preview.downstream_sample.length} of {preview.downstream_count}):</div>
                  <ul className="mt-1 space-y-0.5">
                    {preview.downstream_sample.map((d) => (
                      <li key={d.id} className="opacity-90">
                        {d.movement_date ? formatDate(d.movement_date) : ''} · {d.source_type_display || d.source_type} · {d.direction} · {d.source_document_ref || 'no ref'}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-2 opacity-90">
                Post a correction adjustment — a new signed ADJUSTMENT row
                that nets the ledger back to what it should be. History and
                every downstream reference stay intact.
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onCorrect}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700"
            >
              <Plus size={14} /> Post correction adjustment
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function MovementTable({ rows, onDelete }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
            <th className="px-2 py-1.5">Date</th>
            <th className="px-2 py-1.5">Direction</th>
            <th className="px-2 py-1.5">Source</th>
            <th className="px-2 py-1.5">Ref</th>
            <th className="px-2 py-1.5">Batch</th>
            <th className="px-2 py-1.5">For</th>
            <th className="px-2 py-1.5 text-right">Qty (kg)</th>
            <th className="px-2 py-1.5 text-right">Qty (L)</th>
            <th className="px-2 py-1.5 text-right">Qty (pcs)</th>
            <th className="px-2 py-1.5">Remarks</th>
            {onDelete && <th className="px-2 py-1.5 w-8" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const deletable = onDelete && DELETABLE_SOURCES.has(m.source_type);
            return (
              <tr key={m.id} className="border-b border-slate-100">
                <td className="px-2 py-1.5 tabular-nums">
                  {m.movement_date ? formatDate(m.movement_date) : '—'}
                </td>
                <td className="px-2 py-1.5">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${m.direction === 'IN' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                    {m.direction}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-slate-600">{m.source_type_display || m.source_type}</td>
                <td className="px-2 py-1.5">{m.source_document_ref || '—'}</td>
                <td className="px-2 py-1.5 font-mono text-[10px]">
                  {m.batch_no || <span className="text-slate-300 italic">unbatched</span>}
                </td>
                <td className="px-2 py-1.5">
                  {m.consumed_for_product_name ? (
                    <>
                      <span className="font-medium">{m.consumed_for_product_name}</span>
                      {m.consumed_for_batch_no && (
                        <span className="ml-1 inline-block px-1 rounded text-[10px] bg-slate-100 text-slate-700 font-mono">
                          {m.consumed_for_batch_no}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {Number(m.qty_kg) > 0 ? fmt3(m.qty_kg) : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {Number(m.qty_litres) > 0 ? fmt3(m.qty_litres) : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {Number(m.qty_count) > 0 ? fmt0(m.qty_count) : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2 py-1.5 text-slate-500 max-w-[280px] truncate">
                  {m.remarks || '—'}
                </td>
                {onDelete && (
                  <td className="px-2 py-1.5 text-right">
                    {deletable ? (
                      <button
                        type="button"
                        onClick={() => onDelete(m)}
                        className="text-slate-400 hover:text-red-600"
                        title="Delete or post correction"
                      >
                        <Trash2 size={13} />
                      </button>
                    ) : (
                      <span className="text-slate-200" title="Auto-posted rows are reversed via their source document, not from the ledger.">
                        <Trash2 size={13} />
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
