import { Search, X } from 'lucide-react';

/**
 * Mobile search bar — sticky-ready, Zoho-style. Used inside list pages
 * to filter records. Visually distinct from desktop search (rounded
 * pill, soft fill, larger touch target).
 */
export default function MobileSearchBar({
  value,
  onChange,
  placeholder = 'Search…',
  className = '',
}) {
  return (
    <div className={`relative ${className}`}>
      <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
      <input
        type="search"
        inputMode="search"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-10 pr-10 py-2.5 text-[14px] bg-slate-100 border border-transparent rounded-full focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition-colors min-h-[44px]"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange?.('')}
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-600 rounded-full"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
