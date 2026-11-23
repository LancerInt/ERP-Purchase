/**
 * CustomTimePicker — on-brand drop-in for <input type="time">.
 *
 * Same API as the native input: `value` is an ISO "HH:MM" string and
 * onChange fires a synthetic event ({ target: { name, value } }) so
 * handlers using e.target.value / e.target.name keep working.
 *
 *   <CustomTimePicker name="started" value={v} onChange={handleChange}
 *     className="..." />
 *
 * Why custom: native <input type="time"> opens an OS-styled spinner that
 * looks different on every browser and doesn't match the app's
 * CustomDatePicker calendar. This renders a portal-anchored 24-hour
 * grid + minute column with the same visual language.
 */
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Clock as ClockIcon, X } from 'lucide-react';

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
// 5-minute granularity by default — production-log accuracy without a
// 60-item scroll. Operators can still type any minute in the input.
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

function _split(v) {
  if (!v) return { h: '', m: '' };
  const m = String(v).match(/^(\d{2}):(\d{2})/);
  return m ? { h: m[1], m: m[2] } : { h: '', m: '' };
}
function _join(h, m) {
  if (!h && !m) return '';
  return `${h || '00'}:${m || '00'}`;
}
function _fmt(v) {
  const p = _split(v);
  return p.h && p.m ? `${p.h}:${p.m}` : '';
}

export default function CustomTimePicker({
  value,
  onChange,
  name,
  id,
  disabled = false,
  placeholder = '--:--',
  className = '',
  'aria-label': ariaLabel,
  ...rest
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const wrapRef = useRef(null);
  const panelRef = useRef(null);

  // Track anchor position for portal-rendered panel.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setRect(r);
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  // Click-outside closes the panel.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const emit = (next) => {
    if (onChange) onChange({ target: { name: name || '', value: next } });
  };

  const { h, m } = _split(value);
  const shown = _fmt(value);

  const pickHour = (hv) => emit(_join(hv, m || '00'));
  const pickMinute = (mv) => emit(_join(h || '00', mv));

  const clear = () => { emit(''); setOpen(false); };

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-label={ariaLabel || 'Pick time'}
        id={id}
        className={`w-full px-3 py-2 text-left border rounded-lg text-sm flex items-center justify-between ${
          disabled
            ? 'bg-slate-100 cursor-not-allowed text-slate-500 border-slate-200'
            : 'bg-white border-slate-300 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500'
        }`}
        {...rest}
      >
        <span className={shown ? 'text-slate-800 font-mono' : 'text-slate-400'}>
          {shown || placeholder}
        </span>
        <ClockIcon size={14} className="text-slate-400 shrink-0" />
      </button>

      {open && rect && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            top: rect.bottom + 6,
            left: rect.left,
            minWidth: Math.max(rect.width, 240),
            zIndex: 60,
          }}
          className="bg-white rounded-lg shadow-lg border border-slate-200 p-2"
        >
          <div className="flex items-center justify-between px-1 pb-2 mb-1 border-b border-slate-100">
            <span className="text-xs font-medium text-slate-600">Pick time (24h)</span>
            {value && (
              <button
                type="button"
                onClick={clear}
                className="text-slate-400 hover:text-red-600 p-0.5 rounded"
                title="Clear"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className="flex gap-2" style={{ maxHeight: 220 }}>
            {/* Hours column — 6x4 grid so it fits without scrolling. */}
            <div className="flex-1">
              <div className="text-[10px] text-slate-500 uppercase tracking-wide pb-1 pl-1">Hour</div>
              <div className="grid grid-cols-4 gap-1 overflow-y-auto pr-1" style={{ maxHeight: 190 }}>
                {HOURS.map((hv) => (
                  <button
                    key={hv}
                    type="button"
                    onClick={() => pickHour(hv)}
                    className={`px-2 py-1 text-xs font-mono rounded border ${
                      hv === h
                        ? 'bg-primary-600 text-white border-primary-600'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {hv}
                  </button>
                ))}
              </div>
            </div>
            {/* Minutes column — 5-minute granularity. */}
            <div className="w-20">
              <div className="text-[10px] text-slate-500 uppercase tracking-wide pb-1 pl-1">Min</div>
              <div className="grid grid-cols-2 gap-1 overflow-y-auto pr-1" style={{ maxHeight: 190 }}>
                {MINUTES.map((mv) => (
                  <button
                    key={mv}
                    type="button"
                    onClick={() => pickMinute(mv)}
                    className={`px-2 py-1 text-xs font-mono rounded border ${
                      mv === m
                        ? 'bg-primary-600 text-white border-primary-600'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {mv}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
