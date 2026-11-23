import { Filter, X } from 'lucide-react';

/**
 * MobileFilterChips — horizontally-scrollable chip row for quick filter
 * selection. Zoho-style: tap to toggle, active chips fill with the
 * accent color, and an "All" chip resets every filter.
 *
 * Props:
 *   - chips: [{ key, label, count?, active? }]   per-chip definition
 *   - onChipClick(key)                            toggle handler
 *   - activeCount                                 number of active filters (drives the "All" reset chip)
 *   - onOpenSheet                                 if provided, renders a leading Filter button that
 *                                                  opens an advanced filter sheet
 *   - onReset                                     called when the user taps the "Clear" chip
 *
 * Lives in its own row above the list. Keep chips short and meaningful —
 * if you need 10+ filters, push them into a MobileBottomSheet instead.
 */
export default function MobileFilterChips({
  chips = [],
  onChipClick,
  activeCount = 0,
  onOpenSheet,
  onReset,
  className = '',
}) {
  return (
    <div
      className={`flex items-center gap-2 overflow-x-auto py-2 px-3 -mx-3 sm:hidden no-scrollbar ${className}`}
      style={{ scrollbarWidth: 'none' }}
    >
      {onOpenSheet && (
        <button
          type="button"
          onClick={onOpenSheet}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-slate-200 text-[13px] font-medium text-slate-700 active:bg-slate-100 shadow-sm"
        >
          <Filter size={13} />
          Filters
          {activeCount > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-bold">
              {activeCount}
            </span>
          )}
        </button>
      )}
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => onChipClick?.(chip.key)}
          className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors ${
            chip.active
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-white border border-slate-200 text-slate-700 active:bg-slate-100'
          }`}
        >
          {chip.label}
          {chip.count != null && (
            <span className={`text-[11px] ${chip.active ? 'text-blue-100' : 'text-slate-400'}`}>
              {chip.count}
            </span>
          )}
        </button>
      ))}
      {activeCount > 0 && onReset && (
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[13px] font-medium text-slate-500 active:bg-slate-100"
        >
          <X size={12} />
          Clear
        </button>
      )}
    </div>
  );
}
