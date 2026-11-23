import { AlertCircle, RefreshCw } from 'lucide-react';

/**
 * Shared wrapper for list-page data states so every page stops hand-rolling
 * the loading/error/empty trio three different ways.
 *
 * Loading + empty are owned by the child <DataTable> (pass it `isLoading`),
 * which already ships a polished skeleton + empty state. ListState adds the
 * one thing pages were doing inconsistently — a real ERROR state with Retry,
 * instead of a dead-end red text line (or nothing).
 *
 *   <ListState error={error} onRetry={refetch}>
 *     <DataTable isLoading={isLoading} data={rows} columns={cols} />
 *   </ListState>
 */
export default function ListState({ error, onRetry, errorMessage, children }) {
  if (!error) return children;
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
      <div className="mx-auto mb-3 h-11 w-11 rounded-full bg-red-50 flex items-center justify-center">
        <AlertCircle className="text-red-500" size={22} />
      </div>
      <p className="text-sm font-medium text-slate-700">
        {errorMessage || 'We couldn’t load this list.'}
      </p>
      <p className="text-xs text-slate-400 mt-1">Check your connection and try again.</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700"
        >
          <RefreshCw size={14} /> Retry
        </button>
      )}
    </div>
  );
}
