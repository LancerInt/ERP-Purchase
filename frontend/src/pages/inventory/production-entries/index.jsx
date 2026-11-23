import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { RefreshCw, Eye, Trash2, Workflow, Activity, X, Loader2, AlertTriangle, ChevronLeft } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '../../../utils/formatters.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import { confirm } from '@/components/common/confirm';

const fmt3 = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const fmt0 = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

export default function ProductionEntryList() {
  const navigate = useNavigate();
  const { canCreate, canDelete, canExport } = usePermissions();

  // Filters live in the URL (alongside the existing ?entry drill) so Back /
  // refresh / sharing restore the filtered view.
  const [searchParams, setSearchParams] = useSearchParams();
  const [dateFrom, setDateFrom] = useState(searchParams.get('dateFrom') || isoOffset(-30));
  const [dateTo, setDateTo] = useState(searchParams.get('dateTo') || isoToday());
  const [warehouseId, setWarehouseId] = useState(searchParams.get('warehouseId') || '');
  const [entryType, setEntryType] = useState(searchParams.get('entryType') || '');
  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  const warehouses = useMemo(() => {
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

  const [rows, setRows] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  // The open pack-progress entry lives in the URL (?entry=<id>) so browser Back
  // and a refresh restore it (and Back returns to the list). We re-find the full
  // row from the loaded rows by id — the modal needs its entry_no / warehouse /
  // date for the header, and lazy-fetches the progress by id. While the rows are
  // still loading (or the id no longer matches the current filter window),
  // progressEntry is null and the list shows, rather than crashing.
  const progressId = searchParams.get('entry');
  const progressEntry = progressId ? (rows.find((r) => String(r.id) === progressId) || null) : null;
  const openProgress = (row) => setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set('entry', String(row.id)); return p; });
  const closeProgress = () => setSearchParams((prev) => { const p = new URLSearchParams(prev); p.delete('entry'); return p; }, { replace: true });

  const load = async () => {
    setIsLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (warehouseId) params.set('warehouse', warehouseId);
      if (entryType) params.set('entry_type', entryType);
      params.set('page_size', '500');
      const res = await apiClient.get(`/api/inventory/production-entries/?${params.toString()}`);
      setRows(res.data?.results || res.data || []);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dateFrom, dateTo, warehouseId, entryType]);

  // Write the active filters back to the URL (replace — a filter change isn't a
  // separate history entry; only opening a record / the pack-progress drill is).
  useEffect(() => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      const put = (k, val) => { if (val) p.set(k, val); else p.delete(k); };
      put('dateFrom', dateFrom);
      put('dateTo', dateTo);
      put('warehouseId', warehouseId);
      put('entryType', entryType);
      return p;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, warehouseId, entryType]);

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Remove ${row.entry_no}? Its stock movements will be reversed.` }))) return;
    try {
      await apiClient.delete(`/api/inventory/production-entries/${row.id}/`);
      toast.success('Production entry removed.');
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  };

  const columns = [
    { key: 'entry_no', label: 'Entry No', sortable: true,
      render: (v, row) => (
        <button onClick={(e) => { e.stopPropagation(); navigate(`/inventory/production-entries/${row.id}`); }}
          className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{v || '-'}</button>
      ),
    },
    { key: 'entry_date', label: 'Date', sortable: true, render: (v) => (v ? formatDate(v) : '-') },
    {
      key: 'entry_type', label: 'Type',
      render: (v) => {
        const isPacking = v === 'PACKING';
        return (
          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
            isPacking ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
          }`}>
            {isPacking ? 'Packing' : 'Production'}
          </span>
        );
      },
    },
    { key: 'warehouse_name', label: 'Warehouse', render: (v) => v || '-' },
    { key: 'godown_name', label: 'Godown', render: (v) => v || '-' },
    { key: 'outputs_count', label: 'Outputs', render: (_, row) => (row.outputs || []).length },
    {
      key: 'materials_count', label: 'Materials',
      render: (_, row) => {
        const total = (row.outputs || []).reduce((sum, o) => sum + ((o.inputs || []).length), 0);
        return total;
      },
    },
    { key: 'created_by_name', label: 'Entered by', render: (v) => v || '-' },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {row.entry_type === 'PRODUCTION' && (
            <button
              onClick={(e) => { e.stopPropagation(); openProgress(row); }}
              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded"
              title="View pack progress"
            >
              <Activity size={15} />
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); navigate(`/inventory/production-entries/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View / Edit"><Eye size={15} /></button>
          {canDelete('Production Entry') && (
            <button onClick={(e) => handleDelete(e, row)}
              className="p-1.5 text-red-600 hover:bg-red-50 rounded" title="Remove"><Trash2 size={15} /></button>
          )}
        </div>
      ),
    },
  ];

  // When an entry's pack progress is open, show it as a normal in-layout page
  // (the sidebar stays, no backdrop) with a Back button, instead of an overlay.
  if (progressEntry) {
    return (
      <MainLayout>
        <div className="p-2 sm:p-3">
          <PackProgressModal
            entry={progressEntry}
            inline
            showBack
            onClose={closeProgress}
            onOpenPackingEntry={(id) => {
              closeProgress();
              navigate(`/inventory/production-entries/${id}`);
            }}
          />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title="Production Entries"
        subtitle="Shop-floor material consumption + production per godown per day — posts to Production Stock"
        breadcrumbs={[{ label: 'Inventory' }, { label: 'Production Entries' }]}
        actions={{
          ...(canCreate('Production Entry')
            ? { createLink: '/inventory/production-entries/new', createLabel: 'New Production Entry' }
            : {}),
        }}
      />

      {/* Filter bar — grid on phones so each control gets half the
          width; unlimited flex-wrap on desktop for tight packing. */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <div className="min-w-0">
            <label className="block text-xs font-medium text-slate-600 mb-1">From</label>
            <CustomDatePicker value={dateFrom} onChange={setDateFrom} />
          </div>
          <div className="min-w-0">
            <label className="block text-xs font-medium text-slate-600 mb-1">To</label>
            <CustomDatePicker value={dateTo} onChange={setDateTo} />
          </div>
          <div className="min-w-0">
            <label className="block text-xs font-medium text-slate-600 mb-1">Warehouse</label>
            <CustomSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">All Warehouses</option>
              {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
            </CustomSelect>
          </div>
          <div className="min-w-0">
            <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
            <CustomSelect value={entryType} onChange={(e) => setEntryType(e.target.value)}>
              <option value="">All Types</option>
              <option value="PRODUCTION">Production</option>
              <option value="PACKING">Packing</option>
            </CustomSelect>
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <button onClick={load} className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {error && !isLoading ? (
        <div className="text-center py-8 text-red-500">{error}</div>
      ) : rows.length === 0 && !isLoading ? (
        <div className="text-center py-16 text-slate-500 bg-white rounded-lg border border-slate-200">
          <Workflow size={40} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm">No production entries in this period.</p>
        </div>
      ) : (
        <DataTable persistKey="production-entries"
          columns={columns}
          data={rows}
          isLoading={isLoading}
          canExport={canExport('Production Entry')}
          exportFileName="production-entries"
          onRowClick={(row) => navigate(`/inventory/production-entries/${row.id}`)}
        />
      )}

    </MainLayout>
  );
}

// ─────────────────────────────────────────────────────────────────────
// PackProgressModal — for a given PRODUCTION entry, shows a card per
// OUTPUT with produced qty, packed qty (rolled up across every
// downstream PACKING entry via the packed_from FK), damage, remaining,
// a horizontal progress bar, and clickable chips for each downstream
// packing entry. Fetches lazily on open.
// ─────────────────────────────────────────────────────────────────────

function PackProgressModal({ entry, onClose, onOpenPackingEntry, inline = false, showBack = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    apiClient.get(`/api/inventory/production-entries/${entry.id}/pack-progress/`)
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => { if (!cancelled) setError(getApiErrorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entry.id]);

  return (
    <div className={inline ? '' : 'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4'} onClick={inline ? undefined : onClose}>
      <div
        className={inline
          ? 'bg-white rounded-lg border border-slate-200 w-full overflow-hidden flex flex-col'
          : 'bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[85dvh] overflow-hidden flex flex-col'}
        onClick={inline ? undefined : ((e) => e.stopPropagation())}
      >
        <div className="px-5 py-3 border-b border-slate-200 flex items-start justify-between">
          <div className="flex items-center gap-2 min-w-0">
            {showBack && (
              <button type="button" onClick={onClose} aria-label="Back"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 shrink-0">
                <ChevronLeft size={16} /> Back
              </button>
            )}
            <div>
            <h3 className="text-sm font-semibold text-slate-800">
              Pack progress · {entry.entry_no}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {entry.warehouse_name}{entry.godown_name ? ` · ${entry.godown_name}` : ''}
              {entry.entry_date ? ` · ${formatDate(entry.entry_date)}` : ''}
            </p>
          </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-auto p-4 flex-1">
          {loading ? (
            <div className="text-center py-10 text-xs text-slate-500">
              <Loader2 className="inline animate-spin mr-1" size={14} /> Loading pack progress…
            </div>
          ) : error ? (
            <div className="text-center py-4 sm:py-5 text-red-500 text-sm">{error}</div>
          ) : !data || (data.outputs || []).length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400 italic">
              No outputs on this entry.
            </div>
          ) : (
            <div className="space-y-3">
              {data.outputs.map((o) => (
                <PackProgressCard key={o.line_id} output={o} onOpenPackingEntry={onOpenPackingEntry} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PackProgressCard({ output, onOpenPackingEntry }) {
  // Pick the unit with a non-zero produced qty for the primary
  // display so we don't render three progress bars when only one
  // unit matters for this product.
  const unit = Number(output.produced_kg) > 0
    ? { key: 'kg',    fmt: fmt3, produced: output.produced_kg,    packed: output.packed_kg,    remaining: output.remaining_kg,    damage: output.damage_kg }
    : Number(output.produced_ltr) > 0
    ? { key: 'L',     fmt: fmt3, produced: output.produced_ltr,   packed: output.packed_ltr,   remaining: output.remaining_ltr,   damage: output.damage_ltr }
    : { key: 'pcs',   fmt: fmt0, produced: output.produced_count, packed: output.packed_count, remaining: output.remaining_count, damage: output.damage_count };

  const pct = Number(output.pack_percent) || 0;
  const hasDamage = Number(unit.damage) > 0;
  const fullyPacked = pct >= 100;
  const barTone = fullyPacked ? 'bg-emerald-500' : pct >= 50 ? 'bg-primary-500' : 'bg-amber-500';

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-800 truncate">
            {output.product_name}
            {output.product_code && (
              <span className="ml-2 text-[10px] text-slate-400 font-normal">{output.product_code}</span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Batch <span className="font-mono">{output.batch_no || 'unbatched'}</span>
            {output.godown_name ? ` · ${output.godown_name}` : ''}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-semibold tabular-nums text-slate-800">
            {pct}<span className="text-xs text-slate-500">%</span>
          </div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">packed</div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full ${barTone} transition-all`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>

      {/* Numbers */}
      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="text-[9px] uppercase tracking-wide text-slate-400">Produced</div>
          <div className="tabular-nums font-semibold text-slate-800">
            {unit.fmt(unit.produced)} <span className="text-[9px] text-slate-500 font-normal">{unit.key}</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-slate-400">Packed</div>
          <div className="tabular-nums font-semibold text-primary-700">
            {unit.fmt(unit.packed)} <span className="text-[9px] text-slate-500 font-normal">{unit.key}</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-slate-400">Remaining</div>
          <div className={`tabular-nums font-semibold ${fullyPacked ? 'text-emerald-600' : 'text-slate-800'}`}>
            {unit.fmt(unit.remaining)} <span className="text-[9px] text-slate-500 font-normal">{unit.key}</span>
          </div>
        </div>
      </div>

      {/* Damage strip (only when non-zero) */}
      {hasDamage && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          <AlertTriangle size={12} />
          <span>
            Damage recorded: <span className="font-semibold">{unit.fmt(unit.damage)} {unit.key}</span>
            {' '}(posted as an OUT adjustment)
          </span>
        </div>
      )}

      {/* Downstream packing entries. When any downstream entry
          carries a `packing_stage` (TVP-SS multi-stage flow), we
          show a stage TIMELINE first — Filling → Labeling → Boxing
          → Pelleting → Completed — with a coloured chip per stage
          that ✓s the ones already done. Below the timeline, the
          per-entry chips still list every session for drill-down. */}
      {(output.downstream_entries || []).length > 0 && (() => {
        const STAGE_ORDER = ['FILLING', 'LABELING', 'BOXING', 'PELLETING', 'COMPLETED'];
        const STAGE_LABELS = {
          FILLING: 'Filling', LABELING: 'Labeling',
          BOXING: 'Boxing', PELLETING: 'Pelleting',
          MIXED: 'Mixed', COMPLETED: 'Completed',
        };
        const stagesReached = new Set(
          output.downstream_entries
            .map((d) => (d.packing_stage || '').toUpperCase())
            .filter(Boolean)
        );
        // Timeline is only meaningful when at least one entry has
        // a stage recorded (i.e. TVP-SS flow). Non-TVP entries
        // will have all-blank stages → skip the timeline row.
        const showTimeline = STAGE_ORDER.some((s) => stagesReached.has(s));
        return (
          <div className="mt-2">
            {showTimeline && (
              <>
                <div className="text-[9px] uppercase tracking-wide text-slate-400 mb-1">
                  Stage timeline
                </div>
                <div className="flex items-center gap-1 mb-2 flex-wrap">
                  {STAGE_ORDER.map((s, idx) => {
                    const done = stagesReached.has(s);
                    const isDone = done || (s === 'COMPLETED' && stagesReached.has('COMPLETED'));
                    return (
                      <div key={s} className="flex items-center gap-1">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          done
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                            : 'bg-slate-100 text-slate-400 border border-slate-200'
                        }`}>
                          {done && <span>✓</span>}
                          <span>{STAGE_LABELS[s]}</span>
                        </span>
                        {idx < STAGE_ORDER.length - 1 && <span className="text-slate-300 text-[10px]">→</span>}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            <div className="text-[9px] uppercase tracking-wide text-slate-400 mb-1">
              Packed via {output.downstream_entries.length} entr{output.downstream_entries.length === 1 ? 'y' : 'ies'}
            </div>
            <div className="flex flex-wrap gap-1">
              {output.downstream_entries.map((d) => {
                const bits = [];
                if (Number(d.packed_kg)    > 0) bits.push(`${fmt3(d.packed_kg)} kg`);
                if (Number(d.packed_ltr)   > 0) bits.push(`${fmt3(d.packed_ltr)} L`);
                if (Number(d.packed_count) > 0) bits.push(`${fmt0(d.packed_count)} pcs`);
                const stage = d.packing_stage ? STAGE_LABELS[d.packing_stage] || d.packing_stage : '';
                return (
                  <button
                    key={d.entry_id}
                    type="button"
                    onClick={() => onOpenPackingEntry(d.entry_id)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] bg-purple-50 text-purple-800 hover:bg-purple-100 border border-purple-200"
                    title="Open packing entry"
                  >
                    <span className="font-mono">{d.entry_no}</span>
                    <span className="text-purple-600">·</span>
                    <span>{d.entry_date}</span>
                    {stage && (
                      <>
                        <span className="text-purple-600">·</span>
                        <span className="font-semibold">{stage}</span>
                      </>
                    )}
                    <span className="text-purple-600">·</span>
                    <span className="font-medium">{bits.join(' / ') || '0'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
