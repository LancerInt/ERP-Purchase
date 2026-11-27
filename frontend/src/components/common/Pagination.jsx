import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Shared list-page pagination footer: "Showing X–Y of N" on the left, prev /
 * numbered pages / next on the right. One component so every Purchase list page
 * paginates identically (teal active page, square buttons, same range text).
 *
 *   page       current 1-based page
 *   pageSize   rows per page
 *   total      total row count (across all pages)
 *   onChange   (nextPage) => void
 *   maxButtons how many numbered buttons to show (default 5)
 *
 * Renders nothing when there's nothing to page (total === 0).
 */
export default function Pagination({ page, pageSize, total, onChange, maxButtons = 5 }) {
  if (!total) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  // Windowed page numbers centred on the current page.
  const n = Math.min(totalPages, maxButtons);
  const nums = Array.from({ length: n }, (_, i) =>
    totalPages <= maxButtons ? i + 1
      : page <= 3 ? i + 1
      : page >= totalPages - 2 ? totalPages - (maxButtons - 1) + i
      : page - 2 + i,
  );

  const btn = 'min-w-[28px] h-7 px-1.5 rounded text-[11px] font-semibold border border-slate-200 bg-white text-slate-600 hover:border-primary-300 hover:text-primary-600 disabled:opacity-40 disabled:cursor-default transition flex items-center justify-center';

  return (
    <div className="flex items-center justify-between px-1 py-2.5 text-[11px] text-slate-500 flex-wrap gap-2">
      <span>Showing <b className="text-slate-700">{from}–{to}</b> of <b className="text-slate-700">{total}</b></span>
      <div className="flex items-center gap-1">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous">
          <ChevronLeft size={13} />
        </button>
        {nums.map((p) => (
          <button key={p} type="button" onClick={() => onChange(p)}
            className={`min-w-[28px] h-7 px-1.5 rounded text-[11px] font-semibold border transition ${
              p === page
                ? 'bg-primary-600 text-white border-primary-600'
                : 'bg-white text-slate-600 border-slate-200 hover:border-primary-300 hover:text-primary-600'}`}>
            {p}
          </button>
        ))}
        <button type="button" className={btn} disabled={page >= totalPages} onClick={() => onChange(page + 1)} aria-label="Next">
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}
