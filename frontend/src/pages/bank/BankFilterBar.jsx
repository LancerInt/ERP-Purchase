import { Search, RotateCcw } from 'lucide-react';

const INPUT = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

/**
 * Inline filter bar for the bank register / list pages.
 *  - values: current filter object
 *  - set(key, value): update one filter
 *  - reset(): clear all
 *  - selects: [{ key, label, options: [{value,label}] | [str] }]
 *  - dateKeys: [fromKey, toKey] — omit to hide the date range
 *  - searchKey: key for the free-text box (default 'q')
 */
export default function BankFilterBar({ values, set, reset, selects = [], dateKeys = ['date_from', 'date_to'], searchKey = 'q', searchPlaceholder = 'Search…', showSearch = true }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 flex flex-wrap items-end gap-3">
      {showSearch && (
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-slate-500 mb-1">Search</label>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input value={values[searchKey] || ''} onChange={(e) => set(searchKey, e.target.value)} placeholder={searchPlaceholder} className={`${INPUT} w-full pl-9`} />
          </div>
        </div>
      )}
      {selects.map((s) => (
        <div key={s.key}>
          <label className="block text-xs font-medium text-slate-500 mb-1">{s.label}</label>
          <select value={values[s.key] || ''} onChange={(e) => set(s.key, e.target.value)} className={INPUT}>
            <option value="">All</option>
            {s.options.map((o) => {
              const val = o.value ?? o;
              const lab = o.label ?? o;
              return <option key={val} value={val}>{lab}</option>;
            })}
          </select>
        </div>
      ))}
      {dateKeys && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">From</label>
            <input type="date" value={values[dateKeys[0]] || ''} onChange={(e) => set(dateKeys[0], e.target.value)} className={INPUT} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">To</label>
            <input type="date" value={values[dateKeys[1]] || ''} onChange={(e) => set(dateKeys[1], e.target.value)} className={INPUT} />
          </div>
        </>
      )}
      <button onClick={reset} className="flex items-center gap-1.5 px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">
        <RotateCcw className="w-4 h-4" /> Reset
      </button>
    </div>
  );
}
