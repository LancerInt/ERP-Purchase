import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel from '../../../components/common/FilterPanel';
import DataTable from '../../../components/common/DataTable';
import useApiData from '../../../hooks/useApiData.js';
import { useUrlState, useUrlFilters } from '../../../hooks/useUrlState.js';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { formatDateTime } from '@/utils/formatters';

// Audit Logs is the one list in the app backed by a table that's already
// 100k+ rows and grows on every save anywhere in the ERP. Every other list
// page can afford useApiData's "fetch everything, filter in the browser"
// pattern because its underlying table stays in the hundreds/low thousands —
// this one can't, so it sends its filters to the server instead and only
// ever pulls a bounded window. Defaulting that window to 7 days is what
// actually fixes the slow load; the DB index (see rbac.AuditLog.Meta) makes
// that bounded query fast, but an *unbounded* one would still be slow no
// matter how well-indexed it is.
const DAY = 24 * 60 * 60 * 1000;
const isoDate = (d) => d.toISOString().slice(0, 10);
const RANGE_PRESETS = [
  { key: '7', label: '7 days', days: 7 },
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: 'all', label: 'All Time', days: null },
];

const ACTION_BADGE = {
  CREATE:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  EDIT:     'bg-blue-50 text-blue-700 border-blue-200',
  DELETE:   'bg-red-50 text-red-700 border-red-200',
  VIEW:     'bg-slate-100 text-slate-600 border-slate-200',
  LOGIN:    'bg-indigo-50 text-indigo-700 border-indigo-200',
  LOGOUT:   'bg-slate-100 text-slate-600 border-slate-200',
  PASSWORD: 'bg-amber-50 text-amber-700 border-amber-200',
};

// Summary columns for the default "Users" view — one row per user, their
// current role, when they last signed in, and their single most recent
// action anywhere in the ERP. This is what opens by default; the full
// per-event trail (every past CREATE/EDIT/DELETE, still fully intact) is
// one click away via "View full history", not deleted or reduced.
const SUMMARY_COLUMNS = (onViewHistory) => [
  { key: 'user_display', label: 'User', sortable: true,
    render: (value, row) => value || row.username },
  { key: 'role_name', label: 'Role', sortable: true,
    render: (value) => value || <span className="text-slate-300">—</span> },
  { key: 'last_login', label: 'Last Login', sortable: true,
    render: (value) => value ? formatDateTime(value) : <span className="text-slate-300">Never</span> },
  { key: 'last_activity_timestamp', label: 'Last Activity', sortable: true,
    render: (_v, row) => row.last_activity?.timestamp
      ? formatDateTime(row.last_activity.timestamp)
      : <span className="text-slate-300">No activity yet</span> },
  { key: 'last_activity_module', label: 'Module',
    render: (_v, row) => row.last_activity?.module_name || <span className="text-slate-300">—</span> },
  { key: 'last_activity_record', label: 'Record',
    render: (_v, row) => row.last_activity?.record_repr || <span className="text-slate-300">—</span> },
  { key: 'last_activity_action', label: 'Action',
    render: (_v, row) => row.last_activity?.action
      ? <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium border ${ACTION_BADGE[row.last_activity.action] || 'bg-slate-100 text-slate-700 border-slate-200'}`}>{row.last_activity.action}</span>
      : '-' },
  { key: 'last_activity_details', label: 'Details',
    render: (_v, row) => (
      <span className="text-slate-600 text-xs max-w-xs truncate block" title={row.last_activity?.details}>
        {row.last_activity?.details || '-'}
      </span>
    ) },
  { key: 'last_activity_ip', label: 'IP Address',
    render: (_v, row) => row.last_activity?.ip_address || '' },
  {
    key: 'actions', label: '',
    render: (_v, row) => (
      <button
        type="button"
        onClick={() => onViewHistory(row.username)}
        className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
      >
        <History size={13} /> Full history
      </button>
    ),
  },
];

export default function AuditLogViewer() {
  const [showFilters, setShowFilters] = useState(false);
  // View mode + filters live in the URL so Back / refresh / sharing restore the
  // exact view (which user's history, which range, which filters).
  // 'summary' = one row per user (default). 'detail' = the full, filterable
  // per-event trail — reached via "Full history" or the button below.
  const [mode, setMode] = useUrlState('mode', 'summary');
  // range starts at '7' (days) — the bounded default that keeps this page
  // fast. Picking a Date From/To below switches it to 'custom' implicitly.
  const [range, setRange] = useUrlState('range', '7');
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    user: '', module: '', action: '', date_from: '', date_to: '', search: '',
  });

  const summary = useApiData('/api/rbac/audit-logs/by-user/');

  const viewHistory = (username) => {
    clearFilters();
    setFilterValue('user', username || '');
    setRange('all');
    setMode('detail');
  };

  const filters = [
    { key: 'user', label: 'User', type: 'text', placeholder: 'Filter by user...' },
    { key: 'module', label: 'Module', type: 'text', placeholder: 'Filter by module...' },
    {
      key: 'action',
      label: 'Action',
      type: 'select',
      options: [
        { value: 'CREATE',   label: 'Create' },
        { value: 'EDIT',     label: 'Edit' },
        { value: 'DELETE',   label: 'Delete' },
        { value: 'VIEW',     label: 'View' },
        { value: 'LOGIN',    label: 'Login' },
        { value: 'LOGOUT',   label: 'Logout' },
        { value: 'PASSWORD', label: 'Password Change' },
      ],
    },
    { key: 'date_from', label: 'Date From', type: 'date' },
    { key: 'date_to', label: 'Date To', type: 'date' },
  ];

  const columns = [
    {
      key: 'timestamp',
      label: 'Timestamp',
      sortable: true,
      render: (value) => value ? formatDateTime(value) : '-',
    },
    // user_display is a new serializer field that prefers full name
    // and falls back to username / "System" on signal-driven events
    // that had no HTTP request context.
    { key: 'user_display', label: 'User', sortable: true,
      render: (value, row) => value || row.username || 'System' },
    { key: 'role_name', label: 'Role', sortable: true },
    { key: 'module_name', label: 'Module', sortable: true },
    // record_repr is the human-readable label of the affected row
    // (PO-XXX / Vendor name / etc.), captured at log time so it
    // stays readable even if the source record is later renamed
    // or deleted.
    { key: 'record_repr', label: 'Record', sortable: true,
      render: (value) => value || <span className="text-slate-300">—</span> },
    { key: 'action', label: 'Action', sortable: true },
    {
      key: 'details',
      label: 'Details',
      render: (value) => (
        <span className="text-slate-600 text-xs max-w-xs truncate block" title={value}>
          {value || '-'}
        </span>
      ),
    },
    { key: 'ip_address', label: 'IP Address' },
  ];

  // A manually-picked Date From/To overrides the preset; otherwise the
  // active preset (default: last 7 days) supplies the lower bound. 'all'
  // sends no bound at all — an explicit, understood-to-be-heavier choice,
  // not the default first-load experience.
  const isCustomRange = !!(filterValues.date_from || filterValues.date_to);
  const effectiveDateFrom = filterValues.date_from
    || (range !== 'all' ? isoDate(new Date(Date.now() - Number(range) * DAY)) : '');
  const effectiveDateTo = filterValues.date_to || '';

  const { data, isLoading, error, refetch } = useApiData('/api/rbac/audit-logs/', { autoFetch: false });

  // This table can hold 100k+ rows and grows continuously — every filter
  // (including the date range) is sent to the server so a page view only
  // ever pulls the window actually being looked at, instead of the whole
  // table. Debounced so typing in User/Module doesn't fire a request per
  // keystroke.
  useEffect(() => {
    const params = { ordering: '-timestamp' };
    if (effectiveDateFrom) params.date_from = effectiveDateFrom;
    if (effectiveDateTo) params.date_to = effectiveDateTo;
    if (filterValues.user) params.user = filterValues.user;
    if (filterValues.module) params.module_name = filterValues.module;
    if (filterValues.action) params.action = filterValues.action;
    if (filterValues.search) params.search = filterValues.search;
    const t = setTimeout(() => refetch(params), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveDateFrom, effectiveDateTo, filterValues.user, filterValues.module,
      filterValues.action, filterValues.search]);

  const pickRange = (key) => {
    setRange(key);
    // A preset always wins over a stale manual date pick.
    setFilterValue('date_from', '');
    setFilterValue('date_to', '');
  };

  if (mode === 'summary') {
    return (
      <MainLayout>
        <PageHeader
          title="Audit Logs"
          subtitle="Every user, their current role, and their most recent activity"
          breadcrumbs={[{ label: 'Admin' }, { label: 'Audit Logs' }]}
        />
        <ListState error={summary.error} onRetry={summary.refetch}>
          <MobileListCards
            rows={summary.data}
            isLoading={summary.isLoading}
            onRowClick={(row) => viewHistory(row.username)}
            config={{
              title: (row) => row.user_display || row.username,
              subtitle: (row) => row.role_name || '—',
              badge: (row) => row.last_activity ? ({
                label: row.last_activity.action || '—',
                cls: ACTION_BADGE[row.last_activity.action] || 'bg-slate-100 text-slate-700 border-slate-200',
              }) : null,
              fields: (row) => [
                { label: 'Last Login',    value: row.last_login ? formatDateTime(row.last_login) : 'Never' },
                { label: 'Last Activity', value: row.last_activity?.timestamp ? formatDateTime(row.last_activity.timestamp) : 'No activity yet' },
                { label: 'Module',        value: row.last_activity?.module_name },
                { label: 'Record',        value: row.last_activity?.record_repr },
                { label: 'Note',          value: row.last_activity?.details },
              ],
            }}
            emptyMessage="No users found"
          />
          <div className="hidden sm:block">
            <DataTable persistKey="admin-audit-logs-summary"
              exportFileName="audit-logs-by-user"
              columns={SUMMARY_COLUMNS(viewHistory)}
              data={summary.data}
              isLoading={summary.isLoading}
            />
          </div>
        </ListState>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title={filterValues.user ? `Full history — ${filterValues.user}` : 'Audit Logs — full history'}
        subtitle="Every recorded event. Nothing here is pruned or overwritten."
        breadcrumbs={[{ label: 'Admin' }, { label: 'Audit Logs' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
        }}
      />
      <button
        type="button"
        onClick={() => setMode('summary')}
        className="mb-3 text-xs font-medium text-slate-500 hover:text-slate-800"
      >
        ← Back to Users
      </button>
      {showFilters && (
        <FilterPanel
          filters={filters}
          values={filterValues}
          onChange={setFilterValue}
          onReset={clearFilters}
          onClose={() => setShowFilters(false)}
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => pickRange(p.key)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${
              !isCustomRange && range === p.key
                ? 'bg-slate-800 text-white border-slate-800'
                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
            }`}
          >
            {p.label}
          </button>
        ))}
        {isCustomRange && (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-slate-800 text-white">Custom range</span>
        )}
        {range === 'all' && !isCustomRange && (
          <span className="text-xs text-amber-600">Unbounded — this can take a while to load.</span>
        )}
      </div>
      <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={data}
          isLoading={isLoading}
          searchTerm={filterValues.search || ''}
          onSearchChange={(v) => setFilterValue('search', v)}
          searchPlaceholder="Search audit logs…"
          config={{
            title: (row) => row.user_display || row.username || 'System',
            subtitle: (row) => [row.module_name, row.record_repr].filter(Boolean).join(' · ') || '—',
            badge: (row) => ({
              label: row.action || '—',
              cls: ACTION_BADGE[row.action] || 'bg-slate-100 text-slate-700 border-slate-200',
            }),
            fields: (row) => [
              { label: 'When',   value: row.timestamp ? formatDateTime(row.timestamp) : '-' },
              { label: 'Role',   value: row.role_name },
              { label: 'Record', value: row.record_repr },
              { label: 'IP',     value: row.ip_address },
              { label: 'Note',   value: row.details },
            ],
          }}
          emptyMessage="No audit entries"
        />
        <div className="hidden sm:block">
          <DataTable persistKey="admin-audit-logs"
            exportFileName="audit-logs"
            columns={columns}
            data={data}
            isLoading={isLoading}
          />
        </div>
      </ListState>
    </MainLayout>
  );
}
