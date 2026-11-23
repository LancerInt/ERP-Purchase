import { useSelector } from 'react-redux';
import { Navigate, useLocation } from 'react-router-dom';
import usePermissions from '../../hooks/usePermissions.js';
import PermissionDenied from './PermissionDenied';
import { getFirstAccessiblePath } from '../../constants/navigation.js';

/**
 * ProtectedRoute - Wraps pages with authentication + permission checks.
 *
 * @param {string} module - RBAC module name (e.g., "Company", "Purchase Request")
 * @param {string} action - Permission action (default: "view"). Any action key
 *   exposed by usePermissions().can — i.e., "view"/"create"/"edit"/"delete"
 *   plus workflow ("approve"/"reject"/"confirm"/"close"/"cancel"/"issue"/"convert")
 *   and utility ("send_email"/"export"/"print").
 * @param {string[]} anyOf - If provided, the route is accessible when the user
 *   has ANY one of the listed actions on `module`. Use for routes reachable
 *   via multiple flows (e.g., bills/new is "create" OR "convert").
 * @param {boolean} adminOnly - If true, only admin/superuser can access
 * @param {ReactNode} children - The page component to render
 */
export default function ProtectedRoute({ module, action = 'view', anyOf, adminOnly = false, children }) {
  const isAuthenticated = useSelector(state => !!state.auth.token);
  const { isAdmin, isLoading, error, can, canView, role } = usePermissions();
  const location = useLocation();

  // The permissions fetch failed for a TRANSIENT reason (server unreachable or
  // 5xx), not a real auth failure. Show a "can't reach the server" state that
  // recovers on its own, instead of treating it as revoked access and bouncing
  // the user through getFirstAccessiblePath to the one ungated route.
  const unreachable = () => (
    <div className="flex flex-col items-center justify-center min-h-dvh gap-3 text-center px-6">
      <div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" />
      <p className="text-sm font-medium text-gray-700">Can’t reach the server</p>
      <p className="text-xs text-gray-500 max-w-xs">
        We’re having trouble loading your permissions. This page will retry
        automatically once the connection is back.
      </p>
    </div>
  );

  // When access is denied, send the user to the first page they CAN
  // view (their role's primary module, falling back through the nav)
  // instead of a dead-end screen. Only show PermissionDenied if they
  // can view nothing, or the only option is the page they're already on.
  const denied = () => {
    // Don't send a user away from a page they may actually be allowed on just
    // because we couldn't load permissions — hold on the retry screen instead.
    if (error) {
      return unreachable();
    }
    const fallback = getFirstAccessiblePath(role, canView);
    if (fallback && fallback !== location.pathname) {
      return <Navigate to={fallback} replace />;
    }
    return <PermissionDenied />;
  };

  // Not logged in → redirect to login
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Still loading permissions → show nothing (prevents flash)
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-dvh">
        <div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  // Admin-only pages
  if (adminOnly && !isAdmin) {
    return denied();
  }

  // No module specified → allow (dashboard, etc.)
  if (!module) {
    return children;
  }

  const actionsToCheck = Array.isArray(anyOf) && anyOf.length > 0 ? anyOf : [action];
  const granted = actionsToCheck.some(a => can(module, a));

  if (!granted) {
    return denied();
  }

  return children;
}
