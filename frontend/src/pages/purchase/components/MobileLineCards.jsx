/**
 * Shared mobile line-card wrappers for Purchase-module forms / detail
 * pages. Direct copy of the sales-module's MobileLineCards
 * (frontend/src/pages/sales/components/MobileLineCards.jsx) — kept in
 * lockstep so the mobile UX is identical across both modules.
 *
 * Two pieces:
 *   <MobileLineCard>      — one card per line, with a header (line
 *                           number + optional Remove button) and a
 *                           body slot where the caller drops its own
 *                           inputs / display fields.
 *   <MobileLineTotals>    — a stacked totals strip ("Total Qty: …
 *                           Grand Total: …"). Receives an array of
 *                           `{ label, value, cls }`.
 *
 * Both render under `sm:hidden` only — desktop layouts (the existing
 * wide tables) are left untouched and rendered alongside via
 * `hidden sm:block` by the calling page.
 */
import { Trash2 } from 'lucide-react';

export function MobileLineCard({
  idx,
  title,                  // optional sub-title under "Line #N"
  onRemove,               // optional; renders the Remove button when set
  removeDisabled = false,
  children,
  trailing,               // optional content under the body (e.g. Net Amt row)
}) {
  return (
    <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
        <div className="min-w-0">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
            Line #{idx + 1}
          </span>
          {title && (
            <p className="text-sm font-medium text-slate-800 truncate">{title}</p>
          )}
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(idx)}
            disabled={removeDisabled}
            className="inline-flex items-center gap-1 text-red-500 disabled:opacity-30 text-xs"
          >
            <Trash2 size={14} /> Remove
          </button>
        )}
      </div>
      {children}
      {trailing}
    </div>
  );
}

export function MobileLineLabel({ children }) {
  return (
    <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">
      {children}
    </label>
  );
}

export function MobileReadOnlyValue({ children, cls = 'text-slate-700' }) {
  return (
    <div className={`px-3 py-2 bg-slate-50 border border-slate-200 rounded text-right text-sm ${cls}`}>
      {children}
    </div>
  );
}

export function MobileLineTotals({ rows = [] }) {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1 text-sm">
      {rows.map((r, i) => (
        <div
          key={i}
          className={`flex justify-between ${r.divider ? 'pt-2 mt-1 border-t border-slate-300' : ''}`}
        >
          <span className={r.labelCls || 'text-slate-500'}>{r.label}</span>
          <span className={r.cls || 'font-medium text-slate-800'}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}
