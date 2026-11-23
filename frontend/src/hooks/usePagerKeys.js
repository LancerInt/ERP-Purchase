import { useEffect, useRef } from 'react';

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Is this element actually on screen right now?
 *
 * Presence in the DOM is NOT enough: the mobile nav drawer is permanently
 * mounted with role="dialog" aria-modal="true" and merely parked off-canvas
 * (`-translate-x-full`, plus `lg:hidden` on desktop). Testing for existence
 * alone made every page look like it had an open modal.
 */
function isOnScreen(el) {
  const cs = window.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0
    && r.right > 0 && r.left < window.innerWidth
    && r.bottom > 0 && r.top < window.innerHeight;
}

/**
 * Left / Right arrow keys page a list, so you aren't forced to reach for the
 * on-screen arrows every time.
 *
 * Deliberately narrow about when it fires — a global key handler that steals
 * arrows is worse than no shortcut at all. It stays out of the way when:
 *   • a modifier is held (Alt+Left is the browser's Back)
 *   • focus is in a text field, textarea, select or contenteditable
 *   • focus is inside a listbox / combobox / dialog — our CustomSelect and
 *     date picker both use arrows to move through their own options
 *   • any modal is open (`aria-modal`), so the list behind it stays put
 *   • something else already handled the event
 *
 * preventDefault only runs when a page actually changes, so arrow-scrolling
 * still works on a single-page list.
 *
 * @param {object}   opts
 * @param {Function} opts.onPrev   called for ArrowLeft
 * @param {Function} opts.onNext   called for ArrowRight
 * @param {boolean}  opts.enabled  pass false for single-page lists
 */
export default function usePagerKeys({ onPrev, onNext, enabled = true }) {
  // Callers pass fresh closures every render; park them in refs so the
  // listener is bound once per `enabled` change rather than on every render.
  const prevRef = useRef(onPrev);
  const nextRef = useRef(onNext);
  useEffect(() => {
    prevRef.current = onPrev;
    nextRef.current = onNext;
  });

  useEffect(() => {
    if (!enabled) return undefined;

    const onKey = (e) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

      const el = document.activeElement;
      if (el) {
        if (TYPING_TAGS.has(el.tagName) || el.isContentEditable) return;
        if (el.closest?.('[role="listbox"],[role="dialog"]')) return;
        // Only an OPEN combobox owns the arrow keys. A closed CustomSelect
        // trigger keeps focus after use and opens on ArrowDown/Enter, so
        // left/right there is free for us.
        if (el.closest?.('[aria-haspopup="listbox"][aria-expanded="true"]')) return;
      }
      // A drill-down / picker is genuinely open over the page — leave it alone.
      const modals = document.querySelectorAll('[aria-modal="true"]');
      for (const m of modals) {
        if (isOnScreen(m)) return;
      }

      if (e.key === 'ArrowLeft') prevRef.current?.();
      else nextRef.current?.();
      e.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
