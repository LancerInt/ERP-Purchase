// Per-record activity trail — drops onto any detail page as a card
// that fetches the record's AuditLog events and renders them as a
// vertical timeline.
//
// Usage:
//
//   <ActivityLog module="Purchase Order" recordId={po.id} />
//
// `module` is optional (extra filter) — if you pass both, the API
// filters on the intersection; if you pass just `recordId`, every
// module's events for that record ID are shown. The backend
// (rbac.AuditLogViewSet.get_permissions) allows any authenticated
// user to hit this endpoint when `record_id` is in the query, so no
// per-role gating is needed at the component level.
import { useEffect, useState } from 'react';
import apiClient from '../../utils/api.js';
import { formatDate } from '@/utils/formatters';

const ACTION_STYLE = {
  CREATE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  EDIT: 'bg-blue-50 text-blue-700 border-blue-200',
  DELETE: 'bg-red-50 text-red-700 border-red-200',
  LOGIN: 'bg-slate-50 text-slate-700 border-slate-200',
  LOGOUT: 'bg-slate-50 text-slate-700 border-slate-200',
  PASSWORD: 'bg-amber-50 text-amber-700 border-amber-200',
  VIEW: 'bg-slate-50 text-slate-500 border-slate-200',
};

function _formatDateTime(ts) {
  if (!ts) return '-';
  try {
    const d = new Date(ts);
    const date = formatDate(d);
    const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    return `${date} · ${time}`;
  } catch {
    return String(ts);
  }
}

export default function ActivityLog({ module, recordId, limit = 50, className = '' }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!recordId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ record_id: recordId, ordering: '-timestamp' });
    if (module) params.set('module_name', module);
    if (limit) params.set('page_size', String(limit));
    apiClient.get(`/api/rbac/audit-logs/?${params.toString()}`)
      .then((r) => {
        if (cancelled) return;
        const data = r.data?.results || r.data || [];
        setRows(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.response?.data?.detail || 'Failed to load activity.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [module, recordId, limit]);

  if (!recordId) return null;

  return (
    <div className={`bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base sm:text-lg font-semibold text-slate-900">Activity</h2>
        {rows.length > 0 && (
          <span className="text-xs text-slate-500">{rows.length} event{rows.length === 1 ? '' : 's'}</span>
        )}
      </div>
      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500 italic">No activity recorded yet.</p>
      ) : (
        <ol className="relative border-l border-slate-200 ml-2">
          {rows.map((r) => (
            <li key={r.id} className="mb-3 ml-3 last:mb-0">
              <div className="absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full bg-slate-300 border border-white" />
              <div className="flex flex-wrap items-center gap-2 mb-0.5">
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border uppercase tracking-wide ${ACTION_STYLE[r.action] || 'bg-slate-50 text-slate-600 border-slate-200'}`}
                  title={r.action}
                >
                  {r.action}
                </span>
                <span className="text-xs text-slate-700 font-medium">{r.user_display || 'System'}</span>
                {r.role_name && (
                  <span className="text-[10px] text-slate-500">({r.role_name})</span>
                )}
                <span className="text-[11px] text-slate-400">
                  {_formatDateTime(r.timestamp)}
                </span>
              </div>
              {r.details && (
                <p className="text-sm text-slate-700 leading-snug">{r.details}</p>
              )}
              {r.module_name && !module && (
                <p className="text-[11px] text-slate-500 mt-0.5">{r.module_name}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
