import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { Bell, Building2, ChevronDown, LogOut, Menu, User, CheckCheck, Trash2 } from 'lucide-react';
import { markNotificationRead, markAllNotificationsRead, deleteNotification } from '../../store/slices/notificationSlice.js';
import { signOut } from '../../store/slices/authSlice.js';
import { timeAgo } from '../../utils/timeAgo.js';

// Stable fallback used by the list/items selectors below. Inlining
// `|| []` returns a brand-new array on every render when the slice
// is undefined, which trips react-redux's "selector returned a
// different result" memoization warning. Sharing one frozen array
// keeps the reference identical across renders.
const EMPTY_LIST = Object.freeze([]);

export default function Header({ onMenuClick }) {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showWarehouseMenu, setShowWarehouseMenu] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);

  const user = useSelector((state) => state.auth?.user);
  const selectedWarehouse = useSelector((state) => state.warehouse?.selected);
  const warehouses = useSelector((state) => state.warehouse?.list ?? EMPTY_LIST);
  const notifications = useSelector((state) => state.notifications?.items ?? EMPTY_LIST);
  const unreadCount = useSelector((state) => state.notifications?.unreadCount ?? 0);

  const openNotification = (notif) => {
    if (notif && !notif.is_read) dispatch(markNotificationRead(notif.id));
    setShowNotifs(false);
    if (notif?.link) navigate(notif.link);
  };

  const handleLogout = () => {
    dispatch(signOut());
    navigate('/login');
  };

  const handleWarehouseChange = (warehouseId) => {
    dispatch({ type: 'warehouse/select', payload: warehouseId });
    setShowWarehouseMenu(false);
  };

  return (
    <header
      className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-sm print:hidden pt-safe"
      style={{ paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
    >
      <div className="px-3 sm:px-6 py-2 sm:py-3 flex items-center justify-between gap-2">
        {/* Mobile hamburger — only visible below lg, opens the sidebar
            drawer managed by MainLayout. Desktop has the docked sidebar
            permanently visible, so this button is hidden there. The
            tap-target-44 utility enforces Apple HIG's 44pt minimum so
            the icon is reliably tappable on iPhones. */}
        {/* Mobile navigation is the bottom tab bar now; the hamburger
            drawer is retired, so this is hidden. Kept for the brand row
            spacing / potential future use. */}
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation menu"
          className="hidden tap-target-44 items-center justify-center -ml-1.5 text-slate-600 hover:bg-slate-100 active:bg-slate-200 rounded-lg transition shrink-0"
        >
          <Menu size={20} />
        </button>

        {/* Left: Breadcrumbs or page title */}
        <div className="flex-1 min-w-0">
          <div className="text-sm text-slate-600">
            {/* Breadcrumbs can be injected here by page components */}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1 sm:gap-3 lg:gap-5">
          {/* Warehouse Selector — name is hidden behind a building icon
              on phones so we don't waste the whole header row showing
              "BIOGREEN TECHNOLOGY PVT LTD". Tap reveals the dropdown
              just like on desktop. */}
          {warehouses.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setShowWarehouseMenu(!showWarehouseMenu)}
                className="flex items-center gap-1.5 sm:gap-2 px-1.5 sm:px-3 py-1.5 sm:py-2 rounded-lg hover:bg-slate-100 transition"
                aria-label="Switch warehouse"
              >
                <Building2 size={18} className="text-slate-500 sm:hidden" />
                <span className="hidden sm:inline text-sm font-medium text-slate-700 max-w-none truncate">
                  {selectedWarehouse?.name || 'Select Warehouse'}
                </span>
                <ChevronDown size={14} className="text-slate-500 shrink-0" />
              </button>

              {showWarehouseMenu && (
                <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-slate-200 py-2 z-50">
                  {warehouses.map((wh) => (
                    <button
                      key={wh.id}
                      onClick={() => handleWarehouseChange(wh.id)}
                      className={`w-full text-left px-4 py-2 text-sm transition ${
                        selectedWarehouse?.id === wh.id
                          ? 'bg-blue-50 text-blue-700 font-medium'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {wh.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Notifications */}
          <div className="relative">
            <button
              onClick={() => setShowNotifs((v) => !v)}
              aria-label="Notifications"
              className="relative inline-flex items-center justify-center w-9 h-9 sm:w-11 sm:h-11 text-slate-600 hover:bg-slate-100 active:bg-slate-200 rounded-lg transition"
            >
              <Bell size={18} className="sm:w-5 sm:h-5" />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center text-[10px] font-bold text-white bg-red-500 rounded-full">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>

            {showNotifs && (
              <>
                {/* click-away backdrop */}
                <div className="fixed inset-0 z-40" onClick={() => setShowNotifs(false)} />
                <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-white rounded-lg shadow-lg border border-slate-200 z-50 overflow-hidden">
                  <div className="flex items-center justify-between p-3 border-b border-slate-200">
                    <h3 className="font-semibold text-slate-900 text-sm">
                      Notifications{unreadCount > 0 ? ` (${unreadCount})` : ''}
                    </h3>
                    {unreadCount > 0 && (
                      <button
                        onClick={() => dispatch(markAllNotificationsRead())}
                        className="inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
                      >
                        <CheckCheck size={14} /> Mark all read
                      </button>
                    )}
                  </div>
                  <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
                    {notifications.length === 0 ? (
                      <div className="p-4 sm:p-5 text-center text-sm text-slate-400">You're all caught up.</div>
                    ) : (
                      notifications.map((notif) => (
                        <div
                          key={notif.id}
                          className={`group w-full p-3 hover:bg-slate-50 transition flex gap-2.5 ${notif.is_read ? '' : 'bg-blue-50/40'}`}
                        >
                          <button
                            onClick={() => openNotification(notif)}
                            className="text-left flex gap-2.5 flex-1 min-w-0"
                          >
                            <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${notif.is_read ? 'bg-transparent' : 'bg-blue-500'}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium text-slate-900 break-words">{notif.title}</span>
                              {notif.message && <span className="block text-xs text-slate-600 mt-0.5 break-words">{notif.message}</span>}
                              <span className="block text-[11px] text-slate-400 mt-1">{timeAgo(notif.created_at || notif.timestamp)}</span>
                            </span>
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); dispatch(deleteNotification(notif.id)); }}
                            aria-label="Delete notification"
                            title="Delete"
                            className="self-start p-1 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition sm:opacity-0 sm:group-hover:opacity-100 shrink-0"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* User Menu */}
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-1.5 sm:gap-2 px-1 sm:px-3 py-1.5 sm:py-2 rounded-lg hover:bg-slate-100 transition"
            >
              <div className="w-7 h-7 sm:w-8 sm:h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs sm:text-sm font-semibold shrink-0">
                {user?.name?.charAt(0) || 'U'}
              </div>
              <div className="text-left hidden md:block">
                <p className="text-sm font-medium text-slate-900">{user?.name}</p>
                <p className="text-xs text-slate-500">{user?.email}</p>
              </div>
              <ChevronDown size={14} className="text-slate-500 hidden md:block" />
            </button>

            {showUserMenu && (
              <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-slate-200 py-2 z-50">
                <button
                  onClick={() => { setShowUserMenu(false); navigate('/profile'); }}
                  className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2 transition"
                >
                  <User size={16} />
                  Profile
                </button>
                <div className="border-t border-slate-200 my-2" />
                <button
                  onClick={handleLogout}
                  className="w-full text-left px-4 py-2 text-sm text-red-700 hover:bg-red-50 flex items-center gap-2 transition"
                >
                  <LogOut size={16} />
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
