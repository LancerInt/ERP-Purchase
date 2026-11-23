import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, X, CheckCircle2, AlertTriangle, Clock, ChevronDown } from 'lucide-react';
import { timeAgo } from '../../utils/timeAgo.js';
import { fetchTallySyncSummary, syncTone } from '../../utils/tallySync.js';
import { fetchAppSettings, patchAppSetting } from '../../utils/appSettings.js';

/**
 * Shared "Tally sync status" center modal — used BOTH as the once-per-login
 * greeting (TallySyncLoginModal) and on demand from the sidebar "Tally sync"
 * button. Controlled via `open` / `onClose`; it fetches its own data each time
 * it opens.
 *
 * DATA: /api/sync-status/ (real Tally import recency — the same source as the
 * Bills "Last synced" strip), reduced to last-synced + per-company + per-kind.
 * It also carries the GLOBAL on/off toggle for the login greeting — one value
 * for all users, flipped via /api/app-settings/ (any signed-in user may flip).
 */
export default function TallySyncModal({ open, onClose }) {
  const [sum, setSum] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // Which company sections are collapsed (by company key). Expanded by default
  // so the Sales / Purchase split is visible the moment the modal opens.
  const [collapsed, setCollapsed] = useState({});
  const [popupOn, setPopupOn] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setSum(await fetchTallySyncSummary()); } catch { /* keep last figures */ }
    finally { setRefreshing(false); }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await fetchAppSettings();
      if (typeof s.tally_login_popup === 'boolean') setPopupOn(s.tally_login_popup);
    } catch { /* leave default */ }
  }, []);

  useEffect(() => { if (open) { load(); loadSettings(); } }, [open, load, loadSettings]);

  const toggle = async () => {
    const next = !popupOn;
    setPopupOn(next);              // optimistic
    setSaving(true);
    try {
      const s = await patchAppSetting('tally_login_popup', next);
      if (typeof s.tally_login_popup === 'boolean') setPopupOn(s.tally_login_popup);
    } catch {
      setPopupOn(!next);          // revert on failure
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const iso = sum?.last_synced_at || null;
  const errors = sum?.error_count || 0;
  const tone = syncTone(sum || {});
  const head = {
    green: { cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', Icon: CheckCircle2, line: 'Tally is up to date.' },
    amber: { cls: 'text-amber-700 bg-amber-50 border-amber-200', Icon: Clock, line: 'Tally sync is more than a day old.' },
    red: { cls: 'text-red-700 bg-red-50 border-red-200', Icon: AlertTriangle, line: `${errors} Tally sync${errors > 1 ? 's' : ''} failed.` },
    slate: { cls: 'text-slate-600 bg-slate-50 border-slate-200', Icon: Clock, line: 'Nothing has synced with Tally yet.' },
  }[tone];
  const { Icon } = head;
  const byCompany = sum?.by_company || [];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="tally-sync-title">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]" onClick={onClose} />

      <div className="relative w-full max-w-sm bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5 min-w-0">
            <RefreshCw size={18} className={`text-slate-500 shrink-0 ${refreshing ? 'animate-spin' : ''}`} />
            <h3 id="tally-sync-title" className="font-semibold text-slate-900">Tally sync status</h3>
          </div>
          <button onClick={onClose} aria-label="Dismiss" className="p-1 -mr-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm font-medium ${head.cls}`}>
            <Icon size={18} className="shrink-0" />
            <span>{sum ? head.line : 'Loading sync status…'}</span>
          </div>

          <div className="text-sm text-slate-700">
            Last synced:{' '}
            <span className="font-medium">{iso ? new Date(iso).toLocaleString('en-IN') : (sum ? 'never' : '—')}</span>
            {iso && <span className="text-slate-400"> · {timeAgo(iso)}</span>}
          </div>

          {/* One collapsible group per company; each lists its Tally kinds
              separately — Sales and Purchase first, then creditors / TDS /
              freight / etc. Expanded by default so the split is visible. */}
          {byCompany.length > 0 && (
            <div className="space-y-1">
              {byCompany.map((c) => {
                const key = c.company_id || c.short;
                const isOpen = !collapsed[key];
                return (
                  <div key={key} className="pt-2 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => setCollapsed((m) => ({ ...m, [key]: isOpen }))}
                      aria-expanded={isOpen}
                      className="w-full flex items-center justify-between text-sm group"
                    >
                      <span className="flex items-center gap-1 min-w-0">
                        <ChevronDown
                          size={14}
                          className={`text-slate-400 transition-transform ${isOpen ? '' : '-rotate-90'}`}
                        />
                        <span className="font-semibold text-slate-700 truncate">{c.short || c.company_name || '—'}</span>
                      </span>
                      <span className="text-slate-400 text-xs whitespace-nowrap">
                        {c.last_synced_at ? timeAgo(c.last_synced_at) : 'never'}
                        {c.error_count ? ` · ⚠${c.error_count}` : ''}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="space-y-0.5 mt-1 pl-[18px]">
                        {c.kinds.map((k) => (
                          <div key={k.kind} className="flex items-center justify-between text-xs">
                            <span className="text-slate-500 truncate pr-2">{k.label}</span>
                            <span className={`whitespace-nowrap ${k.status === 'error' ? 'text-red-500' : (k.last_synced_at ? 'text-slate-400' : 'text-slate-300')}`}>
                              {k.status === 'error' ? '⚠ ' : ''}
                              {k.last_synced_at ? timeAgo(k.last_synced_at) : 'never'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* GLOBAL toggle — flips the login greeting for every user */}
          <div className="pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={toggle}
              disabled={saving}
              className="w-full flex items-center justify-between gap-2 text-sm text-slate-600 disabled:opacity-60"
            >
              <span className="text-left">
                Show popup at login
                <span className="block text-[11px] text-slate-400">applies to all users</span>
              </span>
              <span
                role="switch"
                aria-checked={popupOn}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${popupOn ? 'bg-emerald-500' : 'bg-slate-300'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${popupOn ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </span>
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 bg-slate-50 border-t border-slate-100">
          <button onClick={load} className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 font-medium transition">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium transition">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
