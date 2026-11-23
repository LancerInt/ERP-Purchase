import { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { timeAgo } from '../../utils/timeAgo.js';
import { fetchTallySyncSummary, syncTone } from '../../utils/tallySync.js';
import TallySyncModal from './TallySyncModal.jsx';

/**
 * Sidebar "Tally sync" button — moved here from the top bar. Shows a colored
 * status dot (green fresh / amber stale / red error / slate never) and the
 * relative time at a glance; click opens the shared TallySyncModal with the
 * per-company / per-kind detail and the global login-popup toggle.
 *
 * Collapse-aware: icon + dot only when the rail is collapsed (matches the
 * Notifications button it sits beside). Renders nothing extra if the status
 * fetch fails — the button still works, it just shows "never".
 */
const ICON_TONE = {
  green: 'text-emerald-500', amber: 'text-amber-500', red: 'text-red-500', slate: 'text-slate-400',
};
const DOT_TONE = {
  green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', slate: 'bg-slate-400',
};

export default function TallySyncSidebarButton({ collapsed = false }) {
  const [open, setOpen] = useState(false);
  const [sum, setSum] = useState(null);

  const load = useCallback(async () => {
    try { setSum(await fetchTallySyncSummary()); } catch { /* leave null → "never" */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const iso = sum?.last_synced_at || null;
  const errors = sum?.error_count || 0;
  const tone = syncTone(sum || {});
  const title = errors > 0
    ? `Tally: ${errors} sync error${errors > 1 ? 's' : ''}`
    : (iso ? `Tally synced ${timeAgo(iso)}` : 'Tally — not synced yet');

  return (
    <div className="px-2 pb-2 mb-1 border-b border-slate-100">
      <button
        type="button"
        onClick={() => { setOpen(true); load(); }}
        title={title}
        aria-label={title}
        className={`w-full flex items-center gap-2.5 rounded-lg transition-colors duration-100
          ${collapsed ? 'justify-center px-2 py-2' : 'px-3 py-[7px]'}
          text-slate-600 hover:bg-slate-50 hover:text-slate-900`}
      >
        <span className="relative shrink-0">
          <RefreshCw size={18} strokeWidth={1.5} className={ICON_TONE[tone]} />
          <span className={`absolute -top-1 -right-1 w-2 h-2 rounded-full border-2 border-white ${DOT_TONE[tone]}`} />
        </span>
        {!collapsed && <span className="text-[13px] flex-1 text-left">Tally sync</span>}
        {!collapsed && (
          <span className="text-[11px] text-slate-400 whitespace-nowrap">
            {iso ? timeAgo(iso) : 'never'}
          </span>
        )}
      </button>

      <TallySyncModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
