/**
 * ModuleLanding — the post-login home.
 *
 * - Mobile: stays on /home; MobileBottomNav opens the user's primary
 *   MODULE menu (the drill-in tile list) on top of this page, so they
 *   pick a submodule from there. We render only a light placeholder
 *   underneath.
 * - Desktop: there's no bottom-nav overlay and the docked sidebar
 *   already lists everything, so a separate module landing is just an
 *   extra click — redirect straight to the primary submodule instead.
 */
import { Navigate } from 'react-router-dom';
import MainLayout from '../components/layout/MainLayout';
import usePermissions from '../hooks/usePermissions.js';
import {
  SECTION_BY_ID,
  getRolePrimarySectionId,
  getFirstAccessiblePath,
} from '../constants/navigation.js';

function Spinner({ full = false }) {
  return (
    <div className={`flex items-center justify-center ${full ? 'min-h-dvh bg-slate-50' : 'py-24'}`}>
      <div className="w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export default function ModuleLanding() {
  const { role, canView, isLoading } = usePermissions();

  if (isLoading) return <Spinner full />;

  const section = SECTION_BY_ID[getRolePrimarySectionId(role)];
  const items = (section?.items || []).filter((i) => !i.module || canView(i.module));
  const target = items[0]?.path || getFirstAccessiblePath(role, canView);

  if (!target) {
    return (
      <MainLayout>
        <div className="text-center py-20 text-slate-500">No modules available for your role.</div>
      </MainLayout>
    );
  }

  // Large screens: open the primary submodule directly (no module overlay).
  if (typeof window !== 'undefined' && window.innerWidth >= 1024) {
    return <Navigate to={target} replace />;
  }

  // Mobile: the bottom-nav opens the module menu over this placeholder.
  return (
    <MainLayout>
      <Spinner />
    </MainLayout>
  );
}
