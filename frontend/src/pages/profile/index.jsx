import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import apiClient from '../../utils/api.js';
import { confirm } from '@/components/common/confirm';
import { getApiErrorMessage } from '@/utils/formHelpers';
import { LogOut, Mail, User as UserIcon, Shield, KeyRound, Briefcase } from 'lucide-react';
import MainLayout from '../../components/layout/MainLayout';
import PageHeader from '../../components/common/PageHeader';
import { Button } from '../../components/common/forms';
import usePermissions from '../../hooks/usePermissions.js';
import { signOut } from '../../store/slices/authSlice.js';
import TwoFactorSection from './TwoFactorSection.jsx';

/**
 * Profile details page.
 *
 * Reads the current identity off the auth slice + permissions hook
 * (there is no /me API endpoint yet — once one lands we can swap the
 * Redux read for a live fetch without changing the layout).
 *
 * Mobile-first by design: the identity card scales down to a tighter
 * row on phones, the info cards stack, and actions sit in a clear
 * single-column column at the bottom.
 */
export default function ProfilePage() {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const user = useSelector((state) => state.auth?.user);
  const roles = useSelector((state) => state.auth?.roles || []);
  const { isAdmin, isSuperuser, role, permissions, isLoading: permsLoading } = usePermissions();

  // The modules this account can actually open. NOT state.auth.modules —
  // loginUser always returns that as [], so the old read was permanently
  // empty, which is why this page only ever said "Determined by role" and
  // the Module Access card below never appeared at all. The real list is
  // in the permissions payload (/api/rbac/my-permissions/).
  const viewableModules = [...new Set(
    (permissions || [])
      .filter((p) => p.can_view)
      .map((p) => p.module_name || p.module?.name)
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));

  // An admin/superuser bypasses the per-module check entirely (see
  // usePermissions._check), so their permissions rows can legitimately be
  // empty while they can still reach everything — counting rows would
  // wrongly read as "no access" for exactly the people with the most.
  const moduleSummary = permsLoading
    ? 'Loading…'
    : (isAdmin || isSuperuser)
      ? 'All modules'
      : viewableModules.length > 0
        ? `${viewableModules.length} module${viewableModules.length === 1 ? '' : 's'}`
        : 'No modules assigned';

  const displayName = user?.name || user?.username || user?.email || 'User';
  const email = user?.email || user?.username || '—';
  const initial = (displayName.charAt(0) || 'U').toUpperCase();

  // Prefer the actual assigned ERP role (e.g. "Warehouse Coordinator",
  // "Purchase Manager") from the permissions hook. Fall back to the
  // generic labels only when no role is assigned.
  const roleName = typeof role === 'string' ? role : role?.name;
  const roleLabel = roleName
    || (isSuperuser
      ? 'Superuser'
      : isAdmin
        ? 'Administrator'
        : roles.length > 0
          ? roles.join(', ')
          : 'Member');

  const handleLogout = () => {
    dispatch(signOut());
    navigate('/login');
  };

  // Lost or stolen device: ordinary sign-out only ends THIS session, so
  // the missing phone keeps refreshing its token for days. This revokes
  // every session, then signs this one out too.
  const [signingOutAll, setSigningOutAll] = useState(false);
  const signOutEverywhere = async () => {
    const ok = await confirm({
      title: 'Sign out of all devices?',
      message: 'Every phone, tablet and computer signed in as you will be signed out, including this one. Use this if a device was lost or stolen.',
      confirmLabel: 'Sign out everywhere',
      isDangerous: true,
    });
    if (!ok) return;
    setSigningOutAll(true);
    try {
      await apiClient.post('/api/token/logout-all/');
      toast.success('Signed out of all devices.');
    } catch (err) {
      // Even if the revoke failed, still drop THIS session — being stuck
      // signed in is the worse outcome when you came here to get out.
      toast.error(getApiErrorMessage(err));
    } finally {
      setSigningOutAll(false);
      dispatch(signOut());
      navigate('/login');
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Profile"
        subtitle="Your account details and access"
        breadcrumbs={[{ label: 'Profile' }]}
      />

      <div className="space-y-4 sm:space-y-6 max-w-3xl">
        {/* Identity card — gradient banner with avatar + name + email + role pill */}
        <div className="relative overflow-hidden rounded-2xl border border-slate-200 shadow-sm bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-700 text-white">
          {/* Decorative blobs for depth */}
          <div className="absolute -right-12 -top-12 w-56 h-56 rounded-full bg-white/10" aria-hidden="true" />
          <div className="absolute -right-20 -bottom-20 w-72 h-72 rounded-full bg-white/5" aria-hidden="true" />

          <div className="relative px-5 sm:px-7 py-4 sm:py-5 sm:py-8 flex items-center gap-4 sm:gap-5">
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-white/15 backdrop-blur ring-2 ring-white/30 flex items-center justify-center shrink-0 shadow-lg">
              <span className="text-2xl sm:text-3xl font-bold text-white">{initial}</span>
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl sm:text-2xl font-bold truncate">{displayName}</h2>
              <p className="text-[13px] sm:text-sm text-white/80 truncate mt-0.5">{email}</p>
              <div className="mt-2 inline-flex items-center gap-1.5 bg-white/15 backdrop-blur rounded-full px-2.5 py-1 text-[11px] sm:text-xs font-medium ring-1 ring-white/20">
                <Shield size={12} />
                <span>{roleLabel}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Account information */}
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <header className="px-5 sm:px-6 py-4 border-b border-slate-100">
            <h3 className="text-[15px] sm:text-base font-semibold text-slate-900">Account Information</h3>
            <p className="text-[12px] sm:text-[13px] text-slate-500 mt-0.5">Details associated with your login.</p>
          </header>
          {/* 2x2 compact grid on mobile; clean divided list from sm up. */}
          <dl className="grid grid-cols-2 gap-3 p-4 sm:block sm:gap-0 sm:p-0 sm:divide-y sm:divide-slate-100">
            <InfoRow icon={UserIcon} label="Username" value={user?.username || user?.email || '—'} />
            <InfoRow icon={Mail} label="Email" value={email} />
            <InfoRow icon={Shield} label="Role" value={roleLabel} />
            <InfoRow icon={Briefcase} label="Accessible Modules" value={moduleSummary} />
          </dl>
        </section>

        {/* Module access — visible only when we actually have a list to show */}
        {viewableModules.length > 0 && (
          <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <header className="px-5 sm:px-6 py-4 border-b border-slate-100">
              <h3 className="text-[15px] sm:text-base font-semibold text-slate-900">Module Access</h3>
              <p className="text-[12px] sm:text-[13px] text-slate-500 mt-0.5">Modules your role can view.</p>
            </header>
            <div className="px-5 sm:px-6 py-4">
              <div className="flex flex-wrap gap-1.5">
                {viewableModules.map((m) => (
                  <span
                    key={m}
                    className="inline-flex items-center px-2.5 py-1 rounded-full text-[12px] font-medium bg-blue-50 text-blue-700 border border-blue-100"
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Security */}
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <header className="px-5 sm:px-6 py-4 border-b border-slate-100">
            <h3 className="text-[15px] sm:text-base font-semibold text-slate-900">Security</h3>
            <p className="text-[12px] sm:text-[13px] text-slate-500 mt-0.5">Manage how you sign in.</p>
          </header>
          <div className="px-5 sm:px-6 py-4 space-y-3">
            <div className="flex items-start gap-3">
              <span className="shrink-0 mt-0.5 w-9 h-9 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center">
                <KeyRound size={16} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[14px] font-medium text-slate-800">Password</p>
                <p className="text-[12px] text-slate-500">
                  Contact your administrator to reset your password — self-service reset is not yet available.
                </p>
              </div>
            </div>
            <TwoFactorSection />

            <div className="flex items-start gap-3 pt-3 border-t border-slate-100">
              <span className="shrink-0 mt-0.5 w-9 h-9 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center">
                <LogOut size={16} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[14px] font-medium text-slate-800">Sign out everywhere</p>
                <p className="text-[12px] text-slate-500">
                  Ends every session on every device, including this one. Signing out normally
                  only ends the session on the device you’re using.
                </p>
                <button
                  type="button"
                  onClick={signOutEverywhere}
                  disabled={signingOutAll}
                  className="mt-2 text-[13px] font-medium text-danger-600 hover:text-danger-700 hover:underline disabled:opacity-50"
                >
                  {signingOutAll ? 'Signing out…' : 'Sign out of all devices'}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Actions */}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3 pt-2">
          <Button variant="secondary" onClick={() => navigate(-1)}>
            Back
          </Button>
          <Button
            variant="danger"
            leftIcon={<LogOut size={16} />}
            onClick={handleLogout}
          >
            Sign Out
          </Button>
        </div>
      </div>
    </MainLayout>
  );
}

function InfoRow({ icon: Icon, label, value }) {
  return (
    <div className="h-full flex items-start gap-3 rounded-xl border border-slate-200 p-3 sm:h-auto sm:items-center sm:gap-4 sm:rounded-none sm:border-0 sm:px-6 sm:py-3.5">
      {Icon && (
        <span className="shrink-0 w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center">
          <Icon size={15} className="sm:hidden" />
          <Icon size={16} className="hidden sm:block" />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <dt className="text-[10px] sm:text-[11px] uppercase tracking-wide font-semibold text-slate-400">{label}</dt>
        <dd className="text-[13px] sm:text-[14px] text-slate-800 mt-0.5 break-words">{value}</dd>
      </div>
    </div>
  );
}
