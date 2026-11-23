/**
 * CreatableSelect — dropdown with the same look-and-feel as CustomSelect
 * but backed by a plain string list and allowing the operator to add a
 * brand-new value inline.
 *
 * Usage:
 *   <CreatableSelect
 *     name="label"
 *     value={row.label}
 *     onChange={(e) => updateLaborRow(row.cid, 'label', e.target.value)}
 *     options={effectiveLaborCategories}
 *     placeholder="Pick or type — e.g. Loading helpers"
 *   />
 *
 * onChange fires the synthetic { target: { name, value } } event so the
 * caller can use the exact same handler shape as CustomSelect / native
 * <input>. Whether the value came from picking an existing option or
 * typing a new one is intentionally opaque — parents just get the string.
 *
 * The list is a portal so it never gets clipped by an overflow:auto
 * container (tables, cards). Includes a search box at the top; when the
 * query doesn't match any option, a "+ Create «query»" row appears at
 * the bottom.
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search, Plus } from 'lucide-react';

export default function CreatableSelect({
  value,
  onChange,
  options,
  name,
  id,
  disabled = false,
  placeholder = 'Pick or type…',
  className = '',
  ...rest
}) {
  const opts = useMemo(
    () => Array.from(new Set((options || []).filter((o) => o != null && String(o).trim() !== ''))),
    [options],
  );

  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const optionRefs = useRef([]);

  const current = value ?? '';
  const isPlaceholder = !String(current).trim();
  const displayLabel = isPlaceholder ? placeholder : current;

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || listRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = (e) => {
      if (listRef.current && listRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    if (!open && btnRef.current) {
      setRect(btnRef.current.getBoundingClientRect());
      setQuery('');
      const selIdx = opts.findIndex((o) => o === current);
      setActiveIndex(selIdx >= 0 ? selIdx : 0);
    }
    setOpen((o) => !o);
  };

  const emit = (v) => {
    setOpen(false);
    onChange?.({ target: { name, value: v } });
  };

  const VIEW_MAX = 300;
  const below = rect ? window.innerHeight - rect.bottom : 9999;
  const dropUp = rect ? below < VIEW_MAX && rect.top > below : false;
  const menuStyle = rect
    ? {
        position: 'fixed',
        left: rect.left,
        minWidth: rect.width,
        width: 'max-content',
        maxWidth: `calc(100vw - ${Math.round(rect.left) + 8}px)`,
        maxHeight: VIEW_MAX,
        ...(dropUp
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      }
    : {};

  const q = query.trim();
  const qLower = q.toLowerCase();
  const filtered = qLower
    ? opts.filter((o) => String(o).toLowerCase().includes(qLower))
    : opts;
  // "Create «query»" only shows when the search has meaningful text
  // AND no existing option matches it exactly (case-insensitive) —
  // avoids offering a duplicate for what's already there.
  const canCreate = q && !opts.some((o) => String(o).toLowerCase() === qLower);

  useEffect(() => { if (open && query) setActiveIndex(0); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && optionRefs.current[activeIndex]) {
      optionRefs.current[activeIndex].scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setActiveIndex(0); }
    else if (e.key === 'End') { e.preventDefault(); setActiveIndex(filtered.length - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < filtered.length) {
        emit(filtered[activeIndex]);
      } else if (canCreate) {
        emit(q);
      }
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        id={id}
        ref={btnRef}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${className} inline-flex items-center justify-between gap-2 text-left ${
          disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
        }`}
        {...rest}
      >
        <span className={`truncate ${isPlaceholder ? 'text-slate-400' : ''}`}>
          {displayLabel}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && createPortal(
        <div
          ref={listRef}
          style={menuStyle}
          className="z-[200] flex flex-col bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden"
        >
          <div className="p-1.5 border-b border-slate-100 shrink-0">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search or type new…"
                className="w-full pl-8 pr-2 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>
          <ul role="listbox" className="overflow-auto py-1">
            {filtered.length === 0 && !canCreate ? (
              <li className="px-3 py-2 text-sm text-slate-400">No matches</li>
            ) : filtered.map((opt, i) => {
              const isSelected = opt === current;
              const isActive = i === activeIndex;
              return (
                <li key={opt} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    ref={(el) => { optionRefs.current[i] = el; }}
                    onClick={() => emit(opt)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`w-full flex items-start justify-between gap-2 text-left px-3 py-2.5 min-h-[44px] text-sm transition ${
                      isSelected
                        ? 'bg-primary-50 text-primary-700 font-medium'
                        : isActive
                          ? 'bg-primary-50/60 text-slate-900'
                          : 'text-slate-700 hover:bg-primary-50'
                    }`}
                  >
                    <span className="whitespace-normal break-words leading-snug">{opt}</span>
                    {isSelected && <Check size={14} className="shrink-0 mt-0.5 text-primary-600" />}
                  </button>
                </li>
              );
            })}
            {canCreate && (
              <li role="option">
                <button
                  type="button"
                  onClick={() => emit(q)}
                  className="w-full flex items-center gap-2 text-left px-3 py-2 text-sm text-emerald-700 border-t border-slate-100 hover:bg-emerald-50"
                >
                  <Plus size={14} className="shrink-0" />
                  <span className="truncate">Create <span className="font-medium">&quot;{q}&quot;</span></span>
                </button>
              </li>
            )}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
