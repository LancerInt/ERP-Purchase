import { useEffect, useRef, useCallback } from 'react';
import { X, ArrowLeft } from 'lucide-react';

const SIZES = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', '2xl': 'max-w-6xl', full: 'max-w-[92vw]', screen: 'max-w-none w-screen' };

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal shell — the baseline every dialog should sit on:
 *   • Esc closes
 *   • focus moves into the dialog on open, is trapped (Tab cycles), and is
 *     restored to the trigger on close
 *   • body scroll is locked while open
 *   • role=dialog + aria-modal + aria-label(title)
 *
 *   <Modal isOpen onClose={fn} title="…" footer={<>…buttons…</>}>body</Modal>
 */
export default function Modal({
  isOpen = false,
  onClose = () => {},
  title,
  children,
  footer = null,
  size = 'md',
  closeOnBackdrop = true,
  // Render the close control as a left-aligned back arrow (page-style) instead of
  // an X on the right — natural for full-screen modals.
  closeLeft = false,
}) {
  const dialogRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    triggerRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => {
      const el = dialogRef.current;
      if (!el) return;
      const target = el.querySelector('[autofocus]') || el.querySelector(FOCUSABLE) || el;
      target.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      const trig = triggerRef.current;
      if (trig && typeof trig.focus === 'function') trig.focus();
    };
  }, [isOpen]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const el = dialogRef.current;
    if (!el) return;
    const items = el.querySelectorAll(FOCUSABLE);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" aria-hidden="true"
        onClick={closeOnBackdrop ? onClose : undefined} />
      <div className={`fixed inset-0 z-50 flex items-center justify-center pointer-events-none ${size === 'screen' ? 'p-0' : 'p-4'}`}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
          className={`pointer-events-auto bg-white shadow-xl w-full ${SIZES[size] || SIZES.md} ${size === 'screen' ? 'h-[100dvh] max-h-[100dvh] rounded-none' : 'rounded-xl max-h-[90dvh]'} flex flex-col focus:outline-none`}
        >
          {title && (
            closeLeft ? (
              <div className="flex items-center gap-3 px-4 sm:px-5 py-4 border-b border-slate-200 shrink-0">
                <button onClick={onClose} aria-label="Back" title="Back"
                  className="text-slate-500 hover:text-slate-900 transition rounded -ml-1">
                  <ArrowLeft size={22} />
                </button>
                <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
              </div>
            ) : (
              <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-slate-200 shrink-0">
                <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
                <button onClick={onClose} aria-label="Close" title="Close"
                  className="text-slate-500 hover:text-slate-700 transition rounded">
                  <X size={20} />
                </button>
              </div>
            )
          )}
          <div className="px-4 sm:px-5 py-5 overflow-y-auto">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-3 px-4 sm:px-5 py-4 border-t border-slate-200 bg-slate-50 rounded-b-xl shrink-0">
              {footer}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
