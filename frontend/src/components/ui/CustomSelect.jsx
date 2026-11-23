/**
 * CustomSelect — a modern, responsive drop-in replacement for native
 * <select>. Renders the same way you'd write a native select:
 *
 *   <CustomSelect name="mode" value={v} onChange={handleChange}>
 *     <option value="">Select…</option>
 *     <option value="EMAIL">Email</option>
 *   </CustomSelect>
 *
 * It reads its <option> children, so existing markup swaps over with no
 * other changes. onChange fires a synthetic event ({ target:{ name,
 * value } }) so handlers using e.target.value / e.target.name keep
 * working. Works controlled (value) or uncontrolled (defaultValue).
 *
 * Why custom: native <select> renders an OS-styled option list that is
 * huge and inconsistent on mobile. This gives one compact, on-brand
 * list everywhere. The menu renders in a portal so it's never clipped
 * by a card/table with overflow, and flips up when there's no room
 * below. Long lists (>8 options) get a filter box. `required` is
 * mirrored to a hidden native select so browser form validation still
 * fires.
 */
import {
  useState, useRef, useEffect, useMemo,
  Children, isValidElement, cloneElement,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search } from 'lucide-react';

// Flatten <option>/<optgroup>/fragments/arrays into a flat option list.
function collectOptions(children) {
  const out = [];
  const walk = (nodes) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === 'option') {
        out.push({
          value: child.props.value !== undefined ? child.props.value : '',
          label: child.props.children,
          disabled: !!child.props.disabled,
        });
      } else if (child.props && child.props.children) {
        // optgroup, fragment, mapped array wrapper, etc.
        walk(child.props.children);
      }
    });
  };
  walk(children);
  return out;
}

const labelText = (label) => {
  if (typeof label === 'string' || typeof label === 'number') return String(label);
  // Options whose label is an icon + text (e.g. "🏦 Transfer to {account}") arrive
  // as an array of children; flatten the string/number parts so the search box can
  // still match them (otherwise typing "transfer" found nothing). React-element
  // parts can't be read as text and are skipped.
  if (Array.isArray(label)) return label.map(labelText).join('');
  return '';
};

export default function CustomSelect({
  value,
  defaultValue,
  onChange,
  name,
  id,
  disabled = false,
  required = false,
  placeholder,
  className = '',
  children,
  onQueryChange,
  'aria-label': ariaLabel,
  ...rest
}) {
  const options = useMemo(() => collectOptions(children), [children]);

  const isControlled = value !== undefined;
  const [internal, setInternal] = useState(defaultValue ?? '');
  const current = isControlled ? value : internal;

  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [query, setQuery] = useState('');
  // Let the CALLER see what is being typed. Optional and default-free, so
  // every existing dropdown behaves exactly as before. It exists for lists
  // that change their own contents as you drill into them (the product
  // picker shows categories first, then one category's products): while a
  // search is running such a list has to offer EVERYTHING again, or typing a
  // product name would find nothing unless you had already opened the right
  // category.
  useEffect(() => { onQueryChange?.(query); }, [query]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [activeIndex, setActiveIndex] = useState(-1);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const optionRefs = useRef([]);

  const selected = options.find((o) => String(o.value) === String(current ?? ''));
  const emptyOpt = options.find((o) => String(o.value) === '');
  const isPlaceholder = !selected || String(selected.value) === '';
  const displayLabel = isPlaceholder
    ? (placeholder ?? emptyOpt?.label ?? 'Select…')
    : selected.label;

  // Close on outside click, scroll (popover would detach), resize, Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || listRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    // Close when the PAGE (or any outer container) scrolls — the fixed
    // popover would otherwise detach from its trigger. But ignore scrolls
    // that happen INSIDE our own option list, so the user can scroll
    // through long lists without the menu vanishing.
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
      // Open with the currently-selected option highlighted for the keyboard.
      const selIdx = options.findIndex((o) => String(o.value) === String(current ?? ''));
      setActiveIndex(selIdx >= 0 ? selIdx : 0);
    }
    setOpen((o) => !o);
  };

  const pick = (opt) => {
    if (opt.disabled) return;
    setOpen(false);
    // A drill-in list rebuilds itself from this; leaving a stale term behind
    // would reopen the menu showing yesterday's search.
    setQuery('');
    if (!isControlled) setInternal(opt.value);
    onChange?.({ target: { name, value: opt.value } });
  };

  // Position the portal menu: fixed, anchored to the trigger, flips up
  // when there isn't room below.
  const VIEW_MAX = 300;
  const below = rect ? window.innerHeight - rect.bottom : 9999;
  const dropUp = rect ? below < VIEW_MAX && rect.top > below : false;
  // Phones: span the viewport instead of anchoring to the trigger's left
  // edge. Anchoring left the menu only `100vw − left` wide, so a control on
  // the right half of the row had ~300px and every party name truncated.
  const narrowMenu = typeof window !== 'undefined' && window.innerWidth < 640;
  const menuStyle = rect
    ? {
        position: 'fixed',
        ...(narrowMenu
          ? { left: 8, right: 8, width: 'auto' }
          : {
              left: rect.left,
              // At least as wide as the trigger, but grow to fit the longest
              // option — capped so it never overflows the right edge.
              minWidth: rect.width,
              width: 'max-content',
              maxWidth: `calc(100vw - ${Math.round(rect.left) + 8}px)`,
            }),
        maxHeight: VIEW_MAX,
        ...(dropUp
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      }
    : {};

  // Filter box appears from 6 options up. Below that the whole list is
  // already visible, so a search field would be noise — and on mobile it
  // would pop the keyboard over the very options being chosen.
  const showSearch = options.length > 5;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => labelText(o.label).toLowerCase().includes(q))
    : options;
  // Master tables like Products can run into the thousands of rows — render
  // every match as a DOM node and the menu lags on open/scroll. Cap what's
  // actually mounted; typing in the search box narrows `filtered` back down
  // below the cap. No-op for the vast majority of dropdowns, which have far
  // fewer than this many options to begin with.
  const MAX_RENDERED = 200;
  const visible = filtered.length > MAX_RENDERED ? filtered.slice(0, MAX_RENDERED) : filtered;

  // When the user types in the search box, move the keyboard highlight to the
  // first match so ArrowDown/Enter operate on the visible results.
  useEffect(() => { if (open && query) setActiveIndex(0); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep the active option scrolled into view as it moves.
  useEffect(() => {
    if (open && optionRefs.current[activeIndex]) {
      optionRefs.current[activeIndex].scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  // WAI-ARIA listbox keyboard support — the combobox was operable only by
  // mouse before. Open with ArrowDown/Enter, move with Arrow/Home/End,
  // commit with Enter; Escape closes via the open-state document listener.
  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || (e.key === ' ' && !showSearch)) {
        e.preventDefault();
        toggle();
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, visible.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setActiveIndex(0); }
    else if (e.key === 'End') { e.preventDefault(); setActiveIndex(visible.length - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = visible[activeIndex];
      if (opt && !opt.disabled) pick(opt);
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
        aria-label={ariaLabel}
        className={`${className} inline-flex items-center justify-between gap-2 text-left ${
          disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
        }`}
        {...rest}
      >
        {/* min-w-0 is critical: without it a flex item defaults to
            min-width:auto which prevents truncate from shrinking
            below the text's natural width. Long product names then
            push adjacent grid cells sideways on mobile. */}
        <span
          title={labelText(displayLabel) || undefined}
          className={`truncate min-w-0 flex-1 ${isPlaceholder ? 'text-slate-400' : ''}`}
        >
          {displayLabel}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Hidden native mirror so browser `required` validation still
          fires and uncontrolled <form> submits still carry the value. */}
      {required && (
        <select
          name={name}
          value={current ?? ''}
          required
          onChange={() => {}}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        >
          <option value="" />
          {options
            .filter((o) => String(o.value) !== '')
            .map((o, i) => (
              <option key={i} value={o.value}>
                {labelText(o.label) || o.value}
              </option>
            ))}
        </select>
      )}

      {open &&
        createPortal(
          <div
            ref={listRef}
            style={menuStyle}
            className="z-[200] flex flex-col bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden"
          >
            {showSearch && (
              <div className="p-1.5 border-b border-slate-100 shrink-0">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  <input
                    // Don't steal focus on touch — the keyboard would cover
                    // the list the user is trying to read.
                    autoFocus={!narrowMenu}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Search…"
                    className="w-full pl-8 pr-2 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              </div>
            )}
            <ul role="listbox" className="overflow-auto py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-sm text-slate-400">No matches</li>
              ) : (
                visible.map((opt, i) => {
                  const isSelected = String(opt.value) === String(current ?? '');
                  const isActive = i === activeIndex;
                  return (
                    <li key={i} role="option" aria-selected={isSelected}>
                      <button
                        type="button"
                        ref={(el) => { optionRefs.current[i] = el; }}
                        disabled={opt.disabled}
                        onClick={() => pick(opt)}
                        onMouseEnter={() => setActiveIndex(i)}
                        className={`w-full flex items-start justify-between gap-2 text-left px-3 py-2.5 min-h-[44px] text-sm transition ${
                          opt.disabled
                            ? 'text-slate-300 cursor-not-allowed'
                            : isSelected
                              ? 'bg-primary-50 text-primary-700 font-medium'
                              : isActive
                                ? 'bg-primary-50/60 text-slate-900'
                                : 'text-slate-700 hover:bg-primary-50'
                        }`}
                      >
                        {/* Full label, wrapped. Truncating hid the part that
                            tells two similarly-named parties apart (…"Limit…"),
                            and there is no hover tooltip on touch. */}
                        <span className="whitespace-normal break-words leading-snug">{opt.label}</span>
                        {isSelected && <Check size={14} className="shrink-0 mt-0.5 text-primary-600" />}
                      </button>
                    </li>
                  );
                })
              )}
              {filtered.length > visible.length && (
                <li className="px-3 py-2 text-xs text-slate-400 text-center border-t border-slate-100">
                  {filtered.length - visible.length} more — type to narrow the search
                </li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}
