import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

/**
 * MobileBottomSheet — modal sheet that slides up from the bottom edge.
 *
 * Zoho-style for mobile filters / actions / pickers. Closes via the X
 * button, backdrop tap, swipe-down on the handle, or programmatically.
 *
 * Body scroll is locked while the sheet is open (pinning the page via
 * position:fixed because iOS Safari ignores plain `overflow: hidden` on
 * body). The handle bar at the top doubles as a swipe affordance —
 * touchmove > 80px down triggers close.
 *
 * The sheet renders inline (no portal). It's `lg:hidden` so it never
 * shows on desktop; pages should keep their existing filter UI for
 * desktop and use this for mobile.
 */
export default function MobileBottomSheet({
  open,
  onClose,
  title,
  children,
  footer,
  maxHeight = '85vh',
}) {
  const sheetRef = useRef(null);
  const touchStartY = useRef(0);
  const [dragOffset, setDragOffset] = useState(0);

  // Lock background scroll while open. Same pinning approach as the
  // sidebar drawer — iOS Safari needs `position:fixed` to actually
  // freeze the page beneath.
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = `-${scrollY}px`;
    document.body.classList.add('body-scroll-lock');
    return () => {
      document.body.classList.remove('body-scroll-lock');
      document.body.style.top = '';
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  // Esc-to-close for accessibility (and keyboard testing in dev tools).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleTouchStart = (e) => {
    touchStartY.current = e.touches[0].clientY;
    setDragOffset(0);
  };
  const handleTouchMove = (e) => {
    const dy = e.touches[0].clientY - touchStartY.current;
    if (dy > 0) setDragOffset(dy);
  };
  const handleTouchEnd = () => {
    if (dragOffset > 80) onClose?.();
    setDragOffset(0);
  };

  return (
    <div
      className={`fixed inset-0 z-50 lg:hidden print:hidden ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Sheet'}
        className={`absolute inset-x-0 bottom-0 bg-white rounded-t-2xl shadow-2xl transition-transform duration-300 ease-out flex flex-col ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{
          maxHeight,
          paddingBottom: 'env(safe-area-inset-bottom)',
          transform: open
            ? `translateY(${dragOffset}px)`
            : 'translateY(100%)',
        }}
      >
        {/* Handle + header */}
        <div
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="shrink-0 pt-2"
        >
          <div className="mx-auto h-1.5 w-10 rounded-full bg-slate-300 mb-2" aria-hidden="true" />
          {(title || onClose) && (
            <div className="flex items-center justify-between px-4 pb-3 border-b border-slate-100">
              <h3 className="text-[15px] font-semibold text-slate-900 truncate">{title}</h3>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="p-2 -mr-2 text-slate-500 hover:text-slate-700 active:bg-slate-100 rounded-lg"
              >
                <X size={18} />
              </button>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto ios-scroll overscroll-y-contain px-4 py-4">
          {children}
        </div>

        {/* Footer (pinned action bar) */}
        {footer && (
          <div className="shrink-0 border-t border-slate-100 px-4 py-3 bg-white">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
