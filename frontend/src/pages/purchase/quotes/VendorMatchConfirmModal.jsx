import { HelpCircle, X, Check } from 'lucide-react';

/**
 * Lightweight confirmation modal shown when the extracted vendor name is
 * close to — but not an exact / high-confidence match of — a vendor master
 * record. User confirms with Yes (fill the dropdown) or No (keep as text only).
 *
 * Props:
 *   open: bool
 *   extractedName: string  (vendor name as printed on the doc)
 *   candidate: { id, vendor_name, vendor_code? }  (best fuzzy match)
 *   score: number 0..1
 *   onConfirm: () => void   (use this candidate)
 *   onDecline: () => void   (keep as text only)
 */
export default function VendorMatchConfirmModal({
  open, extractedName, candidate, score, onConfirm, onDecline,
}) {
  if (!open || !candidate) return null;
  const pct = Math.round((score || 0) * 100);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg" role="dialog" aria-modal="true" aria-label="Vendor Match Confirmation">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-blue-100 rounded-lg">
              <HelpCircle size={18} className="text-blue-600" />
            </div>
            <h2 className="text-base font-bold text-slate-900">Vendor Match Confirmation</h2>
          </div>
          <button onClick={onDecline} aria-label="Close" title="Close" className="p-1 rounded text-slate-400 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-slate-700">
            The extracted vendor name looks similar to a vendor in your master, but not an exact match. Use the suggested vendor?
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-[10px] uppercase font-semibold text-red-700 tracking-wide">Extracted (Document)</p>
              <p className="text-sm font-semibold text-red-800 mt-1 break-words">{extractedName || '(no name)'}</p>
            </div>
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
              <p className="text-[10px] uppercase font-semibold text-emerald-700 tracking-wide">Vendor Master</p>
              <p className="text-sm font-semibold text-emerald-800 mt-1 break-words">{candidate.vendor_name}</p>
              {candidate.vendor_code && (
                <p className="text-xs text-emerald-700 mt-0.5 font-mono">{candidate.vendor_code}</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-center">
            <span className={`px-2 py-1 rounded text-xs font-semibold ${
              pct >= 80 ? 'bg-emerald-100 text-emerald-700'
                : pct >= 70 ? 'bg-amber-100 text-amber-700'
                : 'bg-red-100 text-red-700'
            }`}>
              {pct}% similarity
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          <button
            type="button"
            onClick={onDecline}
            className="px-4 py-1.5 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            No, keep as text
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Check size={14} /> Yes, use this vendor
          </button>
        </div>
      </div>
    </div>
  );
}
