import { useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useNavigate, useLocation } from 'react-router-dom';
import { Bell, BellRing, BellOff, CheckCheck, ArrowLeft, Loader2, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../components/layout/MainLayout';
import { confirm } from '../../components/common/confirm';
import apiClient from '../../utils/api.js';
import { timeAgo } from '../../utils/timeAgo.js';
import { pushStatus, enablePush, disablePush } from '../../utils/push.js';
import {
  fetchNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  clearAllNotifications,
} from '../../store/slices/notificationSlice.js';

const LEVEL_DOT = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-blue-500',
};

// iOS exposes Web Push only inside an INSTALLED (home-screen) PWA, never in a
// regular Safari tab. Detect "iPhone/iPad in Safari, not yet installed" so we
// can point those users at Add to Home Screen instead of showing nothing.
function iosNeedsInstall() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  return isIos && !standalone;
}

export default function NotificationsPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const notifications = useSelector((s) => s.notifications?.items ?? []);
  const unreadCount = useSelector((s) => s.notifications?.unreadCount ?? 0);

  // Pull a fresh copy on open (MainLayout also polls in the background).
  useEffect(() => { dispatch(fetchNotifications()); }, [dispatch]);

  // ── Native push (per-device) ──────────────────────────────────────────
  const [push, setPush] = useState('off');   // unsupported | denied | on | off
  const [pushBusy, setPushBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => { pushStatus().then(setPush); }, []);

  // Send a test push so the user can see whether native push actually
  // reaches this device — surfaces the real reason if it doesn't.
  const sendTestPush = async () => {
    setTesting(true);
    try {
      const { data } = await apiClient.post('/api/notifications/push/test/');
      if (data.ok) {
        toast.success(`Test sent to ${data.sent} device(s) — check your notification tray.`);
      } else {
        toast.error(data.error || 'Test push could not be sent.', { duration: 8000 });
      }
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Test push failed.', { duration: 8000 });
    } finally {
      setTesting(false);
    }
  };

  const togglePush = async () => {
    setPushBusy(true);
    try {
      if (push === 'on') {
        await disablePush();
        setPush('off');
        toast.success('Notifications turned off for this device.');
      } else {
        await enablePush();
        setPush('on');
        toast.success('Notifications enabled on this device.');
      }
    } catch (err) {
      setPush(await pushStatus());
      toast.error(err?.message || 'Could not change notification settings.');
    } finally {
      setPushBusy(false);
    }
  };

  // Return to the page the user was on before opening notifications.
  // `location.key === 'default'` means there's no in-app history entry to
  // go back to (e.g. the page was opened directly / refreshed) — fall back
  // to the home route instead of leaving the app.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/');
  };

  const open = (notif) => {
    if (notif && !notif.is_read) dispatch(markNotificationRead(notif.id));
    if (notif?.link) navigate(notif.link);
  };

  const remove = (e, id) => {
    e.stopPropagation();
    dispatch(deleteNotification(id));
  };

  const clearAll = async () => {
    const ok = await confirm({
      message: 'Delete all notifications? This cannot be undone.',
      isDangerous: true,
      confirmLabel: 'Clear all',
    });
    if (ok) dispatch(clearAllNotifications());
  };

  return (
    <MainLayout>
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <button
              onClick={goBack}
              aria-label="Back"
              title="Back"
              className="p-1.5 -ml-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition"
            >
              <ArrowLeft size={20} />
            </button>
            <h1 className="text-lg sm:text-xl font-semibold text-slate-900 flex items-center gap-2">
              <Bell size={20} className="text-slate-500" />
              Notifications{unreadCount > 0 ? ` (${unreadCount})` : ''}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {unreadCount > 0 && (
              <button
                onClick={() => dispatch(markAllNotificationsRead())}
                className="inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 font-medium"
              >
                <CheckCheck size={16} /> <span className="hidden sm:inline">Mark all read</span><span className="sm:hidden">Read all</span>
              </button>
            )}
            {notifications.length > 0 && (
              <button
                onClick={clearAll}
                className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-red-600 font-medium"
              >
                <Trash2 size={16} /> <span className="hidden sm:inline">Clear all</span>
              </button>
            )}
          </div>
        </div>

        {/* iOS in Safari (not installed): push is unavailable until the app is
            added to the Home Screen — guide the user there. */}
        {push === 'unsupported' && iosNeedsInstall() && (
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 mb-4 flex items-center gap-3">
            <span className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-slate-100 text-slate-500">
              <BellOff size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-800">Turn on notifications on iPhone/iPad</p>
              <p className="text-xs text-slate-500">
                Tap the Share button, choose <span className="font-medium">Add to Home Screen</span>, then open the app from your Home Screen — the Enable button appears there.
              </p>
            </div>
          </div>
        )}

        {/* Native push toggle — per device. Lets alerts arrive even when the
            app is closed (the device must allow notifications). */}
        {push !== 'unsupported' && (
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 mb-4 flex items-center gap-3">
            <span className={`shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full ${push === 'on' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
              {push === 'on' ? <BellRing size={18} /> : <BellOff size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-800">
                {push === 'on' ? 'Notifications are on for this device' : 'Get notified on this device'}
              </p>
              <p className="text-xs text-slate-500">
                {push === 'denied'
                  ? 'Blocked in your browser — allow notifications for this site in its settings, then try again. (Private / Incognito windows usually block them; use a normal window.)'
                  : push === 'on'
                    ? 'Alerts arrive even when the app is closed.'
                    : 'Approvals and updates pop up like other apps, even when the app is closed.'}
              </p>
            </div>
            {push !== 'denied' && (
              <div className="flex items-center gap-2 shrink-0">
                {push === 'on' && (
                  <button
                    onClick={sendTestPush}
                    disabled={testing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-primary-300 text-primary-700 hover:bg-primary-50 transition disabled:opacity-50"
                  >
                    {testing && <Loader2 size={14} className="animate-spin" />}
                    Send test
                  </button>
                )}
                <button
                  onClick={togglePush}
                  disabled={pushBusy}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition disabled:opacity-50 ${
                    push === 'on'
                      ? 'border border-slate-300 text-slate-600 hover:bg-slate-50'
                      : 'bg-primary-600 text-white hover:bg-primary-700'
                  }`}
                >
                  {pushBusy && <Loader2 size={14} className="animate-spin" />}
                  {push === 'on' ? 'Turn off' : 'Enable'}
                </button>
              </div>
            )}
          </div>
        )}

        {notifications.length === 0 ? (
          <div className="bg-white rounded-lg border border-slate-200 p-10 text-center">
            <Bell size={36} className="mx-auto text-slate-300 mb-3" />
            <p className="text-slate-500 text-sm">You're all caught up.</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            {notifications.map((notif) => (
              <div
                key={notif.id}
                className={`group flex items-start gap-3 p-3.5 hover:bg-slate-50 transition ${notif.is_read ? '' : 'bg-blue-50/40'}`}
              >
                <button
                  onClick={() => open(notif)}
                  className="flex items-start gap-3 flex-1 min-w-0 text-left"
                >
                  <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${notif.is_read ? 'bg-slate-200' : (LEVEL_DOT[notif.level] || 'bg-blue-500')}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-900 break-words">{notif.title}</span>
                    {notif.message && <span className="block text-xs sm:text-sm text-slate-600 mt-0.5 break-words">{notif.message}</span>}
                    {notif.actor_name && <span className="block text-[11px] text-slate-400 mt-1">{notif.actor_name}</span>}
                  </span>
                </button>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className="whitespace-nowrap text-[11px] text-slate-400">
                    {timeAgo(notif.created_at || notif.timestamp)}
                  </span>
                  <button
                    onClick={(e) => remove(e, notif.id)}
                    aria-label="Delete notification"
                    title="Delete"
                    className="p-1 -mr-1 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </MainLayout>
  );
}
