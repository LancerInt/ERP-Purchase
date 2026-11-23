import { useEffect, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import MobileBottomNav from './MobileBottomNav';
import TallySyncLoginModal from './TallySyncLoginModal.jsx';
import { fetchNotifications } from '../../store/slices/notificationSlice.js';
import { checkMfaSetupRequired, signOut } from '../../store/slices/authSlice.js';
import useIdleTimeout from '../../hooks/useIdleTimeout.js';
import IdleWarningDialog from './IdleWarningDialog.jsx';

export default function MainLayout({ children, breadcrumbs = [] }) {
  const dispatch = useDispatch();
  const location = useLocation();
  const navigate = useNavigate();
  const isAuthenticated = useSelector((s) => s.auth?.isAuthenticated);
  const mustSetupMfa = useSelector((s) => s.auth?.mustSetupMfa);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });
  // Mobile drawer state lives here so the Header hamburger and the
  // Sidebar drawer can share it. Desktop ignores this entirely.
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Whether 2FA setup is still outstanding for a mandatory role (see
  // rbac.ERPRole.mfa_required) — checked once per session here rather
  // than trusted solely from the login response, so it's still correct
  // after a page refresh. TwoFactorSection clears it directly the moment
  // setup actually completes, without waiting for this to re-run.
  useEffect(() => {
    if (isAuthenticated) dispatch(checkMfaSetupRequired());
  }, [isAuthenticated, dispatch]);

  // A mandatory-role user with no factor set up yet can't reach anywhere
  // else until they do — Profile > Security is where setup lives. Runs on
  // every navigation (not just mount), so it also catches someone
  // typing a different URL directly, not just in-app navigation.
  useEffect(() => {
    if (mustSetupMfa && location.pathname !== '/profile') {
      navigate('/profile', { replace: true });
    }
  }, [mustSetupMfa, location.pathname, navigate]);

  // Keep the notification bell fresh while logged in — fetch on mount, poll
  // every 15s, and refresh the instant the tab/app regains focus or becomes
  // visible (so notifications appear right away when the user switches back,
  // instead of waiting for a manual refresh). Cleared on unmount/logout.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    // Throttled, and idle while the tab is hidden. Previously this polled
    // every 15s regardless, AND listened to both `focus` and
    // `visibilitychange` — which fire together on a tab switch, so each
    // switch cost two requests. A real 2.5-minute capture showed ~20
    // notification calls competing with the page's own data for connections.
    // 60s while visible is plenty for a bell badge; the immediate refresh on
    // return keeps it feeling live.
    const MIN_GAP = 10000;
    let last = 0;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - last < MIN_GAP) return;
      last = now;
      dispatch(fetchNotifications());
    };
    refresh();
    const id = setInterval(refresh, 60000);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [isAuthenticated, dispatch]);

  const handleCollapseChange = useCallback((collapsed) => {
    setSidebarCollapsed(collapsed);
  }, []);

  // Idle sign-out. Lives here rather than in App so it covers every signed-in
  // page at once and cannot be forgotten on a new route. `signOut` (not the
  // bare reducer) so the refresh token is revoked server-side too — an
  // unattended machine is exactly the case where a still-valid token in
  // localStorage matters most.
  const handleIdleTimeout = useCallback(() => {
    dispatch(signOut());
    navigate('/login?reason=idle', { replace: true });
  }, [dispatch, navigate]);

  const { warning, secondsLeft, staySignedIn } = useIdleTimeout({
    enabled: !!isAuthenticated,
    onTimeout: handleIdleTimeout,
  });

  // Purchase module runs in compact-density mode: the `pg-dense` scope class
  // (see globals.css "PURCHASE MODULE — COMPACT DENSITY LAYER") shrinks type,
  // table rows, card padding and vertical rhythm across every /purchase/* page
  // at once, and the page gutter itself is tightened a notch. Other modules
  // are untouched.
  const dense = location.pathname.startsWith('/purchase');

  return (
    <div className="flex h-dvh bg-slate-50">
      {/* Sidebar */}
      <Sidebar
        onCollapseChange={handleCollapseChange}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* The top header was removed — its only live controls (notification
            bell + profile) now live in the desktop sidebar's footer, and the
            warehouse selector was dead (no `warehouse` store slice). Dropping
            the bar reclaims a full row for content. */}

        {/* Content area with breadcrumbs. `overflow-x-hidden` clips
            any page that has a wide child (lifecycle strips, long
            customer names, etc.) from forcing the whole viewport to
            scroll sideways on phones; vertical scroll is unaffected. */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
          {/* Slim breadcrumb row (sm+). The Tally sync indicator moved to the
              sidebar ("Tally sync" button), so this only renders when a page
              actually passes breadcrumbs — no empty bar otherwise. */}
          {breadcrumbs.length > 0 && (
            <div className="hidden sm:flex items-center gap-3 px-3 sm:px-6 py-2 sm:py-3 bg-white border-b border-slate-200 print:hidden">
              <nav className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm min-w-0">
                {breadcrumbs.map((crumb, idx) => (
                  <div key={idx} className="flex items-center gap-1.5 sm:gap-2">
                    {idx > 0 && <span className="text-slate-400">/</span>}
                    {crumb.href ? (
                      <Link
                        to={crumb.href}
                        className="text-blue-600 hover:text-blue-800 transition"
                      >
                        {crumb.label}
                      </Link>
                    ) : (
                      <span className="text-slate-700 font-medium">{crumb.label}</span>
                    )}
                  </div>
                ))}
              </nav>
            </div>
          )}

          {/* Page content — strip horizontal padding when printing so
              the invoice document hits the page margin set by @page.
              Halve the padding on mobile so list/detail cards get the
              full width minus a thin gutter, matching modern SaaS density.

              `max-w-[2400px] mx-auto` is for wall-mounted interactive panels
              and ultrawide monitors, and is deliberately set ABOVE every
              ordinary desktop: with the 260px sidebar, a 1920 laptop gets
              ~1612px of content and a 2560 monitor ~2300px, so neither is
              touched. Only 3440 ultrawides (~3180px) and 4K panels (~3580px)
              are capped — the widths where a table row stretches so far that
              the eye loses the line between the first and last column. A
              tighter cap was rejected on purpose: on a data-dense ERP,
              horizontal room is how you see more columns at once, so
              letterboxing a normal desktop would cost more than it gained. */}
          <div className={`${dense
                            ? 'pg-dense px-2 py-1.5 sm:px-3 sm:py-2'
                            : 'px-3 py-2 sm:px-4 sm:py-3'} pb-20 lg:pb-5 print:p-0
                          max-w-[2400px] mx-auto w-full`}>
            {children}
          </div>
        </main>
      </div>

      {/* Mobile bottom-tab navigation (phones/tablets). Renders its own
          fixed bar + drill-in menus; hidden on lg+ where the docked
          sidebar takes over. */}
      <MobileBottomNav />

      <IdleWarningDialog open={warning} secondsLeft={secondsLeft} onStay={staySignedIn} />

      {/* One-time Tally sync greeting, shown once per sign-in (not on refresh).
          Renders nothing until a real login raises auth.justLoggedIn. */}
      <TallySyncLoginModal />
    </div>
  );
}
