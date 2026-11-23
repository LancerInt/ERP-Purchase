/**
 * Mobile back chevron shown before a page title.
 *
 * Mirrors the natural hierarchy Module > Submodule (list) > Detail:
 *
 *  - On a DETAIL / nested page (e.g. /purchase/requests/:id, or an RFQ
 *    opened by link from a PR) it does history back, returning to the
 *    exact page the user came from (the list, or the PR that linked it).
 *  - On a SUBMODULE ROOT page (a nav item like /purchase/requests) there
 *    is nowhere further back in-app, so it opens the parent MODULE menu
 *    (the bottom-nav drill-in list) — the module isn't a route, so this
 *    is how "up to the module" is expressed.
 *
 * This gives: RFQ -> PR detail -> PR list -> Purchase menu, one level
 * per tap, instead of looping through history.
 *
 * Visibility: the chevron shows on EVERY page and screen size. On detail /
 * nested pages it does history-back. On submodule ROOT pages it opens the
 * parent module menu on mobile, and on desktop (where the module menu has no
 * equivalent) it does history-back instead — so it's always a working "back".
 */
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { NAV_SECTIONS, getSectionIdForPath } from '../../constants/navigation.js';

export const OPEN_MODULE_MENU_EVENT = 'open-module-menu';

const isSubmoduleRoot = (path) =>
  NAV_SECTIONS.some((s) => s.items.some((i) => i.path === path));

export default function BackToModule({ className = '' }) {
  const navigate = useNavigate();
  const location = useLocation();

  const onBack = () => {
    const path = location.pathname;
    // The module menu is a MOBILE-only drill-in list (no desktop equivalent —
    // the docked sidebar handles that). So on a submodule ROOT page open it only
    // on mobile; on desktop fall through to plain history-back so the chevron is
    // a useful "back" on every page.
    const isDesktop = typeof window !== 'undefined'
      && window.matchMedia('(min-width: 1024px)').matches;
    if (isSubmoduleRoot(path) && !isDesktop) {
      const sectionId = getSectionIdForPath(path);
      if (sectionId) {
        window.dispatchEvent(
          new CustomEvent(OPEN_MODULE_MENU_EVENT, { detail: { sectionId } }),
        );
        return;
      }
    }

    // Anything else -> back to the page the user came from.
    const hasHistory =
      window.history.state && typeof window.history.state.idx === 'number'
        ? window.history.state.idx > 0
        : window.history.length > 1;
    if (hasHistory) {
      navigate(-1);
      return;
    }

    // Deep-linked with no history: a root page has nowhere to climb, so go
    // Home; a detail page climbs one URL level (detail -> list).
    if (isSubmoduleRoot(path)) {
      navigate('/home');
      return;
    }
    const parent = path.replace(/\/[^/]+\/?$/, '');
    navigate(parent || '/home');
  };

  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="Back"
      className={`-ml-1 shrink-0 p-2 rounded-lg text-slate-500 hover:bg-slate-100 active:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${className}`}
    >
      <ChevronLeft size={22} />
    </button>
  );
}
