import { useState, useEffect, useLayoutEffect, useRef, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { signOut } from '../../store/slices/authSlice';
import usePermissions from '../../hooks/usePermissions.js';

import {
  LayoutDashboard, ShoppingCart, Package, DollarSign,
  BarChart3, Settings,
  FileText, Send, MessageSquare, ClipboardCheck, Truck, Receipt,
  CreditCard, FileCheck, Users, Building2, Factory, Box,
  UserCircle, LogOut, ChevronDown, Bell,
  Briefcase, Shield, Mail,
  Tags, Calculator, BookOpen, Wrench, Handshake, Map,
  PanelLeftClose, PanelLeftOpen, GitBranch, XCircle,
  CalendarDays, ArrowDownLeft, ArrowUpRight, Wallet,
  X, Search,
} from 'lucide-react';
import { NAV_SECTIONS as SIDEBAR_SECTIONS, getRoleNavOrder, getRoleMenu, getAdminNavOrder } from '../../constants/navigation.js';
import TallySyncSidebarButton from './TallySyncSidebarButton.jsx';

// Context so MainLayout can read collapsed state
export const SidebarContext = createContext({ isCollapsed: false });
export const useSidebar = () => useContext(SidebarContext);


// Tooltip for collapsed mode. Rendered through a portal to <body> with
// fixed positioning so it escapes the nav's `overflow-x-hidden` scroll
// container (an in-flow absolute tooltip got clipped and never showed).
function Tooltip({ children, text, show }) {
  const ref = useRef(null);
  const [coords, setCoords] = useState(null);

  if (!show) return children;

  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setCoords({ top: r.top + r.height / 2, left: r.right + 8 });
  };

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={place}
      onMouseLeave={() => setCoords(null)}
      onFocus={place}
      onBlur={() => setCoords(null)}
    >
      {children}
      {coords && createPortal(
        <div
          role="tooltip"
          style={{ position: 'fixed', top: coords.top, left: coords.left, transform: 'translateY(-50%)' }}
          className="px-2.5 py-1.5 bg-slate-800 text-white text-xs rounded-md whitespace-nowrap shadow-lg pointer-events-none z-[2000]"
        >
          {text}
          <span className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-slate-800" />
        </div>,
        document.body,
      )}
    </div>
  );
}

export default function Sidebar({ onCollapseChange, mobileOpen: mobileOpenProp, onMobileClose }) {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();
  const user = useSelector((state) => state.auth?.user);
  const unreadCount = useSelector((state) => state.notifications?.unreadCount ?? 0);
  const { canView, isAdmin, isSuperuser, role, isLoading: permsLoading } = usePermissions();

  // Collapsed state with localStorage persistence
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebar-collapsed');
    return saved === 'true';
  });

  // Section collapse state — every module section starts COLLAPSED so the
  // desktop sidebar reads as a compact module list; the user expands only
  // the modules they work in. Explicit expansions are remembered in
  // localStorage so they survive navigation (each page renders its own
  // MainLayout, remounting this Sidebar) and future sessions.
  const EXPANDED_SECTIONS_KEY = 'sidebar-expanded-sections';
  const NAV_SCROLL_KEY = 'sidebar-nav-scroll';
  const [collapsedSections, setCollapsedSections] = useState(() => {
    let expanded = {};
    try {
      expanded = JSON.parse(localStorage.getItem(EXPANDED_SECTIONS_KEY)) || {};
    } catch { /* corrupt storage → fall back to all collapsed */ }
    const defaults = {};
    SIDEBAR_SECTIONS.forEach((s) => {
      if (s.label && !expanded[s.id]) defaults[s.id] = true;
    });
    return defaults;
  });

  // Mobile drawer is controlled by MainLayout via props; fall back to
  // internal state if the parent doesn't supply it (e.g. standalone use).
  const [internalMobileOpen, setInternalMobileOpen] = useState(false);
  const mobileOpen = mobileOpenProp ?? internalMobileOpen;
  const closeMobile = () => {
    onMobileClose?.();
    setInternalMobileOpen(false);
  };

  // Mobile-only UI state: search query and per-section collapse overrides.
  // The mobile drawer auto-collapses every section that doesn't contain the
  // active route to cut down on scrolling; this map only stores values
  // when the user explicitly toggles a section, so the default heuristic
  // keeps working until they intervene.
  const [mobileSearch, setMobileSearch] = useState('');
  const [mobileCollapsedSections, setMobileCollapsedSections] = useState({});

  // Reset transient mobile UI when the drawer closes so it opens fresh
  // next time instead of remembering a half-typed search.
  useEffect(() => {
    if (!mobileOpen) {
      setMobileSearch('');
      setMobileCollapsedSections({});
    }
  }, [mobileOpen]);

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', isCollapsed);
    onCollapseChange?.(isCollapsed);
  }, [isCollapsed, onCollapseChange]);

  // Close mobile sidebar on route change
  useEffect(() => {
    closeMobile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Lock body scroll while the mobile drawer is open. iOS Safari
  // ignores plain `overflow: hidden` on <body> — touches on the
  // backdrop still rubber-band the underlying page — so we pin the
  // body via `position: fixed` and offset it by the current scroll
  // position, then restore that scroll position on unlock. The class
  // `body-scroll-lock` in globals.css does the pinning; the inline
  // `top` value preserves where the user was reading.
  useEffect(() => {
    if (!mobileOpen) return;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = `-${scrollY}px`;
    document.body.classList.add('body-scroll-lock');
    return () => {
      document.body.classList.remove('body-scroll-lock');
      document.body.style.top = '';
      // Restore the scroll position the user was at before the lock.
      window.scrollTo(0, scrollY);
    };
  }, [mobileOpen]);

  // Auto-scroll the active sidebar item into view on first mount /
  // route change. Without this, the sidebar's internal scroll
  // container resets to the top on browser refresh, which makes the
  // currently-active page (e.g. Customer Advances, far below the
  // fold) look like it's missing — the user would see "Dashboard"
  // at the top and assume the active item silently jumped there.
  // We query the active button via a data-attribute set in the
  // render loop below; using a query (rather than a ref) keeps the
  // active-item search resilient to permission-filtered items
  // being added/removed.
  // Two separate refs: the desktop-docked nav and the mobile-drawer nav are
  // BOTH always mounted (hidden by a `lg:hidden` / `hidden lg:block` CSS
  // class per breakpoint, never conditionally rendered) — they used to
  // share one ref object, which meant whichever one attached last "won"
  // and the other's real scroll position was silently ignored. `offsetParent`
  // is null for a `display: none` element, which reliably tells them apart
  // regardless of DOM/attachment order.
  const navScrollRef = useRef(null);
  const mobileNavScrollRef = useRef(null);
  const activeNav = () => {
    const d = navScrollRef.current, m = mobileNavScrollRef.current;
    if (d && d.offsetParent !== null) return d;
    if (m && m.offsetParent !== null) return m;
    return d || m || null;
  };

  // The Sidebar remounts on every navigation (see the persisted-sections note
  // below), so its internal scroll otherwise snaps back to the top each time —
  // clicking an item far down (e.g. the SALES section) bounced the list to the
  // top and lost the user's place. Persist the nav scrollTop across the remount
  // and restore it before paint (useLayoutEffect = no visible jump). Fall back
  // to bringing the active item into view only when there's nothing saved
  // (first load / fresh session / browser refresh).
  useLayoutEffect(() => {
    const nav = activeNav();
    if (!nav) return;
    let restored = false;
    try {
      const saved = sessionStorage.getItem(NAV_SCROLL_KEY);
      if (saved != null) { nav.scrollTop = parseInt(saved, 10) || 0; restored = true; }
    } catch { /* private mode / quota */ }
    if (!restored) {
      const el = nav.querySelector('[data-sidebar-active="true"]');
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }, [location.pathname]);

  // Re-assert the restored position for a short window after mount —
  // confirmed live via console trace that this useLayoutEffect's restore
  // succeeds (correct scrollTop applied before paint), but some OTHER
  // same-tick-or-later passive effect elsewhere in the tree (App.jsx's
  // ScrollToTop, which runs `window.scrollTo(0,0)` on every non-POP
  // navigation, is the only other route-change-triggered scroll code in
  // the app) then knocks it back to 0 moments later. A single one-frame
  // correction won races most of the time but not always — a heavier
  // navigation (lazy-loaded chunk, extra data-fetch renders) can push the
  // reset later than one frame, past a single correction. Rather than risk
  // touching ScrollToTop — its POP/PUSH split already fixed a separate,
  // documented back-navigation bug elsewhere — this instead keeps
  // correcting on every frame for ~500ms, which comfortably covers a slow
  // navigation without guessing the exact culprit's timing.
  useEffect(() => {
    let saved = null;
    try { saved = sessionStorage.getItem(NAV_SCROLL_KEY); } catch { /* ignore */ }
    if (saved == null) return undefined;
    const top = parseInt(saved, 10) || 0;
    let rafId;
    let frame = 0;
    const MAX_FRAMES = 30; // ~500ms at 60fps
    const reassert = () => {
      const nav = activeNav();
      if (nav && Math.round(nav.scrollTop) !== top) { nav.scrollTop = top; }
      frame += 1;
      if (frame < MAX_FRAMES) rafId = requestAnimationFrame(reassert);
    };
    rafId = requestAnimationFrame(reassert);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const handleNavScroll = (e) => {
    try { sessionStorage.setItem(NAV_SCROLL_KEY, String(e.currentTarget.scrollTop)); } catch { /* ignore */ }
  };

  // Belt-and-braces for the same persistence: the `onScroll` save above is
  // reactive and can miss the truly final position — e.g. clicking a nav
  // item fires a route change (unmounting this Sidebar) essentially
  // instantly, and if that happens to race the browser's last scroll event
  // for the gesture that just settled, the saved value stays one scroll
  // "behind" what the user actually saw. Reading the live DOM value at the
  // exact moment of unmount (rather than trusting the last dispatched
  // event) is unconditionally correct, so it's saved again here.
  useEffect(() => {
    return () => {
      const nav = activeNav();
      if (!nav) return;
      try { sessionStorage.setItem(NAV_SCROLL_KEY, String(nav.scrollTop)); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCollapse = () => setIsCollapsed((prev) => !prev);

  const toggleSection = (sectionId) => {
    if (isCollapsed) return;
    setCollapsedSections((prev) => {
      const next = { ...prev, [sectionId]: !prev[sectionId] };
      // Persist the expanded set (inverse of `next`) so user choices
      // survive the per-navigation Sidebar remount.
      const expanded = {};
      SIDEBAR_SECTIONS.forEach((s) => {
        if (s.label && !next[s.id]) expanded[s.id] = true;
      });
      try { localStorage.setItem(EXPANDED_SECTIONS_KEY, JSON.stringify(expanded)); } catch { /* quota/private mode */ }
      return next;
    });
  };

  const isActive = (path) => {
    // The old unified /freight entry is gone — sidebar now only points
    // at the dedicated Inward / Outward pages. Each entry stays
    // highlighted across its list, create, and detail routes.
    if (path === '/freight/inward')
      return location.pathname.startsWith('/freight/inward')
        || location.pathname.startsWith('/freight/purchase/')
        || location.pathname === '/freight'
        || location.pathname === '/freight/new';
    if (path === '/freight/outward')
      return location.pathname.startsWith('/freight/outward')
        || location.pathname.startsWith('/freight/sales/');
    // Match the path exactly, or as a parent of a sub-route (path + '/').
    // Plain startsWith() is wrong here: '/masters/machinery' is a prefix
    // of '/masters/machinery-division' and '/masters/machinery-expense',
    // so it would light up Machinery on those pages too (two active items).
    if (location.pathname === path) return true;
    if (!location.pathname.startsWith(path + '/')) return false;
    // Active as a parent of a sub-route — UNLESS a more specific sibling nav
    // item also matches (e.g. '/freight/wages' must NOT stay active on
    // '/freight/wages/payments', which is its own nav item).
    const matchesDeeper = SIDEBAR_SECTIONS.some((s) => s.items.some((it) =>
      it.path !== path
      && it.path.startsWith(path + '/')
      && (location.pathname === it.path || location.pathname.startsWith(it.path + '/'))));
    return !matchesDeeper;
  };

  const handleLogout = () => {
    dispatch(signOut());
    navigate('/login');
  };

  // Roles with a hand-curated menu (e.g. Office Management) see only the
  // whitelisted sections/items, in the order declared in navigation.js.
  // Permission filtering below still applies on top, so this never grants
  // access — it only hides items the role shouldn't be bothered with.
  const roleMenu = getRoleMenu(role);
  const baseSections = roleMenu || SIDEBAR_SECTIONS;

  // Filter sections and items by permissions (show all while loading)
  const accessibleSections = baseSections.map((section) => {
    if (section.adminOnly && !isAdmin && !isSuperuser && !permsLoading) return null;

    const filteredItems = section.items.filter((item) => {
      // Items flagged superuserOnly are hidden from everyone except Django
      // superusers — covers the Product Mismatch Logs admin page.
      if (item.superuserOnly && !isSuperuser) return false;
      if (!item.module) return true;
      if (permsLoading) return true; // Show all items while loading
      return canView(item.module);
    });

    if (filteredItems.length === 0) return null;
    return { ...section, items: filteredItems };
  }).filter(Boolean);

  // Order sections. Admins / superusers get the admin lead order
  // (User/Admin, Purchase, Sales, Expenses, Freight, Reports first, then
  // the rest — nothing hidden). Everyone else: their primary module first
  // (matches the mobile bottom-nav order), then the default order. Skipped
  // entirely for a curated role menu, which carries its own explicit order.
  if (!roleMenu) {
    const navOrder = (isAdmin || isSuperuser) ? getAdminNavOrder() : getRoleNavOrder(role);
    const sectionRank = (id) => {
      const i = navOrder.indexOf(id);
      return i === -1 ? 999 : i;
    };
    accessibleSections.sort((a, b) => sectionRank(a.id) - sectionRank(b.id));
  }

  const sidebarWidth = isCollapsed ? 'w-16' : 'w-[260px]';

  const sectionContainsActive = (section) =>
    section.items.some((i) => isActive(i.path));

  const sidebarContent = (
    <div className={`flex flex-col h-full bg-white border-r border-slate-200 ${sidebarWidth} transition-all duration-200 ease-in-out print:hidden`}>
      {/* Safe-area spacer for iOS notch / Dynamic Island. The brand row
          sits flush below it so the logo never hides under the cutout. */}
      <div className="pt-safe shrink-0" />

      {/* Brand area — doubles as the primary collapse/expand control.
          Collapsed: the logo IS the expand button (tooltip'd). Expanded:
          brand on the left, a panel toggle on the right. The bottom
          "Collapse" button is kept as a secondary affordance. */}
      <div className={`flex items-center h-16 border-b border-slate-100 shrink-0 ${isCollapsed ? 'justify-center px-2' : 'px-5'}`}>
        {isCollapsed ? (
          <Tooltip text="Expand sidebar" show>
            <button
              onClick={toggleCollapse}
              aria-label="Expand sidebar"
              className="group/brand relative w-8 h-8 bg-gradient-to-br from-primary-500 to-primary-700 rounded-lg flex items-center justify-center shadow-sm hover:brightness-110 transition"
            >
              {/* Logo by default; morph to an expand chevron on hover so
                  it's clear the logo is clickable to open the rail. */}
              <span className="text-white font-bold text-sm group-hover/brand:opacity-0 transition-opacity">L</span>
              <PanelLeftOpen size={16} strokeWidth={2} className="absolute text-white opacity-0 group-hover/brand:opacity-100 transition-opacity" />
            </button>
          </Tooltip>
        ) : (
          <>
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 bg-gradient-to-br from-primary-500 to-primary-700 rounded-lg flex items-center justify-center shadow-sm shrink-0">
                <span className="text-white font-bold text-sm">L</span>
              </div>
              <div className="min-w-0">
                <h1 className="text-[15px] font-semibold text-slate-800 leading-tight truncate">Lancer ERP</h1>
              </div>
            </div>
            <button
              onClick={toggleCollapse}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="ml-auto shrink-0 p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            >
              <PanelLeftClose size={18} strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>

      {/* Scrollable nav area — `ios-scroll` adds touch momentum and
          contains rubber-band so the drawer scrolls smoothly on iPhone
          without dragging the underlying page. */}
      <nav ref={navScrollRef} onScroll={handleNavScroll} className="flex-1 overflow-y-auto overflow-x-hidden py-2 sidebar-scroll ios-scroll overscroll-y-contain">
        {/* Notifications — pinned at the TOP of the rail (Inbox pattern).
            Time-sensitive items (approvals, QC) deserve a high-visibility
            anchor rather than the footer; the unread count shows as a
            right-aligned pill when expanded and as a badge on the bell
            when collapsed so it survives the icon-only state. */}
        <div className="px-2 pb-2 mb-1 border-b border-slate-100">
          <Tooltip text={unreadCount > 0 ? `Notifications (${unreadCount})` : 'Notifications'} show={isCollapsed}>
            <button
              onClick={() => navigate('/notifications')}
              data-sidebar-active={isActive('/notifications') ? 'true' : undefined}
              aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
              className={`w-full flex items-center gap-2.5 rounded-lg transition-colors duration-100
                ${isCollapsed ? 'justify-center px-2 py-2' : 'px-3 py-[7px]'}
                ${isActive('/notifications')
                  ? 'bg-primary-50 text-primary-700 font-medium'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}
              `}
            >
              <span className="relative shrink-0">
                <Bell
                  size={18}
                  strokeWidth={isActive('/notifications') ? 2 : 1.5}
                  className={isActive('/notifications') ? 'text-primary-600' : 'text-slate-400'}
                />
                {isCollapsed && unreadCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-1 flex items-center justify-center text-[9px] font-bold text-white bg-red-500 rounded-full">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </span>
              {!isCollapsed && <span className="text-[13px] flex-1 text-left">Notifications</span>}
              {!isCollapsed && unreadCount > 0 && (
                <span className="min-w-[20px] h-5 px-1.5 flex items-center justify-center text-[11px] font-bold text-white bg-red-500 rounded-full">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
          </Tooltip>
        </div>

        {/* Standalone (no Tally): Tally sync sidebar button removed. */}

        {accessibleSections.map((section) => (
          <div key={section.id} className={section.label ? 'mt-1' : ''}>
            {/* Section header */}
            {section.label && !isCollapsed && (
              <button
                onClick={() => toggleSection(section.id)}
                className="w-full flex items-center justify-between px-5 pt-4 pb-1.5 group cursor-pointer"
                aria-expanded={!collapsedSections[section.id]}
              >
                {/* Tint the label of the module that owns the active route
                    (expanded or collapsed) so the user can always tell
                    which module they're in. */}
                <span className={`text-[11px] font-semibold uppercase tracking-wider select-none ${
                  sectionContainsActive(section)
                    ? 'text-primary-600'
                    : 'text-slate-400 group-hover:text-slate-600'
                }`}>
                  {section.label}
                </span>
                <ChevronDown
                  size={12}
                  className={`text-slate-400 transition-transform duration-200 opacity-60 group-hover:opacity-100 ${
                    collapsedSections[section.id] ? '-rotate-90' : ''
                  }`}
                />
              </button>
            )}

            {/* Collapsed mode: a small centered module label above its icon
                group so it's always clear which module the icons belong to
                (tinted when the group owns the active route). */}
            {section.label && isCollapsed && (
              <div className="mt-3 mb-1.5 px-1">
                <div className="border-t border-slate-100 mb-1.5" />
                <p className={`text-[8px] leading-[1.15] font-semibold uppercase tracking-tight text-center ${
                  sectionContainsActive(section) ? 'text-primary-600' : 'text-slate-400'
                }`}>
                  {section.label}
                </p>
              </div>
            )}

            {/* Section items. In icon-only (collapsed) mode ALWAYS show every
                module's icons — the per-section accordion state applies only
                to the expanded sidebar. (Previously this gated on
                collapsedSections even when collapsed, so the icon rail was
                blank for any module the user hadn't expanded.) */}
            {(isCollapsed || !collapsedSections[section.id]) && (
              <div className="space-y-0.5 px-2">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.path);

                  return (
                    <Tooltip key={item.path} text={item.name} show={isCollapsed}>
                      <button
                        onClick={() => navigate(item.path)}
                        data-sidebar-active={active ? 'true' : undefined}
                        className={`w-full flex items-center gap-2.5 rounded-lg transition-colors duration-100 group/item
                          ${isCollapsed ? 'justify-center px-2 py-2' : 'px-3 py-[7px]'}
                          ${active
                            ? 'bg-primary-50 text-primary-700 font-medium'
                            : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                          }
                        `}
                      >
                        <Icon
                          size={18}
                          strokeWidth={active ? 2 : 1.5}
                          className={`shrink-0 ${active ? 'text-primary-600' : 'text-slate-400 group-hover/item:text-slate-600'}`}
                        />
                        {!isCollapsed && (
                          <span className={`text-[13px] truncate ${active ? 'font-medium' : ''}`}>
                            {item.name}
                          </span>
                        )}
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            )}

            {/* Collapsed section indicator (show collapsed state) */}
            {collapsedSections[section.id] && !isCollapsed && (
              <div className="px-5 py-1">
                <div className="border-t border-dashed border-slate-200" />
              </div>
            )}
          </div>
        ))}
      </nav>

      {/* Bottom section — pb-safe lifts the logout button above the
          iPhone home indicator so it never sits underneath the gesture
          bar. No-ops on devices without an inset. */}
      <div className="shrink-0 border-t border-slate-100 pb-safe">
        {/* Collapse toggle */}
        <div className={`px-2 py-2 ${isCollapsed ? 'flex justify-center' : ''}`}>
          <Tooltip text={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} show={isCollapsed}>
            <button
              onClick={toggleCollapse}
              aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={`flex items-center gap-2.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors duration-100
                ${isCollapsed ? 'justify-center p-2' : 'px-3 py-[7px] w-full'}
              `}
            >
              {isCollapsed ? <PanelLeftOpen size={18} strokeWidth={1.5} /> : <PanelLeftClose size={18} strokeWidth={1.5} />}
              {!isCollapsed && <span className="text-[13px]">Collapse</span>}
            </button>
          </Tooltip>
        </div>

        {/* User profile / logout. Identity card is clickable → opens
            the Profile page. Settings was removed; profile is now the
            single entry point for "account stuff". */}
        <div className={`px-2 pb-3 ${isCollapsed ? '' : ''}`}>
          {!isCollapsed && (
            <Tooltip text="View profile" show={false}>
              <button
                onClick={() => navigate('/profile')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 mb-1 rounded-md hover:bg-slate-50 transition-colors text-left ${
                  isActive('/profile') ? 'bg-primary-50' : ''
                }`}
              >
                <div className="w-7 h-7 bg-gradient-to-br from-primary-500 to-primary-700 rounded-full flex items-center justify-center shrink-0 shadow-sm">
                  <span className="text-white text-xs font-semibold">{user?.name?.charAt(0) || 'U'}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-slate-700 truncate">{user?.name || 'User'}</p>
                  {/* Second line shows the user's ROLE (not a duplicate of the
                      name) — same resolution the role pill below uses. */}
                  <p className="text-[11px] text-slate-400 truncate">
                    {(typeof role === 'string' ? role : role?.name)
                      || (isSuperuser ? 'Superuser' : isAdmin ? 'Administrator' : 'Member')}
                  </p>
                </div>
              </button>
            </Tooltip>
          )}
          {isCollapsed && (
            <Tooltip text="View profile" show={isCollapsed}>
              <button
                onClick={() => navigate('/profile')}
                aria-label={`View profile — ${user?.name || 'User'}`}
                className="w-full flex items-center justify-center px-2 py-2 mb-1 rounded-md hover:bg-slate-50 transition-colors"
              >
                <div className="w-7 h-7 bg-gradient-to-br from-primary-500 to-primary-700 rounded-full flex items-center justify-center shrink-0 shadow-sm">
                  <span className="text-white text-xs font-semibold">{user?.name?.charAt(0) || 'U'}</span>
                </div>
              </button>
            </Tooltip>
          )}
          <Tooltip text="Logout" show={isCollapsed}>
            <button
              onClick={handleLogout}
              aria-label="Logout"
              className={`w-full flex items-center gap-2.5 rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 transition-colors duration-100
                ${isCollapsed ? 'justify-center px-2 py-2' : 'px-3 py-[7px]'}
              `}
            >
              <LogOut size={18} strokeWidth={1.5} className="shrink-0" />
              {!isCollapsed && <span className="text-[13px]">Logout</span>}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );

  // ── Mobile-only sidebar ─────────────────────────────────────────────
  // Standalone variant tailored for the phone drawer: sticky brand+close
  // header, tappable user card up top (opens the Profile page), search
  // input that filters items live, and sections that default to
  // collapsed unless they hold the active route. The desktop
  // `sidebarContent` above stays untouched.
  const isMobileSectionCollapsed = (section) => {
    // While searching, force every matching section open so the user
    // sees their hits without a second tap.
    if (mobileSearch.trim()) return false;
    if (mobileCollapsedSections[section.id] !== undefined) {
      return mobileCollapsedSections[section.id];
    }
    // Header-less main section (Dashboard) is always visible.
    if (!section.label) return false;
    // Collapse unless this section owns the current route.
    return !sectionContainsActive(section);
  };

  const toggleMobileSection = (section) => {
    const current = isMobileSectionCollapsed(section);
    setMobileCollapsedSections((prev) => ({ ...prev, [section.id]: !current }));
  };

  // Case-insensitive substring filter across item names. Empty query →
  // pass-through. Sections that have no matches drop out so the list
  // doesn't show empty headers while typing.
  const mobileSections = (() => {
    const q = mobileSearch.trim().toLowerCase();
    if (!q) return accessibleSections;
    return accessibleSections
      .map((section) => ({
        ...section,
        items: section.items.filter((i) => i.name.toLowerCase().includes(q)),
      }))
      .filter((section) => section.items.length > 0);
  })();

  const mobileSidebarContent = (
    <div className="flex flex-col h-full bg-white w-[290px] max-w-[88vw]">
      <div className="pt-safe shrink-0" />

      {/* Sticky header — brand + close. Larger close target than the
          old design and the X icon is conventional for "dismiss". */}
      <div className="flex items-center justify-between h-14 px-4 border-b border-slate-100 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 bg-gradient-to-br from-primary-500 to-primary-700 rounded-lg flex items-center justify-center shadow-sm shrink-0 shadow-sm">
            <span className="text-white font-bold text-sm">L</span>
          </div>
          <h1 className="text-[15px] font-semibold text-slate-800 leading-tight truncate">Lancer ERP</h1>
        </div>
        <button
          onClick={closeMobile}
          className="p-2 -mr-2 text-slate-500 hover:text-slate-700 active:bg-slate-100 rounded-lg"
          aria-label="Close menu"
        >
          <X size={20} />
        </button>
      </div>

      {/* Live search — filters across every visible item, expands all
          matching sections so users can find a module without scrolling
          through every section. */}
      <div className="px-3 pt-3 pb-2 shrink-0">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            inputMode="search"
            placeholder="Search menu…"
            value={mobileSearch}
            onChange={(e) => setMobileSearch(e.target.value)}
            className="w-full pl-9 pr-9 py-2.5 text-[14px] bg-slate-100 border border-transparent rounded-lg focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition-colors"
          />
          {mobileSearch && (
            <button
              onClick={() => setMobileSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 rounded"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Nav list */}
      <nav ref={mobileNavScrollRef} onScroll={handleNavScroll} className="flex-1 overflow-y-auto overflow-x-hidden pb-2 sidebar-scroll ios-scroll overscroll-y-contain">
        {mobileSections.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            No results for &ldquo;{mobileSearch}&rdquo;
          </div>
        )}
        {mobileSections.map((section) => {
          const sectionCollapsed = isMobileSectionCollapsed(section);
          return (
            <div key={section.id} className="mt-1">
              {section.label ? (
                <button
                  onClick={() => toggleMobileSection(section)}
                  className="w-full flex items-center justify-between px-4 pt-3 pb-1.5 active:bg-slate-50"
                  aria-expanded={!sectionCollapsed}
                >
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider select-none">
                    {section.label}
                  </span>
                  <ChevronDown
                    size={14}
                    className={`text-slate-400 transition-transform duration-200 ${sectionCollapsed ? '-rotate-90' : ''}`}
                  />
                </button>
              ) : (
                <div className="h-1" />
              )}

              {!sectionCollapsed && (
                <div className="px-2 space-y-0.5">
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const active = isActive(item.path);
                    return (
                      <button
                        key={item.path}
                        onClick={() => navigate(item.path)}
                        data-sidebar-active={active ? 'true' : undefined}
                        className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors text-left
                          ${active
                            ? 'bg-primary-50 text-primary-700 font-medium'
                            : 'text-slate-700 active:bg-slate-100 hover:bg-slate-50'
                          }
                        `}
                      >
                        <Icon
                          size={18}
                          strokeWidth={active ? 2 : 1.6}
                          className={`shrink-0 ${active ? 'text-primary-600' : 'text-slate-500'}`}
                        />
                        <span className="text-[14px] truncate">{item.name}</span>
                        {active && (
                          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary-600 shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer — single compact identity row. The big top user card was
          removed (it duplicated this and ate ~70px above the nav); the
          identity now lives here only: avatar + name tap through to the
          Profile page, with Logout as an icon button on the right. This
          is the drawer's one profile affordance — the header avatar menu
          handles it when the drawer is closed. */}
      <div className="shrink-0 border-t border-slate-100 pb-safe">
        <div className="px-2 py-2 flex items-center gap-1.5">
          <button
            onClick={() => navigate('/profile')}
            className={`flex-1 min-w-0 flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors
              ${isActive('/profile') ? 'bg-primary-50' : 'active:bg-slate-100 hover:bg-slate-50'}
            `}
          >
            <div className="w-9 h-9 bg-gradient-to-br from-primary-500 to-primary-700 rounded-full flex items-center justify-center shrink-0 shadow-sm">
              <span className="text-white text-sm font-semibold">
                {(user?.name || user?.username || 'U').charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-slate-800 truncate">
                {user?.name || user?.username || 'User'}
              </p>
              <p className="text-[11px] text-slate-500 truncate">
                {(typeof role === 'string' ? role : role?.name)
                  || (isSuperuser ? 'Superuser' : isAdmin ? 'Administrator' : 'Member')}
              </p>
            </div>
          </button>
          <button
            onClick={handleLogout}
            aria-label="Logout"
            title="Logout"
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg text-red-600 active:bg-red-50 hover:bg-red-50 transition-colors"
          >
            <LogOut size={18} strokeWidth={1.6} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <SidebarContext.Provider value={{ isCollapsed }}>
      {/* Mobile overlay backdrop — closes the drawer on tap */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden print:hidden"
          onClick={closeMobile}
          aria-hidden="true"
        />
      )}

      {/* Mobile drawer sidebar (slides in from left). The hamburger
          in the Header controls `mobileOpen` via MainLayout.
          `paddingLeft: env(safe-area-inset-left)` covers landscape iPhones
          where the notch sits to the left of the screen. The width is
          capped so a strip of the page remains visible behind the
          drawer — a visual cue that tapping outside closes it. */}
      <div
        className={`fixed inset-y-0 left-0 z-50 lg:hidden transition-transform duration-200 ease-out shadow-2xl print:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{
          paddingLeft: 'env(safe-area-inset-left)',
          maxWidth: '88vw',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        {mobileSidebarContent}
      </div>

      {/* Desktop sidebar — docked, only visible at lg+. The mobile
          drawer above (`lg:hidden`) handles screens below 1024px.
          Without the `hidden lg:block` guard here, phones would render
          both at once and the page content got squeezed to a sliver
          beside the sidebar. */}
      <div className="hidden lg:block shrink-0 print:hidden">
        {sidebarContent}
      </div>

      {/* Custom scrollbar styles */}
      <style>{`
        .sidebar-scroll::-webkit-scrollbar {
          width: 4px;
        }
        .sidebar-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .sidebar-scroll::-webkit-scrollbar-thumb {
          background-color: #cbd5e1;
          border-radius: 4px;
        }
        .sidebar-scroll::-webkit-scrollbar-thumb:hover {
          background-color: #94a3b8;
        }
        .sidebar-scroll {
          scrollbar-width: thin;
          scrollbar-color: #cbd5e1 transparent;
        }
      `}</style>
    </SidebarContext.Provider>
  );
}
