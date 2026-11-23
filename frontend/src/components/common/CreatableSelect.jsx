import { useState, useEffect, useRef, useMemo } from 'react';
import { Plus, Loader2, ChevronDown, X } from 'lucide-react';

const inputClass =
  'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export default function CreatableSelect({
  value = '',
  options = [],
  onChange,
  onCreate,
  placeholder = 'Select or type to search...',
  loading = false,
  creating = false,
  disabled = false,
  disabledHint = '',
  canCreate = true,
  required = false,
  className = '',
  emptyMessage = 'No matches.',
  showChevron = true,
  icon: LeadingIcon = null,
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const selectedOption = useMemo(
    () => options.find((o) => o.value === value) || null,
    [options, value],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      String(o.label || '').toLowerCase().includes(q),
    );
  }, [options, search]);

  const exactMatch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return options.find((o) => String(o.label || '').toLowerCase() === q) || null;
  }, [options, search]);

  const showCreateOption =
    canCreate && search.trim().length > 0 && !exactMatch;

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = (opt) => {
    onChange?.(opt.value, opt);
    setOpen(false);
    setSearch('');
  };

  const handleClear = (e) => {
    e.stopPropagation();
    onChange?.('', null);
    setSearch('');
  };

  const handleCreate = async () => {
    const name = search.trim();
    if (!name || !onCreate) return;
    try {
      const created = await onCreate(name);
      if (created && created.value) {
        onChange?.(created.value, created);
      }
      setOpen(false);
      setSearch('');
    } catch {
      // The caller is expected to surface a toast on failure.
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && open) {
      e.preventDefault();
      if (filtered.length > 0) {
        handleSelect(filtered[0]);
      } else if (showCreateOption) {
        handleCreate();
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setSearch('');
    }
  };

  const displayValue = open ? search : (selectedOption?.label || '');

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div
        className={`${inputClass} flex items-center gap-1 ${
          disabled ? 'bg-slate-100 cursor-not-allowed' : 'bg-white cursor-text'
        }`}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        {LeadingIcon && <LeadingIcon size={14} className="text-slate-400 flex-shrink-0" />}
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
          }}
          onFocus={() => !disabled && setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled && disabledHint
              ? disabledHint
              : selectedOption
                ? ''
                : placeholder
          }
          disabled={disabled}
          required={required && !value}
          className="flex-1 outline-none bg-transparent disabled:cursor-not-allowed"
          autoComplete="off"
        />
        {selectedOption && !disabled && !open && (
          <button
            type="button"
            onClick={handleClear}
            className="p-0.5 text-slate-400 hover:text-red-500"
            aria-label="Clear"
            title="Clear"
          >
            <X size={14} />
          </button>
        )}
        {showChevron && <ChevronDown size={14} className="text-slate-400 flex-shrink-0" />}
      </div>

      {open && !disabled && (
        <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-auto z-30">
          {loading && (
            <div className="px-3 py-3 text-sm text-slate-500 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          )}

          {!loading && filtered.length > 0 && filtered.slice(0, 50).map((opt) => (
            <button
              type="button"
              key={opt.value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(opt)}
              className={`block w-full text-left px-3 py-2 text-sm hover:bg-primary-50 border-b border-slate-100 last:border-b-0 ${
                opt.value === value ? 'bg-primary-50 font-medium text-primary-800' : 'text-slate-700'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span>{opt.label}</span>
                {opt.code && (
                  <span className="text-xs text-slate-400 font-mono">{opt.code}</span>
                )}
              </div>
            </button>
          ))}

          {!loading && filtered.length === 0 && !showCreateOption && (
            <div className="px-3 py-3 text-sm text-slate-500">
              {options.length === 0 ? (
                <>
                  <div className="font-medium text-slate-700">No entries yet.</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Type a name above to add a new one.
                  </div>
                </>
              ) : (
                <>
                  <div>{emptyMessage}</div>
                  {canCreate && (
                    <div className="text-xs text-slate-400 mt-0.5">
                      Type a new name to create it.
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {!loading && showCreateOption && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleCreate}
              disabled={creating}
              className="block w-full text-left px-3 py-2 text-sm bg-emerald-50 text-emerald-700 font-medium hover:bg-emerald-100 border-t border-slate-100 disabled:opacity-50"
            >
              {creating ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Creating "{search.trim()}"…
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <Plus size={14} /> Add "{search.trim()}"
                </span>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
