import CustomSelect from "@/components/ui/CustomSelect";
/**
 * Mobile-only card list for Purchase-module record lists.
 *
 * Direct copy of the Sales-module's MobileListCards
 * (frontend/src/pages/sales/components/MobileListCards.jsx) — the
 * user explicitly asked for "the same exact" mobile UX in Purchase,
 * so the implementations are kept in lockstep. Any bug fixed in one
 * should be replicated to the other; eventually we should hoist this
 * to a shared `components/common/` location, but keeping it
 * module-local for now matches the existing project convention.
 *
 * Drop in below sm:hidden alongside a `hidden sm:block` DataTable so
 * every Purchase list page gets the same compact, no-horizontal-scroll
 * mobile UX. Each page configures the same shape — title / status /
 * fields / actions — so the visual language stays consistent across
 * Purchase Requests, RFQ, Quotes, Orders, Receipts, Bills, etc.
 */
import { useState, useMemo } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { CTRL_FIELD } from '@/components/common/controls';

const DEFAULT_PAGE_SIZE = 10;

export default function MobileListCards({
  rows = [],
  isLoading = false,
  // Search wiring — shared with the desktop DataTable so the filter
  // applies to both views at once.
  searchTerm = '',
  onSearchChange,
  searchPlaceholder = 'Search…',
  // Filters dropdowns. Each filter: { key, label, options: [{value, label}] }
  filters = [],
  filterValues = {},
  onFilterChange,
  // Per-list customization. Required:
  //   title(row)  -> headline string (PO number, PR number, etc.)
  // Optional:
  //   subtitle(row) -> small text under the title
  //   badge(row) -> { label, cls } for the right-side chip
  //   fields(row) -> array of { label, value } for the body
  //   actions(row) -> array of { icon, label, onClick, cls, hidden }
  config,
  onRowClick,
  emptyMessage = 'No records found',
  pageSize = DEFAULT_PAGE_SIZE,
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [rows, safePage, pageSize],
  );

  return (
    <div className="sm:hidden space-y-3">
      {(onSearchChange || filters.length > 0) && (
        <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
          {onSearchChange && (
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="search"
                value={searchTerm}
                onChange={(e) => { onSearchChange(e.target.value); setPage(1); }}
                placeholder={searchPlaceholder}
                className={`w-full pl-9 pr-3 ${CTRL_FIELD} focus:outline-none focus:ring-2 focus:ring-primary-500`}
              />
            </div>
          )}
          {filters.map(f => (
            <CustomSelect
              key={f.key}
              value={filterValues[f.key] || ''}
              onChange={(e) => {
                const value = e.target.value;
                onFilterChange?.(f.key, value || undefined);
                setPage(1);
              }}
              className={`w-full ${CTRL_FIELD} focus:outline-none focus:ring-2 focus:ring-primary-500`}
            >
              <option value="">{f.label}: All</option>
              {f.options.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </CustomSelect>
          ))}
        </div>
      )}

      {isLoading && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 text-center text-sm text-slate-500">
          Loading…
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 text-center text-sm text-slate-500">
          {emptyMessage}
        </div>
      )}

      {/* Cards in a responsive grid: one column on narrow phones,
          two from xs (480px) up so larger phones / small tablets use
          the horizontal space instead of leaving a wide blank gutter
          inside each card. */}
      {pageRows.length > 0 && (
        <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-2.5">
          {pageRows.map((row, i) => (
            <MobileRecordCard
              key={row.id ?? i}
              row={row}
              config={config}
              onRowClick={onRowClick}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="bg-white rounded-lg border border-slate-200 p-3 flex items-center justify-between text-sm">
          <span className="text-slate-600">
            Page {safePage} of {totalPages}
            <span className="text-slate-400 ml-1">· {rows.length} record{rows.length === 1 ? '' : 's'}</span>
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="p-2 rounded border border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="p-2 rounded border border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MobileRecordCard({ row, config, onRowClick }) {
  const title = config?.title?.(row) ?? '';
  const subtitle = config?.subtitle?.(row);
  const badge = config?.badge?.(row);
  // Optional compact meta (e.g. created date) shown right-aligned under
  // the status pill — keeps a high-signal value visible without spending
  // a whole body row on it.
  const meta = config?.meta?.(row);
  const fields = (config?.fields?.(row) || []).filter(f => f && f.value !== null && f.value !== undefined && f.value !== '');
  const actions = (config?.actions?.(row) || []).filter(a => a && !a.hidden);

  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden active:bg-slate-50 h-full flex flex-col">
      <button
        type="button"
        onClick={() => onRowClick?.(row)}
        className="w-full text-left px-3.5 py-2.5 flex-1"
      >
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-blue-700 truncate">{title}</p>
            {subtitle && (
              <p className="text-[11px] text-slate-500 mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
          {(badge || meta) && (
            <div className="shrink-0 flex flex-col items-end gap-0.5">
              {badge && (
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${badge.cls || 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                  {badge.label}
                </span>
              )}
              {meta && <span className="text-[10px] text-slate-400 whitespace-nowrap">{meta}</span>}
            </div>
          )}
        </div>

        {fields.length > 0 && (
          <div className="space-y-0.5 text-[13px]">
            {fields.map((f, idx) => (
              <div key={idx} className="flex items-baseline gap-2">
                <span className="text-[10px] uppercase tracking-wide text-slate-400 w-14 shrink-0">{f.label}</span>
                <span className={`truncate ${f.cls || 'text-slate-700'}`}>{f.value}</span>
              </div>
            ))}
          </div>
        )}
      </button>

      {actions.length > 0 && (
        <div className="border-t border-slate-100 px-2 py-2 flex items-center gap-1 flex-wrap">
          {actions.map((a, idx) => {
            const Icon = a.icon;
            return (
              <button
                key={idx}
                type="button"
                onClick={(e) => { e.stopPropagation(); a.onClick?.(row); }}
                title={a.title || a.label}
                aria-label={a.label}
                className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-2 text-[13px] font-medium rounded ${a.cls || 'text-slate-700 hover:bg-slate-50'} ${a.iconOnly ? '' : 'flex-1 min-w-[64px]'}`}
              >
                {Icon && <Icon size={14} />}
                {!a.iconOnly && a.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
