/**
 * CustomDatePicker — a modern, responsive drop-in for <input type="date">.
 *
 * Swap it in with no other changes:
 *
 *   <CustomDatePicker name="ship_date" value={v} onChange={handleChange}
 *     className="..." min="2026-01-01" max="2026-12-31" />
 *
 * Same API as the native input: `value` is an ISO "YYYY-MM-DD" string and
 * onChange fires a synthetic event ({ target:{ name, value } }) so handlers
 * using e.target.value / e.target.name keep working. `min`/`max` (ISO
 * strings) disable out-of-range days; `required` is mirrored to a hidden
 * native input so browser form validation still fires.
 *
 * Why custom: the native date input opens an OS calendar that is clipped /
 * awkward inside the mobile viewport and looks different on every browser.
 * This renders one compact, on-brand calendar in a portal (never clipped,
 * flips up when there's no room) for a consistent experience everywhere.
 */
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-react';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// Parse "YYYY-MM-DD" with NO timezone shift (local calendar date).
function parseISO(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { y: +m[1], mo: +m[2] - 1, d: +m[3] } : null;
}
function toISO(y, mo, d) {
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function fmtDisplay(v) {
  const p = parseISO(v);
  return p ? `${String(p.d).padStart(2, '0')} ${MONTHS[p.mo].slice(0, 3)} ${p.y}` : '';
}

export default function CustomDatePicker({
  value,
  onChange,
  name,
  id,
  disabled = false,
  required = false,
  min,
  max,
  placeholder = 'dd-mm-yyyy',
  className = '',
  'aria-label': ariaLabel,
  ...rest
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  // `mode` controls which grid the popover shows:
  //   'day'   – day picker (default, matches original behavior)
  //   'month' – month grid (for the current view year)
  //   'year'  – 12-year page grid (jumps by 12 years with prev/next)
  // Clicking the header labels drills up (day → month → year); picking
  // a value drills back down. Closing the popover resets to 'day'.
  const [mode, setMode] = useState('day');
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const parsed = parseISO(value);
  // Month being viewed in the calendar.
  const [view, setView] = useState(() => {
    if (parsed) return { y: parsed.y, mo: parsed.mo };
    const t = new Date();
    return { y: t.getFullYear(), mo: t.getMonth() };
  });

  // When the value changes (e.g. reset / prefilled), jump the calendar to it.
  useEffect(() => {
    const p = parseISO(value);
    if (p) setView({ y: p.y, mo: p.mo });
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = (e) => {
      if (popRef.current && popRef.current.contains(e.target)) return;
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
      const p = parseISO(value);
      if (p) setView({ y: p.y, mo: p.mo });
      // Always open in day mode; drill-down state is per-open.
      setMode('day');
    }
    setOpen((o) => !o);
  };

  const emit = (v) => onChange?.({ target: { name, value: v } });
  const pick = (d) => { emit(toISO(view.y, view.mo, d)); setOpen(false); };
  const stepMonth = (delta) => setView((v) => {
    const m = v.mo + delta;
    return { y: v.y + Math.floor(m / 12), mo: ((m % 12) + 12) % 12 };
  });
  const stepYear = (delta) => setView((v) => ({ ...v, y: v.y + delta }));

  const today = new Date();
  const todayKey = toISO(today.getFullYear(), today.getMonth(), today.getDate());
  const minP = parseISO(min);
  const maxP = parseISO(max);
  const outOfRange = (iso) => (min && iso < min) || (max && iso > max);

  // Calendar grid for the viewed month.
  const daysInMonth = new Date(view.y, view.mo + 1, 0).getDate();
  const firstDow = new Date(view.y, view.mo, 1).getDay();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  // Popover position (fixed, anchored to the trigger; flips up if cramped).
  const POP_H = 320;
  const below = rect ? window.innerHeight - rect.bottom : 9999;
  const dropUp = rect ? below < POP_H && rect.top > below : false;
  const popStyle = rect
    ? {
        position: 'fixed',
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
        width: 288,
        ...(dropUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      }
    : {};

  const display = fmtDisplay(value);

  return (
    <div className="relative">
      <button
        type="button"
        id={id}
        ref={btnRef}
        disabled={disabled}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`${className} inline-flex items-center justify-between gap-2 text-left ${
          disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
        }`}
        {...rest}
      >
        <span className={display ? 'text-slate-800 truncate' : 'text-slate-400 truncate'}>
          {display || placeholder}
        </span>
        <CalendarIcon size={16} className="shrink-0 text-slate-400" />
      </button>

      {/* Hidden native mirror so browser `required` validation still fires. */}
      {required && (
        <input
          type="date"
          name={name}
          value={value || ''}
          required
          onChange={() => {}}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        />
      )}

      {open &&
        createPortal(
          <div
            ref={popRef}
            style={popStyle}
            className="z-[200] bg-white border border-slate-200 rounded-xl shadow-lg p-3 select-none"
          >
            {/* Header — prev / label / next.
                Prev/next behavior depends on mode:
                  day   → ± 1 month   (chevrons single-step; span opens month grid)
                  month → ± 1 year    (span opens year grid)
                  year  → ± 12 years  (a "page" of years)
                Clicking the month or year label drills up to that picker. */}
            {(() => {
              const yearBlock = Math.floor(view.y / 12) * 12;
              const prev = () => {
                if (mode === 'day') stepMonth(-1);
                else if (mode === 'month') stepYear(-1);
                else stepYear(-12);
              };
              const next = () => {
                if (mode === 'day') stepMonth(1);
                else if (mode === 'month') stepYear(1);
                else stepYear(12);
              };
              const centerLabel =
                mode === 'day' ? (
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setMode('month')}
                      className="px-1.5 py-0.5 rounded hover:bg-slate-100"
                      title="Pick a month"
                    >{MONTHS[view.mo]}</button>
                    <button
                      type="button"
                      onClick={() => setMode('year')}
                      className="px-1.5 py-0.5 rounded hover:bg-slate-100"
                      title="Pick a year"
                    >{view.y}</button>
                  </span>
                ) : mode === 'month' ? (
                  <button
                    type="button"
                    onClick={() => setMode('year')}
                    className="px-2 py-0.5 rounded hover:bg-slate-100"
                    title="Pick a year"
                  >{view.y}</button>
                ) : (
                  <span className="px-1">{yearBlock} – {yearBlock + 11}</span>
                );
              return (
                <div className="flex items-center justify-between mb-2">
                  <button type="button" onClick={prev} className="p-1 rounded hover:bg-slate-100 text-slate-500" aria-label="Previous"><ChevronLeft size={16} /></button>
                  <span className="text-sm font-semibold text-slate-800 flex-1 text-center">{centerLabel}</span>
                  <button type="button" onClick={next} className="p-1 rounded hover:bg-slate-100 text-slate-500" aria-label="Next"><ChevronRight size={16} /></button>
                </div>
              );
            })()}

            {/* Body — one of day-grid, month-grid, or year-grid. */}
            {mode === 'day' && (
              <>
                <div className="grid grid-cols-7 gap-0.5 mb-1">
                  {WEEKDAYS.map((w) => (
                    <div key={w} className="text-center text-[10px] font-semibold uppercase text-slate-400 py-1">{w}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-0.5">
                  {cells.map((d, i) => {
                    if (d === null) return <div key={`b-${i}`} />;
                    const iso = toISO(view.y, view.mo, d);
                    const selected = value === iso;
                    const isToday = iso === todayKey;
                    const disabledDay = outOfRange(iso);
                    return (
                      <button
                        key={iso}
                        type="button"
                        disabled={disabledDay}
                        onClick={() => pick(d)}
                        className={`h-8 rounded-lg text-sm transition ${
                          disabledDay
                            ? 'text-slate-300 cursor-not-allowed'
                            : selected
                              ? 'bg-primary-600 text-white font-semibold'
                              : isToday
                                ? 'bg-primary-50 text-primary-700 font-semibold hover:bg-primary-100'
                                : 'text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {mode === 'month' && (
              <div className="grid grid-cols-3 gap-2">
                {MONTHS.map((m, i) => {
                  const active = i === view.mo && parsed?.y === view.y;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => { setView((v) => ({ ...v, mo: i })); setMode('day'); }}
                      className={`h-11 rounded-lg text-sm font-medium transition ${
                        active
                          ? 'bg-primary-600 text-white'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {m.slice(0, 3)}
                    </button>
                  );
                })}
              </div>
            )}

            {mode === 'year' && (() => {
              const yearBlock = Math.floor(view.y / 12) * 12;
              const years = Array.from({ length: 12 }, (_, i) => yearBlock + i);
              return (
                <div className="grid grid-cols-3 gap-2">
                  {years.map((y) => {
                    const active = y === view.y;
                    return (
                      <button
                        key={y}
                        type="button"
                        onClick={() => { setView((v) => ({ ...v, y })); setMode('month'); }}
                        className={`h-11 rounded-lg text-sm font-medium transition ${
                          active
                            ? 'bg-primary-600 text-white'
                            : 'text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {y}
                      </button>
                    );
                  })}
                </div>
              );
            })()}

            {/* Footer: Today / Clear */}
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  if (outOfRange(todayKey)) return;
                  emit(todayKey);
                  setOpen(false);
                }}
                className="text-xs font-medium text-primary-700 hover:underline disabled:text-slate-300"
                disabled={outOfRange(todayKey)}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => { emit(''); setOpen(false); }}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700"
              >
                <X size={12} /> Clear
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
