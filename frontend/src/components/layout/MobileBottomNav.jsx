/**
 * Mobile bottom-tab navigation (phones / small tablets).
 *
 * Replaces the hamburger drawer with a fixed bottom tab bar + drill-in
 * module menus + a "More" sheet — the premium app pattern. Tabs are
 * role-adaptive: the user's primary module is the first tab (see
 * getRoleNavOrder), the rest follow, and overflow lands under "More".
 *
 * Behaviour:
 *   - Tap a module tab        -> full-screen menu of that module's pages.
 *   - Tap "More"              -> list of the remaining modules.
 *   - Tap a module under More -> that module's pages (back returns to More).
 *   - Tap a page              -> navigate + close.
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { ChevronLeft, ChevronRight, MoreHorizontal, Bell } from 'lucide-react';
import usePermissions from '../../hooks/usePermissions.js';
import { NAV_SECTIONS, getRoleNavOrder } from '../../constants/navigation.js';

const EMPTY = Object.freeze([]);

const MAX_TABS = 5; // module tabs before overflowing into "More"

export default function MobileBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const { canView, isAdmin, isSuperuser, role, isLoading: permsLoading } = usePermissions();
  const user = useSelector((s) => s.auth?.user);
  const notifications = useSelector((s) => s.notifications?.items ?? EMPTY);
  const unreadCount = useSelector((s) => s.notifications?.unreadCount ?? 0);

  // view: null | { mode: 'section'|'more'|'moreSection', section? }
  const [view, setView] = useState(null);

  // Close the menu whenever the route changes.
  useEffect(() => { setView(null); }, [location.pathname]);

  // Lock body scroll while a menu overlay is open.
  useEffect(() => {
    if (!view) return;
    document.body.classList.add('overflow-hidden');
    return () => document.body.classList.remove('overflow-hidden');
  }, [view]);

  // Sections the user can actually see, in role order.
  const accessible = useMemo(() => {
    const visibleItems = (section) => section.items.filter((i) =>
      !i.module || permsLoading || canView(i.module),
    );
    const order = getRoleNavOrder(role);
    const rank = (id) => {
      const idx = order.indexOf(id);
      return idx === -1 ? 999 : idx;
    };
    return NAV_SECTIONS
      .filter((s) => !(s.adminOnly && !isAdmin && !isSuperuser && !permsLoading))
      .map((s) => ({ ...s, _items: visibleItems(s) }))
      .filter((s) => s._items.length > 0)
      .sort((a, b) => rank(a.id) - rank(b.id));
  }, [role, canView, isAdmin, isSuperuser, permsLoading]);

  const overflow = accessible.length > MAX_TABS;
  const tabs = overflow ? accessible.slice(0, MAX_TABS) : accessible;
  const moreSections = overflow ? accessible.slice(MAX_TABS) : [];

  // Post-login landing (/home): open the user's PRIMARY module menu so
  // they pick a submodule from this polished drill-in list, rather than
  // a separate landing page. Waits for permissions so the right module
  // is chosen; opens once per visit to /home.
  const homeOpenedRef = useRef(false);
  useEffect(() => {
    if (location.pathname !== '/home') { homeOpenedRef.current = false; return; }
    if (!permsLoading && !homeOpenedRef.current && accessible.length > 0) {
      homeOpenedRef.current = true;
      setView({ mode: 'section', sectionId: accessible[0].id });
    }
  }, [location.pathname, permsLoading, accessible]);

  // Which section owns the current route (for active highlight).
  const activeSectionId = useMemo(() => {
    const path = location.pathname;
    const match = accessible.find((s) =>
      s._items.some((i) => path === i.path || path.startsWith(i.path + '/')),
    );
    return match?.id;
  }, [location.pathname, accessible]);

  const activeInMore = moreSections.some((s) => s.id === activeSectionId);

  // Mirrors Sidebar.isActive. Match the path exactly, or as the parent of a
  // sub-route — but NOT when a more specific nav item also matches. Without
  // that second rule '/sales/orders' stays lit on '/sales/orders/multi-po',
  // so Sales Orders and Multi-PO Sales Order both highlight at once.
  const isItemActive = (path) => {
    const p = location.pathname;
    if (p === path) return true;
    if (!p.startsWith(path + '/')) return false;
    const matchesDeeper = accessible.some((s) => (s._items || []).some((it) =>
      it.path !== path
      && it.path.startsWith(path + '/')
      && (p === it.path || p.startsWith(it.path + '/'))));
    return !matchesDeeper;
  };

  const openSection = (section, fromMore = false) =>
    setView({ mode: fromMore ? 'moreSection' : 'section', sectionId: section.id });

  // The section object backing the currently-open menu (resolved by id
  // so the page-title back button can open a menu just by id).
  const currentSection = view?.sectionId
    ? accessible.find((s) => s.id === view.sectionId)
    : null;

  // A page-title back button (BackToModule) fires this to open the
  // current page's parent module menu from anywhere.
  useEffect(() => {
    const handler = (e) => {
      const sectionId = e.detail?.sectionId;
      if (sectionId) setView({ mode: 'section', sectionId });
    };
    window.addEventListener('open-module-menu', handler);
    return () => window.removeEventListener('open-module-menu', handler);
  }, []);

  const go = (path) => { navigate(path); setView(null); };
  const back = () => setView(view?.mode === 'moreSection' ? { mode: 'more' } : null);

  if (permsLoading && accessible.length === 0) return null;

  const Tab = ({ section, icon: Icon, label, active, onClick, badge }) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className="relative flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 min-h-[44px] min-w-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
    >
      {active && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-primary-600" />}
      <Icon size={21} strokeWidth={active ? 2.2 : 1.8}
        className={active ? 'text-primary-600' : 'text-slate-500'} />
      <span className={`text-[10px] leading-none truncate max-w-full ${active ? 'text-primary-700 font-semibold' : 'text-slate-500'}`}>
        {label}
      </span>
    </button>
  );

  return (
    <>
      {/* Drill-in menu overlay */}
      {view && (
        <div className="lg:hidden fixed inset-0 z-50 bg-slate-50 flex flex-col print:hidden animate-[fadeIn_120ms_ease-out]">
          <div className="pt-safe shrink-0 bg-white" />
          <div className="flex items-center gap-1.5 h-14 px-3 bg-white border-b border-slate-100 shrink-0">
            {/* Back chevron only when drilling back out of a "More"
                module — a top-level module menu has nowhere to go back
                to (tap a page or another tab to leave), so we drop it. */}
            {view.mode === 'moreSection' && (
              <button onClick={back} className="p-2 -ml-1 rounded-lg text-slate-600 active:bg-slate-100" aria-label="Back">
                <ChevronLeft size={22} />
              </button>
            )}
            <h2 className="text-[17px] font-bold text-slate-900 flex-1 truncate">
              {view.mode === 'more' ? 'More' : (currentSection?.label || '').replace(/\//g, ' / ').replace(/\b\w/g, (c) => c.toUpperCase())}
            </h2>
            {/* Account row — profile + notifications live here (in the
                module menus) instead of a top bar on every page. */}
            <button onClick={() => go('/notifications')} className="relative p-2 rounded-lg text-slate-500 active:bg-slate-100" aria-label="Notifications">
              <Bell size={19} />
              {unreadCount > 0 && (
                <span className="absolute top-0.5 right-0.5 min-w-[16px] h-[16px] px-1 flex items-center justify-center text-[9px] font-bold text-white bg-red-500 rounded-full">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
            <button onClick={() => go('/profile')} className="p-0.5 rounded-full active:opacity-80" aria-label="Profile">
              <span className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white text-xs font-semibold flex items-center justify-center shadow-sm">
                {(user?.name || user?.username || 'U').charAt(0).toUpperCase()}
              </span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 pb-24">
            {view.mode === 'more'
              ? moreSections.map((s) => {
                  const Icon = s.groupIcon;
                  return (
                    <button key={s.id} onClick={() => openSection(s, true)}
                      className="w-full flex items-center gap-3 px-4 py-3.5 bg-white rounded-xl border border-slate-200 active:bg-slate-50 text-left shadow-sm">
                      <span className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
                        <Icon size={18} className="text-primary-600" />
                      </span>
                      <span className="flex-1 text-[15px] font-medium text-slate-800 capitalize">{s.label.toLowerCase()}</span>
                      <ChevronRight size={18} className="text-slate-400" />
                    </button>
                  );
                })
              : (currentSection?._items || []).map((item) => {
                  const Icon = item.icon;
                  const active = isItemActive(item.path);
                  return (
                    <button key={item.path} onClick={() => go(item.path)}
                      className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border text-left shadow-sm transition ${
                        active ? 'bg-primary-50 border-primary-300' : 'bg-white border-slate-200 active:bg-slate-50'
                      }`}>
                      <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${active ? 'bg-primary-100' : 'bg-slate-100'}`}>
                        <Icon size={18} className={active ? 'text-primary-700' : 'text-slate-500'} />
                      </span>
                      <span className={`flex-1 text-[15px] font-medium ${active ? 'text-primary-800' : 'text-slate-800'}`}>{item.name}</span>
                      <ChevronRight size={18} className={active ? 'text-primary-400' : 'text-slate-300'} />
                    </button>
                  );
                })}
          </div>
        </div>
      )}

      {/* Fixed bottom tab bar */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-[55] bg-white border-t border-slate-200 shadow-[0_-2px_12px_rgba(15,23,42,0.06)] pb-safe print:hidden"
        role="navigation"
        aria-label="Primary"
      >
        <div className="flex items-stretch">
          {tabs.map((s) => (
            <Tab
              key={s.id}
              section={s}
              icon={s.groupIcon}
              label={s.tabLabel}
              // While a menu is open, highlight the tab whose menu it is;
              // otherwise highlight the tab that owns the current route.
              active={view ? view.sectionId === s.id : activeSectionId === s.id}
              onClick={() => openSection(s)}
            />
          ))}
          {overflow && (
            <Tab
              icon={MoreHorizontal}
              label="More"
              // Active while browsing the "More" sheet or any module under
              // it, and when the current route lives in a More section.
              active={view ? (view.mode === 'more' || view.mode === 'moreSection') : activeInMore}
              onClick={() => setView({ mode: 'more' })}
            />
          )}
        </div>
      </nav>
    </>
  );
}
