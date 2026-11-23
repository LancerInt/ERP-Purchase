import { useEffect, useState } from 'react';

/**
 * True while the viewport is below Tailwind's `sm` breakpoint (640px).
 *
 * For layout swaps CSS alone can't express — rendering a bottom sheet
 * instead of an anchored popover, or a ranked list instead of a chart.
 * Prefer plain Tailwind `sm:` classes for anything that IS expressible
 * in CSS; this is for choosing a different component tree.
 *
 * Uses matchMedia rather than a resize listener so it only fires when the
 * breakpoint is actually crossed.
 */
export default function useIsNarrow(breakpoint = 640) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < breakpoint,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = (e) => setNarrow(e.matches);
    setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [breakpoint]);
  return narrow;
}
