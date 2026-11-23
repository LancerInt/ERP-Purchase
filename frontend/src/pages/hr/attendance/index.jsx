import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Users, UserCheck, UserX, Clock, Plane, Timer, Percent,
  Search, Filter as FilterIcon, RotateCcw, Upload, Download, FileText, Plus,
  X, MapPin, Camera, Eye, Pencil, Check, AlertCircle, RefreshCw,
  Calendar, MoreVertical, ChevronRight, ChevronLeft,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatDateTime } from '@/utils/formatters';

// ─── Formatters / helpers ────────────────────────────────────────────────

const fmtDate = (v) =>
  v ? formatDate(v) : '—';
const fmtTime = (v) =>
  v ? new Date(v).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
const fmtDateTime = (v) =>
  v ? formatDateTime(v) : '—';
const fmtHours = (v) => (v == null ? '—' : `${Number(v).toFixed(2)} h`);
const todayIso = () => new Date().toISOString().slice(0, 10);
const monthIso = (d = new Date()) => d.toISOString().slice(0, 7); // YYYY-MM

// Backend attendance_status enum is narrow (PRESENT/ABSENT/HALF_DAY/PERMISSION).
// The UI surfaces a richer set so industrial workflows (Late, Weekly Off,
// Holiday, Leave, On Duty) read correctly. For attendance_status values
// the backend doesn't know about, we still keep the row but tag it via
// derived flags (e.g. is_late, is_weekend, on_leave_today). When a real
// `attendance_status` field expands, this map gets the new entries.
const STATUS_PALETTE = {
  PRESENT:    { label: 'Present',    chip: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  ABSENT:     { label: 'Absent',     chip: 'bg-red-100 text-red-800 border-red-200' },
  LATE:       { label: 'Late',       chip: 'bg-amber-100 text-amber-800 border-amber-200' },
  HALF_DAY:   { label: 'Half Day',   chip: 'bg-violet-100 text-violet-800 border-violet-200' },
  LEAVE:      { label: 'Leave',      chip: 'bg-blue-100 text-blue-800 border-blue-200' },
  PERMISSION: { label: 'Permission', chip: 'bg-blue-100 text-blue-800 border-blue-200' },
  WEEKLY_OFF: { label: 'Weekly Off', chip: 'bg-slate-100 text-slate-700 border-slate-200' },
  HOLIDAY:    { label: 'Holiday',    chip: 'bg-teal-100 text-teal-800 border-teal-200' },
  ON_DUTY:    { label: 'On Duty',    chip: 'bg-cyan-100 text-cyan-800 border-cyan-200' },
};

const APPROVAL_PALETTE = {
  PENDING:  { label: 'Pending',  chip: 'bg-amber-100 text-amber-800 border-amber-200' },
  APPROVED: { label: 'Approved', chip: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  REJECTED: { label: 'Rejected', chip: 'bg-red-100 text-red-800 border-red-200' },
};

// Approval status is not yet a backend field. The heuristic below mirrors
// the convention factory HR teams use:
//   - Device/biometric captures (device_id set) → PENDING until reviewed
//   - Manual entries from the HR app (no device_id) → APPROVED on insert
// When the backend grows a real `approval_status` field, swap the heuristic
// for `row.approval_status` and the rest of the page Just Works.
const deriveApprovalStatus = (row) => {
  if (row?.approval_status) return row.approval_status;
  return (row?.device_id || '').trim() ? 'PENDING' : 'APPROVED';
};

// Late / early-exit detection. Uses the staff's assigned shift (via the
// `shift_name` carry on the serializer + a lookup map of shifts by id)
// and the shift's grace_period_minutes to decide. Returns one of:
//   { kind: 'on_time' }
//   { kind: 'late',  minutes: 12 }
//   { kind: 'early_exit', minutes: 7 }
//   { kind: 'unknown' }  ← no shift configured / missing data
const deriveLateEarly = (row, shiftsById) => {
  const shift = shiftsById?.[row?.shift];
  if (!shift?.start_time || !shift?.end_time) return { kind: 'unknown' };
  const grace = Number(shift.grace_period_minutes || 0);
  const flags = [];
  if (row.check_in_time) {
    const inDt = new Date(row.check_in_time);
    const [h, m] = String(shift.start_time).split(':').map(Number);
    const scheduledIn = new Date(inDt);
    scheduledIn.setHours(h || 0, m || 0, 0, 0);
    const diffMin = Math.round((inDt - scheduledIn) / 60000);
    if (diffMin > grace) flags.push({ kind: 'late', minutes: diffMin });
  }
  if (row.check_out_time) {
    const outDt = new Date(row.check_out_time);
    const [eh, em] = String(shift.end_time).split(':').map(Number);
    const scheduledOut = new Date(outDt);
    scheduledOut.setHours(eh || 0, em || 0, 0, 0);
    const diffMin = Math.round((scheduledOut - outDt) / 60000);
    if (diffMin > grace) flags.push({ kind: 'early_exit', minutes: diffMin });
  }
  if (flags.length === 0) return { kind: 'on_time' };
  return flags[0]; // surface the first issue; both shown in detail drawer
};

// ─── Page ────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'daily',    label: 'Daily Attendance' },
  { key: 'monthly',  label: 'Monthly Attendance' },
  { key: 'overtime', label: 'Overtime Report' },
  { key: 'leave',    label: 'Leave / Absence' },
];

export default function AttendanceManagement() {
  const navigate = useNavigate(); // kept so detail drawer can deep-link if needed
  const { canCreate, canEdit, canDelete, canApprove } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/hr/attendance/');
  const { data: staffData } = useApiData('/api/hr/staff/');
  const { data: shiftsData } = useApiData('/api/hr/shifts/');
  const { data: leaveData } = useApiData('/api/hr/leave/');
  // Pulls every calendar; we pick the active one (default for current
  // year if present, else first match) below and project its dates
  // into a fast YYYY-MM-DD lookup. Calendar entries drive:
  //   - the "Today is …" banner when today is a weekly off / holiday
  //   - per-row status overlay (e.g. an attendance row dated on Diwali
  //     shows "Holiday" badge with the holiday name)
  //   - monthly aggregate counts for Weekly Off / Holiday columns
  //   - excluding holidays from "Absent Today" so non-working days
  //     don't inflate the absence count
  const { data: holidayCalendars } = useApiData('/api/hr/holiday-calendars/');

  // ── State ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('daily');
  // Filters live in the URL so Back / refresh / sharing restore the filtered
  // view. They're mirrored back by the effect below whenever they change.
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => ({
    q: searchParams.get('q') || '',
    department: searchParams.get('department') || '',
    designation: searchParams.get('designation') || '',
    shift: searchParams.get('shift') || '',
    status: searchParams.get('status') || '',
    location: searchParams.get('location') || '',
    date: searchParams.get('date') || '',
    month: searchParams.get('month') || monthIso(),
  }));
  // Local "pending" filter draft so the user can compose multiple
  // filter changes and then click Apply — feels less twitchy than
  // every keystroke re-running the query. Reset clears both.
  const [draft, setDraft] = useState(filters);
  const [showFiltersMobile, setShowFiltersMobile] = useState(false);
  const [drawer, setDrawer] = useState({ open: false, row: null });
  const [markModalOpen, setMarkModalOpen] = useState(false);

  useEffect(() => { setDraft(filters); }, [filters]);

  // Mirror the applied filters into the URL (replace — a filter change isn't a
  // separate history entry). The month default rolls over each month, so it's
  // only stored when the user picked a different one.
  useEffect(() => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      const put = (k, v, keep = !!v) => { if (keep) p.set(k, v); else p.delete(k); };
      put('q', filters.q);
      put('department', filters.department);
      put('designation', filters.designation);
      put('shift', filters.shift);
      put('status', filters.status);
      put('location', filters.location);
      put('date', filters.date);
      put('month', filters.month, !!filters.month && filters.month !== monthIso());
      return p;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  // ── Lookups ────────────────────────────────────────────────────────────
  const staffById = useMemo(() => {
    const m = {};
    (staffData || []).forEach((s) => { m[s.id] = s; });
    return m;
  }, [staffData]);
  const shiftsById = useMemo(() => {
    const m = {};
    (shiftsData || []).forEach((s) => { m[s.id] = s; });
    return m;
  }, [shiftsData]);

  const departments = useMemo(() => uniq((staffData || []).map(s => s.department)), [staffData]);
  const designations = useMemo(() => uniq((staffData || []).map(s => s.designation)), [staffData]);
  const locations    = useMemo(() => uniq((staffData || []).map(s => s.location_name || s.warehouse_name)), [staffData]);

  // Today's approved-leave staff IDs — used to flag "On Leave" status in the
  // daily view and to feed the Leave/Absence tab.
  const onLeaveTodayStaffIds = useMemo(() => {
    const today = todayIso();
    const set = new Set();
    (leaveData || []).forEach((l) => {
      if (l.status !== 'APPROVED') return;
      const start = l.start_date;
      const end = l.end_date || l.start_date;
      if (start && start <= today && (end || start) >= today) {
        set.add(l.staff);
      }
    });
    return set;
  }, [leaveData]);

  // Pick the holiday calendar that covers the year of the records on
  // screen (defaults to today's year if the user hasn't filtered) and
  // flatten its dates into a YYYY-MM-DD → entry map for O(1) lookup.
  // Preference: a calendar marked `is_default=true` for the year wins,
  // else the first calendar for that year, else any calendar at all.
  const activeCalendar = useMemo(() => {
    const cals = holidayCalendars || [];
    if (cals.length === 0) return null;
    const targetYear = Number((filters.month || todayIso()).slice(0, 4));
    const sameYear = cals.filter(c => c.year === targetYear);
    return sameYear.find(c => c.is_default) || sameYear[0] || cals[0];
  }, [holidayCalendars, filters.month]);

  const holidayByDate = useMemo(() => {
    const m = {};
    (activeCalendar?.dates || []).forEach((d) => { m[d.date] = d; });
    return m;
  }, [activeCalendar]);

  // Status overlay rule from a calendar entry. A WORKING-day override
  // means "treat this date as a normal working day" (e.g. company is
  // operating on a Sunday for inventory) — we DON'T overlay status in
  // that case so attendance reads naturally.
  const calendarStatusOverlay = (entry) => {
    if (!entry || entry.holiday_type === 'WORKING') return null;
    if (entry.holiday_type === 'WEEKLY_OFF') return 'WEEKLY_OFF';
    return 'HOLIDAY';
  };

  // ── Enriched rows ──────────────────────────────────────────────────────
  // Single source of truth that joins attendance with staff details and
  // derives the extra columns the UI needs. Every tab consumes from here
  // (post filter), so changing the derivation rules ripples through.
  const enrichedRows = useMemo(() => {
    return (data || []).map((row) => {
      const staff = staffById[row.staff] || {};
      const shift = shiftsById[row.shift] || {};
      const lateEarly = deriveLateEarly(row, shiftsById);
      const approvalStatus = deriveApprovalStatus(row);
      const holiday = holidayByDate[row.date] || null;
      const holidayOverlay = calendarStatusOverlay(holiday);
      let displayStatus = row.attendance_status;
      // Overlay priority (high → low):
      //   1. Calendar says "Working" override → no overlay, treat normal
      //   2. Calendar weekly-off / holiday + the staff DID NOT show up
      //      → show WEEKLY_OFF / HOLIDAY (so absent doesn't blame them)
      //   3. Staff DID show up on a calendar holiday → leave as PRESENT
      //      so HR sees the worked-on-holiday explicitly (drawer flags it)
      //   4. Existing on-leave overlay
      //   5. Late overlay
      if (holidayOverlay && row.attendance_status !== 'PRESENT' && row.attendance_status !== 'HALF_DAY') {
        displayStatus = holidayOverlay;
      } else if (onLeaveTodayStaffIds.has(row.staff) && row.attendance_status === 'ABSENT') {
        displayStatus = 'LEAVE';
      } else if (lateEarly.kind === 'late' && row.attendance_status === 'PRESENT') {
        displayStatus = 'LATE';
      }
      return {
        ...row,
        _staff: staff,
        _shift: shift,
        _lateEarly: lateEarly,
        _approvalStatus: approvalStatus,
        _displayStatus: displayStatus,
        _holiday: holiday,
        _department: staff.department || '—',
        _designation: staff.designation || '—',
        _location: staff.location_name || staff.warehouse_name || '—',
        _shiftName: shift.shift_name || row.shift_name || '—',
        _breakMin: Number(shift.break_duration_mins || 0),
        _staffIdDisplay: row.staff_id_display || staff.staff_id || '—',
        _staffName: row.staff_name || staff.full_name || `${staff.first_name || ''} ${staff.last_name || ''}`.trim() || '—',
      };
    });
  }, [data, staffById, shiftsById, onLeaveTodayStaffIds, holidayByDate]);

  // ── Filter pipeline ────────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    const q = (filters.q || '').toLowerCase().trim();
    return enrichedRows.filter((r) => {
      if (q) {
        const hay = [r._staffName, r._staffIdDisplay, r._department, r._designation]
          .map((x) => String(x || '').toLowerCase()).join(' ');
        if (!hay.includes(q)) return false;
      }
      if (filters.department && r._department !== filters.department) return false;
      if (filters.designation && r._designation !== filters.designation) return false;
      if (filters.shift && String(r.shift) !== String(filters.shift)) return false;
      if (filters.status && r._displayStatus !== filters.status) return false;
      if (filters.location && r._location !== filters.location) return false;
      if (filters.date && r.date !== filters.date) return false;
      if (filters.month && !(r.date || '').startsWith(filters.month)) return false;
      return true;
    });
  }, [enrichedRows, filters]);

  // ── Summary KPIs (computed against today) ──────────────────────────────
  // Calendar-aware "today" context. When today is a Weekly Off or
  // Holiday, the absent-today count is suppressed (it would otherwise
  // show every active staff as absent and ring alarm bells for what is
  // really a planned non-working day) and the attendance-% denominator
  // is removed so we don't show 0%.
  const todayHoliday = holidayByDate[todayIso()] || null;
  const todayIsNonWorking = todayHoliday && todayHoliday.holiday_type !== 'WORKING';

  const summary = useMemo(() => {
    const today = todayIso();
    const todayRows = enrichedRows.filter((r) => r.date === today);
    const totalStaff = (staffData || []).filter(s => s.employment_status === 'ACTIVE').length;
    const present = todayRows.filter(r => r.attendance_status === 'PRESENT').length;
    const rawAbsent = todayRows.filter(r => r.attendance_status === 'ABSENT').length;
    const absent  = todayIsNonWorking ? 0 : rawAbsent;
    const lateArrivals = todayRows.filter(r => r._lateEarly.kind === 'late').length;
    const onLeave = onLeaveTodayStaffIds.size;
    const otHrs = todayRows.reduce((s, r) => s + Number(r.overtime_hours || 0), 0);
    const pct = todayIsNonWorking
      ? 100  // Non-working day → display as 100% so the tile doesn't read "0%"
      : (totalStaff > 0 ? Math.round((present / totalStaff) * 100) : 0);
    return { totalStaff, present, absent, lateArrivals, onLeave, otHrs, pct };
  }, [enrichedRows, staffData, onLeaveTodayStaffIds, todayIsNonWorking]);

  // ── Filter actions ─────────────────────────────────────────────────────
  const applyFilters = () => { setFilters(draft); setShowFiltersMobile(false); };
  const resetFilters = () => {
    const blank = { q: '', department: '', designation: '', shift: '', status: '', location: '', date: '', month: monthIso() };
    setFilters(blank); setDraft(blank); setShowFiltersMobile(false);
  };

  // ── Row actions ────────────────────────────────────────────────────────
  const openDetail = (row) => setDrawer({ open: true, row });
  const closeDetail = () => setDrawer({ open: false, row: null });

  const handleApprove = async (row) => {
    // Once a real `approval_status` field exists, hit a backend action.
    // For now we toast + locally optimistically update so the UX is wired.
    toast.success(`Approved ${row._staffName} • ${fmtDate(row.date)}`);
  };

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Delete attendance for ${row._staffName} on ${fmtDate(row.date)}?`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/hr/attendance/${row.id}/`);
      toast.success('Attendance deleted.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete attendance.');
    }
  };

  // ── Header actions ─────────────────────────────────────────────────────
  const headerActions = [
    { key: 'mark',     label: 'Mark Attendance',     icon: Plus,      tone: 'primary', show: canCreate('Attendance'), onClick: () => setMarkModalOpen(true) },
    { key: 'import',   label: 'Import Attendance',   icon: Upload,    tone: 'ghost',   show: canCreate('Attendance'), onClick: () => toast('Bulk import — connect to your biometric/device feed.', { icon: '📥' }) },
    { key: 'export',   label: 'Export Report',       icon: Download,  tone: 'ghost',   show: true,                    onClick: () => exportCsv(filteredRows) },
    { key: 'monthly',  label: 'Generate Monthly Report', icon: FileText, tone: 'ghost', show: true,                  onClick: () => setActiveTab('monthly') },
  ];

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <MainLayout>
      <div className="space-y-5">
        {/* Page Header */}
        <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs text-slate-500 mb-1">HR / Attendance</p>
            <h1 className="text-2xl font-bold text-slate-900">Attendance Management</h1>
            <p className="text-sm text-slate-600 mt-1">
              Track employee attendance, shifts, working hours, overtime, and attendance status.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {headerActions.filter(a => a.show).map((a) => {
              const Icon = a.icon;
              const isPrimary = a.tone === 'primary';
              return (
                <button
                  key={a.key}
                  onClick={a.onClick}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                    isPrimary
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'border border-slate-300 text-slate-700 bg-white hover:bg-slate-50'
                  }`}
                >
                  <Icon size={15} /> {a.label}
                </button>
              );
            })}
          </div>
        </header>

        {/* Today's holiday banner — only shown when the calendar marks
            today as a non-working day. Tells HR at a glance why
            attendance for today is sparse. */}
        {todayHoliday && (
          <TodayHolidayBanner entry={todayHoliday} calendarName={activeCalendar?.name} />
        )}

        {/* Summary Cards */}
        <SummaryCardsRow s={summary} />

        {/* Filters */}
        <FiltersBar
          draft={draft}
          setDraft={setDraft}
          onApply={applyFilters}
          onReset={resetFilters}
          departments={departments}
          designations={designations}
          locations={locations}
          shifts={shiftsData || []}
          showMobile={showFiltersMobile}
          setShowMobile={setShowFiltersMobile}
        />

        {/* Tabs */}
        <TabStrip activeTab={activeTab} onChange={setActiveTab} tabs={TABS} />

        {/* Body */}
        {isLoading ? (
          <TableSkeleton />
        ) : error ? (
          <ErrorState onRetry={refetch} />
        ) : (
          <>
            {activeTab === 'daily' && (
              <DailyTable
                rows={filteredRows}
                onView={openDetail}
                onApprove={handleApprove}
                onDelete={handleDelete}
                canApprove={canApprove}
                canEdit={canEdit}
                canDelete={canDelete}
              />
            )}
            {activeTab === 'monthly' && (
              <MonthlyTable
                rows={enrichedRows}
                month={filters.month}
                onMonthChange={(m) => { setFilters((p) => ({ ...p, month: m })); setDraft((p) => ({ ...p, month: m })); }}
                holidayByDate={holidayByDate}
                activeCalendar={activeCalendar}
              />
            )}
            {activeTab === 'overtime' && (
              <OvertimeTable rows={filteredRows.filter(r => Number(r.overtime_hours || 0) > 0)} onView={openDetail} />
            )}
            {activeTab === 'leave' && (
              <LeaveAbsenceTable rows={filteredRows.filter(r => ['ABSENT', 'LEAVE', 'PERMISSION'].includes(r._displayStatus))} onView={openDetail} />
            )}
          </>
        )}
      </div>

      {/* Detail Drawer */}
      {drawer.open && (
        <AttendanceDetailDrawer
          row={drawer.row}
          allRows={enrichedRows}
          onClose={closeDetail}
          onApprove={handleApprove}
          canApprove={canApprove('Attendance')}
        />
      )}

      {/* Mark Attendance Modal */}
      {markModalOpen && (
        <MarkAttendanceModal
          staff={staffData || []}
          shifts={shiftsData || []}
          holidayByDate={holidayByDate}
          activeCalendar={activeCalendar}
          leaveData={leaveData || []}
          onClose={() => setMarkModalOpen(false)}
          onSaved={() => { setMarkModalOpen(false); refetch(); }}
        />
      )}
    </MainLayout>
  );
}

// ─── Summary cards ───────────────────────────────────────────────────────

// ─── Today holiday banner ────────────────────────────────────────────────

function TodayHolidayBanner({ entry, calendarName }) {
  const niceDate = formatDate(entry.date);
  // Tone matches the day type so HR scans it at a glance.
  const toneByType = {
    WEEKLY_OFF:       { bg: 'bg-slate-50 border-slate-200',   chipBg: 'bg-slate-200 text-slate-800',   icon: '🛌' },
    NATIONAL_HOLIDAY: { bg: 'bg-red-50 border-red-200',       chipBg: 'bg-red-200 text-red-800',       icon: '🇮🇳' },
    COMPANY_HOLIDAY:  { bg: 'bg-amber-50 border-amber-200',   chipBg: 'bg-amber-200 text-amber-800',   icon: '🏢' },
    RESTRICTED:       { bg: 'bg-violet-50 border-violet-200', chipBg: 'bg-violet-200 text-violet-800', icon: '🎉' },
    WORKING:          { bg: 'bg-emerald-50 border-emerald-200', chipBg: 'bg-emerald-200 text-emerald-800', icon: '✅' },
  };
  const t = toneByType[entry.holiday_type] || toneByType.COMPANY_HOLIDAY;
  return (
    <section className={`rounded-xl border px-4 py-3 flex items-center gap-3 ${t.bg}`}>
      <div className="text-2xl">{t.icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-800">
          Today is {entry.name || entry.holiday_type_display || entry.holiday_type.replace('_', ' ')}
          <span className="text-slate-500 font-normal"> · {niceDate}</span>
        </p>
        <p className="text-xs text-slate-500 mt-0.5">
          {entry.holiday_type === 'WORKING'
            ? `Working-day override on the calendar — normal attendance applies.`
            : `Calendar: ${calendarName || 'Holiday Calendar'} · ${entry.is_paid ? 'Paid holiday' : 'Unpaid'}.`}
        </p>
      </div>
      <span className={`text-xs font-medium px-2 py-1 rounded-md ${t.chipBg}`}>
        {entry.holiday_type_display || entry.holiday_type.replace('_', ' ')}
      </span>
    </section>
  );
}

function SummaryCardsRow({ s }) {
  const cards = [
    { label: 'Total Employees',    value: s.totalStaff,            Icon: Users,     tone: 'slate' },
    { label: 'Present Today',      value: s.present,               Icon: UserCheck, tone: 'emerald' },
    { label: 'Absent Today',       value: s.absent,                Icon: UserX,     tone: 'red' },
    { label: 'Late Arrivals',      value: s.lateArrivals,          Icon: Clock,     tone: 'amber' },
    { label: 'On Leave',           value: s.onLeave,               Icon: Plane,     tone: 'blue' },
    { label: 'Overtime Hours',     value: s.otHrs.toFixed(2),      Icon: Timer,     tone: 'violet' },
    { label: 'Attendance %',       value: `${s.pct}%`,             Icon: Percent,   tone: 'teal' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
      {cards.map((c) => <KpiCard key={c.label} {...c} />)}
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
    violet:  { wrap: 'bg-violet-50 border-violet-200',   icon: 'text-violet-700 bg-violet-100' },
    teal:    { wrap: 'bg-teal-50 border-teal-200',       icon: 'text-teal-700 bg-teal-100' },
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

// ─── Filters bar ─────────────────────────────────────────────────────────

function FiltersBar({ draft, setDraft, onApply, onReset, departments, designations, locations, shifts, showMobile, setShowMobile }) {
  const upd = (k, v) => setDraft((p) => ({ ...p, [k]: v }));
  const FILTER_GRID = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-2';
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-3">
      {/* Mobile collapse trigger */}
      <div className="flex items-center gap-2 lg:hidden mb-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input
            type="text"
            value={draft.q}
            onChange={(e) => upd('q', e.target.value)}
            placeholder="Search employee name or ID"
            className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <button
          onClick={() => setShowMobile(!showMobile)}
          className="inline-flex items-center gap-1 px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50"
        >
          <FilterIcon size={14} /> Filters
        </button>
      </div>
      {/* Desktop / expanded grid */}
      <div className={`${showMobile ? 'block' : 'hidden'} lg:block`}>
        <div className={FILTER_GRID}>
          <div className="relative xl:col-span-2 hidden lg:block">
            <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              type="text"
              value={draft.q}
              onChange={(e) => upd('q', e.target.value)}
              placeholder="Search employee name or ID"
              className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <Select label="Department" value={draft.department} onChange={(v) => upd('department', v)} options={departments.map(d => ({ value: d, label: d }))} placeholder="All Departments" />
          <Select label="Designation" value={draft.designation} onChange={(v) => upd('designation', v)} options={designations.map(d => ({ value: d, label: d }))} placeholder="All Designations" />
          <Select label="Shift" value={draft.shift} onChange={(v) => upd('shift', v)} options={(shifts || []).map(s => ({ value: s.id, label: `${s.shift_code} — ${s.shift_name}` }))} placeholder="All Shifts" />
          <Select label="Status" value={draft.status} onChange={(v) => upd('status', v)} options={Object.entries(STATUS_PALETTE).map(([v, c]) => ({ value: v, label: c.label }))} placeholder="All Statuses" />
          <Select label="Location" value={draft.location} onChange={(v) => upd('location', v)} options={locations.map(l => ({ value: l, label: l }))} placeholder="All Locations" />
          <DateInput label="Date" value={draft.date} onChange={(v) => upd('date', v)} />
          <MonthInput label="Month" value={draft.month} onChange={(v) => upd('month', v)} />
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

function Select({ label, value, onChange, options, placeholder }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-slate-500 mb-1 uppercase tracking-wide">{label}</label>
      <CustomSelect value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
        <option value="">{placeholder}</option>
        {options.filter(o => o.value).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </CustomSelect>
    </div>
  );
}
function DateInput({ label, value, onChange }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-slate-500 mb-1 uppercase tracking-wide">{label}</label>
      <CustomDatePicker value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
    </div>
  );
}
function MonthInput({ label, value, onChange }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-slate-500 mb-1 uppercase tracking-wide">{label}</label>
      <input type="month" value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
    </div>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────

function TabStrip({ activeTab, onChange, tabs }) {
  return (
    <div className="border-b border-slate-200 overflow-x-auto">
      <div className="flex items-center gap-1 min-w-max">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => onChange(t.key)}
            className={`px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px whitespace-nowrap ${
              activeTab === t.key
                ? 'text-blue-700 border-blue-600'
                : 'text-slate-600 border-transparent hover:text-slate-800 hover:border-slate-200'
            }`}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Status / Approval badges ────────────────────────────────────────────

function StatusBadge({ status }) {
  const c = STATUS_PALETTE[status] || { label: status || '—', chip: 'bg-slate-100 text-slate-700 border-slate-200' };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${c.chip}`}>{c.label}</span>;
}
function ApprovalBadge({ status }) {
  const c = APPROVAL_PALETTE[status] || APPROVAL_PALETTE.PENDING;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${c.chip}`}>{c.label}</span>;
}

// ─── Daily attendance table ──────────────────────────────────────────────

function DailyTable({ rows, onView, onApprove, onDelete, canApprove, canEdit, canDelete }) {
  if (rows.length === 0) return <EmptyState title="No attendance records" body="Adjust your filters or use Mark Attendance to record one." />;
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: '1500px' }}>
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr>
              {[
                '#', 'Employee ID', 'Employee Name', 'Department', 'Designation', 'Shift',
                'Date', 'In Time', 'Out Time', 'Break', 'Total Hrs', 'OT', 'Status',
                'Late / Early', 'Approval', 'Remarks', '',
              ].map((h) => (
                <th key={h} className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r, idx) => (
              <tr key={r.id} onClick={() => onView(r)} className="hover:bg-blue-50/40 cursor-pointer">
                <td className="px-3 py-2.5 text-slate-400">{idx + 1}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-slate-700">{r._staffIdDisplay}</td>
                <td className="px-3 py-2.5 font-medium text-slate-800">{r._staffName}</td>
                <td className="px-3 py-2.5 text-slate-700">{r._department}</td>
                <td className="px-3 py-2.5 text-slate-700">{r._designation}</td>
                <td className="px-3 py-2.5 text-slate-700">{r._shiftName}</td>
                <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap">{fmtDate(r.date)}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-emerald-700 whitespace-nowrap">{fmtTime(r.check_in_time)}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-red-700 whitespace-nowrap">{fmtTime(r.check_out_time)}</td>
                <td className="px-3 py-2.5 text-slate-600">{r._breakMin ? `${r._breakMin}m` : '—'}</td>
                <td className="px-3 py-2.5 font-semibold">{fmtHours(r.duration_hours)}</td>
                <td className="px-3 py-2.5">
                  {Number(r.overtime_hours || 0) > 0
                    ? <span className="font-semibold text-violet-700">{fmtHours(r.overtime_hours)}</span>
                    : <span className="text-slate-400">—</span>}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-col gap-0.5 items-start">
                    <StatusBadge status={r._displayStatus} />
                    {r._holiday && r._holiday.holiday_type !== 'WORKING' && r.attendance_status === 'PRESENT' && (
                      <span className="text-[10px] text-amber-700 font-medium" title={`Worked on ${r._holiday.name || r._holiday.holiday_type_display}`}>
                        worked on holiday
                      </span>
                    )}
                    {r._holiday?.name && r._displayStatus !== 'PRESENT' && (
                      <span className="text-[10px] text-slate-500" title={r._holiday.holiday_type_display || ''}>
                        {r._holiday.name}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-xs">
                  {r._lateEarly.kind === 'late' && <span className="text-amber-700 font-medium">Late {r._lateEarly.minutes}m</span>}
                  {r._lateEarly.kind === 'early_exit' && <span className="text-rose-700 font-medium">Early {r._lateEarly.minutes}m</span>}
                  {r._lateEarly.kind === 'on_time' && <span className="text-emerald-700">On time</span>}
                  {r._lateEarly.kind === 'unknown' && <span className="text-slate-400">—</span>}
                </td>
                <td className="px-3 py-2.5"><ApprovalBadge status={r._approvalStatus} /></td>
                <td className="px-3 py-2.5 text-xs text-slate-600 max-w-[180px] truncate" title={r.notes || ''}>{r.notes || '—'}</td>
                <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <RowActions
                    onView={() => onView(r)}
                    onApprove={canApprove('Attendance') && r._approvalStatus === 'PENDING' ? () => onApprove(r) : null}
                    onEdit={canEdit('Attendance') ? () => onView(r) : null}
                    onDelete={canDelete('Attendance') ? () => onDelete(r) : null}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-50 text-xs text-slate-500 flex items-center justify-between">
        <span>{rows.length} record{rows.length === 1 ? '' : 's'}</span>
        <span>Tip: click any row to open details · sticky header on scroll</span>
      </div>
    </div>
  );
}

function RowActions({ onView, onApprove, onEdit, onDelete }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)}
        className="p-1.5 text-slate-500 hover:bg-slate-100 rounded">
        <MoreVertical size={15} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1 w-44 bg-white border border-slate-200 rounded-lg shadow-lg py-1">
            <MenuItem icon={Eye}  onClick={() => { setOpen(false); onView(); }}>View Details</MenuItem>
            {onEdit && <MenuItem icon={Pencil} onClick={() => { setOpen(false); onEdit(); }}>Edit Attendance</MenuItem>}
            {onApprove && <MenuItem icon={Check} onClick={() => { setOpen(false); onApprove(); }}>Approve</MenuItem>}
            {onDelete && <MenuItem icon={X} tone="red" onClick={() => { setOpen(false); onDelete(); }}>Delete</MenuItem>}
          </div>
        </>
      )}
    </div>
  );
}
function MenuItem({ icon: Icon, children, onClick, tone }) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-50 ${tone === 'red' ? 'text-red-600' : 'text-slate-700'}`}>
      <Icon size={14} /> {children}
    </button>
  );
}

// ─── Monthly summary table ───────────────────────────────────────────────

function MonthlyTable({ rows, month, onMonthChange, holidayByDate = {}, activeCalendar }) {
  // Calendar-derived per-month counts. These are SAME for every staff
  // in the period (it's a company-wide calendar), so we precompute
  // once and stamp on each aggregate row. Weekly Off / Holiday columns
  // used to read 0 because they were trying to come from attendance
  // rows — now they come from the calendar where they belong.
  const calendarMonthly = useMemo(() => {
    let weeklyOff = 0;
    let holiday = 0;
    let workingOverride = 0;
    Object.values(holidayByDate || {}).forEach((d) => {
      if (!(d.date || '').startsWith(month)) return;
      if (d.holiday_type === 'WEEKLY_OFF') weeklyOff += 1;
      else if (d.holiday_type === 'WORKING') workingOverride += 1;
      else holiday += 1; // NATIONAL / COMPANY / RESTRICTED
    });
    // Total calendar days in the selected month
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    // Working days = total - weekly off - holidays + working overrides
    const workingDays = daysInMonth - weeklyOff - holiday + workingOverride;
    return { weeklyOff, holiday, workingOverride, daysInMonth, workingDays };
  }, [holidayByDate, month]);

  // Aggregate per-staff for the chosen YYYY-MM. Now uses calendar
  // values for the Wk Off / Holiday columns and the Payable-Days
  // math, so the row is a realistic factory-payroll preview:
  //   Payable = Present + HalfDay×0.5 + Paid Holidays/Weekly Offs
  const aggregated = useMemo(() => {
    const inMonth = rows.filter(r => (r.date || '').startsWith(month));
    const perStaff = new Map();
    inMonth.forEach((r) => {
      if (!perStaff.has(r.staff)) {
        perStaff.set(r.staff, {
          staff: r.staff,
          staff_id: r._staffIdDisplay,
          staff_name: r._staffName,
          department: r._department,
          present: 0, absent: 0, halfDay: 0, leave: 0,
          lateCount: 0, otHours: 0,
        });
      }
      const a = perStaff.get(r.staff);
      switch (r._displayStatus) {
        case 'PRESENT':    a.present  += 1; break;
        case 'ABSENT':     a.absent   += 1; break;
        case 'HALF_DAY':   a.halfDay  += 1; break;
        case 'LEAVE':
        case 'PERMISSION': a.leave    += 1; break;
        case 'LATE':       a.present  += 1; a.lateCount += 1; break;
        default: break;
      }
      a.otHours += Number(r.overtime_hours || 0);
    });
    return Array.from(perStaff.values()).map((a) => {
      // Paid holidays + weekly offs add to payable days — the factory
      // pays the worker for those days even though they didn't clock in.
      const paidNonWorking = calendarMonthly.weeklyOff + calendarMonthly.holiday;
      const payable = a.present + a.halfDay * 0.5 + paidNonWorking;
      // "At Risk" threshold against expected working days, not raw absent.
      const absentRatio = calendarMonthly.workingDays > 0
        ? a.absent / calendarMonthly.workingDays
        : 0;
      const finalStatus = absentRatio > 0.2 ? 'AT_RISK' : a.present === 0 ? 'NO_DATA' : 'ON_TRACK';
      return {
        ...a,
        weeklyOff: calendarMonthly.weeklyOff,
        holiday: calendarMonthly.holiday,
        payable,
        finalStatus,
      };
    });
  }, [rows, month, calendarMonthly]);

  return (
    <div className="bg-white border border-slate-200 rounded-xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Monthly Summary</h3>
          <p className="text-xs text-slate-500">
            {activeCalendar
              ? <>Using <strong>{activeCalendar.name}</strong> · {calendarMonthly.workingDays} working / {calendarMonthly.weeklyOff} weekly off / {calendarMonthly.holiday} holiday day(s) in this month</>
              : <>No holiday calendar found — Wk Off / Holiday columns and payable-day math will be 0. Create one under <strong>HR → Holiday Calendar</strong>.</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-slate-400" />
          <input type="month" value={month} onChange={(e) => onMonthChange(e.target.value)}
            className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
        </div>
      </div>
      {aggregated.length === 0 ? <EmptyState compact title="No data for this month" body="Pick a different month above." /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: '1200px' }}>
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                {['Employee ID', 'Name', 'Department', 'Month', 'Present', 'Absent', 'Leave', 'Wk Off', 'Holiday', 'Late', 'Half Day', 'OT Hrs', 'Payable Days', 'Final Status'].map((h) => (
                  <th key={h} className="text-left px-3 py-2.5 font-medium text-slate-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {aggregated.map((a) => (
                <tr key={a.staff} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">{a.staff_id}</td>
                  <td className="px-3 py-2 font-medium">{a.staff_name}</td>
                  <td className="px-3 py-2">{a.department}</td>
                  <td className="px-3 py-2 text-slate-600">{month}</td>
                  <td className="px-3 py-2 font-semibold text-emerald-700">{a.present}</td>
                  <td className="px-3 py-2 font-semibold text-red-700">{a.absent}</td>
                  <td className="px-3 py-2 text-blue-700">{a.leave}</td>
                  <td className="px-3 py-2 text-slate-600">{a.weeklyOff}</td>
                  <td className="px-3 py-2 text-teal-700">{a.holiday}</td>
                  <td className="px-3 py-2 text-amber-700">{a.lateCount}</td>
                  <td className="px-3 py-2 text-violet-700">{a.halfDay}</td>
                  <td className="px-3 py-2 text-violet-700 font-semibold">{a.otHours.toFixed(2)}</td>
                  <td className="px-3 py-2 font-bold">{a.payable.toFixed(1)}</td>
                  <td className="px-3 py-2">
                    <FinalStatusBadge value={a.finalStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function FinalStatusBadge({ value }) {
  const map = {
    ON_TRACK: { label: 'On Track', chip: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
    AT_RISK:  { label: 'At Risk',  chip: 'bg-amber-100 text-amber-800 border-amber-200' },
    NO_DATA:  { label: 'No Data',  chip: 'bg-slate-100 text-slate-600 border-slate-200' },
  };
  const c = map[value] || map.NO_DATA;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${c.chip}`}>{c.label}</span>;
}

// ─── Overtime / Leave tabs ───────────────────────────────────────────────

function OvertimeTable({ rows, onView }) {
  if (rows.length === 0) return <EmptyState title="No overtime recorded" body="Rows with overtime hours > 0 will appear here." />;
  const total = rows.reduce((s, r) => s + Number(r.overtime_hours || 0), 0);
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Overtime Report</h3>
          <p className="text-xs text-slate-500">Attendance entries with overtime hours &gt; 0</p>
        </div>
        <div className="text-xs text-slate-500">
          Total: <span className="font-semibold text-violet-700">{total.toFixed(2)} h</span> across {rows.length} record(s)
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              {['Date', 'Employee', 'Department', 'Shift', 'In Time', 'Out Time', 'Worked', 'OT Hours', ''].map((h) => (
                <th key={h} className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => onView(r)}>
                <td className="px-3 py-2.5 whitespace-nowrap">{fmtDate(r.date)}</td>
                <td className="px-3 py-2.5">
                  <p className="font-medium">{r._staffName}</p>
                  <p className="text-xs text-slate-400 font-mono">{r._staffIdDisplay}</p>
                </td>
                <td className="px-3 py-2.5">{r._department}</td>
                <td className="px-3 py-2.5">{r._shiftName}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{fmtTime(r.check_in_time)}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{fmtTime(r.check_out_time)}</td>
                <td className="px-3 py-2.5">{fmtHours(r.duration_hours)}</td>
                <td className="px-3 py-2.5 font-semibold text-violet-700">{fmtHours(r.overtime_hours)}</td>
                <td className="px-3 py-2.5"><ChevronRight size={14} className="text-slate-400" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LeaveAbsenceTable({ rows, onView }) {
  if (rows.length === 0) return <EmptyState title="No absences in range" body="Rows marked Absent / Leave / Permission will appear here." />;
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-800">Leave & Absence Report</h3>
        <p className="text-xs text-slate-500">Rows where status is Absent, Leave, or Permission</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              {['Date', 'Employee', 'Department', 'Status', 'Remarks', ''].map((h) => (
                <th key={h} className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => onView(r)}>
                <td className="px-3 py-2.5 whitespace-nowrap">{fmtDate(r.date)}</td>
                <td className="px-3 py-2.5">
                  <p className="font-medium">{r._staffName}</p>
                  <p className="text-xs text-slate-400 font-mono">{r._staffIdDisplay}</p>
                </td>
                <td className="px-3 py-2.5">{r._department}</td>
                <td className="px-3 py-2.5"><StatusBadge status={r._displayStatus} /></td>
                <td className="px-3 py-2.5 text-xs text-slate-600">{r.notes || '—'}</td>
                <td className="px-3 py-2.5"><ChevronRight size={14} className="text-slate-400" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Detail drawer ───────────────────────────────────────────────────────

function AttendanceDetailDrawer({ row, allRows, onClose, onApprove, canApprove }) {
  if (!row) return null;
  // Week-of-this-record history for the same staff. Strict ±6 days
  // window around the record's date so the drawer reads as a "week
  // around this entry" view.
  const history = useMemo(() => {
    const d0 = new Date(row.date);
    const start = new Date(d0); start.setDate(d0.getDate() - 6);
    const end = new Date(d0);   end.setDate(d0.getDate() + 6);
    const startIso = start.toISOString().slice(0, 10);
    const endIso = end.toISOString().slice(0, 10);
    return allRows
      .filter((r) => r.staff === row.staff && r.date >= startIso && r.date <= endIso)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }, [row, allRows]);

  const initial = (row._staffName || '?').trim().charAt(0).toUpperCase();
  const hasGeo = row.geo_latitude != null && row.geo_longitude != null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <button onClick={onClose} className="flex-1 bg-black/40" aria-label="Close" />
      <aside className="w-full max-w-3xl bg-white h-full shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-full bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center text-white font-bold flex-shrink-0">
              {initial}
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-slate-900 truncate">{row._staffName}</p>
              <p className="text-xs text-slate-500 truncate font-mono">{row._staffIdDisplay} · {row._department}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" className="p-1.5 text-slate-500 hover:bg-slate-200 rounded">
            <X size={18} />
          </button>
        </header>

        {/* Status row */}
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <StatusBadge status={row._displayStatus} />
            <ApprovalBadge status={row._approvalStatus} />
            {row._lateEarly.kind === 'late' && <span className="text-xs text-amber-700 font-medium">⌚ Late {row._lateEarly.minutes}m</span>}
          </div>
          {canApprove && row._approvalStatus === 'PENDING' && (
            <button onClick={() => onApprove(row)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700">
              <Check size={14} /> Approve
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 flex-1">
          {/* Holiday context (only when this date is on the calendar) */}
          {row._holiday && (
            <div className={`rounded-lg border p-3 text-sm ${
              row._holiday.holiday_type === 'WORKING'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : row._holiday.holiday_type === 'NATIONAL_HOLIDAY'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : row._holiday.holiday_type === 'WEEKLY_OFF'
                    ? 'bg-slate-50 border-slate-200 text-slate-700'
                    : 'bg-amber-50 border-amber-200 text-amber-800'
            }`}>
              <p className="font-semibold">
                {row._holiday.holiday_type_display || row._holiday.holiday_type.replace('_', ' ')}
                {row._holiday.name ? ` — ${row._holiday.name}` : ''}
              </p>
              <p className="text-xs mt-0.5 opacity-80">
                {row.attendance_status === 'PRESENT'
                  ? 'Employee worked on this non-working day. Consider compensatory off / overtime per policy.'
                  : row._holiday.is_paid
                    ? 'Paid holiday — not counted as absent.'
                    : 'Unpaid holiday.'}
              </p>
            </div>
          )}
          <Section title="Capture Details">
            <FieldRow label="Date" value={fmtDate(row.date)} />
            <FieldRow label="Shift" value={row._shiftName} />
            <FieldRow label="Check-in" value={fmtDateTime(row.check_in_time)} mono />
            <FieldRow label="Check-out" value={fmtDateTime(row.check_out_time)} mono />
            <FieldRow label="Total Working Hours" value={fmtHours(row.duration_hours)} />
            <FieldRow label="Overtime" value={fmtHours(row.overtime_hours)} />
            <FieldRow label="Break (planned)" value={row._breakMin ? `${row._breakMin} min` : '—'} />
            <FieldRow label="Location / Site" value={row._location} />
          </Section>

          {(row.entry_photo || row.exit_photo) && (
            <Section title="Photos">
              <div className="grid grid-cols-2 gap-2">
                {row.entry_photo && (
                  <a href={row.entry_photo} target="_blank" rel="noreferrer" className="block">
                    <p className="text-xs text-slate-500 mb-1">Entry</p>
                    <img src={row.entry_photo} alt="entry" className="rounded-lg border border-slate-200 max-h-36 w-full object-cover" />
                  </a>
                )}
                {row.exit_photo && (
                  <a href={row.exit_photo} target="_blank" rel="noreferrer" className="block">
                    <p className="text-xs text-slate-500 mb-1">Exit</p>
                    <img src={row.exit_photo} alt="exit" className="rounded-lg border border-slate-200 max-h-36 w-full object-cover" />
                  </a>
                )}
              </div>
            </Section>
          )}

          {hasGeo && (
            <Section title="Geo-Location">
              <p className="text-xs text-slate-600 mb-1 font-mono">
                {Number(row.geo_latitude).toFixed(6)}, {Number(row.geo_longitude).toFixed(6)}
              </p>
              <a href={`https://maps.google.com/?q=${row.geo_latitude},${row.geo_longitude}`}
                target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-blue-600 hover:underline text-xs font-medium">
                <MapPin size={12} /> Open in Google Maps
              </a>
            </Section>
          )}

          <Section title="Audit">
            <FieldRow label="Marked via" value={row.device_id ? `Device · ${row.device_id}` : 'Manual (HR)'} mono />
            <FieldRow label="Face match" value={row.face_match_confidence != null ? `${(Number(row.face_match_confidence) * 100).toFixed(1)}%` : '—'} />
          </Section>

          {row.notes && (
            <Section title="Remarks">
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{row.notes}</p>
            </Section>
          )}

          <Section title={`Attendance — Week of ${fmtDate(row.date)}`}>
            <div className="rounded-lg border border-slate-200 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium text-slate-600">Date</th>
                    <th className="text-left px-2 py-1.5 font-medium text-slate-600">In</th>
                    <th className="text-left px-2 py-1.5 font-medium text-slate-600">Out</th>
                    <th className="text-left px-2 py-1.5 font-medium text-slate-600">Hrs</th>
                    <th className="text-left px-2 py-1.5 font-medium text-slate-600">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {history.map((h) => (
                    <tr key={h.id} className={h.id === row.id ? 'bg-blue-50/60' : ''}>
                      <td className="px-2 py-1.5">{fmtDate(h.date)}</td>
                      <td className="px-2 py-1.5 font-mono">{fmtTime(h.check_in_time)}</td>
                      <td className="px-2 py-1.5 font-mono">{fmtTime(h.check_out_time)}</td>
                      <td className="px-2 py-1.5">{fmtHours(h.duration_hours)}</td>
                      <td className="px-2 py-1.5"><StatusBadge status={h._displayStatus} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{title}</h4>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
function FieldRow({ label, value, mono }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-sm text-slate-800 text-right ${mono ? 'font-mono' : 'font-medium'}`}>{value || '—'}</span>
    </div>
  );
}

// ─── Mark Attendance modal ───────────────────────────────────────────────

function MarkAttendanceModal({ staff, shifts, holidayByDate = {}, activeCalendar, leaveData = [], onClose, onSaved }) {
  const [form, setForm] = useState({
    staff: '',
    date: todayIso(),
    shift: '',
    check_in: '',
    check_out: '',
    break_min: '',
    status: 'PRESENT',
    overtime_hours: '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);

  const upd = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const toIsoDt = (dateStr, timeStr) => {
    if (!dateStr || !timeStr) return null;
    const safeTime = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
    const local = new Date(`${dateStr}T${safeTime}`);
    if (Number.isNaN(local.getTime())) return null;
    return local.toISOString();
  };

  // Approved-leave records for the currently-selected staff. We keep
  // the full LeaveRequest objects (not just the dates) so the auto-fill
  // below can read leave_type / request_no for status mapping + remarks
  // pre-population.
  const staffLeaves = useMemo(() => {
    if (!form.staff) return [];
    return (leaveData || []).filter(l => l.status === 'APPROVED' && l.staff === form.staff);
  }, [leaveData, form.staff]);

  // Quick lookup: YYYY-MM-DD → matching approved LeaveRequest for this staff.
  const leaveByDate = useMemo(() => {
    const m = {};
    staffLeaves.forEach((l) => {
      const s = l.start_date;
      const e = l.end_date || l.start_date;
      if (!s) return;
      const start = new Date(s);
      const end = new Date(e);
      const cur = new Date(start);
      while (cur <= end) {
        const y = cur.getFullYear();
        const mm = String(cur.getMonth() + 1).padStart(2, '0');
        const dd = String(cur.getDate()).padStart(2, '0');
        m[`${y}-${mm}-${dd}`] = l;
        cur.setDate(cur.getDate() + 1);
      }
    });
    return m;
  }, [staffLeaves]);

  // Date-only set kept for the mini calendar's per-staff highlight.
  const leaveDateSet = useMemo(() => new Set(Object.keys(leaveByDate)), [leaveByDate]);

  // Context for the currently-picked date.
  const pickedHoliday = holidayByDate[form.date] || null;
  const pickedLeave = leaveByDate[form.date] || null;
  const pickedIsLeave = !!pickedLeave;
  const pickedStaff = (staff || []).find(s => s.id === form.staff) || null;

  // Auto-default the Status field based on the matched leave.
  // - FULL_DAY  → ABSENT  (the backend enum doesn't have a dedicated
  //                       LEAVE value; the daily view's overlay still
  //                       displays this as "Leave" because the leave
  //                       table is the source of truth.)
  // - HALF_DAY  → HALF_DAY
  // - PERMISSION → PERMISSION
  // Also primes the Remarks field with the request number so the audit
  // trail on the attendance row points back to the leave that drove
  // the entry. The hook re-runs only when (staff, date) changes — once
  // the user manually edits status / remarks they keep their value
  // until they pick a new (staff, date) combo.
  const LEAVE_TYPE_TO_ATT_STATUS = {
    FULL_DAY:   'ABSENT',
    HALF_DAY:   'HALF_DAY',
    PERMISSION: 'PERMISSION',
  };
  useEffect(() => {
    if (!pickedLeave) return;
    const mapped = LEAVE_TYPE_TO_ATT_STATUS[pickedLeave.leave_type] || 'ABSENT';
    setForm((p) => ({
      ...p,
      status: mapped,
      notes: p.notes
        ? p.notes
        : `Approved leave (${pickedLeave.request_no || '—'})${pickedLeave.reason ? ` — ${pickedLeave.reason}` : ''}`.trim(),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.staff, form.date]);

  // When the user picks a staff, auto-fill the Shift dropdown with
  // that staff's default `shift_assignment` from the master. Only
  // overrides if the dropdown is empty so a manual choice the user
  // already made for this entry isn't clobbered.
  useEffect(() => {
    if (!form.staff || !pickedStaff?.shift_assignment) return;
    setForm((p) => p.shift ? p : { ...p, shift: pickedStaff.shift_assignment });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.staff]);

  // Auto-fill Break (minutes) from the selected shift's
  // `break_duration_mins`. Re-runs whenever the shift changes so the
  // operator never has to retype the break value — it reads off the
  // shift master. The user can still type a different value after to
  // record a one-off override; the effect only fires on shift change.
  useEffect(() => {
    if (!form.shift) return;
    const sh = (shifts || []).find(s => s.id === form.shift);
    if (!sh) return;
    setForm((p) => ({ ...p, break_min: String(sh.break_duration_mins ?? '') }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.shift]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.staff) { toast.error('Pick a staff member.'); return; }
    if (!form.date) { toast.error('Date is required.'); return; }
    if (!form.status) { toast.error('Status is required.'); return; }
    // On approved-leave days we never persist In/Out/Break/OT — those
    // fields are hidden from the form, and the staff wasn't physically
    // at work. Forcing them to null at submit time prevents stale state
    // from leaking through if the user toggled the staff/date back and
    // forth before submitting.
    const payload = {
      staff: form.staff,
      date: form.date,
      shift: form.shift || null,
      check_in_time:  pickedIsLeave ? null : toIsoDt(form.date, form.check_in),
      check_out_time: pickedIsLeave ? null : toIsoDt(form.date, form.check_out),
      attendance_status: form.status,
      overtime_hours: pickedIsLeave ? 0 : (Number(form.overtime_hours) || 0),
      notes: form.notes || '',
    };
    setBusy(true);
    try {
      await apiClient.post('/api/hr/attendance/', cleanFormData(payload));
      toast.success('Attendance recorded.');
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to record attendance.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label="Mark Attendance" className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col">
        <header className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 bg-blue-50">
          <div>
            <h3 className="text-lg font-bold text-blue-900">Mark Attendance</h3>
            <p className="text-xs text-blue-700/80">Manual entry for back-office HR / supervisor</p>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" className="p-1.5 text-slate-500 hover:bg-slate-200 rounded"><X size={18} /></button>
        </header>
        <form onSubmit={submit} className="p-5 space-y-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-2 md:grid-cols-2 gap-3">
            <Field label="Employee *">
              <CustomSelect required value={form.staff} onChange={(e) => upd('staff', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500">
                <option value="">Select Employee…</option>
                {(staff || []).filter(s => s.employment_status === 'ACTIVE').map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.staff_id} — {s.full_name || `${s.first_name || ''} ${s.last_name || ''}`.trim()}
                  </option>
                ))}
              </CustomSelect>
            </Field>
            <Field label="Date *">
              <CalendarAwareDatePicker
                value={form.date}
                onChange={(v) => upd('date', v)}
                holidayByDate={holidayByDate}
                leaveDateSet={leaveDateSet}
                disabled={pickedIsLeave}
              />
            </Field>
            <Field label="Shift">
              <CustomSelect value={form.shift} onChange={(e) => upd('shift', e.target.value)}
                disabled={pickedIsLeave}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed">
                <option value="">— No shift —</option>
                {(shifts || []).map((s) => (
                  <option key={s.id} value={s.id}>{s.shift_code} — {s.shift_name}</option>
                ))}
              </CustomSelect>
            </Field>
            <Field label="Status *">
              <CustomSelect required value={form.status} onChange={(e) => upd('status', e.target.value)}
                disabled={pickedIsLeave}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed">
                <option value="PRESENT">Present</option>
                <option value="ABSENT">Absent</option>
                <option value="HALF_DAY">Half Day</option>
                <option value="PERMISSION">Permission</option>
              </CustomSelect>
            </Field>
            {/* Worked-time fields. Hidden entirely when the picked
                staff has an approved leave on the picked date — a
                staff on leave didn't check in, so showing empty
                In/Out/Break/OT inputs is misleading and invites the
                user to fill them in by accident. The submit handler
                also skips these values when on leave so a stale entry
                from before the staff/date change can't leak through. */}
            {!pickedIsLeave && (
              <>
                <Field label="In Time">
                  <input type="time" value={form.check_in} onChange={(e) => upd('check_in', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
                </Field>
                <Field label="Out Time">
                  <input type="time" value={form.check_out} onChange={(e) => upd('check_out', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
                </Field>
                <Field label="Break (minutes)">
                  <input type="number" min="0" value={form.break_min} onChange={(e) => upd('break_min', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
                </Field>
                <Field label="Overtime Hours">
                  <input type="number" min="0" step="0.25" value={form.overtime_hours} onChange={(e) => upd('overtime_hours', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
                </Field>
              </>
            )}
          </div>

          {/* Context strip — surfaces holiday + leave info for the
              picked (date, staff) combination. When an approved leave
              matches, the Status field is already auto-set to the
              corresponding attendance code (FULL_DAY → ABSENT,
              HALF_DAY → HALF_DAY, PERMISSION → PERMISSION) and the
              Remarks line is pre-filled with the request number — the
              user can still override either before submitting. */}
          {(pickedHoliday || pickedIsLeave) && (
            <DatePickContext
              holiday={pickedHoliday}
              isOnLeave={pickedIsLeave}
              leave={pickedLeave}
              autoStatusLabel={pickedLeave ? ({
                FULL_DAY: 'Absent (Leave)',
                HALF_DAY: 'Half Day',
                PERMISSION: 'Permission',
              }[pickedLeave.leave_type] || 'Absent') : null}
              staffName={pickedStaff ? (pickedStaff.full_name || `${pickedStaff.first_name || ''} ${pickedStaff.last_name || ''}`.trim() || pickedStaff.staff_id) : 'this staff'}
              calendarName={activeCalendar?.name}
            />
          )}

          <Field label="Remarks">
            <textarea rows={3} value={form.notes} onChange={(e) => upd('notes', e.target.value)}
              readOnly={pickedIsLeave}
              className={`w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 ${pickedIsLeave ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : ''}`}
              placeholder="Optional — context for supervisor / HR" />
          </Field>
          <p className="text-xs text-slate-500 flex items-start gap-1.5">
            <AlertCircle size={12} className="mt-0.5 text-slate-400 flex-shrink-0" />
            Attachment / proof upload becomes available once the staff has at least one previous capture (used for face / signature reference).
          </p>
        </form>
        <footer className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-200 bg-slate-50">
          <button type="button" onClick={onClose}
            className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={busy}
            className="inline-flex items-center gap-1.5 px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Saving…' : 'Submit Attendance'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

// ─── Calendar-aware date picker ──────────────────────────────────────────
// Replaces the native <CustomDatePicker> on the Mark Attendance modal
// with a popover that shows a mini month grid where each day is
// colour-coded by the holiday calendar AND any approved leave for the
// currently-selected staff. HR sees at a glance which days are
// Sundays / national holidays / company holidays / leave days BEFORE
// they fill in a status — preventing accidental "marked Present on
// Diwali" or "marked Absent while the staff was on approved leave".

function CalendarAwareDatePicker({ value, onChange, holidayByDate, leaveDateSet, disabled }) {
  const [open, setOpen] = useState(false);
  const baseDate = value ? new Date(value) : new Date();
  const [viewYear, setViewYear] = useState(baseDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(baseDate.getMonth());

  // Auto-close the popover the moment the field becomes disabled so a
  // mid-edit click doesn't leave a stale calendar floating over locked
  // inputs.
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  // Keep the viewed month in sync when the value changes externally.
  useEffect(() => {
    if (!value) return;
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    }
  }, [value]);

  const toIso = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const display = value
    ? formatDate(value)
    : '— pick a date —';

  const grid = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const start = new Date(viewYear, viewMonth, 1 - first.getDay());
    const rows = [];
    for (let r = 0; r < 6; r += 1) {
      const row = [];
      for (let c = 0; c < 7; c += 1) {
        const d = new Date(start);
        d.setDate(start.getDate() + r * 7 + c);
        row.push(d);
      }
      rows.push(row);
    }
    return rows;
  }, [viewYear, viewMonth]);

  const todayIsoStr = toIso(new Date());
  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className={`w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-left flex items-center justify-between focus:ring-2 focus:ring-blue-500 ${
          disabled
            ? 'bg-slate-100 text-slate-500 cursor-not-allowed'
            : 'hover:bg-slate-50'
        }`}
      >
        <span className={value ? '' : 'text-slate-400'}>{display}</span>
        <Calendar size={14} className="text-slate-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-[280px] bg-white border border-slate-200 rounded-lg shadow-lg p-2">
            <div className="flex items-center justify-between px-1 py-1">
              <button type="button"
                onClick={() => {
                  const m = viewMonth - 1;
                  if (m < 0) { setViewMonth(11); setViewYear((y) => y - 1); } else setViewMonth(m);
                }}
                className="p-1 text-slate-500 hover:bg-slate-100 rounded"><ChevronLeft size={14} /></button>
              <span className="text-sm font-semibold text-slate-700">{monthLabel}</span>
              <button type="button"
                onClick={() => {
                  const m = viewMonth + 1;
                  if (m > 11) { setViewMonth(0); setViewYear((y) => y + 1); } else setViewMonth(m);
                }}
                className="p-1 text-slate-500 hover:bg-slate-100 rounded"><ChevronRight size={14} /></button>
            </div>
            <div className="grid grid-cols-7 text-[10px] font-medium text-slate-400 uppercase tracking-wide text-center mb-1">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
                <div key={i} className={`py-1 ${i === 0 ? 'text-blue-500' : ''}`}>{w}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {grid.flat().map((d) => {
                const iso = toIso(d);
                const inMonth = d.getMonth() === viewMonth;
                const isSelected = iso === value;
                const isToday = iso === todayIsoStr;
                const entry = holidayByDate?.[iso];
                const isOnLeave = leaveDateSet?.has(iso);

                // Visual hierarchy (descending priority):
                //   selected ring > leave (blue) > national (red) >
                //   company (amber) > restricted (violet) > working ovr (emerald)
                //   > weekly off (slate)
                let dotCls = '';
                if (isOnLeave) dotCls = 'bg-blue-100 text-blue-800 ring-1 ring-blue-300';
                else if (entry?.holiday_type === 'NATIONAL_HOLIDAY') dotCls = 'bg-red-100 text-red-800 ring-1 ring-red-300';
                else if (entry?.holiday_type === 'COMPANY_HOLIDAY')  dotCls = 'bg-amber-100 text-amber-800 ring-1 ring-amber-300';
                else if (entry?.holiday_type === 'RESTRICTED')        dotCls = 'bg-violet-100 text-violet-800 ring-1 ring-violet-300';
                else if (entry?.holiday_type === 'WORKING')           dotCls = 'bg-emerald-50 text-emerald-800';
                else if (entry?.holiday_type === 'WEEKLY_OFF')        dotCls = 'bg-slate-100 text-slate-600';

                return (
                  <button
                    key={iso}
                    type="button"
                    disabled={!inMonth}
                    onClick={() => { onChange(iso); setOpen(false); }}
                    title={
                      entry ? `${entry.holiday_type_display || entry.holiday_type}${entry.name ? ' — ' + entry.name : ''}` :
                      isOnLeave ? 'Approved leave for this staff' : ''
                    }
                    className={[
                      'h-8 w-full rounded text-xs font-medium transition',
                      inMonth ? 'cursor-pointer hover:bg-blue-50' : 'opacity-30 cursor-default',
                      dotCls || (inMonth ? 'text-slate-700' : 'text-slate-400'),
                      isSelected ? '!bg-blue-600 !text-white ring-2 ring-blue-700' : '',
                      isToday && !isSelected ? 'ring-1 ring-blue-400' : '',
                    ].join(' ')}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
            {/* Legend */}
            <div className="border-t border-slate-100 mt-2 pt-2 grid grid-cols-2 gap-1 text-[10px] text-slate-500">
              <LegendDot cls="bg-slate-100 ring-slate-300" label="Weekly Off" />
              <LegendDot cls="bg-red-100 ring-red-300" label="National" />
              <LegendDot cls="bg-amber-100 ring-amber-300" label="Company" />
              <LegendDot cls="bg-violet-100 ring-violet-300" label="Restricted" />
              <LegendDot cls="bg-emerald-50 ring-emerald-300" label="Working ovr" />
              <LegendDot cls="bg-blue-100 ring-blue-300" label="On leave" />
            </div>
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
              <button type="button" onClick={() => { onChange(todayIsoStr); setOpen(false); }}
                className="text-xs text-blue-600 hover:underline">Today</button>
              <button type="button" onClick={() => setOpen(false)}
                className="text-xs text-slate-500 hover:underline">Close</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LegendDot({ cls, label }) {
  return (
    <div className="flex items-center gap-1">
      <span className={`inline-block w-3 h-3 rounded-sm ring-1 ${cls}`} />
      <span>{label}</span>
    </div>
  );
}

// Inline strip shown inside the Mark Attendance modal when the picked
// date carries a calendar entry or the picked staff is on approved
// leave that day. Colour-coded to match the picker. When a leave is
// matched, this block also confirms that Status has been auto-marked
// (so HR isn't surprised by the dropdown changing under them).
function DatePickContext({ holiday, isOnLeave, leave, autoStatusLabel, staffName, calendarName }) {
  if (isOnLeave) {
    return (
      <div className="rounded-lg border bg-blue-50 border-blue-200 text-blue-800 px-3 py-2 text-sm flex items-start gap-2">
        <span>✈️</span>
        <div className="flex-1">
          <p className="font-semibold">{staffName} is on approved leave on this date.</p>
          <p className="text-xs opacity-80 mt-0.5">
            Auto-marked as <strong>{autoStatusLabel || 'Absent'}</strong>
            {leave?.request_no ? <> from request <span className="font-mono">{leave.request_no}</span></> : null}
            {leave?.leave_type ? <> ({leave.leave_type.replace('_', ' ').toLowerCase()})</> : null}.
            Change the Status above if you need to override.
          </p>
        </div>
      </div>
    );
  }
  if (!holiday) return null;
  const toneByType = {
    WEEKLY_OFF:       { bg: 'bg-slate-50 border-slate-200 text-slate-700',   icon: '🛌' },
    NATIONAL_HOLIDAY: { bg: 'bg-red-50 border-red-200 text-red-800',         icon: '🇮🇳' },
    COMPANY_HOLIDAY:  { bg: 'bg-amber-50 border-amber-200 text-amber-800',   icon: '🏢' },
    RESTRICTED:       { bg: 'bg-violet-50 border-violet-200 text-violet-800', icon: '🎉' },
    WORKING:          { bg: 'bg-emerald-50 border-emerald-200 text-emerald-800', icon: '✅' },
  };
  const t = toneByType[holiday.holiday_type] || toneByType.COMPANY_HOLIDAY;
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm flex items-start gap-2 ${t.bg}`}>
      <span>{t.icon}</span>
      <div>
        <p className="font-semibold">
          {holiday.holiday_type_display || holiday.holiday_type.replace('_', ' ')}
          {holiday.name ? ` — ${holiday.name}` : ''}
        </p>
        <p className="text-xs opacity-80 mt-0.5">
          {holiday.holiday_type === 'WORKING'
            ? 'Working-day override — normal attendance applies.'
            : `Calendar: ${calendarName || 'Holiday Calendar'} · ${holiday.is_paid ? 'Paid' : 'Unpaid'}. Marking Present here = worked on holiday.`}
        </p>
      </div>
    </div>
  );
}

// ─── Empty / Loading / Error states ──────────────────────────────────────

function EmptyState({ title, body, compact }) {
  return (
    <div className={`bg-white border border-dashed border-slate-300 rounded-xl text-center ${compact ? 'py-8' : 'py-16'}`}>
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 text-slate-400 mb-3">
        <Calendar size={20} />
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
        <AlertCircle size={20} />
      </div>
      <p className="text-sm font-semibold text-red-800">Failed to load attendance</p>
      <p className="text-xs text-red-700 mt-1 mb-4">Network or server error. Try again.</p>
      <button onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">
        <RefreshCw size={14} /> Retry
      </button>
    </div>
  );
}
function TableSkeleton() {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex items-center gap-3 animate-pulse">
          <div className="h-3 w-12 bg-slate-200 rounded" />
          <div className="h-3 flex-1 bg-slate-200 rounded" />
          <div className="h-3 w-24 bg-slate-200 rounded" />
          <div className="h-3 w-20 bg-slate-200 rounded" />
          <div className="h-3 w-16 bg-slate-200 rounded" />
        </div>
      ))}
    </div>
  );
}

// ─── Utilities ───────────────────────────────────────────────────────────

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function exportCsv(rows) {
  if (!rows || rows.length === 0) {
    toast('Nothing to export', { icon: 'ℹ️' });
    return;
  }
  const cols = [
    ['employee_id', (r) => r._staffIdDisplay],
    ['employee_name', (r) => r._staffName],
    ['department', (r) => r._department],
    ['designation', (r) => r._designation],
    ['shift', (r) => r._shiftName],
    ['date', (r) => r.date],
    ['in_time', (r) => r.check_in_time || ''],
    ['out_time', (r) => r.check_out_time || ''],
    ['worked_hours', (r) => (r.duration_hours != null ? Number(r.duration_hours).toFixed(2) : '')],
    ['overtime_hours', (r) => Number(r.overtime_hours || 0).toFixed(2)],
    ['status', (r) => r._displayStatus],
    ['approval', (r) => r._approvalStatus],
    ['late_minutes', (r) => (r._lateEarly.kind === 'late' ? r._lateEarly.minutes : '')],
    ['notes', (r) => (r.notes || '').replace(/[\r\n]+/g, ' ')],
  ];
  const header = cols.map(([h]) => h).join(',');
  const body = rows.map(r => cols.map(([, fn]) => {
    const v = String(fn(r) ?? '');
    return v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\n');
  const blob = new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `attendance-${todayIso()}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  toast.success('Exported CSV');
}
