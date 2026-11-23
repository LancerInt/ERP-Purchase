import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Plus, Users, UserCheck, Sun, Moon, RefreshCw, AlertTriangle, UserX, ListChecks,
  Settings as SettingsIcon, Filter as FilterIcon, RotateCcw, Search, Download, Upload,
  Eye, Pencil, Copy, Trash2, X as XIcon, MoreVertical, Calendar as CalIcon,
  ChevronLeft, ChevronRight, CheckCircle, Clock, Building2,
  List as ListIcon, LayoutGrid, FileText, MapPin,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatDateTime } from '@/utils/formatters';

// ─── Formatters / helpers ────────────────────────────────────────────────

const fmtTime12 = (v) => {
  if (!v) return '—';
  const [hStr, mStr = '00'] = String(v).split(':');
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return '—';
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${h}:${mStr.slice(0, 2)} ${ampm}`;
};
const fmtTime24 = (v) => v ? String(v).slice(0, 5) : '—';
const fmtDate = (v) =>
  v ? formatDate(v) : '—';
const todayIso = () => new Date().toISOString().slice(0, 10);
const uniq = (arr) => [...new Set((arr || []).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

// Heuristic shift-type classifier driven by start time + name. The
// backend doesn't have a `shift_type` enum yet; this lets the UI
// already render the chip / KPI counts correctly. Once you add a real
// field, swap `classifyShiftType(s)` for `s.shift_type`.
const classifyShiftType = (s) => {
  const name = `${s.shift_code || ''} ${s.shift_name || ''}`.toUpperCase();
  if (/ROTAT|RTN/.test(name)) return 'ROTATIONAL';
  if (/SPLIT/.test(name)) return 'SPLIT';
  if (/FLEX/.test(name)) return 'FLEXIBLE';
  if (/WEEKEND|SAT|SUN/.test(name)) return 'WEEKEND';
  if (/OT|OVER/.test(name)) return 'OVERTIME';
  if (/ON.?CALL|CALL/.test(name)) return 'ON_CALL';
  if (!s.start_time) return 'GENERAL';
  const h = parseInt(String(s.start_time).slice(0, 2), 10);
  if (Number.isNaN(h)) return 'GENERAL';
  if (h >= 19 || h < 5) return 'NIGHT';
  if (h >= 5 && h < 12) return 'DAY';
  return 'GENERAL';
};

const SHIFT_TYPE_META = {
  GENERAL:    { label: 'General',    chip: 'bg-slate-100 text-slate-700 border-slate-200' },
  DAY:        { label: 'Day',        chip: 'bg-amber-100 text-amber-800 border-amber-200' },
  NIGHT:      { label: 'Night',      chip: 'bg-indigo-100 text-indigo-800 border-indigo-200' },
  ROTATIONAL: { label: 'Rotational', chip: 'bg-violet-100 text-violet-800 border-violet-200' },
  SPLIT:      { label: 'Split',      chip: 'bg-cyan-100 text-cyan-800 border-cyan-200' },
  FLEXIBLE:   { label: 'Flexible',   chip: 'bg-teal-100 text-teal-800 border-teal-200' },
  WEEKEND:    { label: 'Weekend',    chip: 'bg-rose-100 text-rose-800 border-rose-200' },
  OVERTIME:   { label: 'Overtime',   chip: 'bg-pink-100 text-pink-800 border-pink-200' },
  ON_CALL:    { label: 'On-call',    chip: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200' },
};

const STATUS_META = {
  ACTIVE:   { label: 'Active',   chip: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  INACTIVE: { label: 'Inactive', chip: 'bg-slate-100 text-slate-600 border-slate-200' },
  DRAFT:    { label: 'Draft',    chip: 'bg-blue-100 text-blue-800 border-blue-200' },
  ARCHIVED: { label: 'Archived', chip: 'bg-slate-200 text-slate-700 border-slate-300' },
};

const APPROVAL_META = {
  PENDING:  { label: 'Pending',  chip: 'bg-amber-100 text-amber-800 border-amber-200' },
  APPROVED: { label: 'Approved', chip: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  REJECTED: { label: 'Rejected', chip: 'bg-red-100 text-red-800 border-red-200' },
};

const TABS = [
  { key: 'list',         label: 'Shift List',           Icon: ListIcon },
  { key: 'roster',       label: 'Shift Roster',         Icon: CalIcon },
  { key: 'assignments',  label: 'Employee Assignments', Icon: Users },
  { key: 'rotations',    label: 'Rotation Rules',       Icon: RefreshCw },
  { key: 'weekly_off',   label: 'Weekly Off Rules',     Icon: Sun },
  { key: 'calendar',     label: 'Shift Calendar',       Icon: LayoutGrid },
  { key: 'reports',      label: 'Reports',              Icon: FileText },
];

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SHIFT_COLORS = [
  'bg-blue-100 text-blue-800 border-blue-300',
  'bg-emerald-100 text-emerald-800 border-emerald-300',
  'bg-amber-100 text-amber-800 border-amber-300',
  'bg-violet-100 text-violet-800 border-violet-300',
  'bg-rose-100 text-rose-800 border-rose-300',
  'bg-cyan-100 text-cyan-800 border-cyan-300',
  'bg-indigo-100 text-indigo-800 border-indigo-300',
  'bg-teal-100 text-teal-800 border-teal-300',
];

// ─── Page ────────────────────────────────────────────────────────────────

export default function ShiftManagement() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete } = usePermissions();
  const { data: shifts, isLoading, error, refetch } = useApiData('/api/hr/shifts/');
  const { data: staff } = useApiData('/api/hr/staff/');

  const [activeTab, setActiveTab] = useState('list');
  // Filters live in the URL so Back / refresh / sharing restore the filtered
  // view. They're mirrored back by the effect below whenever they change.
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => ({
    q: searchParams.get('q') || '',
    department: searchParams.get('department') || '',
    location: searchParams.get('location') || '',
    shift_type: searchParams.get('shift_type') || '',
    status: searchParams.get('status') || '',
    supervisor: searchParams.get('supervisor') || '',
    employee: searchParams.get('employee') || '',
    date_from: searchParams.get('date_from') || '',
    date_to: searchParams.get('date_to') || '',
  }));
  const [draft, setDraft] = useState(filters);
  const [showFiltersMobile, setShowFiltersMobile] = useState(false);
  const [drawer, setDrawer] = useState({ open: false, row: null });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState(null); // null = create, object = edit
  const [assignOpen, setAssignOpen] = useState(false);

  useEffect(() => { setDraft(filters); }, [filters]);

  // Mirror the applied filters into the URL (replace — a filter change isn't a
  // separate history entry; only opening a record is).
  useEffect(() => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      const put = (k, v) => { if (v) p.set(k, v); else p.delete(k); };
      put('q', filters.q);
      put('department', filters.department);
      put('location', filters.location);
      put('shift_type', filters.shift_type);
      put('status', filters.status);
      put('supervisor', filters.supervisor);
      put('employee', filters.employee);
      put('date_from', filters.date_from);
      put('date_to', filters.date_to);
      return p;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  // ── Derived collections ────────────────────────────────────────────────
  const departments = useMemo(() => uniq((staff || []).map(s => s.department)), [staff]);
  const locations   = useMemo(() => uniq((staff || []).map(s => s.location_name || s.warehouse_name)), [staff]);

  const staffByShift = useMemo(() => {
    const m = {};
    (staff || []).forEach((s) => {
      if (s.shift_assignment) {
        if (!m[s.shift_assignment]) m[s.shift_assignment] = [];
        m[s.shift_assignment].push(s);
      }
    });
    return m;
  }, [staff]);

  // Enrich each shift row with type + assignment count + colour seed.
  const enrichedShifts = useMemo(() => {
    return (shifts || []).map((s, i) => {
      const type = classifyShiftType(s);
      return {
        ...s,
        _type: type,
        _typeMeta: SHIFT_TYPE_META[type] || SHIFT_TYPE_META.GENERAL,
        _assignedCount: (staffByShift[s.id] || []).length,
        _approvalStatus: s.approval_required ? 'PENDING' : 'APPROVED',
        _statusKey: s.is_active === false ? 'INACTIVE' : 'ACTIVE',
        _color: SHIFT_COLORS[i % SHIFT_COLORS.length],
      };
    });
  }, [shifts, staffByShift]);

  const filteredShifts = useMemo(() => {
    const q = filters.q.toLowerCase().trim();
    return enrichedShifts.filter((s) => {
      if (q) {
        const hay = [s.shift_code, s.shift_name, s.warehouse_name].map(x => String(x || '').toLowerCase()).join(' ');
        if (!hay.includes(q)) return false;
      }
      if (filters.shift_type && s._type !== filters.shift_type) return false;
      if (filters.status && s._statusKey !== filters.status) return false;
      if (filters.location && s.warehouse_name !== filters.location) return false;
      return true;
    });
  }, [enrichedShifts, filters]);

  // ── KPI counts ─────────────────────────────────────────────────────────
  const kpi = useMemo(() => {
    const all = enrichedShifts;
    const active = all.filter(s => s.is_active !== false);
    const assigned = (staff || []).filter(s => s.shift_assignment).length;
    const totalActiveStaff = (staff || []).filter(s => s.employment_status === 'ACTIVE').length;
    const unassigned = totalActiveStaff - assigned;
    const day = active.filter(s => s._type === 'DAY' || s._type === 'GENERAL').reduce((c, s) => c + s._assignedCount, 0);
    const night = active.filter(s => s._type === 'NIGHT').reduce((c, s) => c + s._assignedCount, 0);
    const rotational = active.filter(s => s._type === 'ROTATIONAL').length;
    // Conflicts: staff assigned to a shift that's been deactivated.
    const conflicts = (staff || []).filter((p) => {
      if (!p.shift_assignment) return false;
      const sh = all.find(x => x.id === p.shift_assignment);
      return !sh || sh.is_active === false;
    }).length;
    return {
      total: all.length,
      active: active.length,
      assigned, day, night, rotational, unassigned, conflicts,
    };
  }, [enrichedShifts, staff]);

  // ── Actions ────────────────────────────────────────────────────────────
  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Delete shift "${row.shift_code} — ${row.shift_name}"?`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/hr/shifts/${row.id}/`);
      toast.success('Shift deleted.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };
  const handleDuplicate = (row) => {
    setEditorTarget({
      ...row,
      id: undefined,
      shift_code: `${row.shift_code}-COPY`,
      shift_name: `${row.shift_name} (Copy)`,
    });
    setEditorOpen(true);
  };
  const openEditor = (row = null) => { setEditorTarget(row); setEditorOpen(true); };
  const closeEditor = () => { setEditorOpen(false); setEditorTarget(null); };
  const onEditorSaved = () => { closeEditor(); refetch(); };

  const applyFilters = () => { setFilters(draft); setShowFiltersMobile(false); };
  const resetFilters = () => {
    const blank = { q: '', department: '', location: '', shift_type: '', status: '', supervisor: '', employee: '', date_from: '', date_to: '' };
    setFilters(blank); setDraft(blank); setShowFiltersMobile(false);
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <MainLayout>
      <div className="space-y-5">
        {/* Header */}
        <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs text-slate-500 mb-1">HR / Shift Management</p>
            <h1 className="text-2xl font-bold text-slate-900">Shift Management</h1>
            <p className="text-sm text-slate-600 mt-1 max-w-2xl">
              Create, assign, monitor, and manage employee shifts, rotations, weekly offs, and attendance rules.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canCreate('Shift') && (
              <button onClick={() => openEditor(null)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                <Plus size={15} /> Create Shift
              </button>
            )}
            <button onClick={() => setAssignOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              <UserCheck size={15} /> Assign Shift
            </button>
            <button onClick={() => { setAssignOpen(true); }}
              className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Users size={15} /> Bulk Assign
            </button>
            <button onClick={() => toast('Bulk import — wire to your roster CSV / device feed.', { icon: '📥' })}
              className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Download size={15} /> Import Roster
            </button>
            <button onClick={() => exportShiftCsv(filteredShifts, staffByShift)}
              className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Upload size={15} /> Export Report
            </button>
          </div>
        </header>

        {/* KPI cards */}
        <SummaryRow k={kpi} />

        {/* Filters */}
        <FiltersBar
          draft={draft} setDraft={setDraft}
          onApply={applyFilters} onReset={resetFilters}
          departments={departments} locations={locations}
          showMobile={showFiltersMobile} setShowMobile={setShowFiltersMobile}
        />

        {/* Tabs */}
        <TabStrip tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

        {/* Tab body */}
        {isLoading ? (
          <Skeleton />
        ) : error ? (
          <ErrorState onRetry={refetch} />
        ) : (
          <>
            {activeTab === 'list' && (
              <ShiftListTab
                rows={filteredShifts}
                onView={(r) => setDrawer({ open: true, row: r })}
                onEdit={(r) => openEditor(r)}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                onAssign={(r) => { setAssignOpen(true); /* prefill happens via shared state if extended */ }}
                canEdit={canEdit} canDelete={canDelete}
              />
            )}
            {activeTab === 'roster' && (
              <RosterTab shifts={enrichedShifts} staff={staff || []} onShiftClick={(id) => setDrawer({ open: true, row: enrichedShifts.find(s => s.id === id) })} />
            )}
            {activeTab === 'assignments' && (
              <AssignmentsTab shifts={enrichedShifts} staff={staff || []} staffByShift={staffByShift} onAssign={() => setAssignOpen(true)} />
            )}
            {activeTab === 'rotations'  && <RotationRulesTab />}
            {activeTab === 'weekly_off' && <WeeklyOffRulesTab />}
            {activeTab === 'calendar'   && <CalendarTab shifts={enrichedShifts} staff={staff || []} onShiftClick={(id) => setDrawer({ open: true, row: enrichedShifts.find(s => s.id === id) })} />}
            {activeTab === 'reports'    && <ReportsTab shifts={enrichedShifts} staff={staff || []} staffByShift={staffByShift} />}
          </>
        )}
      </div>

      {/* Detail drawer */}
      {drawer.open && drawer.row && (
        <ShiftDetailDrawer
          row={drawer.row}
          staff={staffByShift[drawer.row.id] || []}
          onClose={() => setDrawer({ open: false, row: null })}
          onEdit={() => { setDrawer({ open: false, row: null }); openEditor(drawer.row); }}
        />
      )}

      {/* Create / Edit modal */}
      {editorOpen && (
        <ShiftEditorModal
          initial={editorTarget}
          onClose={closeEditor}
          onSaved={onEditorSaved}
        />
      )}

      {/* Assign modal */}
      {assignOpen && (
        <AssignShiftModal
          shifts={enrichedShifts}
          staff={staff || []}
          staffByShift={staffByShift}
          onClose={() => setAssignOpen(false)}
          onSaved={() => { setAssignOpen(false); refetch(); }}
        />
      )}
    </MainLayout>
  );
}

// ─── Summary KPI cards ──────────────────────────────────────────────────

function SummaryRow({ k }) {
  const cards = [
    { label: 'Total Shifts',         value: k.total,       Icon: ListIcon,   tone: 'slate' },
    { label: 'Active Shifts',        value: k.active,      Icon: CheckCircle, tone: 'emerald' },
    { label: 'Employees Assigned',   value: k.assigned,    Icon: UserCheck,  tone: 'blue' },
    { label: "Today's Day Shift",    value: k.day,         Icon: Sun,        tone: 'amber' },
    { label: "Today's Night Shift",  value: k.night,       Icon: Moon,       tone: 'indigo' },
    { label: 'Rotational Shifts',    value: k.rotational,  Icon: RefreshCw,  tone: 'violet' },
    { label: 'Unassigned',           value: k.unassigned,  Icon: UserX,      tone: k.unassigned > 0 ? 'red' : 'slate' },
    { label: 'Conflicts',            value: k.conflicts,   Icon: AlertTriangle, tone: k.conflicts > 0 ? 'red' : 'slate' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-3">
      {cards.map(c => <KpiCard key={c.label} {...c} />)}
    </div>
  );
}
function KpiCard({ label, value, Icon, tone }) {
  const toneMap = {
    slate:   { wrap: 'bg-slate-50 border-slate-200',     icon: 'text-slate-600 bg-slate-100' },
    emerald: { wrap: 'bg-emerald-50 border-emerald-200', icon: 'text-emerald-700 bg-emerald-100' },
    red:     { wrap: 'bg-red-50 border-red-200',         icon: 'text-red-700 bg-red-100' },
    amber:   { wrap: 'bg-amber-50 border-amber-200',     icon: 'text-amber-700 bg-amber-100' },
    blue:    { wrap: 'bg-blue-50 border-blue-200',       icon: 'text-blue-700 bg-blue-100' },
    indigo:  { wrap: 'bg-indigo-50 border-indigo-200',   icon: 'text-indigo-700 bg-indigo-100' },
    violet:  { wrap: 'bg-violet-50 border-violet-200',   icon: 'text-violet-700 bg-violet-100' },
  };
  const t = toneMap[tone] || toneMap.slate;
  return (
    <div className={`rounded-xl border ${t.wrap} px-4 py-3.5 flex items-center gap-3 transition hover:shadow-sm`}>
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${t.icon}`}>
        <Icon size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-slate-600 truncate">{label}</p>
        <p className="text-xl font-bold text-slate-900 leading-tight">{value}</p>
      </div>
    </div>
  );
}

// ─── Filter bar ──────────────────────────────────────────────────────────

function FiltersBar({ draft, setDraft, onApply, onReset, departments, locations, showMobile, setShowMobile }) {
  const upd = (k, v) => setDraft((p) => ({ ...p, [k]: v }));
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-3">
      <div className="flex items-center gap-2 lg:hidden mb-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input type="text" value={draft.q} onChange={(e) => upd('q', e.target.value)}
            placeholder="Search shift code or name"
            className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
        </div>
        <button onClick={() => setShowMobile(!showMobile)}
          className="inline-flex items-center gap-1 px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
          <FilterIcon size={14} /> Filters
        </button>
      </div>
      <div className={`${showMobile ? 'block' : 'hidden'} lg:block`}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-2">
          <div className="relative xl:col-span-2 hidden lg:block">
            <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input type="text" value={draft.q} onChange={(e) => upd('q', e.target.value)}
              placeholder="Search shift code or name"
              className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
          </div>
          <Sel label="Department" value={draft.department} onChange={(v) => upd('department', v)} options={departments.map(d => ({ value: d, label: d }))} placeholder="All Depts" />
          <Sel label="Location" value={draft.location} onChange={(v) => upd('location', v)} options={locations.map(l => ({ value: l, label: l }))} placeholder="All Sites" />
          <Sel label="Shift Type" value={draft.shift_type} onChange={(v) => upd('shift_type', v)}
            options={Object.entries(SHIFT_TYPE_META).map(([v, m]) => ({ value: v, label: m.label }))} placeholder="All Types" />
          <Sel label="Status" value={draft.status} onChange={(v) => upd('status', v)}
            options={Object.entries(STATUS_META).map(([v, m]) => ({ value: v, label: m.label }))} placeholder="All" />
          <DateF label="From" value={draft.date_from} onChange={(v) => upd('date_from', v)} />
          <DateF label="To" value={draft.date_to} onChange={(v) => upd('date_to', v)} />
        </div>
        <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-slate-100">
          <button onClick={onReset}
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
            <RotateCcw size={14} /> Reset
          </button>
          <button onClick={onApply}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
            Apply Filters
          </button>
        </div>
      </div>
    </section>
  );
}
function Sel({ label, value, onChange, options, placeholder }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-slate-500 mb-1 uppercase tracking-wide">{label}</label>
      <CustomSelect value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500">
        <option value="">{placeholder}</option>
        {options.filter(o => o.value).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </CustomSelect>
    </div>
  );
}
function DateF({ label, value, onChange }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-slate-500 mb-1 uppercase tracking-wide">{label}</label>
      <CustomDatePicker value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
    </div>
  );
}

// ─── Tab strip ───────────────────────────────────────────────────────────

function TabStrip({ tabs, activeTab, onChange }) {
  return (
    <div className="border-b border-slate-200 overflow-x-auto">
      <div className="flex items-center gap-1 min-w-max">
        {tabs.map((t) => {
          const Icon = t.Icon;
          const active = activeTab === t.key;
          return (
            <button key={t.key} onClick={() => onChange(t.key)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px whitespace-nowrap ${
                active ? 'text-blue-700 border-blue-600' : 'text-slate-600 border-transparent hover:text-slate-800 hover:border-slate-200'
              }`}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Status badges ───────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const c = STATUS_META[status] || STATUS_META.INACTIVE;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${c.chip}`}>{c.label}</span>;
}
function ApprovalBadge({ status }) {
  const c = APPROVAL_META[status] || APPROVAL_META.PENDING;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${c.chip}`}>{c.label}</span>;
}
function TypeBadge({ type, meta }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${meta?.chip || ''}`}>{meta?.label || type}</span>;
}

// ─── Shift List tab ──────────────────────────────────────────────────────

function ShiftListTab({ rows, onView, onEdit, onDuplicate, onDelete, onAssign, canEdit, canDelete }) {
  if (rows.length === 0) return <EmptyState title="No shifts found" body="Create your first shift or adjust filters." />;
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: '1700px' }}>
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr>
              {[
                '#', 'Code', 'Name', 'Type', 'Start', 'End', 'Break', 'Total Hrs',
                'Grace', 'Late After', 'Early Before', 'OT After', 'Wk Off', 'Assigned',
                'Location', 'Status', 'Approval', '',
              ].map((h) => (
                <th key={h} className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((s, idx) => {
              const grace = Number(s.grace_period_minutes || 0);
              const lateAfter = grace > 0 ? `+${grace}m` : '—';
              return (
                <tr key={s.id} onClick={() => onView(s)} className="hover:bg-blue-50/40 cursor-pointer">
                  <td className="px-3 py-2.5 text-slate-400">{idx + 1}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-blue-700 font-medium">{s.shift_code}</td>
                  <td className="px-3 py-2.5 font-medium text-slate-800">{s.shift_name}</td>
                  <td className="px-3 py-2.5"><TypeBadge type={s._type} meta={s._typeMeta} /></td>
                  <td className="px-3 py-2.5 font-mono text-xs text-emerald-700 whitespace-nowrap">{fmtTime12(s.start_time)}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-red-700 whitespace-nowrap">{fmtTime12(s.end_time)}</td>
                  <td className="px-3 py-2.5 text-slate-600">{s.break_duration_mins ? `${s.break_duration_mins}m` : '—'}</td>
                  <td className="px-3 py-2.5 font-semibold">{s.shift_duration_hours != null ? `${Number(s.shift_duration_hours).toFixed(2)}h` : '—'}</td>
                  <td className="px-3 py-2.5 text-slate-600">{grace ? `${grace}m` : '—'}</td>
                  <td className="px-3 py-2.5 text-amber-700 text-xs">{lateAfter}</td>
                  <td className="px-3 py-2.5 text-rose-700 text-xs">—</td>
                  <td className="px-3 py-2.5 text-violet-700 text-xs">{s.overtime_eligibility ? 'After shift' : '—'}</td>
                  <td className="px-3 py-2.5 text-slate-600 text-xs">Sun</td>
                  <td className="px-3 py-2.5">
                    <span className="font-semibold">{s._assignedCount}</span>
                    <span className="text-xs text-slate-400 ml-1">{s._assignedCount === 1 ? 'emp' : 'emps'}</span>
                  </td>
                  <td className="px-3 py-2.5 text-slate-700">{s.warehouse_name || '—'}</td>
                  <td className="px-3 py-2.5"><StatusBadge status={s._statusKey} /></td>
                  <td className="px-3 py-2.5"><ApprovalBadge status={s._approvalStatus} /></td>
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <RowActions
                      onView={() => onView(s)}
                      onEdit={canEdit('Shift') ? () => onEdit(s) : null}
                      onAssign={() => onAssign(s)}
                      onDuplicate={() => onDuplicate(s)}
                      onDelete={canDelete('Shift') ? () => onDelete(s) : null}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-50 text-xs text-slate-500 flex items-center justify-between">
        <span>{rows.length} shift{rows.length === 1 ? '' : 's'}</span>
        <span>Tip: click any row to open the detail drawer</span>
      </div>
    </div>
  );
}

function RowActions({ onView, onEdit, onAssign, onDuplicate, onDelete }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded">
        <MoreVertical size={15} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1 w-44 bg-white border border-slate-200 rounded-lg shadow-lg py-1">
            <MItem icon={Eye} onClick={() => { setOpen(false); onView(); }}>View Details</MItem>
            {onEdit && <MItem icon={Pencil} onClick={() => { setOpen(false); onEdit(); }}>Edit Shift</MItem>}
            <MItem icon={Users} onClick={() => { setOpen(false); onAssign(); }}>Assign Employees</MItem>
            <MItem icon={Copy} onClick={() => { setOpen(false); onDuplicate(); }}>Duplicate</MItem>
            {onDelete && <MItem icon={Trash2} tone="red" onClick={() => { setOpen(false); onDelete(); }}>Delete</MItem>}
          </div>
        </>
      )}
    </div>
  );
}
function MItem({ icon: Icon, children, onClick, tone }) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-50 ${tone === 'red' ? 'text-red-600' : 'text-slate-700'}`}>
      <Icon size={14} /> {children}
    </button>
  );
}

// ─── Roster tab ──────────────────────────────────────────────────────────

function RosterTab({ shifts, staff, onShiftClick }) {
  const [view, setView] = useState('weekly'); // daily | weekly | monthly
  const shiftById = useMemo(() => Object.fromEntries(shifts.map(s => [s.id, s])), [shifts]);
  const rows = useMemo(() => (staff || []).filter(s => s.is_active !== false && s.employment_status === 'ACTIVE'), [staff]);
  return (
    <div className="bg-white border border-slate-200 rounded-xl">
      <header className="px-4 py-3 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Shift Roster</h3>
          <p className="text-xs text-slate-500">
            Reads each staff&apos;s default <code className="text-[10px] bg-slate-100 px-1 rounded">shift_assignment</code>.
            Day-by-day variability needs a <code className="text-[10px] bg-slate-100 px-1 rounded">ShiftRoster</code> model.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
          {['daily', 'weekly', 'monthly'].map((v, i) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 text-sm font-medium transition ${i > 0 ? 'border-l border-slate-300' : ''} ${
                view === v ? 'bg-blue-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'
              }`}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </header>
      {view === 'weekly' && <WeeklyRosterGrid rows={rows} shiftById={shiftById} onShiftClick={onShiftClick} />}
      {view === 'daily' && <DailyRosterTable rows={rows} shiftById={shiftById} />}
      {view === 'monthly' && (
        <div className="p-4 sm:p-5 text-center text-slate-500 text-sm">
          Monthly roster needs the <code className="bg-slate-100 px-1 rounded">ShiftRoster</code> model (per-date-per-staff assignments).
          The Weekly view above shows the default schedule each employee follows.
        </div>
      )}
    </div>
  );
}

function WeeklyRosterGrid({ rows, shiftById, onShiftClick }) {
  if (rows.length === 0) return <EmptyState compact title="No staff to roster" body="Hire staff and assign a default shift." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: '900px' }}>
        <thead className="bg-slate-50 border-b">
          <tr>
            <th className="text-left px-3 py-2.5 font-medium text-slate-600 w-56">Employee</th>
            {DAYS_OF_WEEK.map((d, i) => <th key={d} className={`text-center px-2 py-2.5 font-medium ${i === 0 ? 'text-blue-500' : 'text-slate-600'}`}>{d}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((s) => {
            const sh = s.shift_assignment ? shiftById[s.shift_assignment] : null;
            const name = s.full_name || `${s.first_name || ''} ${s.last_name || ''}`.trim() || s.staff_id;
            return (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 align-top">
                  <p className="font-medium text-slate-800">{name}</p>
                  <p className="text-xs text-slate-400 font-mono">{s.staff_id} · {s.department || '—'}</p>
                </td>
                {DAYS_OF_WEEK.map((d, i) => (
                  <td key={d} className="px-1.5 py-2 text-center align-top">
                    {i === 0 ? (
                      <span className="inline-block w-full text-[10px] text-slate-400 italic py-1">Weekly Off</span>
                    ) : sh ? (
                      <button onClick={() => onShiftClick(sh.id)}
                        className={`block w-full border rounded-md px-2 py-1.5 text-xs font-medium text-left hover:opacity-90 transition ${sh._color}`}>
                        <p className="font-semibold truncate">{sh.shift_code}</p>
                        <p className="text-[10px] opacity-80">{fmtTime24(sh.start_time)} – {fmtTime24(sh.end_time)}</p>
                      </button>
                    ) : (
                      <span className="inline-block w-full text-[10px] text-slate-300 italic py-1">Unassigned</span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DailyRosterTable({ rows, shiftById }) {
  const today = todayIso();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b">
          <tr>
            {['Date', 'Employee ID', 'Name', 'Department', 'Designation', 'Shift', 'Time', 'Location', 'Status'].map((h) => (
              <th key={h} className="text-left px-3 py-2.5 font-medium text-slate-600 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((s) => {
            const sh = s.shift_assignment ? shiftById[s.shift_assignment] : null;
            return (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="px-3 py-2">{fmtDate(today)}</td>
                <td className="px-3 py-2 font-mono text-xs">{s.staff_id}</td>
                <td className="px-3 py-2 font-medium">{s.full_name || `${s.first_name || ''} ${s.last_name || ''}`.trim() || '—'}</td>
                <td className="px-3 py-2">{s.department || '—'}</td>
                <td className="px-3 py-2">{s.designation || '—'}</td>
                <td className="px-3 py-2">{sh ? <span className="font-mono text-xs text-blue-700">{sh.shift_code}</span> : <span className="text-slate-400">—</span>}</td>
                <td className="px-3 py-2 font-mono text-xs">{sh ? `${fmtTime12(sh.start_time)} – ${fmtTime12(sh.end_time)}` : '—'}</td>
                <td className="px-3 py-2">{s.location_name || s.warehouse_name || '—'}</td>
                <td className="px-3 py-2">{sh ? <StatusBadge status="ACTIVE" /> : <span className="text-xs text-red-600">Unassigned</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Assignments tab ─────────────────────────────────────────────────────

function AssignmentsTab({ shifts, staff, staffByShift, onAssign }) {
  const unassigned = useMemo(() => staff.filter(s => s.employment_status === 'ACTIVE' && !s.shift_assignment), [staff]);
  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <header className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Employees grouped by shift</h3>
            <p className="text-xs text-slate-500">Default <code className="text-[10px] bg-slate-100 px-1 rounded">staff.shift_assignment</code> values.</p>
          </div>
          <button onClick={onAssign}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700">
            <UserCheck size={14} /> Assign Shift
          </button>
        </header>
        {shifts.length === 0 ? <EmptyState compact title="No shifts" body="Create a shift first." /> : (
          <div className="divide-y divide-slate-100">
            {shifts.map((s) => {
              const list = staffByShift[s.id] || [];
              return (
                <div key={s.id} className="px-4 py-3">
                  <div className="flex items-center gap-3 flex-wrap mb-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${s._color}`}>
                      {s.shift_code}
                    </span>
                    <span className="font-medium text-slate-800">{s.shift_name}</span>
                    <span className="text-xs text-slate-500 font-mono">{fmtTime12(s.start_time)} – {fmtTime12(s.end_time)}</span>
                    <span className="ml-auto text-xs text-slate-500">{list.length} employee(s)</span>
                  </div>
                  {list.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {list.map((p) => (
                        <span key={p.id} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-100 text-xs text-slate-700">
                          <span className="font-mono text-[10px] text-slate-400">{p.staff_id}</span>
                          {p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim()}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400 italic">No employees on this shift.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {unassigned.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 text-amber-600 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-800">
                {unassigned.length} employee(s) without a shift assignment
              </p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {unassigned.map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-amber-200 text-xs">
                    <span className="font-mono text-[10px] text-slate-400">{p.staff_id}</span>
                    {p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim()}
                  </span>
                ))}
              </div>
              <button onClick={onAssign}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-medium hover:bg-amber-700">
                <UserCheck size={14} /> Assign now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Rotation Rules tab (stub) ───────────────────────────────────────────

function RotationRulesTab() {
  // Sample rules — what the UI would look like once the backend
  // RotationRule model exists. Shown as a preview so the design intent
  // is clear; the actions are disabled.
  const sample = [
    { name: 'Plant Floor 3-Shift', rotation: 'Weekly', sequence: ['Day', 'Evening', 'Night', 'Off'], dept: 'Production', count: 24, from: '01 Apr 2026', status: 'ACTIVE' },
    { name: 'Security Bi-Weekly',  rotation: 'Bi-weekly', sequence: ['Day', 'Night'], dept: 'Security', count: 8, from: '01 Jan 2026', status: 'ACTIVE' },
  ];
  return (
    <div className="space-y-3">
      <BackendStubBanner
        model="RotationRule"
        explanation="Define rotation patterns (Day → Evening → Night → Off), assign to departments, auto-generate rosters from them."
      />
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden opacity-75">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              {['Rule Name', 'Rotation', 'Sequence', 'Department', 'Employees', 'Effective From', 'Status', ''].map(h => (
                <th key={h} className="text-left px-3 py-2.5 font-medium text-slate-600 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sample.map((r) => (
              <tr key={r.name} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2"><span className="px-2 py-0.5 rounded text-xs bg-violet-100 text-violet-700">{r.rotation}</span></td>
                <td className="px-3 py-2 text-xs text-slate-600">{r.sequence.join(' → ')}</td>
                <td className="px-3 py-2">{r.dept}</td>
                <td className="px-3 py-2 font-semibold">{r.count}</td>
                <td className="px-3 py-2">{r.from}</td>
                <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                <td className="px-3 py-2"><span className="text-xs text-slate-400">—</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Weekly Off Rules tab (stub) ─────────────────────────────────────────

function WeeklyOffRulesTab() {
  const sample = [
    { name: 'Office — Sundays',   pattern: 'Every Sunday',          dept: 'Office',     site: 'HQ',    shift: 'General', count: 18, status: 'ACTIVE' },
    { name: 'Plant — Sat + Sun',  pattern: 'Alt Sat + every Sun',   dept: 'Production', site: 'NKP',   shift: 'Day',     count: 35, status: 'ACTIVE' },
    { name: 'Security — 2nd & 4th Sat', pattern: '2nd & 4th Sat + every Sun', dept: 'Security', site: 'All', shift: 'Rotating', count: 8, status: 'ACTIVE' },
  ];
  return (
    <div className="space-y-3">
      <BackendStubBanner
        model="WeeklyOffRule"
        explanation="Per-shift / per-department weekly-off patterns (every-Sunday, alternate-Saturday, 2nd-and-4th-Saturday, etc.) with comp-off and holiday adjustment rules."
      />
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden opacity-75">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              {['Rule Name', 'Pattern', 'Department', 'Location', 'Applies to Shift', 'Employees', 'Status', ''].map(h => (
                <th key={h} className="text-left px-3 py-2.5 font-medium text-slate-600 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sample.map((r) => (
              <tr key={r.name} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{r.pattern}</td>
                <td className="px-3 py-2">{r.dept}</td>
                <td className="px-3 py-2">{r.site}</td>
                <td className="px-3 py-2">{r.shift}</td>
                <td className="px-3 py-2 font-semibold">{r.count}</td>
                <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                <td className="px-3 py-2"><span className="text-xs text-slate-400">—</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Calendar tab ────────────────────────────────────────────────────────

function CalendarTab({ shifts, staff, onShiftClick }) {
  const [view, setView] = useState('week');
  const [cursor, setCursor] = useState(new Date());
  const shiftById = useMemo(() => Object.fromEntries(shifts.map(s => [s.id, s])), [shifts]);
  return (
    <div className="bg-white border border-slate-200 rounded-xl">
      <header className="px-4 py-3 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button onClick={() => { const d = new Date(cursor); d.setDate(d.getDate() - (view === 'day' ? 1 : view === 'week' ? 7 : 30)); setCursor(d); }}
            aria-label="Previous" title="Previous"
            className="p-1.5 border border-slate-300 rounded hover:bg-slate-50"><ChevronLeft size={14} /></button>
          <span className="text-sm font-semibold min-w-[140px] text-center">
            {view === 'month'
              ? cursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
              : formatDate(cursor)}
          </span>
          <button onClick={() => { const d = new Date(cursor); d.setDate(d.getDate() + (view === 'day' ? 1 : view === 'week' ? 7 : 30)); setCursor(d); }}
            aria-label="Next" title="Next"
            className="p-1.5 border border-slate-300 rounded hover:bg-slate-50"><ChevronRight size={14} /></button>
          <button onClick={() => setCursor(new Date())}
            className="ml-2 px-3 py-1.5 text-xs border border-slate-300 rounded hover:bg-slate-50">Today</button>
        </div>
        <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
          {['day', 'week', 'month'].map((v, i) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 text-xs font-medium ${i > 0 ? 'border-l border-slate-300' : ''} ${
                view === v ? 'bg-blue-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'
              }`}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </header>
      <div className="p-4">
        {view === 'week' && <WeekCalendar cursor={cursor} shifts={shifts} staff={staff} shiftById={shiftById} onShiftClick={onShiftClick} />}
        {view === 'day' && <DayCalendar cursor={cursor} shifts={shifts} staff={staff} shiftById={shiftById} onShiftClick={onShiftClick} />}
        {view === 'month' && <MonthCalendar cursor={cursor} shifts={shifts} shiftById={shiftById} />}
      </div>
    </div>
  );
}

function WeekCalendar({ cursor, shifts, staff, shiftById, onShiftClick }) {
  const start = new Date(cursor); start.setDate(start.getDate() - start.getDay());
  const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  return (
    <div className="grid grid-cols-7 gap-2">
      {days.map((d) => {
        const isToday = d.toDateString() === new Date().toDateString();
        const isSunday = d.getDay() === 0;
        return (
          <div key={d.toISOString()} className={`min-h-[160px] rounded-lg border ${isToday ? 'border-blue-400 bg-blue-50/30' : 'border-slate-200'}`}>
            <header className={`px-2 py-1.5 border-b text-xs font-semibold ${isSunday ? 'text-blue-700 bg-blue-50/50' : 'text-slate-700 bg-slate-50/50'}`}>
              {d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit' })}
            </header>
            <div className="p-1.5 space-y-1.5">
              {isSunday ? (
                <p className="text-[10px] text-slate-400 italic text-center py-2">Weekly Off</p>
              ) : (
                shifts.filter(s => s.is_active !== false).slice(0, 3).map((s) => {
                  const count = (staff || []).filter(p => p.shift_assignment === s.id).length;
                  return (
                    <button key={s.id} onClick={() => onShiftClick(s.id)}
                      className={`block w-full text-left text-[10px] px-2 py-1 rounded border ${s._color}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-semibold truncate">{s.shift_code}</span>
                        <span>{count}👥</span>
                      </div>
                      <p className="opacity-80">{fmtTime24(s.start_time)} – {fmtTime24(s.end_time)}</p>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayCalendar({ cursor, shifts, staff, shiftById, onShiftClick }) {
  const sorted = [...shifts].filter(s => s.is_active !== false).sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
  if (sorted.length === 0) return <EmptyState compact title="No shifts" body="Create a shift to see it on the calendar." />;
  return (
    <div className="space-y-2">
      {sorted.map((s) => {
        const list = (staff || []).filter(p => p.shift_assignment === s.id);
        return (
          <div key={s.id} className={`rounded-lg border p-3 ${s._color}`}>
            <div className="flex items-center justify-between mb-2">
              <button onClick={() => onShiftClick(s.id)} className="text-left">
                <p className="font-semibold">{s.shift_code} — {s.shift_name}</p>
                <p className="text-xs opacity-80 font-mono">{fmtTime12(s.start_time)} – {fmtTime12(s.end_time)} · {s.warehouse_name || 'No site'}</p>
              </button>
              <span className="text-xs font-medium">{list.length} 👥</span>
            </div>
            {list.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {list.slice(0, 8).map((p) => (
                  <span key={p.id} className="text-[10px] px-1.5 py-0.5 bg-white/70 rounded">
                    {p.full_name || p.staff_id}
                  </span>
                ))}
                {list.length > 8 && <span className="text-[10px] opacity-70">+ {list.length - 8}</span>}
              </div>
            ) : (
              <p className="text-[10px] opacity-70 italic">No employees assigned.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MonthCalendar({ cursor, shifts, shiftById }) {
  const year = cursor.getFullYear();
  const monthIdx = cursor.getMonth();
  const first = new Date(year, monthIdx, 1);
  const start = new Date(year, monthIdx, 1 - first.getDay());
  const rows = [];
  for (let r = 0; r < 6; r += 1) {
    const row = [];
    for (let c = 0; c < 7; c += 1) {
      const d = new Date(start); d.setDate(start.getDate() + r * 7 + c);
      row.push(d);
    }
    rows.push(row);
  }
  const activeShiftCount = shifts.filter(s => s.is_active !== false).length;
  return (
    <div>
      <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase tracking-wide text-slate-500 mb-1">
        {DAYS_OF_WEEK.map((d, i) => <div key={d} className={`py-1.5 ${i === 0 ? 'text-blue-500' : ''}`}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {rows.flat().map((d) => {
          const inMonth = d.getMonth() === monthIdx;
          const isToday = d.toDateString() === new Date().toDateString();
          const isSunday = d.getDay() === 0;
          return (
            <div key={d.toISOString()}
              className={`aspect-square rounded p-1 text-xs border ${
                !inMonth ? 'opacity-30 border-transparent' :
                isToday ? 'border-blue-400 bg-blue-50' :
                isSunday ? 'border-slate-200 bg-slate-50/50' :
                'border-transparent hover:border-slate-200'
              }`}>
              <p className={`font-medium ${isSunday && inMonth ? 'text-blue-600' : 'text-slate-700'}`}>{d.getDate()}</p>
              {inMonth && !isSunday && activeShiftCount > 0 && (
                <p className="text-[9px] text-slate-400 mt-0.5">{activeShiftCount} shifts</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Reports tab ─────────────────────────────────────────────────────────

function ReportsTab({ shifts, staff, staffByShift }) {
  const reports = [
    { key: 'shift_emp',   title: 'Shift-wise Employee Report', body: shifts.map(s => ({ label: `${s.shift_code} — ${s.shift_name}`, value: (staffByShift[s.id] || []).length })) },
    { key: 'dept',        title: 'Department Coverage',         body: groupCounts(staff, 'department') },
    { key: 'night',       title: 'Night Shift Coverage',        body: shifts.filter(s => s._type === 'NIGHT').map(s => ({ label: s.shift_name, value: (staffByShift[s.id] || []).length })) },
    { key: 'ot',          title: 'OT-eligible Shifts',          body: shifts.filter(s => s.overtime_eligibility).map(s => ({ label: s.shift_name, value: (staffByShift[s.id] || []).length })) },
    { key: 'unassigned',  title: 'Unassigned Employees',        body: [{ label: 'Without shift', value: staff.filter(p => p.employment_status === 'ACTIVE' && !p.shift_assignment).length }] },
    { key: 'conflicts',   title: 'Shift Conflicts',             body: [{ label: 'Assigned to deactivated shift', value: staff.filter(p => p.shift_assignment && !shifts.find(s => s.id === p.shift_assignment && s.is_active !== false)).length }] },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-2 gap-3">
      {reports.map((r) => (
        <div key={r.key} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <header className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">{r.title}</h3>
            <button onClick={() => toast('Hook to PDF / Excel exporter when ready.', { icon: '📊' })}
              className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1">
              <Upload size={11} /> Export
            </button>
          </header>
          <div className="p-3">
            {r.body.length === 0 ? <p className="text-xs text-slate-400 italic px-2 py-3">No data.</p> : (
              <ul className="text-sm divide-y divide-slate-100">
                {r.body.map((row, i) => (
                  <li key={i} className="flex justify-between py-1.5">
                    <span className="text-slate-700">{row.label}</span>
                    <span className="font-semibold">{row.value}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
function groupCounts(arr, key) {
  const m = new Map();
  (arr || []).forEach(x => { const k = x[key] || '(unset)'; m.set(k, (m.get(k) || 0) + 1); });
  return Array.from(m, ([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

// ─── Shift detail drawer ─────────────────────────────────────────────────

function ShiftDetailDrawer({ row, staff, onClose, onEdit }) {
  return (
    <div className="fixed inset-0 z-50 flex">
      <button onClick={onClose} className="flex-1 bg-black/40" aria-label="Close" />
      <aside className="w-full max-w-3xl bg-white h-full shadow-2xl overflow-y-auto flex flex-col">
        <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <TypeBadge type={row._type} meta={row._typeMeta} />
              <StatusBadge status={row._statusKey} />
              <ApprovalBadge status={row._approvalStatus} />
            </div>
            <p className="font-semibold text-slate-900 truncate">{row.shift_code} — {row.shift_name}</p>
            <p className="text-xs text-slate-500">{row.warehouse_name || '— No site —'}</p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={onEdit} aria-label="Edit" className="p-1.5 text-slate-500 hover:bg-slate-200 rounded" title="Edit"><Pencil size={16} /></button>
            <button onClick={onClose} aria-label="Close" className="p-1.5 text-slate-500 hover:bg-slate-200 rounded" title="Close"><XIcon size={18} /></button>
          </div>
        </header>
        <div className="p-5 space-y-5 flex-1">
          <Sec title="Shift Information">
            <Fld label="Shift Code" value={row.shift_code} mono />
            <Fld label="Shift Name" value={row.shift_name} />
            <Fld label="Shift Type" value={row._typeMeta?.label} />
            <Fld label="Location / Site" value={row.warehouse_name} />
            <Fld label="Status" value={STATUS_META[row._statusKey]?.label} />
            <Fld label="Approval" value={APPROVAL_META[row._approvalStatus]?.label} />
          </Sec>
          <Sec title="Timing Rules">
            <Fld label="Start Time" value={fmtTime12(row.start_time)} mono />
            <Fld label="End Time" value={fmtTime12(row.end_time)} mono />
            <Fld label="Break Duration" value={row.break_duration_mins ? `${row.break_duration_mins} min` : '—'} />
            <Fld label="Net Working Hours" value={row.shift_duration_hours != null ? `${Number(row.shift_duration_hours).toFixed(2)} h` : '—'} />
            <Fld label="Grace Period" value={row.grace_period_minutes ? `${row.grace_period_minutes} min` : '—'} />
            <Fld label="Late After" value={row.grace_period_minutes ? `Start + ${row.grace_period_minutes}m` : 'On start time'} />
          </Sec>
          <Sec title="Attendance Rules">
            <Fld label="Attendance Rule" value={row.attendance_calculation_rule === 'EIGHT_HOUR' ? '8 Hour' : row.attendance_calculation_rule || '—'} />
            <Fld label="Overtime Eligible" value={row.overtime_eligibility ? 'Yes' : 'No'} />
            <Fld label="Approval Required" value={row.approval_required ? 'Yes' : 'No'} />
            <Fld label="Half-day Threshold" value="—" hint="needs backend field" />
            <Fld label="Auto Mark Absent" value="—" hint="needs backend field" />
            <Fld label="Geo-fence" value="—" hint="needs backend field" />
          </Sec>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Assigned Employees</h4>
            {staff.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No employees on this shift.</p>
            ) : (
              <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
                {staff.map((p) => (
                  <div key={p.id} className="px-3 py-2 flex items-center gap-3 text-sm">
                    <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-semibold text-xs">
                      {(p.full_name || p.staff_id).charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.staff_id}</p>
                      <p className="text-xs text-slate-400 font-mono">{p.staff_id} · {p.department || '—'}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <Sec title="Audit">
            <Fld label="Created" value={row.created_at ? formatDateTime(row.created_at) : '—'} />
            <Fld label="Updated" value={row.updated_at ? formatDateTime(row.updated_at) : '—'} />
          </Sec>
        </div>
      </aside>
    </div>
  );
}
function Sec({ title, children }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{title}</h4>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">{children}</div>
    </div>
  );
}
function Fld({ label, value, mono, hint }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label} {hint && <span className="italic text-slate-400">({hint})</span>}</p>
      <p className={`text-sm text-slate-800 ${mono ? 'font-mono' : 'font-medium'}`}>{value || '—'}</p>
    </div>
  );
}

// ─── Editor modal (Create / Edit) ────────────────────────────────────────

function ShiftEditorModal({ initial, onClose, onSaved }) {
  const isEdit = !!initial?.id;
  const { options: warehousesRaw } = useLookup('/api/warehouses/');
  // The warehouse master can hold same-named sites across companies
  // (two "Office", two "TVP", …). Show each unique location name once.
  const warehouses = useMemo(() => {
    const seen = new Set();
    return (warehousesRaw || []).filter(w => {
      const key = String(w.label || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [warehousesRaw]);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState('basic');
  // Hydrate from `initial` for edit; sensible defaults for create.
  // Decimal fields come in as strings from DRF — we keep them as
  // strings in form state so the user can type freely, then coerce
  // (or null-out for empty) at submit time.
  const numToStr = (v) => (v == null || v === '' ? '' : String(v));
  const [form, setForm] = useState({
    shift_code:           initial?.shift_code || '',
    shift_name:           initial?.shift_name || '',
    shift_type:           initial?.shift_type || initial?._type || 'GENERAL',
    department:           initial?.department || '',
    warehouse:            initial?.warehouse || '',
    start_time:           initial?.start_time || '',
    end_time:             initial?.end_time || '',
    break_duration_mins:  initial?.break_duration_mins ?? 0,
    is_overnight:         !!initial?.is_overnight,
    is_flexible:          !!initial?.is_flexible,
    // Attendance
    grace_period_minutes:        initial?.grace_period_minutes ?? 0,
    attendance_calculation_rule: initial?.attendance_calculation_rule || 'EIGHT_HOUR',
    half_day_threshold_hours:    numToStr(initial?.half_day_threshold_hours),
    full_day_threshold_hours:    numToStr(initial?.full_day_threshold_hours),
    auto_absent_after_time:      initial?.auto_absent_after_time || '',
    approval_required:           !!initial?.approval_required,
    // Overtime
    overtime_eligibility:    initial?.overtime_eligibility != null ? !!initial.overtime_eligibility : true,
    ot_starts_after_hours:   numToStr(initial?.ot_starts_after_hours),
    min_ot_duration_minutes: initial?.min_ot_duration_minutes ?? 0,
    max_ot_per_day_hours:    numToStr(initial?.max_ot_per_day_hours),
    ot_approver_role:        initial?.ot_approver_role || 'SUPERVISOR_HR',
    // Weekly off + device
    weekly_off_days:            Array.isArray(initial?.weekly_off_days) && initial.weekly_off_days.length > 0
      ? initial.weekly_off_days
      : ['SUN'],
    biometric_device_mapping:   initial?.biometric_device_mapping || '',
    geo_required:               !!initial?.geo_required,
    attendance_sources_allowed: Array.isArray(initial?.attendance_sources_allowed) && initial.attendance_sources_allowed.length > 0
      ? initial.attendance_sources_allowed
      : ['BIOMETRIC', 'WEB', 'MOBILE', 'SUPERVISOR', 'IMPORT'],
    remarks: initial?.remarks || '',
    status:  'ACTIVE',
  });
  const upd = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  // Coerce '' → null for nullable decimals so the DRF DecimalField
  // doesn't reject empty strings. Required ints fall back to 0.
  const toDec = (v) => (v === '' || v == null ? null : Number(v));
  const toInt = (v) => (v === '' || v == null ? 0 : Number(v));

  const save = async (status = 'ACTIVE') => {
    if (!form.shift_code.trim()) { toast.error('Shift Code is required.'); return; }
    if (!form.shift_name.trim()) { toast.error('Shift Name is required.'); return; }
    if (!form.warehouse) { toast.error('Warehouse is required.'); return; }
    const payload = {
      shift_code: form.shift_code.trim(),
      shift_name: form.shift_name.trim(),
      shift_type: form.shift_type || 'GENERAL',
      department: (form.department || '').trim(),
      warehouse: form.warehouse,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      break_duration_mins: toInt(form.break_duration_mins),
      is_overnight: !!form.is_overnight,
      is_flexible: !!form.is_flexible,
      // Attendance
      attendance_calculation_rule: form.attendance_calculation_rule || 'EIGHT_HOUR',
      grace_period_minutes: toInt(form.grace_period_minutes),
      half_day_threshold_hours: toDec(form.half_day_threshold_hours),
      full_day_threshold_hours: toDec(form.full_day_threshold_hours),
      auto_absent_after_time: form.auto_absent_after_time || null,
      approval_required: !!form.approval_required,
      // Overtime
      overtime_eligibility: !!form.overtime_eligibility,
      ot_starts_after_hours: toDec(form.ot_starts_after_hours),
      min_ot_duration_minutes: toInt(form.min_ot_duration_minutes),
      max_ot_per_day_hours: toDec(form.max_ot_per_day_hours),
      ot_approver_role: form.ot_approver_role || 'SUPERVISOR_HR',
      // Weekly off + device
      weekly_off_days: form.weekly_off_days || [],
      biometric_device_mapping: (form.biometric_device_mapping || '').trim(),
      geo_required: !!form.geo_required,
      attendance_sources_allowed: form.attendance_sources_allowed || [],
      remarks: form.remarks || '',
      is_active: status !== 'DRAFT',
    };
    setBusy(true);
    try {
      if (isEdit) await apiClient.patch(`/api/hr/shifts/${initial.id}/`, payload);
      else await apiClient.post('/api/hr/shifts/', payload);
      toast.success(isEdit ? 'Shift updated.' : `Shift created${status === 'DRAFT' ? ' as draft' : ' & activated'}.`);
      onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to save.');
    } finally {
      setBusy(false);
    }
  };

  const sections = [
    { key: 'basic',      label: 'A · Basic Details' },
    { key: 'timing',     label: 'B · Shift Timing' },
    { key: 'attendance', label: 'C · Attendance Rules' },
    { key: 'ot',         label: 'D · Overtime Rules' },
    { key: 'weekly_off', label: 'E · Weekly Off' },
    { key: 'device',     label: 'F · Device / Location' },
    { key: 'remarks',    label: 'G · Remarks' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label={isEdit ? 'Edit Shift' : 'Create Shift'} className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[92dvh] overflow-hidden flex flex-col">
        <header className="px-5 py-3.5 border-b border-slate-200 bg-blue-50 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-blue-900">{isEdit ? 'Edit Shift' : 'Create Shift'}</h3>
            <p className="text-xs text-blue-700/80">All Sections below contribute to the final shift definition.</p>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" className="p-1.5 text-slate-500 hover:bg-slate-200 rounded"><XIcon size={18} /></button>
        </header>
        <div className="flex flex-1 overflow-hidden">
          {/* Side nav */}
          <nav className="w-52 border-r border-slate-200 bg-slate-50 overflow-y-auto py-2">
            {sections.map((s) => (
              <button key={s.key} onClick={() => setSection(s.key)}
                className={`w-full text-left px-4 py-2 text-sm transition ${
                  section === s.key
                    ? 'bg-white text-blue-700 border-r-2 border-blue-600 font-medium'
                    : 'text-slate-600 hover:bg-white'
                }`}>
                {s.label}
              </button>
            ))}
          </nav>
          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {section === 'basic' && <BasicSection form={form} upd={upd} warehouses={warehouses} />}
            {section === 'timing' && <TimingSection form={form} upd={upd} />}
            {section === 'attendance' && <AttendanceSection form={form} upd={upd} />}
            {section === 'ot' && <OvertimeSection form={form} upd={upd} />}
            {section === 'weekly_off' && <WeeklyOffSection form={form} upd={upd} />}
            {section === 'device' && <DeviceSection form={form} upd={upd} />}
            {section === 'remarks' && <RemarksSection form={form} upd={upd} />}
          </div>
        </div>
        <footer className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            All Sections persist to the shift definition. Required fields are marked with *.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={onClose}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100">
              Cancel
            </button>
            {!isEdit && (
              <button onClick={() => save('DRAFT')} disabled={busy}
                className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">
                Save as Draft
              </button>
            )}
            <button onClick={() => save('ACTIVE')} disabled={busy}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {busy ? 'Saving…' : isEdit ? 'Save Changes' : 'Save & Activate'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function BasicSection({ form, upd, warehouses }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FieldM label="Shift Code *">
        <input type="text" value={form.shift_code} onChange={(e) => upd('shift_code', e.target.value)}
          placeholder="MOR-001" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
      <FieldM label="Shift Name *">
        <input type="text" value={form.shift_name} onChange={(e) => upd('shift_name', e.target.value)}
          placeholder="Morning Shift" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
      <FieldM label="Shift Type">
        <CustomSelect value={form.shift_type} onChange={(e) => upd('shift_type', e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
          {Object.entries(SHIFT_TYPE_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </CustomSelect>
      </FieldM>
      <FieldM label="Location *">
        <CustomSelect value={form.warehouse} onChange={(e) => upd('warehouse', e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
          <option value="">Select location…</option>
          {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </CustomSelect>
      </FieldM>
      <FieldM label="Status">
        <CustomSelect value={form.status} onChange={(e) => upd('status', e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
          {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </CustomSelect>
      </FieldM>
      <FieldM label="Department">
        <input type="text" value={form.department} onChange={(e) => upd('department', e.target.value)}
          placeholder="e.g. Production, Security"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
    </div>
  );
}
function TimingSection({ form, upd }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FieldM label="Start Time *">
        <input type="time" value={form.start_time} onChange={(e) => upd('start_time', e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
      <FieldM label="End Time *">
        <input type="time" value={form.end_time} onChange={(e) => upd('end_time', e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
      <FieldM label="Break (minutes)">
        <input type="number" min="0" value={form.break_duration_mins} onChange={(e) => upd('break_duration_mins', e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
      <FieldM label="Attendance Rule">
        <CustomSelect value={form.attendance_calculation_rule} onChange={(e) => upd('attendance_calculation_rule', e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
          <option value="EIGHT_HOUR">8 Hour</option>
          <option value="CUSTOM">Custom</option>
        </CustomSelect>
      </FieldM>
      <div className="col-span-2 flex items-center gap-4 sm:gap-5">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_overnight} onChange={(e) => upd('is_overnight', e.target.checked)} /> Overnight shift (crosses midnight)</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_flexible} onChange={(e) => upd('is_flexible', e.target.checked)} /> Flexible timings</label>
      </div>
    </div>
  );
}
function AttendanceSection({ form, upd }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FieldM label="Grace Period (mins)">
        <input type="number" min="0" value={form.grace_period_minutes} onChange={(e) => upd('grace_period_minutes', e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
      <FieldM label="Half-day Threshold (hrs)">
        <input type="number" min="0" step="0.25" value={form.half_day_threshold_hours} onChange={(e) => upd('half_day_threshold_hours', e.target.value)}
          placeholder="e.g. 4" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
      <FieldM label="Full-day Threshold (hrs)">
        <input type="number" min="0" step="0.25" value={form.full_day_threshold_hours} onChange={(e) => upd('full_day_threshold_hours', e.target.value)}
          placeholder="e.g. 8" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
      <FieldM label="Auto Mark Absent After">
        <input type="time" value={form.auto_absent_after_time} onChange={(e) => upd('auto_absent_after_time', e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
      <div className="col-span-2 flex items-center gap-4 sm:gap-5">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.approval_required} onChange={(e) => upd('approval_required', e.target.checked)} /> Require approval for corrections</label>
      </div>
    </div>
  );
}
function OvertimeSection({ form, upd }) {
  const disabled = !form.overtime_eligibility;
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="col-span-2 flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" checked={form.overtime_eligibility} onChange={(e) => upd('overtime_eligibility', e.target.checked)} />
        Overtime is applicable to this shift
      </label>
      <FieldM label="OT Starts After (hrs)">
        <input type="number" min="0" step="0.25" value={form.ot_starts_after_hours} disabled={disabled}
          onChange={(e) => upd('ot_starts_after_hours', e.target.value)}
          placeholder="e.g. 8"
          className={`w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${disabled ? 'bg-slate-100 cursor-not-allowed' : ''}`} />
      </FieldM>
      <FieldM label="Min OT Duration (mins)">
        <input type="number" min="0" value={form.min_ot_duration_minutes} disabled={disabled}
          onChange={(e) => upd('min_ot_duration_minutes', e.target.value)}
          placeholder="e.g. 30"
          className={`w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${disabled ? 'bg-slate-100 cursor-not-allowed' : ''}`} />
      </FieldM>
      <FieldM label="Max OT / day (hrs)">
        <input type="number" min="0" step="0.25" value={form.max_ot_per_day_hours} disabled={disabled}
          onChange={(e) => upd('max_ot_per_day_hours', e.target.value)}
          placeholder="e.g. 4"
          className={`w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${disabled ? 'bg-slate-100 cursor-not-allowed' : ''}`} />
      </FieldM>
      <FieldM label="OT Approver Role">
        <CustomSelect value={form.ot_approver_role} disabled={disabled}
          onChange={(e) => upd('ot_approver_role', e.target.value)}
          className={`w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${disabled ? 'bg-slate-100 cursor-not-allowed' : ''}`}>
          <option value="SUPERVISOR">Supervisor</option>
          <option value="HR">HR</option>
          <option value="SUPERVISOR_HR">Supervisor + HR</option>
          <option value="MANAGER">Manager</option>
        </CustomSelect>
      </FieldM>
    </div>
  );
}
function WeeklyOffSection({ form, upd }) {
  const toggleDay = (d) => upd('weekly_off_days', form.weekly_off_days.includes(d)
    ? form.weekly_off_days.filter(x => x !== d)
    : [...form.weekly_off_days, d]);
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-medium text-slate-600 mb-2">Weekly Off Days</p>
        <div className="flex flex-wrap gap-2">
          {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d) => (
            <button key={d} type="button" onClick={() => toggleDay(d)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                form.weekly_off_days.includes(d)
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}>
              {d}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-400 mt-2">Days the shift is off. Persisted as JSON on the shift.</p>
      </div>
    </div>
  );
}

// All five sources the brief listed. Stored on the shift as a JSON
// list of these codes — backend agnostic enough that adding new
// sources later (Slack bot, QR scan, etc.) costs zero migration.
const ATTENDANCE_SOURCES = [
  { code: 'BIOMETRIC',  label: 'Biometric' },
  { code: 'WEB',        label: 'Web' },
  { code: 'MOBILE',     label: 'Mobile App' },
  { code: 'SUPERVISOR', label: 'Supervisor Entry' },
  { code: 'IMPORT',     label: 'Import' },
];

function DeviceSection({ form, upd }) {
  const toggleSrc = (code) => upd('attendance_sources_allowed',
    form.attendance_sources_allowed.includes(code)
      ? form.attendance_sources_allowed.filter(x => x !== code)
      : [...form.attendance_sources_allowed, code]);
  return (
    <div className="grid grid-cols-2 gap-3">
      <FieldM label="Biometric Device Mapping">
        <input type="text" value={form.biometric_device_mapping}
          onChange={(e) => upd('biometric_device_mapping', e.target.value)}
          placeholder="e.g. BIO-PLANT-3 (S/N 88234)"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
      </FieldM>
      <div className="col-span-2 flex items-center gap-4 sm:gap-5">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.geo_required} onChange={(e) => upd('geo_required', e.target.checked)} />
          Require geo-fencing
        </label>
      </div>
      <div className="col-span-2">
        <p className="text-xs font-medium text-slate-600 mb-2">Attendance Sources Allowed</p>
        <div className="flex flex-wrap gap-2">
          {ATTENDANCE_SOURCES.map(s => {
            const on = form.attendance_sources_allowed.includes(s.code);
            return (
              <label key={s.code}
                className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs cursor-pointer transition ${
                  on ? 'bg-blue-50 border-blue-300 text-blue-800' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}>
                <input type="checkbox" checked={on} onChange={() => toggleSrc(s.code)} /> {s.label}
              </label>
            );
          })}
        </div>
        <p className="text-[11px] text-slate-400 mt-2">At least one source must be enabled for the shift to capture attendance.</p>
      </div>
    </div>
  );
}
function RemarksSection({ form, upd }) {
  return (
    <div className="space-y-3">
      <FieldM label="Internal Note">
        <textarea rows={3} value={form.remarks} onChange={(e) => upd('remarks', e.target.value)}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" placeholder="Context for HR / supervisor" />
      </FieldM>
    </div>
  );
}
function FieldM({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

// ─── Assign Shift modal ──────────────────────────────────────────────────

function AssignShiftModal({ shifts, staff, staffByShift, onClose, onSaved }) {
  const [mode, setMode] = useState('INDIVIDUAL'); // INDIVIDUAL | DEPARTMENT | DESIGNATION | LOCATION
  const [shiftId, setShiftId] = useState('');
  const [filterValue, setFilterValue] = useState(''); // dept / designation / location
  const [employeeId, setEmployeeId] = useState('');
  const [effFrom, setEffFrom] = useState(todayIso());
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState(false);

  const targets = useMemo(() => {
    const active = staff.filter(s => s.employment_status === 'ACTIVE');
    if (mode === 'INDIVIDUAL')   return employeeId ? active.filter(s => s.id === employeeId) : [];
    if (mode === 'DEPARTMENT')   return filterValue ? active.filter(s => s.department === filterValue) : [];
    if (mode === 'DESIGNATION')  return filterValue ? active.filter(s => s.designation === filterValue) : [];
    if (mode === 'LOCATION')     return filterValue ? active.filter(s => (s.location_name || s.warehouse_name) === filterValue) : [];
    return [];
  }, [mode, employeeId, filterValue, staff]);

  // Conflict detection: targets currently on a different active shift.
  const conflicts = useMemo(() => {
    if (!shiftId) return [];
    return targets.filter(t => t.shift_assignment && t.shift_assignment !== shiftId);
  }, [targets, shiftId]);

  const departments  = useMemo(() => uniq(staff.map(s => s.department)), [staff]);
  const designations = useMemo(() => uniq(staff.map(s => s.designation)), [staff]);
  const locations    = useMemo(() => uniq(staff.map(s => s.location_name || s.warehouse_name)), [staff]);

  const submit = async () => {
    if (!shiftId) { toast.error('Pick a shift.'); return; }
    if (targets.length === 0) { toast.error('No targets selected.'); return; }
    setBusy(true);
    let ok = 0, fail = 0;
    for (const t of targets) {
      try {
        if (!replace && t.shift_assignment) { continue; }
        await apiClient.patch(`/api/hr/staff/${t.id}/`, { shift_assignment: shiftId });
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setBusy(false);
    if (ok > 0) toast.success(`Assigned ${ok} staff to shift.`);
    if (fail > 0) toast.error(`${fail} assignment(s) failed.`);
    if (ok > 0) onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label="Assign Shift" className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col">
        <header className="px-5 py-3.5 border-b border-slate-200 bg-blue-50 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-blue-900">Assign Shift</h3>
            <p className="text-xs text-blue-700/80">Assign one or many employees to a shift in a single action.</p>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" className="p-1.5 text-slate-500 hover:bg-slate-200 rounded"><XIcon size={18} /></button>
        </header>
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          <FieldM label="Shift *">
            <CustomSelect value={shiftId} onChange={(e) => setShiftId(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
              <option value="">Select shift…</option>
              {shifts.map(s => <option key={s.id} value={s.id}>{s.shift_code} — {s.shift_name} ({fmtTime12(s.start_time)})</option>)}
            </CustomSelect>
          </FieldM>
          <FieldM label="Assignment Type">
            <div className="flex flex-wrap gap-2">
              {[
                { v: 'INDIVIDUAL', l: 'Individual Employee' },
                { v: 'DEPARTMENT', l: 'Department-wise' },
                { v: 'DESIGNATION', l: 'Designation-wise' },
                { v: 'LOCATION', l: 'Location-wise' },
              ].map(({ v, l }) => (
                <button key={v} type="button" onClick={() => { setMode(v); setEmployeeId(''); setFilterValue(''); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                    mode === v ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}>
                  {l}
                </button>
              ))}
            </div>
          </FieldM>
          {mode === 'INDIVIDUAL' && (
            <FieldM label="Employee">
              <CustomSelect value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                <option value="">Pick an employee…</option>
                {staff.filter(s => s.employment_status === 'ACTIVE').map(s =>
                  <option key={s.id} value={s.id}>{s.staff_id} — {s.full_name || `${s.first_name || ''} ${s.last_name || ''}`.trim()}</option>
                )}
              </CustomSelect>
            </FieldM>
          )}
          {mode === 'DEPARTMENT' && (
            <FieldM label="Department">
              <CustomSelect value={filterValue} onChange={(e) => setFilterValue(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                <option value="">Pick a department…</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </CustomSelect>
            </FieldM>
          )}
          {mode === 'DESIGNATION' && (
            <FieldM label="Designation">
              <CustomSelect value={filterValue} onChange={(e) => setFilterValue(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                <option value="">Pick a designation…</option>
                {designations.map(d => <option key={d} value={d}>{d}</option>)}
              </CustomSelect>
            </FieldM>
          )}
          {mode === 'LOCATION' && (
            <FieldM label="Location / Site">
              <CustomSelect value={filterValue} onChange={(e) => setFilterValue(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                <option value="">Pick a location…</option>
                {locations.map(l => <option key={l} value={l}>{l}</option>)}
              </CustomSelect>
            </FieldM>
          )}
          <div className="grid grid-cols-2 gap-3">
            <FieldM label="Effective From">
              <CustomDatePicker value={effFrom} onChange={(e) => setEffFrom(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
            </FieldM>
            <FieldM label="Effective To">
              <CustomDatePicker disabled placeholder="needs ShiftAssignment model" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-slate-100 cursor-not-allowed" />
            </FieldM>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Replace existing shift assignment if any
          </label>
          {/* Conflict / preview */}
          {targets.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="font-semibold mb-1">{targets.length} employee(s) will be assigned</p>
              <div className="flex flex-wrap gap-1">
                {targets.slice(0, 12).map((t) => (
                  <span key={t.id} className="text-[11px] px-1.5 py-0.5 bg-white border border-slate-200 rounded">{t.staff_id}</span>
                ))}
                {targets.length > 12 && <span className="text-[11px] text-slate-500">+ {targets.length - 12} more</span>}
              </div>
            </div>
          )}
          {conflicts.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 text-amber-600 flex-shrink-0" />
              <div>
                <p className="font-semibold text-amber-800">{conflicts.length} employee(s) already on a different shift</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  {replace ? 'Their existing assignment will be replaced.' : 'They will be skipped — uncheck "Replace existing" to override.'}
                </p>
              </div>
            </div>
          )}
        </div>
        <footer className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100">
            Cancel
          </button>
          <button onClick={submit} disabled={busy || !shiftId || targets.length === 0}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Assigning…' : `Submit · ${targets.length} staff`}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─── Helpers / states ────────────────────────────────────────────────────

function BackendStubBanner({ model, explanation }) {
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
      <p className="font-semibold">Needs <code className="text-xs bg-blue-100 px-1 rounded">{model}</code> backend model</p>
      <p className="text-xs text-blue-800/80 mt-1">{explanation}</p>
      <p className="text-xs text-blue-700/80 mt-2">
        The preview below shows what the UI will look like once the model + serializer + viewset land.
        All actions on this tab are disabled until then.
      </p>
    </div>
  );
}

function EmptyState({ title, body, compact }) {
  return (
    <div className={`bg-white border border-dashed border-slate-300 rounded-xl text-center ${compact ? 'py-8' : 'py-16'}`}>
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 text-slate-400 mb-3">
        <CalIcon size={20} />
      </div>
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">{body}</p>
    </div>
  );
}
function ErrorState({ onRetry }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-xl py-10 text-center">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 text-red-600 mb-3">
        <AlertTriangle size={20} />
      </div>
      <p className="text-sm font-semibold text-red-800">Failed to load shifts</p>
      <button onClick={onRetry}
        className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">
        <RefreshCw size={14} /> Retry
      </button>
    </div>
  );
}
function Skeleton() {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex items-center gap-3 animate-pulse">
          <div className="h-3 w-12 bg-slate-200 rounded" />
          <div className="h-3 flex-1 bg-slate-200 rounded" />
          <div className="h-3 w-24 bg-slate-200 rounded" />
          <div className="h-3 w-20 bg-slate-200 rounded" />
        </div>
      ))}
    </div>
  );
}

function exportShiftCsv(rows, staffByShift) {
  if (!rows || rows.length === 0) { toast('Nothing to export', { icon: 'ℹ️' }); return; }
  const cols = [
    ['shift_code', r => r.shift_code],
    ['shift_name', r => r.shift_name],
    ['type', r => r._typeMeta?.label || r._type],
    ['location', r => r.warehouse_name || ''],
    ['start', r => r.start_time || ''],
    ['end', r => r.end_time || ''],
    ['break_min', r => r.break_duration_mins || 0],
    ['grace_min', r => r.grace_period_minutes || 0],
    ['ot_eligible', r => r.overtime_eligibility ? 'yes' : 'no'],
    ['assigned_emps', r => (staffByShift[r.id] || []).length],
    ['status', r => r._statusKey],
  ];
  const header = cols.map(([h]) => h).join(',');
  const body = rows.map(r => cols.map(([, fn]) => {
    const v = String(fn(r) ?? '');
    return v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\n');
  const blob = new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `shifts-${todayIso()}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  toast.success('Exported CSV');
}
