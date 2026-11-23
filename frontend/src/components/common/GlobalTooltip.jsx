import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * One app-wide styled replacement for the browser's native `title` tooltip.
 *
 * Mounted once at the app root, it watches for hover over any element carrying
 * a `title` attribute, suppresses the native (unstyled, slow) tooltip by lifting
 * the attribute off the element while hovered, and renders a small styled
 * tooltip in its place. The `title` is restored on mouse-out, so nothing is lost
 * for the next hover or for assistive tech.
 *
 * This means every existing `title="…"` in the app gets the styled treatment
 * with zero per-component changes.
 */
const SHOW_DELAY = 350;   // ms — roughly the native delay, avoids flicker
const STASH = 'data-native-title';

export default function GlobalTooltip() {
  const [tip, setTip] = useState(null);   // { text, x, y, placement }
  const elRef = useRef(null);             // element whose title we lifted
  const timerRef = useRef(null);
  const tipRef = useRef(null);

  // Restore the lifted title back onto the element.
  const restore = () => {
    const el = elRef.current;
    if (el && el.getAttribute(STASH) != null) {
      el.setAttribute('title', el.getAttribute(STASH));
      el.removeAttribute(STASH);
    }
    elRef.current = null;
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    restore();
    setTip(null);
  };

  useEffect(() => {
    const onOver = (e) => {
      const el = e.target?.closest?.('[title]');
      if (!el || el === elRef.current) return;
      const text = el.getAttribute('title');
      if (!text || !text.trim()) return;
      // New target — tear down any previous one first.
      clearTimeout(timerRef.current);
      restore();
      // Lift the native title immediately so the browser tooltip never fires.
      el.setAttribute(STASH, text);
      el.removeAttribute('title');
      elRef.current = el;
      timerRef.current = setTimeout(() => {
        const r = el.getBoundingClientRect();
        // Below by default; flip above when near the bottom edge.
        const below = r.bottom + 8 + 40 < window.innerHeight;
        setTip({
          text,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(below ? r.bottom + 8 : r.top - 8),
          placement: below ? 'below' : 'above',
        });
      }, SHOW_DELAY);
    };
    const onOut = (e) => {
      if (elRef.current && (e.target === elRef.current || !elRef.current.contains(e.relatedTarget))) {
        hide();
      }
    };
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    // Any scroll/visibility change or click should dismiss it.
    const onScroll = () => hide();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('click', onScroll, true);
    document.addEventListener('keydown', onScroll, true);
    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('click', onScroll, true);
      document.removeEventListener('keydown', onScroll, true);
      clearTimeout(timerRef.current);
      restore();
    };
  }, []);

  // Clamp horizontally so it never spills off-screen.
  useEffect(() => {
    if (!tip || !tipRef.current) return;
    const w = tipRef.current.offsetWidth;
    const margin = 8;
    let left = tip.x - w / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    tipRef.current.style.left = `${left}px`;
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      style={{
        position: 'fixed',
        top: tip.placement === 'above' ? undefined : tip.y,
        bottom: tip.placement === 'above' ? window.innerHeight - tip.y : undefined,
        left: tip.x,
        maxWidth: 'min(320px, calc(100vw - 16px))',
        zIndex: 9999,
      }}
      className="pointer-events-none rounded-md bg-slate-800 px-2.5 py-1.5 text-[11.5px] leading-snug font-medium text-white shadow-lg ring-1 ring-black/10 whitespace-pre-line animate-[tipFade_120ms_ease-out]"
    >
      {tip.text}
    </div>,
    document.body,
  );
}
