import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { CTRL_FIELD } from '@/components/common/controls';

const DEFAULT_PAGE_SIZE = 12;

export default function MobileListCards({
  rows = [],
  isLoading = false,
  searchTerm = '',
  onSearchChange,
  searchPlaceholder = 'Search…',
  filters = [],
  filterValues = {},
  onFilterChange,
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
    <div className="sm:hidden space-y-2">
      {(onSearchChange || filters.length > 0) && (
        <div className="bg-white rounded-lg border border-slate-200 p-2.5 space-y-1.5">
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
                onFilterChange?.(f.key, e.target.value || undefined);
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
        <div className="bg-white rounded-lg border border-slate-200 p-4 text-center text-sm text-slate-500">
          Loading…
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 text-center text-sm text-slate-500">
          {emptyMessage}
        </div>
      )}

      {pageRows.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {pageRows.map((row, i) => (
            <GridCell key={row.id ?? i} row={row} config={config} onRowClick={onRowClick} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-1 py-1.5 text-[11px] text-slate-500">
          <span>{(safePage - 1) * pageSize + 1}-{Math.min(safePage * pageSize, rows.length)} of {rows.length}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="w-7 h-7 flex items-center justify-center rounded border border-slate-200 disabled:opacity-30"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="w-7 h-7 flex items-center justify-center rounded border border-slate-200 disabled:opacity-30"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function GridCell({ row, config, onRowClick }) {
  const title = config?.title?.(row) ?? '';
  const badge = config?.badge?.(row);
  const meta = config?.meta?.(row);
  const fields = (config?.fields?.(row) || []).filter(f => f && f.value != null && f.value !== '');

  return (
    <button
      type="button"
      onClick={() => onRowClick?.(row)}
      className="bg-white rounded-lg border border-slate-200 p-2.5 text-left active:bg-slate-50 transition-colors flex flex-col"
    >
      <div className="flex items-start justify-between gap-1 w-full">
        <span className="text-[13px] font-bold text-primary-700 truncate leading-tight">{title}</span>
        {badge && (
          <span className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold leading-none ${badge.cls || 'bg-slate-100 text-slate-700'}`}>
            {badge.label}
          </span>
        )}
      </div>
      {fields.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-500 leading-snug truncate">
          {fields.map((f, idx) => (
            <span key={idx}>
              {idx > 0 && <span className="mx-0.5 text-slate-300">&middot;</span>}
              <span className={f.cls || ''}>{f.value}</span>
            </span>
          ))}
        </div>
      )}
      {meta && (
        <div className="mt-0.5 text-[10px] text-slate-400 leading-snug">{meta}</div>
      )}
    </button>
  );
}
