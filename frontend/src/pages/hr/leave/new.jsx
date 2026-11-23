import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
/**
 * Leave Application workspace — HR module.
 *
 * Built as a single tabbed page so an employee / HR coordinator can:
 *   • Apply for leave with a real industrial-grade form (sections A-F)
 *   • Inspect live quota balances, LOP impact, policy rules
 *   • See their own request history and pull up a detail drawer
 *   • Glance at the team calendar to avoid overlapping requests
 *   • Read the policy ledger and an audit-friendly approval history
 *
 * Backend constraint:
 *   /api/hr/leave/ currently stores: staff, leave_type (FULL_DAY|HALF_DAY|
 *   PERMISSION), start_date, end_date, reason, status, approval_date,
 *   approval_remarks, lop_days. Rich UI types (Casual, Sick, Earned, etc.)
 *   and the extra metadata (backup, handover, contact, declarations) get
 *   serialised into the `reason` text so nothing is lost when the policy
 *   models land.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle, Info, Calendar as CalendarIcon, Clock,
  Briefcase, User as UserIcon, Phone, MapPin, FileText, Paperclip,
  Users, ShieldCheck, X as XIcon, Eye, Download, Upload, Edit3, Trash2,
  ChevronLeft, ChevronRight, Search, Filter, RefreshCw, CalendarDays,
  TrendingUp, Activity, Hash, Building2, Star, Hourglass, BadgeCheck,
  ClipboardList, MessageSquare, History,
} from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useApiData from '../../../hooks/useApiData.js';
import { formatCurrency, formatDate, formatDateTime } from '@/utils/formatters';

/* ─────────────────────────────────────────────────────────────────────────
 * Constants
 * ─────────────────────────────────────────────────────────────────────── */

// Twelve leave types the UI offers. Each maps to ONE of the three
// backend-supported codes (FULL_DAY, HALF_DAY, PERMISSION) plus a
// quota-bucket so the balance dashboard can group correctly.
const LEAVE_TYPES = [
  { code: 'CASUAL',     label: 'Casual Leave (CL)',        backend: 'FULL_DAY', bucket: 'CASUAL',  color: 'sky',     entitled: 12, attach: false, notice: 1,  desc: 'Personal / short-notice leave.' },
  { code: 'SICK',       label: 'Sick Leave (SL)',          backend: 'FULL_DAY', bucket: 'SICK',    color: 'rose',    entitled: 12, attach: true,  notice: 0,  desc: 'Medical leave — certificate required if >2 days.' },
  { code: 'EARNED',     label: 'Earned / Paid Leave (EL)', backend: 'FULL_DAY', bucket: 'EARNED',  color: 'emerald', entitled: 18, attach: false, notice: 7,  desc: 'Accrued 1.5 days/month. Encashable on exit.' },
  { code: 'UNPAID',     label: 'Unpaid Leave (LWP)',       backend: 'FULL_DAY', bucket: 'UNPAID',  color: 'slate',   entitled: 0,  attach: false, notice: 7,  desc: 'Salary will be deducted for these days.' },
  { code: 'MATERNITY',  label: 'Maternity Leave',          backend: 'FULL_DAY', bucket: 'STAT',    color: 'pink',    entitled: 182, attach: true, notice: 30, desc: 'Statutory — up to 26 weeks per Maternity Benefit Act.' },
  { code: 'PATERNITY',  label: 'Paternity Leave',          backend: 'FULL_DAY', bucket: 'STAT',    color: 'indigo',  entitled: 7,  attach: false, notice: 14, desc: 'Up to 7 working days within 3 months of childbirth.' },
  { code: 'BEREAVEMENT',label: 'Bereavement Leave',        backend: 'FULL_DAY', bucket: 'SPECIAL', color: 'zinc',    entitled: 5,  attach: false, notice: 0,  desc: 'Up to 5 days on the death of an immediate family member.' },
  { code: 'COMP_OFF',   label: 'Comp-Off',                 backend: 'FULL_DAY', bucket: 'COMPOFF', color: 'violet',  entitled: 0,  attach: false, notice: 1,  desc: 'Granted against approved overtime. Use within 60 days.' },
  { code: 'WFH',        label: 'Work From Home',           backend: 'FULL_DAY', bucket: 'WFH',     color: 'cyan',    entitled: 0,  attach: false, notice: 1,  desc: 'Not a leave — flagged on roster, attendance counts.' },
  { code: 'ON_DUTY',    label: 'On Duty',                  backend: 'FULL_DAY', bucket: 'OD',      color: 'teal',    entitled: 0,  attach: false, notice: 1,  desc: 'Out of office on company work — attendance counts.' },
  { code: 'HALF_DAY',   label: 'Half Day',                 backend: 'HALF_DAY', bucket: 'CASUAL',  color: 'amber',   entitled: 0,  attach: false, notice: 0,  desc: 'Half-day leave deducted as 0.5 from the casual pool.' },
  { code: 'SHORT',      label: 'Short Leave / Permission', backend: 'PERMISSION', bucket: 'PERMISSION', color: 'orange', entitled: 0, attach: false, notice: 0, desc: 'Up to 2 hours. Capped at 2/month, no quota deduction.' },
];

const REASON_CATEGORIES = [
  'Personal Work', 'Medical / Health', 'Family Function', 'Travel',
  'Education / Exam', 'Religious Observance', 'Bereavement',
  'Marriage', 'Childcare', 'Government Work', 'Court Appearance',
  'Emergency', 'Other',
];

const SESSION_OPTIONS = [
  { value: 'FULL',  label: 'Full Day' },
  { value: 'FIRST', label: 'First Half (Morning)' },
  { value: 'SECOND',label: 'Second Half (Afternoon)' },
];

// Status → badge palette. Mirrors the eight workflow states the spec
// asks for; the backend currently only emits PENDING / APPROVED /
// REJECTED, the others are wired so the UI is ready when multi-level
// approval lands.
const STATUS_META = {
  DRAFT:                    { label: 'Draft',                     tone: 'bg-slate-100 text-slate-700 border-slate-200' },
  PENDING_SUPERVISOR:       { label: 'Pending Supervisor Review', tone: 'bg-amber-100 text-amber-800 border-amber-200' },
  PENDING_MANAGER:          { label: 'Pending Manager Approval',  tone: 'bg-orange-100 text-orange-800 border-orange-200' },
  PENDING_HR:               { label: 'Pending HR Review',         tone: 'bg-blue-100 text-blue-800 border-blue-200' },
  PENDING:                  { label: 'Pending Approval',          tone: 'bg-amber-100 text-amber-800 border-amber-200' },
  APPROVED:                 { label: 'Approved',                  tone: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  REJECTED:                 { label: 'Rejected',                  tone: 'bg-red-100 text-red-800 border-red-200' },
  CANCELLED:                { label: 'Cancelled',                 tone: 'bg-zinc-200 text-zinc-700 border-zinc-300' },
  WITHDRAWN:                { label: 'Withdrawn',                 tone: 'bg-violet-100 text-violet-800 border-violet-200' },
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ─────────────────────────────────────────────────────────────────────────
 * Helpers
 * ─────────────────────────────────────────────────────────────────────── */

const fmtDate = (v) =>
  v ? formatDate(v) : '—';

const fmtDateTime = (v) =>
  v ? formatDateTime(v) : '—';

const fmtMoney = (v) => formatCurrency(v);

const daysBetween = (a, b) => {
  if (!a || !b) return 0;
  const s = new Date(a), e = new Date(b);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  return Math.max(0, Math.round((e - s) / 86400000) + 1);
};

// Same math as backend LeaveService._days_for so the preview matches
// what gets stored.
const computeDays = (typeCode, start, end, halfDay) => {
  if (!start) return 0;
  if (typeCode === 'HALF_DAY' || halfDay) return 0.5;
  if (typeCode === 'SHORT') return 0;
  return daysBetween(start, end || start);
};

// Loss-of-Pay for `days` of the selected leave, mirroring the backend
// LeaveService so the previewed deduction matches what payroll actually
// applies. `balance.by_type` is keyed by quota bucket (typeMeta.bucket):
// unpaid pools (LWP) are always LOP, paid pools with no fixed quota
// (WFH / On-Duty / Comp-Off / Permission) never are, and paid quota
// pools spill to LOP once the year's remaining balance is exhausted.
const poolLopFor = (balance, typeMeta, days) => {
  if (!balance || !(days > 0)) return null;
  const pool = (balance.by_type || []).find(t => t.code === typeMeta.bucket);
  if (!pool) {
    const remaining = Number(balance.remaining || 0);
    return { lop: Math.max(0, days - remaining), remaining, hasPool: false };
  }
  const entitled = Number(pool.entitled || 0);
  const remaining = Number(pool.remaining || 0);
  let lop;
  if (!pool.is_paid) lop = days;            // unpaid (LWP)
  else if (entitled <= 0) lop = 0;          // paid, no fixed quota
  else lop = Math.max(0, days - remaining); // paid quota pool: spillover
  return { lop, remaining, entitled, isPaid: pool.is_paid, hasPool: true };
};

// Encodes the rich UI metadata into the `reason` field so nothing is
// lost on submit. Format is human-readable AND machine-parseable.
const buildReasonPayload = (form) => {
  const typeMeta = LEAVE_TYPES.find(t => t.code === form.leave_type);
  const parts = [`[${typeMeta?.label || form.leave_type}]`];
  if (form.reason_category) parts.push(`(${form.reason_category})`);
  parts.push(form.reason || '—');
  const extras = [];
  if (form.start_session && form.start_session !== 'FULL') extras.push(`Start session: ${form.start_session === 'FIRST' ? '1st half' : '2nd half'}`);
  if (form.end_session && form.end_session !== 'FULL')   extras.push(`End session: ${form.end_session === 'FIRST' ? '1st half' : '2nd half'}`);
  if (form.exclude_weekly_off) extras.push('Excludes weekly off');
  if (form.exclude_holidays)   extras.push('Excludes holidays');
  if (form.is_emergency) extras.push('⚠ EMERGENCY LEAVE');
  if (form.contact_number) extras.push(`Contact during leave: ${form.contact_number}`);
  if (form.contact_address) extras.push(`Address: ${form.contact_address}`);
  if (form.shift_replacement_required) extras.push('Shift replacement required');
  if (form.backup_staff_name) extras.push(`Backup: ${form.backup_staff_name}`);
  if (form.notify_supervisor) extras.push('Supervisor notified');
  if (form.handover_required) extras.push('Handover required');
  if (form.handover_staff_name) extras.push(`Handover to: ${form.handover_staff_name}`);
  if (form.handover_notes) extras.push(`Handover notes: ${form.handover_notes}`);
  if (form.client_impact) extras.push(`Client/site impact: ${form.client_impact}`);
  if (form.attachments?.length) extras.push(`Attachments: ${form.attachments.map(a => a.name).join(', ')}`);
  if (extras.length) parts.push(`\n— ${extras.join(' | ')}`);
  return parts.filter(Boolean).join(' ').trim();
};

// Pull the friendly leave-type label back out of `reason` for display
// in tables / drawers. Falls back to the backend code when no prefix.
const parseRichType = (reason, backendType) => {
  const m = String(reason || '').match(/^\[([^\]]+)\]/);
  if (m) return m[1];
  return { FULL_DAY: 'Full Day', HALF_DAY: 'Half Day', PERMISSION: 'Permission' }[backendType] || backendType;
};

const calcAge = (dob) => {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  return Math.floor(diff / (365.25 * 86400000));
};

/* ─────────────────────────────────────────────────────────────────────────
 * Root page
 * ─────────────────────────────────────────────────────────────────────── */

export default function LeaveApplicationPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('apply');
  const [drawerId, setDrawerId] = useState(null);

  // Source data — single fetch shared across tabs.
  const { data: staffList = [], isLoading: staffLoading } = useApiData('/api/hr/staff/');
  const { data: leaveRequests = [], isLoading: requestsLoading, refetch: refetchRequests } =
    useApiData('/api/hr/leave/');
  const { data: shifts = [] } = useApiData('/api/hr/shifts/');
  const { data: holidayDates = [] } = useApiData('/api/hr/holiday-dates/');
  // The logged-in user's OWN staff record, via the same self-service
  // endpoint the check-in page uses. This lets a regular employee — who
  // has the 'Leave' permission but NOT 'Staff' permission, so
  // /api/hr/staff/ comes back empty for them — still apply for themselves.
  // (Direct apiClient call: my_status returns a single object, which the
  // list-oriented useApiData hook would discard.)
  const [myStatus, setMyStatus] = useState(null);
  useEffect(() => {
    let cancelled = false;
    apiClient.get('/api/hr/attendance/my_status/')
      .then(r => { if (!cancelled) setMyStatus(r.data); })
      .catch(() => { if (!cancelled) setMyStatus(null); });
    return () => { cancelled = true; };
  }, []);
  const selfStaff = useMemo(() => {
    const s = myStatus?.staff;
    if (!s?.id) return null;
    return { id: s.id, staff_id: s.staff_id, full_name: s.name, name: s.name, __self: true };
  }, [myStatus]);

  // The "current employee" context. HR (who can see the Staff master) can
  // pick anyone; a self-service employee falls back to just themselves.
  const [selectedStaffId, setSelectedStaffId] = useState('');
  // Merge the logged-in user into the pickable list when the Staff master
  // isn't visible to them (or doesn't already include them), so the form
  // renders for self-service employees too.
  const effectiveStaffList = useMemo(() => {
    const list = staffList || [];
    if (!selfStaff || list.some(s => s.id === selfStaff.id)) return list;
    return [selfStaff, ...list];
  }, [staffList, selfStaff]);
  const selectedStaff = useMemo(
    () => (effectiveStaffList || []).find(s => s.id === selectedStaffId) || null,
    [effectiveStaffList, selectedStaffId],
  );

  // Live balance — refetched whenever staff changes.
  const [balance, setBalance] = useState(null);
  useEffect(() => {
    if (!selectedStaffId) { setBalance(null); return; }
    let cancelled = false;
    apiClient.get('/api/hr/leave/balance/', { params: { staff_id: selectedStaffId } })
      .then(r => { if (!cancelled) setBalance(r.data); })
      .catch(() => { if (!cancelled) setBalance(null); });
    return () => { cancelled = true; };
  }, [selectedStaffId]);

  // Default the selection: the logged-in employee themselves first (self-
  // service), else the first active staff (HR opening the page cold) so the
  // page never sits empty with no form.
  useEffect(() => {
    if (selectedStaffId) return;
    if (selfStaff) { setSelectedStaffId(selfStaff.id); return; }
    if (staffList?.length) {
      const first = staffList.find(s => s.is_active !== false) || staffList[0];
      if (first) setSelectedStaffId(first.id);
    }
  }, [staffList, selfStaff, selectedStaffId]);

  return (
    <MainLayout>
      <PageBanner
        onApply={() => setActiveTab('apply')}
        onBalance={() => setActiveTab('balance')}
        onHistory={() => setActiveTab('requests')}
        onExport={() => exportLeaveReport(leaveRequests, selectedStaff)}
      />

      <StaffPicker
        staffList={effectiveStaffList}
        selectedStaffId={selectedStaffId}
        onChange={setSelectedStaffId}
        loading={staffLoading}
      />

      {/* Neither an HR user (no Staff master visible) nor linked to a staff
          record → there's nobody to apply for. Say so plainly instead of
          leaving an empty form with no submit button. */}
      {myStatus && myStatus.linked === false && !(staffList || []).length && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            Your login isn't linked to a staff record, so there's no one to apply
            for here. Please ask HR to link your account to your employee profile.
          </span>
        </div>
      )}

      <EmployeeContextCard staff={selectedStaff} balance={balance} loading={staffLoading} />

      <BalanceSummaryCards
        balance={balance}
        leaveRequests={leaveRequests}
        staffId={selectedStaffId}
      />

      <TabStrip
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          { key: 'apply',    label: 'Apply Leave',      icon: Edit3 },
          { key: 'requests', label: 'My Requests',      icon: ClipboardList },
          { key: 'balance',  label: 'Leave Balance',    icon: Hash },
          { key: 'team',     label: 'Team Calendar',    icon: CalendarDays },
          { key: 'policy',   label: 'Policy Rules',     icon: ShieldCheck },
          { key: 'audit',    label: 'Approval History', icon: History },
        ]}
      />

      <div className="mt-4">
        {activeTab === 'apply' && (
          <ApplyLeaveTab
            staff={selectedStaff}
            staffList={effectiveStaffList}
            shifts={shifts}
            holidayDates={holidayDates}
            balance={balance}
            existingRequests={leaveRequests}
            onSubmitted={() => { refetchRequests(); setActiveTab('requests'); }}
          />
        )}
        {activeTab === 'requests' && (
          <MyRequestsTab
            requests={leaveRequests}
            staffList={staffList}
            staffId={selectedStaffId}
            loading={requestsLoading}
            onView={setDrawerId}
            onRefetch={refetchRequests}
            navigate={navigate}
          />
        )}
        {activeTab === 'balance' && (
          <BalanceLedgerTab
            requests={leaveRequests}
            staffId={selectedStaffId}
            balance={balance}
          />
        )}
        {activeTab === 'team' && (
          <TeamCalendarTab
            requests={leaveRequests}
            staffList={staffList}
            holidayDates={holidayDates}
          />
        )}
        {activeTab === 'policy' && (
          <PolicyRulesTab />
        )}
        {activeTab === 'audit' && (
          <ApprovalAuditTab requests={leaveRequests} staffList={staffList} />
        )}
      </div>

      <LeaveDetailDrawer
        requestId={drawerId}
        requests={leaveRequests}
        staffList={staffList}
        onClose={() => setDrawerId(null)}
        onRefetch={refetchRequests}
      />
    </MainLayout>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Page banner
 * ─────────────────────────────────────────────────────────────────────── */

function PageBanner({ onApply, onBalance, onHistory, onExport }) {
  return (
    <div className="mb-5 rounded-2xl border border-slate-200 bg-gradient-to-br from-white via-sky-50/30 to-indigo-50/40 px-4 sm:px-5 py-5 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">HR Module</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">Leave Application</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Apply for leave, track approval status, view leave balances, and manage leave requests across shifts,
            sites and departments.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={onApply}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700">
            <Edit3 size={15} /> Apply Leave
          </button>
          <button onClick={onBalance}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <Hash size={15} /> View Leave Balance
          </button>
          <button onClick={onHistory}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <ClipboardList size={15} /> My Leave History
          </button>
          <button onClick={onExport}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <Upload size={15} /> Export Report
          </button>
        </div>
      </div>
    </div>
  );
}

function exportLeaveReport(requests, staff) {
  const rows = (requests || []).filter(r => !staff || r.staff === staff.id || r.staff_id === staff.id);
  const header = ['Request ID', 'Staff', 'Type', 'From', 'To', 'Days', 'Status', 'LOP Days', 'Reason'];
  const body = rows.map(r => [
    r.id?.slice(0, 8) || '',
    r.staff_name || r.staff_id || '',
    parseRichType(r.reason, r.leave_type),
    r.start_date || '',
    r.end_date || r.start_date || '',
    r.days_requested ?? '',
    r.status || '',
    r.lop_days ?? '0',
    String(r.reason || '').replace(/[\r\n]+/g, ' '),
  ]);
  const csv = [header, ...body].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `leave-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success('Leave report downloaded.');
}

/* ─────────────────────────────────────────────────────────────────────────
 * Staff picker (acts as the "logged-in user" toggle)
 * ─────────────────────────────────────────────────────────────────────── */

function StaffPicker({ staffList, selectedStaffId, onChange, loading }) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (staffList || []).filter(s => {
      if (s.is_active === false) return false;
      if (!q) return true;
      const hay = [s.staff_id, s.first_name, s.last_name, s.full_name, s.department, s.designation]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [staffList, search]);

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-600">
        <UserIcon size={15} /> Acting as:
      </div>
      <div className="relative flex-1">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search employee by ID, name, department…"
          className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
        />
      </div>
      <CustomSelect
        value={selectedStaffId || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 sm:min-w-[260px]"
      >
        <option value="">— Select employee —</option>
        {filtered.map(s => {
          const name = s.full_name || [s.first_name, s.last_name].filter(Boolean).join(' ').trim() || '(unnamed)';
          return <option key={s.id} value={s.id}>{s.staff_id} — {name}</option>;
        })}
      </CustomSelect>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Employee context card — the "this is me" header
 * ─────────────────────────────────────────────────────────────────────── */

function EmployeeContextCard({ staff, balance, loading }) {
  if (loading && !staff) {
    return (
      <div className="mb-4 animate-pulse rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex gap-4">
          <div className="h-20 w-20 rounded-full bg-slate-200" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-48 rounded bg-slate-200" />
            <div className="h-3 w-64 rounded bg-slate-100" />
            <div className="h-3 w-40 rounded bg-slate-100" />
          </div>
        </div>
      </div>
    );
  }
  if (!staff) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-4 sm:py-5 text-sm text-slate-500">
        <Info size={18} className="text-slate-400" />
        Pick an employee above to load their leave dashboard, balance, and application form.
      </div>
    );
  }

  const name = staff.full_name || [staff.first_name, staff.last_name].filter(Boolean).join(' ').trim() || '—';
  const initials = (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const tenure = staff.employment_start_date
    ? `${Math.floor((Date.now() - new Date(staff.employment_start_date).getTime()) / (365.25 * 86400000))}y ${Math.floor(((Date.now() - new Date(staff.employment_start_date).getTime()) % (365.25 * 86400000)) / (30.44 * 86400000))}m`
    : '—';

  return (
    <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-2xl font-bold text-white shadow-inner">
            {initials}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-slate-900">{name}</h2>
              {staff.is_active === false
                ? <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-600">Inactive</span>
                : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">Active</span>}
            </div>
            <p className="text-sm text-slate-500">
              <span className="font-mono">{staff.staff_id}</span> · {staff.designation || 'Designation —'} · {staff.department || 'Department —'}
            </p>
            <p className="mt-0.5 text-xs text-slate-400">
              Joined {fmtDate(staff.employment_start_date)} · {tenure} tenure · {staff.staff_type_display || staff.staff_type || '—'}
            </p>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4 lg:border-l lg:border-slate-200 lg:pl-6">
          <ContextField icon={Building2} label="Work location" value={staff.location_name || '—'} />
          <ContextField icon={Briefcase} label="Department"    value={staff.department || '—'} />
          <ContextField icon={Star}      label="Designation"   value={staff.designation || '—'} />
          <ContextField icon={Clock}     label="Current shift" value={staff.shift_name || 'Unassigned'} />
          <ContextField icon={UserIcon}  label="Reporting to"  value={staff.hr_owner_name || staff.reporting_manager_name || 'Not set'} />
          <ContextField icon={Phone}     label="Contact"       value={staff.contact_number || '—'} />
          <ContextField icon={CalendarIcon} label="Joining date" value={fmtDate(staff.employment_start_date)} />
          <ContextField icon={ShieldCheck} label="Employment"  value={staff.employment_status_display || staff.employment_status || '—'} />
        </div>
      </div>

      {balance && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600">
          <span className="font-semibold uppercase tracking-wider text-slate-500">FY {balance.year}</span>
          <span>•</span>
          <span>Annual quota <strong className="text-slate-900">{balance.quota}d</strong></span>
          <span>•</span>
          <span>Used <strong className="text-amber-600">{balance.used}d</strong></span>
          <span>•</span>
          <span>Remaining <strong className="text-emerald-600">{balance.remaining}d</strong></span>
          {Number(balance.salary_per_day || 0) > 0 && (
            <>
              <span>•</span>
              <span>Salary/day <strong className="text-slate-900">{fmtMoney(balance.salary_per_day)}</strong></span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ContextField({ icon: Icon, label, value }) {
  return (
    <div className="flex items-start gap-2">
      <Icon size={14} className="mt-0.5 flex-shrink-0 text-slate-400" />
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
        <p className="truncate text-sm font-medium text-slate-800" title={value}>{value}</p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Balance summary cards (8 tiles)
 * ─────────────────────────────────────────────────────────────────────── */

function BalanceSummaryCards({ balance, leaveRequests, staffId }) {
  // Derive bucket-wise usage from real LeaveRequest rows. Until the
  // backend has a Policy/Bucket model, we infer bucket from the rich
  // type prefix in `reason` (defaults to CASUAL when the prefix is
  // missing — matches legacy data).
  const buckets = useMemo(() => {
    const out = { CASUAL: 0, SICK: 0, EARNED: 0, COMPOFF: 0, UNPAID: 0, PENDING_REQ: 0, APPROVED_MONTH: 0, UPCOMING: 0 };
    const today = new Date().toISOString().slice(0, 10);
    const monthKey = today.slice(0, 7);
    (leaveRequests || []).filter(r => !staffId || r.staff === staffId || r.staff_id === staffId).forEach(r => {
      const m = String(r.reason || '').match(/^\[([^\]]+)\]/);
      const label = (m?.[1] || '').toLowerCase();
      let bucket = 'CASUAL';
      if (label.includes('sick')) bucket = 'SICK';
      else if (label.includes('earned') || label.includes('paid')) bucket = 'EARNED';
      else if (label.includes('comp')) bucket = 'COMPOFF';
      else if (label.includes('unpaid') || label.includes('lwp')) bucket = 'UNPAID';
      const days = Number(r.days_requested || 0);
      if (r.status === 'APPROVED') {
        out[bucket] += days;
        if ((r.approval_date || r.created_at || '').slice(0, 7) === monthKey) out.APPROVED_MONTH += 1;
        const end = r.end_date || r.start_date;
        if (r.start_date && r.start_date > today) out.UPCOMING += 1;
        if (bucket === 'UNPAID' || Number(r.lop_days || 0) > 0) {
          /* unpaid counter already increments via bucket UNPAID */
        }
      }
      if (r.status === 'PENDING') out.PENDING_REQ += 1;
    });
    return out;
  }, [leaveRequests, staffId]);

  const remaining = Number(balance?.remaining ?? 0);

  const cards = [
    { key: 'CASUAL',  label: 'Casual Leave',     icon: CalendarIcon, used: buckets.CASUAL,  total: 12, available: Math.max(0, 12 - buckets.CASUAL),  tone: 'sky' },
    { key: 'SICK',    label: 'Sick Leave',       icon: Activity,     used: buckets.SICK,    total: 12, available: Math.max(0, 12 - buckets.SICK),    tone: 'rose' },
    { key: 'EARNED',  label: 'Earned / Paid',    icon: TrendingUp,   used: buckets.EARNED,  total: 18, available: Math.max(0, 18 - buckets.EARNED),  tone: 'emerald' },
    { key: 'COMPOFF', label: 'Comp-Off',         icon: BadgeCheck,   used: buckets.COMPOFF, total: '—', available: '—', tone: 'violet' },
    { key: 'UNPAID',  label: 'Unpaid Taken',     icon: AlertTriangle,used: buckets.UNPAID,  total: '∞', available: '—', tone: 'slate' },
    { key: 'PENDING', label: 'Pending Requests', icon: Hourglass,    used: buckets.PENDING_REQ, total: '', available: buckets.PENDING_REQ, tone: 'amber' },
    { key: 'APPRMTH', label: 'Approved (Month)', icon: CheckCircle,  used: '', total: '', available: buckets.APPROVED_MONTH, tone: 'teal' },
    { key: 'UPCOMING',label: 'Upcoming Leaves',  icon: CalendarDays, used: '', total: '', available: buckets.UPCOMING, tone: 'indigo' },
  ];

  return (
    <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
      {cards.map(c => <BalanceCard key={c.key} {...c} />)}
    </div>
  );
}

const TONES = {
  sky:     'from-sky-50 to-white border-sky-100 text-sky-700',
  rose:    'from-rose-50 to-white border-rose-100 text-rose-700',
  emerald: 'from-emerald-50 to-white border-emerald-100 text-emerald-700',
  violet:  'from-violet-50 to-white border-violet-100 text-violet-700',
  slate:   'from-slate-50 to-white border-slate-200 text-slate-700',
  amber:   'from-amber-50 to-white border-amber-100 text-amber-700',
  teal:    'from-teal-50 to-white border-teal-100 text-teal-700',
  indigo:  'from-indigo-50 to-white border-indigo-100 text-indigo-700',
  orange:  'from-orange-50 to-white border-orange-100 text-orange-700',
  cyan:    'from-cyan-50 to-white border-cyan-100 text-cyan-700',
  pink:    'from-pink-50 to-white border-pink-100 text-pink-700',
  zinc:    'from-zinc-50 to-white border-zinc-200 text-zinc-700',
};

// Tailwind JIT only picks up class names it can see as literal strings,
// so dynamic interpolation like `bg-${color}-100` would silently produce
// no styles. The maps below pre-build every variant we use so the JIT
// sees them and the leave-type colour theming actually renders.
const TYPE_DOT = {
  sky: 'bg-sky-500',     rose: 'bg-rose-500',       emerald: 'bg-emerald-500',
  violet: 'bg-violet-500', slate: 'bg-slate-500',   amber: 'bg-amber-500',
  teal: 'bg-teal-500',   indigo: 'bg-indigo-500',   orange: 'bg-orange-500',
  cyan: 'bg-cyan-500',   pink: 'bg-pink-500',       zinc: 'bg-zinc-500',
};
const TYPE_CHIP = {
  sky:     'bg-sky-100 text-sky-800',
  rose:    'bg-rose-100 text-rose-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  violet:  'bg-violet-100 text-violet-800',
  slate:   'bg-slate-100 text-slate-800',
  amber:   'bg-amber-100 text-amber-800',
  teal:    'bg-teal-100 text-teal-800',
  indigo:  'bg-indigo-100 text-indigo-800',
  orange:  'bg-orange-100 text-orange-800',
  cyan:    'bg-cyan-100 text-cyan-800',
  pink:    'bg-pink-100 text-pink-800',
  zinc:    'bg-zinc-100 text-zinc-800',
};

function BalanceCard({ label, icon: Icon, used, total, available, tone }) {
  const showProgress = Number.isFinite(Number(total)) && Number(total) > 0;
  const pct = showProgress ? Math.min(100, Math.round((Number(used) / Number(total)) * 100)) : 0;
  return (
    <div className={`rounded-xl border bg-gradient-to-br p-3 shadow-sm ${TONES[tone] || TONES.slate}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
        <Icon size={14} className="opacity-70" />
      </div>
      <p className="mt-2 text-2xl font-bold text-slate-900">
        {available === '' || available == null ? (used ?? 0) : available}
        {showProgress && <span className="ml-1 text-xs font-normal text-slate-500">/ {total}</span>}
      </p>
      {(used !== '' && used != null && showProgress) && (
        <p className="mt-0.5 text-[11px] text-slate-500">Used {used}{total ? ` of ${total}` : ''}</p>
      )}
      {showProgress && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/70">
          <div className={`h-full rounded-full ${tone === 'rose' ? 'bg-rose-400' : tone === 'amber' ? 'bg-amber-400' : tone === 'slate' ? 'bg-slate-400' : 'bg-current'}`}
            style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Tab strip
 * ─────────────────────────────────────────────────────────────────────── */

function TabStrip({ tabs, active, onChange }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
      {tabs.map(t => {
        const Icon = t.icon;
        const on = active === t.key;
        return (
          <button key={t.key} onClick={() => onChange(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              on ? 'bg-indigo-600 text-white shadow' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}>
            {Icon && <Icon size={14} />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
 *  TAB 1 — APPLY LEAVE
 * ═════════════════════════════════════════════════════════════════════════ */

const EMPTY_FORM = {
  leave_type: 'CASUAL',
  reason_category: '',
  start_date: '',
  end_date: '',
  start_session: 'FULL',
  end_session: 'FULL',
  half_day: false,
  exclude_weekly_off: true,
  exclude_holidays: true,
  reason: '',
  is_emergency: false,
  contact_number: '',
  contact_address: '',
  attachments: [],

  shift_replacement_required: false,
  backup_staff_id: '',
  backup_staff_name: '',
  notify_supervisor: true,

  handover_required: false,
  handover_staff_id: '',
  handover_staff_name: '',
  handover_notes: '',
  client_impact: '',

  declare_accurate: false,
  declare_consequences: false,
};

function ApplyLeaveTab({ staff, staffList, shifts, holidayDates, balance, existingRequests, onSubmitted }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [drafting, setDrafting] = useState(false);

  // Whenever the active staff changes, reset the form so we never
  // accidentally apply for the wrong person.
  useEffect(() => { setForm(EMPTY_FORM); }, [staff?.id]);

  // Pre-fill contact from the staff record when first picked.
  useEffect(() => {
    if (!staff) return;
    setForm(p => ({
      ...p,
      contact_number: p.contact_number || staff.contact_number || '',
    }));
  }, [staff?.id]);

  const typeMeta = LEAVE_TYPES.find(t => t.code === form.leave_type) || LEAVE_TYPES[0];
  const days = computeDays(form.leave_type, form.start_date, form.end_date, form.half_day);

  // Live validation — surfaces every failing rule the moment it kicks
  // in instead of waiting for the submit click.
  const validations = useMemo(
    () => computeValidations({ form, staff, balance, existingRequests, typeMeta, days, holidayDates }),
    [form, staff, balance, existingRequests, typeMeta, days, holidayDates],
  );
  const blockers = validations.filter(v => v.level === 'error');
  const warnings = validations.filter(v => v.level === 'warn');
  const okays    = validations.filter(v => v.level === 'ok');

  // LOP preview — same math as backend LeaveService so the user sees
  // the salary impact before the request is filed.
  const preview = (() => {
    const pl = poolLopFor(balance, typeMeta, days);
    if (!pl) return null;
    const rate = Number(balance.salary_per_day || 0);
    const paid = Math.max(0, days - pl.lop);
    return { days, paid, lop: pl.lop, rate, deduction: pl.lop * rate };
  })();

  const handle = (patch) => setForm(p => ({ ...p, ...patch }));

  const submit = async (asDraft) => {
    if (!staff) { toast.error('Pick an employee first.'); return; }
    if (!asDraft && blockers.length > 0) { toast.error(blockers[0].message); return; }
    const payload = {
      staff_id: staff.id,
      leave_type: typeMeta.backend,
      // The quota pool this leave is drawn against. The backend stores it
      // on the row and computes per-type balance + LOP from it (it used to
      // be parsed out of the reason text client-side).
      leave_category: typeMeta.bucket,
      start_date: form.start_date,
      end_date: form.end_date || form.start_date,
      reason: buildReasonPayload(form),
    };
    asDraft ? setDrafting(true) : setSubmitting(true);
    try {
      await apiClient.post('/api/hr/leave/', cleanFormData(payload));
      toast.success(asDraft ? 'Saved as draft (stored as pending).' : 'Leave request submitted for approval.');
      setForm(EMPTY_FORM);
      onSubmitted?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to submit leave request.');
    } finally {
      setSubmitting(false); setDrafting(false);
    }
  };

  if (!staff) {
    return (
      <EmptyState
        icon={UserIcon}
        title="Pick an employee to start a leave application"
        hint="Use the search box above. The form, validations, balance, and roster impact all update for the selected employee."
      />
    );
  }

  const submitDisabled = blockers.length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-6">
      <FormSection
        letter="1" title="Leave Type & Duration"
        subtitle="What kind of leave, the dates, and whether it's a full or half day."
        icon={CalendarIcon}>
        <SectionA form={form} onChange={handle} typeMeta={typeMeta} days={days} />
      </FormSection>

      <FormSection
        letter="2" title="Reason & Supporting Details"
        subtitle="Help the approver understand why. Attach proof when policy requires it."
        icon={FileText}>
        <SectionC form={form} onChange={handle} typeMeta={typeMeta} />
      </FormSection>

      {/* Compact impact + validation summary — replaces the old sticky side
          panel and fixed footer (which left a tall empty area below the form). */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-md bg-slate-100 px-2 py-1 font-semibold text-slate-700">
            {days || 0} day{(days || 0) === 1 ? '' : 's'}
          </span>
          {preview && preview.lop > 0 ? (
            <span className="rounded-md bg-red-100 px-2 py-1 font-semibold text-red-700">
              {preview.lop} LOP{preview.deduction ? ` · ${fmtMoney(preview.deduction)} deduction` : ''}
            </span>
          ) : days > 0 ? (
            <span className="rounded-md bg-emerald-100 px-2 py-1 font-semibold text-emerald-700">Fully paid</span>
          ) : null}
        </div>
        {blockers.length > 0 && (
          <ul className="space-y-1">
            {blockers.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-red-700">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {b.message}
              </li>
            ))}
          </ul>
        )}
        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-amber-700">
                <Info size={13} className="mt-0.5 shrink-0" /> {w.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Inline actions — no fixed footer, so nothing floats and there's no
          reserved empty space under the form. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setForm(EMPTY_FORM)}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={() => submit(true)}
          disabled={drafting || submitting}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {drafting ? 'Saving…' : 'Save Draft'}
        </button>
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={submitDisabled || submitting || drafting}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : 'Submit for Approval'}
        </button>
      </div>
    </div>
  );
}

/* ─── Form section shell ─── */

function FormSection({ letter, title, subtitle, icon: Icon, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-sm font-bold text-indigo-700">
          {letter}
        </div>
        <div className="flex-1">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            {Icon && <Icon size={14} className="text-indigo-500" />}
            {title}
          </h3>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

/* ─── A. Leave Type & Duration ─── */

function SectionA({ form, onChange, typeMeta, days }) {
  return (
    <>
      <div>
        <Label required>Leave Type</Label>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {LEAVE_TYPES.map(t => {
            const on = form.leave_type === t.code;
            return (
              <button key={t.code} type="button"
                onClick={() => onChange({ leave_type: t.code, half_day: t.code === 'HALF_DAY' })}
                className={`group rounded-lg border px-3 py-2 text-left text-xs transition ${
                  on
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-900 shadow-sm ring-2 ring-indigo-200'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/40'
                }`}>
                <span className={`mb-1 inline-block h-2 w-2 rounded-full ${TYPE_DOT[t.color] || TYPE_DOT.slate}`} />
                <div className="font-semibold">{t.label}</div>
                <div className="mt-0.5 text-[10px] text-slate-500 group-hover:text-slate-600">{t.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="From Date" required>
          <CustomDatePicker value={form.start_date}
            onChange={(e) => onChange({ start_date: e.target.value })}
            className="input" />
        </Field>
        <Field label="To Date">
          <CustomDatePicker value={form.end_date} min={form.start_date}
            onChange={(e) => onChange({ end_date: e.target.value })}
            disabled={typeMeta.code === 'HALF_DAY' || typeMeta.code === 'SHORT' || form.half_day}
            className="input disabled:bg-slate-50 disabled:text-slate-400" />
        </Field>
        <Field label="Total Days" hint="Auto-calculated">
          <div className="input flex items-center justify-between bg-slate-50 font-semibold text-slate-800">
            {days || 0} <span className="text-xs font-normal text-slate-500">{typeMeta.code === 'SHORT' ? 'hours-based' : 'day(s)'}</span>
          </div>
        </Field>
        <Field label="Half-Day Leave">
          <label className="input flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={form.half_day}
              onChange={(e) => onChange({ half_day: e.target.checked, end_date: e.target.checked ? form.start_date : form.end_date })}
              disabled={typeMeta.code === 'SHORT'}
              className="h-4 w-4 rounded text-indigo-600" />
            <span className="text-sm">Apply as half-day</span>
          </label>
        </Field>
      </div>

      {(typeMeta.code === 'HALF_DAY' || form.half_day) && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Start-date session">
            <CustomSelect value={form.start_session} onChange={(e) => onChange({ start_session: e.target.value })} className="input">
              {SESSION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </Field>
          <Field label="End-date session">
            <CustomSelect value={form.end_session} onChange={(e) => onChange({ end_session: e.target.value })} className="input">
              {SESSION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </Field>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-4 rounded-lg bg-slate-50 px-4 py-3 text-xs">
        <Toggle label="Exclude weekly off in count"
          checked={form.exclude_weekly_off}
          onChange={(v) => onChange({ exclude_weekly_off: v })} />
        <Toggle label="Exclude holidays in count"
          checked={form.exclude_holidays}
          onChange={(v) => onChange({ exclude_holidays: v })} />
      </div>
    </>
  );
}

/* ─── B. Shift / Roster Impact ─── */

function SectionB({ form, onChange, staff, staffList }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Currently assigned shift">
        <div className="input flex items-center gap-2 bg-slate-50 font-medium text-slate-800">
          <Clock size={14} className="text-slate-400" />
          {staff?.shift_name || 'Unassigned'}
        </div>
      </Field>
      <Field label="Dates overlap roster?">
        <div className="input flex items-center bg-slate-50 text-slate-700">
          {form.start_date
            ? <span><strong className="text-amber-600">Yes</strong> — {fmtDate(form.start_date)}{form.end_date && form.end_date !== form.start_date ? ` → ${fmtDate(form.end_date)}` : ''}</span>
            : <span className="text-slate-400">Pick dates first</span>}
        </div>
      </Field>

      <Field label="Shift replacement required?">
        <Toggle label="Yes — assign a backup for my shift"
          checked={form.shift_replacement_required}
          onChange={(v) => onChange({ shift_replacement_required: v })} />
      </Field>

      <Field label="Notify shift supervisor on apply">
        <Toggle label="Send notification to supervisor"
          checked={form.notify_supervisor}
          onChange={(v) => onChange({ notify_supervisor: v })} />
      </Field>

      <Field label="Backup / Substitute employee" hint="Pick another active staff for this shift">
        <StaffPickerField
          staffList={staffList}
          excludeId={staff?.id}
          value={form.backup_staff_id}
          onChange={(id, label) => onChange({ backup_staff_id: id, backup_staff_name: label })}
          placeholder="Select backup employee"
          disabled={!form.shift_replacement_required}
        />
      </Field>

      <Field label="Roster impact warning">
        <div className={`input flex items-start gap-2 text-xs ${form.shift_replacement_required && !form.backup_staff_id ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-600'}`}>
          {form.shift_replacement_required && !form.backup_staff_id
            ? <><AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /><span>Backup not assigned. Your shift will be uncovered.</span></>
            : <><Info size={14} className="mt-0.5 flex-shrink-0" /><span>Roster will be auto-rebalanced when leave is approved.</span></>}
        </div>
      </Field>
    </div>
  );
}

/* ─── C. Reason & Supporting Details ─── */

function SectionC({ form, onChange, typeMeta }) {
  const fileInputRef = useRef(null);
  const addFiles = (files) => {
    const added = Array.from(files).map(f => ({ name: f.name, size: f.size, type: f.type, addedAt: Date.now() }));
    onChange({ attachments: [...(form.attachments || []), ...added] });
  };
  const removeFile = (idx) => {
    const next = [...(form.attachments || [])];
    next.splice(idx, 1);
    onChange({ attachments: next });
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Reason category" required>
          <CustomSelect value={form.reason_category} onChange={(e) => onChange({ reason_category: e.target.value })} className="input">
            <option value="">— Select —</option>
            {REASON_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </CustomSelect>
        </Field>
        <Field label="Emergency leave?">
          <Toggle label="Yes — bypass minimum notice period"
            checked={form.is_emergency}
            onChange={(v) => onChange({ is_emergency: v })} />
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Detailed reason" required hint="Be specific so the approver doesn't need to follow up.">
          <textarea rows={3} value={form.reason}
            onChange={(e) => onChange({ reason: e.target.value })}
            placeholder="e.g. Attending elder sister's wedding ceremony on 18-May at Coimbatore. Will be reachable on mobile throughout."
            className="input" />
        </Field>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Contact number during leave">
          <div className="input flex items-center gap-2">
            <Phone size={14} className="text-slate-400" />
            <input value={form.contact_number}
              onChange={(e) => onChange({ contact_number: e.target.value })}
              placeholder="+91 90000 00000"
              className="w-full bg-transparent outline-none" />
          </div>
        </Field>
        <Field label="Address / location during leave">
          <div className="input flex items-center gap-2">
            <MapPin size={14} className="text-slate-400" />
            <input value={form.contact_address}
              onChange={(e) => onChange({ contact_address: e.target.value })}
              placeholder="City / village — where you'll be"
              className="w-full bg-transparent outline-none" />
          </div>
        </Field>
      </div>

      <div className="mt-4">
        <Label>
          Attachments {typeMeta.attach && <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">REQUIRED</span>}
        </Label>
        <div className="mt-2 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 p-4 text-center hover:border-indigo-400"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
          <Paperclip size={20} className="mx-auto text-slate-400" />
          <p className="mt-2 text-xs text-slate-600">
            Drag & drop or{' '}
            <button type="button" onClick={() => fileInputRef.current?.click()}
              className="font-semibold text-indigo-600 hover:underline">browse</button>{' '}
            (medical certificate, approval proof, supporting document — PDF, JPG, PNG up to 5 MB)
          </p>
          <input ref={fileInputRef} type="file" multiple hidden
            accept="application/pdf,image/*"
            onChange={(e) => addFiles(e.target.files)} />
        </div>
        {form.attachments?.length > 0 && (
          <ul className="mt-2 space-y-1">
            {form.attachments.map((f, i) => (
              <li key={i} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs">
                <span className="flex items-center gap-2 text-slate-700">
                  <FileText size={13} className="text-slate-400" />
                  <span className="truncate">{f.name}</span>
                  <span className="text-slate-400">· {(f.size / 1024).toFixed(0)} KB</span>
                </span>
                <button type="button" onClick={() => removeFile(i)}
                  className="text-slate-400 hover:text-red-600"><XIcon size={13} /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/* ─── D. Approval Information ─── */

function SectionD({ form, staff, validations }) {
  const steps = [
    { key: 'employee',   label: 'Employee Submits',     by: staff?.full_name || '—',                  done: true,  icon: UserIcon },
    { key: 'supervisor', label: 'Supervisor Review',    by: 'Shift Supervisor',                       done: false, icon: ShieldCheck },
    { key: 'manager',    label: 'Manager Approval',     by: staff?.hr_owner_name || 'Reporting Mgr',  done: false, icon: BadgeCheck },
    { key: 'hr',         label: 'HR Records Leave',     by: 'HR Coordinator',                         done: false, icon: ClipboardList },
  ];
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Reporting manager">
          <div className="input bg-slate-50">{staff?.hr_owner_name || staff?.reporting_manager_name || 'Not set'}</div>
        </Field>
        <Field label="Shift supervisor">
          <div className="input bg-slate-50">{staff?.shift_supervisor_name || 'Auto-from shift'}</div>
        </Field>
        <Field label="HR reviewer">
          <div className="input bg-slate-50">HR Coordinator</div>
        </Field>
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Approval Workflow</p>
        <ol className="flex flex-wrap items-center gap-2">
          {steps.map((s, idx) => {
            const Icon = s.icon;
            return (
              <li key={s.key} className="flex items-center gap-2">
                <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${s.done ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-600'}`}>
                  <Icon size={14} />
                  <div>
                    <div className="font-semibold leading-tight">{s.label}</div>
                    <div className="text-[10px] opacity-70">{s.by}</div>
                  </div>
                </div>
                {idx < steps.length - 1 && <ChevronRight size={14} className="text-slate-300" />}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Auto-Validation</p>
        <ul className="space-y-1.5">
          {validations.length === 0 && (
            <li className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              Fill the form above to run validations.
            </li>
          )}
          {validations.map((v, i) => (
            <ValidationRow key={i} {...v} />
          ))}
        </ul>
      </div>
    </>
  );
}

function ValidationRow({ level, message }) {
  const cfg = {
    error: { bg: 'border-red-200 bg-red-50 text-red-800',         icon: AlertTriangle },
    warn:  { bg: 'border-amber-200 bg-amber-50 text-amber-800',   icon: AlertTriangle },
    ok:    { bg: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: CheckCircle },
    info:  { bg: 'border-blue-200 bg-blue-50 text-blue-800',       icon: Info },
  }[level] || { bg: 'border-slate-200 bg-slate-50 text-slate-700', icon: Info };
  const Icon = cfg.icon;
  return (
    <li className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${cfg.bg}`}>
      <Icon size={14} className="mt-0.5 flex-shrink-0" />
      <span>{message}</span>
    </li>
  );
}

/* ─── E. Handover ─── */

function SectionE({ form, onChange, staffList, staff }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Work handover required?">
        <Toggle label="Yes — I have open tasks to hand off"
          checked={form.handover_required}
          onChange={(v) => onChange({ handover_required: v })} />
      </Field>
      <Field label="Handover to">
        <StaffPickerField
          staffList={staffList}
          excludeId={staff?.id}
          value={form.handover_staff_id}
          onChange={(id, label) => onChange({ handover_staff_id: id, handover_staff_name: label })}
          placeholder="Select colleague"
          disabled={!form.handover_required}
        />
      </Field>
      <Field label="Pending task summary" className="sm:col-span-2">
        <textarea rows={2} value={form.handover_notes}
          onChange={(e) => onChange({ handover_notes: e.target.value })}
          disabled={!form.handover_required}
          placeholder="List open tasks, deadlines, ticket numbers, files / folders…"
          className="input disabled:bg-slate-50 disabled:text-slate-400" />
      </Field>
      <Field label="Client / project / site impact note" className="sm:col-span-2">
        <input value={form.client_impact}
          onChange={(e) => onChange({ client_impact: e.target.value })}
          placeholder="e.g. Site visit at Plant-3 on 17-May — reassigned to Karthik"
          className="input" />
      </Field>
    </div>
  );
}

/* ─── F. Declaration ─── */

function SectionF({ form, onChange }) {
  return (
    <div className="space-y-3 rounded-lg bg-slate-50 p-4 text-sm">
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" checked={form.declare_accurate}
          onChange={(e) => onChange({ declare_accurate: e.target.checked })}
          className="mt-0.5 h-4 w-4 rounded text-indigo-600" />
        <span className="text-slate-700">I confirm that the information provided in this leave application is accurate and complete to the best of my knowledge.</span>
      </label>
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" checked={form.declare_consequences}
          onChange={(e) => onChange({ declare_consequences: e.target.checked })}
          className="mt-0.5 h-4 w-4 rounded text-indigo-600" />
        <span className="text-slate-700">I understand that providing false information or unauthorised absence may result in disciplinary action as per company policy.</span>
      </label>
    </div>
  );
}

/* ─── Live preview / sticky right panel ─── */

function LivePreviewPanel({ form, staff, typeMeta, days, balance, preview, blockers, warnings, okays }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Live Summary</p>

      <div className="mt-3 space-y-2 text-sm">
        <PreviewRow label="Employee" value={staff?.full_name || '—'} />
        <PreviewRow label="Type" value={
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold ${TYPE_CHIP[typeMeta.color] || TYPE_CHIP.slate}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${TYPE_DOT[typeMeta.color] || TYPE_DOT.slate}`} /> {typeMeta.label}
          </span>
        } />
        <PreviewRow label="Period" value={form.start_date ? `${fmtDate(form.start_date)} → ${fmtDate(form.end_date || form.start_date)}` : '—'} />
        <PreviewRow label="Days" value={<strong className="text-slate-900">{days || 0}</strong>} />
        {form.is_emergency && (
          <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">
            ⚠ Marked as Emergency Leave
          </div>
        )}
      </div>

      {preview && (
        <div className={`mt-4 rounded-lg border p-3 text-xs ${preview.lop > 0 ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
          <div className="flex items-center gap-2 font-semibold">
            {preview.lop > 0
              ? <><AlertTriangle size={14} /> Salary impact</>
              : <><CheckCircle size={14} /> Fully covered</>}
          </div>
          <ul className="mt-1.5 space-y-0.5">
            <li><strong>{preview.paid}</strong> day(s) within annual quota.</li>
            {preview.lop > 0 && (
              <li>
                <strong>{preview.lop}</strong> day(s) → <strong>Loss of Pay</strong>
                {preview.rate > 0 && <>. Deduction: <strong>{fmtMoney(preview.deduction)}</strong></>}
              </li>
            )}
          </ul>
        </div>
      )}

      {balance && (
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <MiniTile label="Quota"     value={`${balance.quota}d`} tone="slate" />
          <MiniTile label="Used"      value={`${balance.used}d`}  tone="amber" />
          <MiniTile label="Remaining" value={`${balance.remaining}d`} tone="emerald" />
        </div>
      )}

      <div className="mt-4 space-y-1.5">
        {blockers.length > 0 && (
          <p className="text-[10px] font-semibold uppercase tracking-wider text-red-700">
            {blockers.length} blocker{blockers.length === 1 ? '' : 's'}
          </p>
        )}
        {warnings.length > 0 && (
          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">
            {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </p>
        )}
        {blockers.length === 0 && warnings.length === 0 && okays.length > 0 && (
          <p className="flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
            <CheckCircle size={12} /> Ready to submit
          </p>
        )}
      </div>
    </div>
  );
}

function PreviewRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs uppercase tracking-wider text-slate-400">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function MiniTile({ label, value, tone }) {
  const t = TONES[tone] || TONES.slate;
  return (
    <div className={`rounded-lg border bg-gradient-to-br p-2 ${t}`}>
      <p className="text-[10px] font-semibold uppercase opacity-70">{label}</p>
      <p className="text-base font-bold text-slate-900">{value}</p>
    </div>
  );
}

/** Page-bottom action bar — fixed to the viewport so Submit / Save Draft /
 *  Cancel are always reachable regardless of how far the user has scrolled.
 *  Carries a compact summary chip (days + LOP + blocker count) so the
 *  user has just-enough context without needing to scroll back up. */
function PageActionBar({ drafting, submitting, disabled, blockers, warnings, days, preview, declarationOk, onSubmit, onDraft, onCancel }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_12px_-6px_rgba(0,0,0,0.08)] backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
        {/* compact status chips */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-md bg-slate-100 px-2 py-1 font-semibold text-slate-700">
            {days || 0} day{(days || 0) === 1 ? '' : 's'}
          </span>
          {preview && preview.lop > 0 && (
            <span className="rounded-md bg-red-100 px-2 py-1 font-semibold text-red-700">
              {preview.lop} LOP{preview.deduction ? ` · ${fmtMoney(preview.deduction)}` : ''}
            </span>
          )}
          {blockers.length > 0 && (
            <span className="rounded-md bg-red-100 px-2 py-1 font-semibold text-red-700">
              {blockers.length} blocker{blockers.length === 1 ? '' : 's'}
            </span>
          )}
          {warnings.length > 0 && (
            <span className="rounded-md bg-amber-100 px-2 py-1 font-semibold text-amber-700">
              {warnings.length} warning{warnings.length === 1 ? '' : 's'}
            </span>
          )}
          {!declarationOk && (
            <span className="rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-500">
              Confirm declaration to enable submit
            </span>
          )}
          {disabled === false && (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 font-semibold text-emerald-700">
              <CheckCircle size={12} /> Ready to submit
            </span>
          )}
        </div>

        {/* buttons pinned to the right */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button onClick={onCancel}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={onDraft} disabled={drafting || submitting}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {drafting ? 'Saving…' : 'Save as Draft'}
          </button>
          <button onClick={onSubmit} disabled={disabled || submitting || drafting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300">
            {submitting ? 'Submitting…' : 'Submit Leave Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Validation rules engine ─── */

function computeValidations({ form, staff, balance, existingRequests, typeMeta, days, holidayDates }) {
  const out = [];
  const today = new Date().toISOString().slice(0, 10);

  if (form.start_date && staff?.employment_start_date && form.start_date < staff.employment_start_date)
    out.push({ level: 'error', message: 'Leave date is before the employee\'s joining date.' });

  if (form.start_date && staff?.employment_end_date && form.start_date > staff.employment_end_date)
    out.push({ level: 'error', message: 'Leave date is after the employee\'s last working day.' });

  if (form.end_date && form.start_date && form.end_date < form.start_date)
    out.push({ level: 'error', message: 'End date is before start date.' });

  // Overlap with existing pending / approved request
  const overlap = (existingRequests || []).find(r => {
    if (!staff || (r.staff !== staff.id && r.staff_id !== staff.id)) return false;
    if (r.status !== 'PENDING' && r.status !== 'APPROVED') return false;
    const s = r.start_date, e = r.end_date || r.start_date;
    if (!s || !form.start_date) return false;
    const ns = form.start_date, ne = form.end_date || form.start_date;
    return s <= ne && ns <= e;
  });
  if (overlap) out.push({ level: 'error', message: `Overlaps with existing ${overlap.status.toLowerCase()} request ${overlap.start_date} → ${overlap.end_date || overlap.start_date}.` });

  // Balance check — per quota pool, matching the backend LOP rules.
  if (balance && days > 0) {
    const pl = poolLopFor(balance, typeMeta, days);
    if (pl && pl.lop > 0) {
      out.push({ level: 'warn', message: `Insufficient ${typeMeta.bucket} balance — ${pl.lop} day(s) will be Loss of Pay.` });
    } else if (pl) {
      out.push({ level: 'ok', message: `Within ${typeMeta.label} quota — ${days} day(s) covered.` });
    }
  }

  // Attachment requirement
  if (typeMeta.attach && !(form.attachments?.length)) {
    out.push({ level: 'error', message: `${typeMeta.label} requires supporting attachment(s).` });
  } else if (typeMeta.attach) {
    out.push({ level: 'ok', message: `Attachment provided for ${typeMeta.label}.` });
  }

  // Notice period
  if (form.start_date && typeMeta.notice > 0 && !form.is_emergency) {
    const noticeDays = Math.round((new Date(form.start_date) - new Date(today)) / 86400000);
    if (noticeDays < typeMeta.notice) {
      out.push({ level: 'warn', message: `${typeMeta.label} expects ${typeMeta.notice}-day notice — only ${Math.max(0, noticeDays)} day(s) given. Mark as emergency to override.` });
    }
  }

  // Half-day rules
  if (form.half_day && form.start_date && form.end_date && form.start_date !== form.end_date) {
    out.push({ level: 'error', message: 'Half-day leave must be a single date.' });
  }

  // Holiday warning
  if (form.start_date) {
    const onHoliday = (holidayDates || []).find(h => h.date === form.start_date && h.holiday_type !== 'WORKING');
    if (onHoliday) out.push({ level: 'warn', message: `Start date is a holiday (${onHoliday.name || onHoliday.holiday_type}). It won't be deducted from quota.` });
  }

  // Sandwich leave heuristic — Fri + Mon flagged
  if (form.start_date && form.end_date && days >= 2) {
    const sDay = new Date(form.start_date).getDay();
    const eDay = new Date(form.end_date).getDay();
    if (sDay === 5 && eDay === 1)
      out.push({ level: 'warn', message: 'Sandwich-leave policy may apply — Sat/Sun in between could be counted as paid leave.' });
  }

  // Critical-department coverage
  if (form.shift_replacement_required && !form.backup_staff_id) {
    out.push({ level: 'error', message: 'Backup employee not picked — shift coverage required.' });
  }

  // Department capacity warning (>= 3 from same dept already approved)
  if (form.start_date && staff?.department) {
    const sameDay = (existingRequests || []).filter(r => r.status === 'APPROVED'
      && (r.staff_department === staff.department)
      && r.start_date <= (form.end_date || form.start_date)
      && (r.end_date || r.start_date) >= form.start_date);
    if (sameDay.length >= 3)
      out.push({ level: 'warn', message: `${sameDay.length} colleagues from ${staff.department} are already on leave for the same period.` });
  }

  return out;
}

/* ═════════════════════════════════════════════════════════════════════════
 *  TAB 2 — MY REQUESTS
 * ═════════════════════════════════════════════════════════════════════════ */

function MyRequestsTab({ requests, staffList, staffId, loading, onView, onRefetch, navigate }) {
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const rows = useMemo(() => {
    return (requests || [])
      .filter(r => !staffId || r.staff === staffId || r.staff_id === staffId)
      .filter(r => statusFilter === 'ALL' || r.status === statusFilter)
      .filter(r => {
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return [r.id, r.reason, r.start_date, r.end_date, r.status, r.staff_name]
          .filter(Boolean).join(' ').toLowerCase().includes(q);
      })
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }, [requests, statusFilter, search, staffId]);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-bold text-slate-900">My Leave Requests</h3>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{rows.length}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
              className="rounded-lg border border-slate-300 py-1.5 pl-8 pr-3 text-xs focus:border-indigo-500 focus:ring-1 focus:ring-indigo-200" />
          </div>
          <CustomSelect value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs">
            <option value="ALL">All Status</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="CANCELLED">Cancelled</option>
          </CustomSelect>
          <button onClick={onRefetch}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Request ID</th>
              <th className="px-3 py-2 text-left">Applied</th>
              <th className="px-3 py-2 text-left">Leave Type</th>
              <th className="px-3 py-2 text-left">From</th>
              <th className="px-3 py-2 text-left">To</th>
              <th className="px-3 py-2 text-right">Days</th>
              <th className="px-3 py-2 text-left">Half Day</th>
              <th className="px-3 py-2 text-left">Reason</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">LOP</th>
              <th className="px-3 py-2 text-left">Remarks</th>
              <th className="px-3 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr><td colSpan={12} className="px-3 py-8 text-center text-xs text-slate-400">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={12} className="px-3 py-12 text-center">
                <EmptyState
                  icon={ClipboardList}
                  title="No leave requests found"
                  hint="Switch to Apply Leave to file your first request."
                  inline
                />
              </td></tr>
            )}
            {rows.map(r => {
              const meta = STATUS_META[r.status] || STATUS_META.PENDING;
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">LR-{String(r.id || '').slice(0, 8).toUpperCase()}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{fmtDate(r.created_at)}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-800">
                      {parseRichType(r.reason, r.leave_type)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtDate(r.start_date)}</td>
                  <td className="px-3 py-2 text-xs">{fmtDate(r.end_date || r.start_date)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{r.days_requested ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.leave_type === 'HALF_DAY' ? 'Yes' : '—'}</td>
                  <td className="px-3 py-2 max-w-[200px] truncate text-xs text-slate-600" title={r.reason}>{String(r.reason || '—').replace(/\[[^\]]+\]\s*/, '')}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.tone}`}>{meta.label}</span>
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {Number(r.lop_days || 0) > 0
                      ? <span className="rounded-full bg-red-100 px-1.5 py-0.5 font-semibold text-red-700">{r.lop_days}d</span>
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2 max-w-[160px] truncate text-xs text-slate-500" title={r.approval_remarks || ''}>
                    {r.approval_remarks || '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <button onClick={() => onView(r.id)} title="View details"
                        className="rounded-md p-1.5 text-slate-500 hover:bg-indigo-50 hover:text-indigo-700">
                        <Eye size={14} />
                      </button>
                      <button onClick={() => navigate(`/hr/leave/${r.id}`)} title="Open page"
                        className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100">
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
 *  TAB 3 — BALANCE LEDGER
 * ═════════════════════════════════════════════════════════════════════════ */

function BalanceLedgerTab({ requests, staffId, balance }) {
  const [year, setYear] = useState(new Date().getFullYear());

  const ledger = useMemo(() => {
    const buckets = LEAVE_TYPES.reduce((m, t) => { m[t.bucket] = m[t.bucket] || { used: 0, pending: 0, type: t }; return m; }, {});
    (requests || []).filter(r => !staffId || r.staff === staffId || r.staff_id === staffId)
      .filter(r => (r.start_date || '').slice(0, 4) === String(year))
      .forEach(r => {
        const m = String(r.reason || '').match(/^\[([^\]]+)\]/);
        const label = (m?.[1] || '').toLowerCase();
        let bucketKey = 'CASUAL';
        if (label.includes('sick'))    bucketKey = 'SICK';
        else if (label.includes('earned') || label.includes('paid')) bucketKey = 'EARNED';
        else if (label.includes('comp'))  bucketKey = 'COMPOFF';
        else if (label.includes('unpaid') || label.includes('lwp')) bucketKey = 'UNPAID';
        else if (label.includes('mater') || label.includes('pater')) bucketKey = 'STAT';
        else if (label.includes('wfh') || label.includes('home')) bucketKey = 'WFH';
        else if (label.includes('duty')) bucketKey = 'OD';
        else if (label.includes('permission') || label.includes('short')) bucketKey = 'PERMISSION';

        if (!buckets[bucketKey]) buckets[bucketKey] = { used: 0, pending: 0, type: LEAVE_TYPES.find(t => t.bucket === bucketKey) };
        const days = Number(r.days_requested || 0);
        if (r.status === 'APPROVED') buckets[bucketKey].used += days;
        else if (r.status === 'PENDING') buckets[bucketKey].pending += days;
      });
    return Object.entries(buckets).map(([key, v]) => ({ key, ...v }));
  }, [requests, staffId, year]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-bold text-slate-900">Leave Balance Ledger</h3>
        <span className="text-xs text-slate-500">FY {year} · {balance ? `${balance.used}d used / ${balance.quota}d quota` : 'No staff selected'}</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setYear(y => y - 1)} className="rounded-md border border-slate-300 p-1 text-slate-600 hover:bg-slate-50"><ChevronLeft size={14} /></button>
          <span className="text-sm font-semibold text-slate-800">{year}</span>
          <button onClick={() => setYear(y => y + 1)} disabled={year >= new Date().getFullYear()} className="rounded-md border border-slate-300 p-1 text-slate-600 hover:bg-slate-50 disabled:opacity-40"><ChevronRight size={14} /></button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Leave Type</th>
              <th className="px-3 py-2 text-right">Opening</th>
              <th className="px-3 py-2 text-right">Accrued</th>
              <th className="px-3 py-2 text-right">Used</th>
              <th className="px-3 py-2 text-right">Pending</th>
              <th className="px-3 py-2 text-right">Encashed</th>
              <th className="px-3 py-2 text-right">Adjusted</th>
              <th className="px-3 py-2 text-right">Available</th>
              <th className="px-3 py-2 text-right">Carry-Fwd</th>
              <th className="px-3 py-2 text-left">Expires</th>
              <th className="px-3 py-2 text-left">Remarks</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ledger.map(b => {
              if (!b.type) return null;
              const annual = b.type.entitled || 0;
              const accrued = annual;
              const available = Math.max(0, annual - b.used - b.pending);
              return (
                <tr key={b.key} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold ${TYPE_CHIP[b.type.color] || TYPE_CHIP.slate}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${TYPE_DOT[b.type.color] || TYPE_DOT.slate}`} /> {b.type.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">{annual}</td>
                  <td className="px-3 py-2 text-right">{accrued}</td>
                  <td className="px-3 py-2 text-right font-semibold text-amber-700">{b.used.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{b.pending.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right text-slate-400">0</td>
                  <td className="px-3 py-2 text-right text-slate-400">0</td>
                  <td className="px-3 py-2 text-right font-bold text-emerald-700">{available.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{b.type.bucket === 'EARNED' ? '5' : b.type.bucket === 'SICK' ? '30' : '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">31-Dec-{year}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{b.type.desc}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Panel title="Monthly accrual" icon={TrendingUp}>
          <p className="text-xs text-slate-600">Earned Leave accrues at <strong>1.5 days/month</strong>, credited on the 1st of every month. Sick Leave is credited as 1d/month.</p>
        </Panel>
        <Panel title="Policy applied" icon={ShieldCheck}>
          <p className="text-xs text-slate-600">Standard SME policy — aligned with the Factories Act 1948 and the Shops & Establishments Act of your state.</p>
        </Panel>
        <Panel title="Comp-off ledger" icon={BadgeCheck}>
          <p className="text-xs text-slate-600">Earn comp-off by working approved overtime on a weekly off or holiday. Use within 60 days or it expires.</p>
        </Panel>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
 *  TAB 4 — TEAM CALENDAR
 * ═════════════════════════════════════════════════════════════════════════ */

function TeamCalendarTab({ requests, staffList, holidayDates }) {
  const [cursor, setCursor] = useState(() => new Date());
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('ALL');

  const month = cursor.getMonth();
  const year = cursor.getFullYear();
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const startWeekday = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();

  const departments = useMemo(() => {
    const s = new Set();
    (staffList || []).forEach(st => st.department && s.add(st.department));
    return ['ALL', ...Array.from(s).sort()];
  }, [staffList]);

  const dayMap = useMemo(() => {
    const m = new Map();
    (requests || []).filter(r => r.status === 'APPROVED').forEach(r => {
      const start = r.start_date, end = r.end_date || r.start_date;
      if (!start) return;
      const reasonType = parseRichType(r.reason, r.leave_type).toLowerCase();
      if (typeFilter !== 'ALL' && !reasonType.includes(typeFilter.toLowerCase())) return;
      const staffRec = staffList.find(s => s.id === r.staff || s.id === r.staff_id);
      if (deptFilter !== 'ALL' && staffRec?.department !== deptFilter) return;
      const cur = new Date(start);
      const last = new Date(end);
      while (cur <= last) {
        const k = cur.toISOString().slice(0, 10);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push({ name: staffRec?.full_name || r.staff_name || '—', type: parseRichType(r.reason, r.leave_type), id: r.id });
        cur.setDate(cur.getDate() + 1);
      }
    });
    return m;
  }, [requests, staffList, deptFilter, typeFilter]);

  const holidaySet = useMemo(() => {
    const s = new Map();
    (holidayDates || []).forEach(h => s.set(h.date, h));
    return s;
  }, [holidayDates]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <button onClick={() => setCursor(new Date(year, month - 1, 1))} aria-label="Previous month" title="Previous month"
          className="rounded-md border border-slate-300 p-1.5 hover:bg-slate-50"><ChevronLeft size={14} /></button>
        <h3 className="text-sm font-bold text-slate-900">
          {cursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
        </h3>
        <button onClick={() => setCursor(new Date(year, month + 1, 1))} aria-label="Next month" title="Next month"
          className="rounded-md border border-slate-300 p-1.5 hover:bg-slate-50"><ChevronRight size={14} /></button>
        <button onClick={() => setCursor(new Date())}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50">Today</button>

        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <Filter size={13} className="text-slate-400" />
          <CustomSelect value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1">
            {departments.map(d => <option key={d} value={d}>{d === 'ALL' ? 'All Departments' : d}</option>)}
          </CustomSelect>
          <CustomSelect value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1">
            <option value="ALL">All Types</option>
            {LEAVE_TYPES.map(t => <option key={t.code} value={t.label.split(' ')[0]}>{t.label}</option>)}
          </CustomSelect>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {WEEKDAYS.map(d => <div key={d} className="py-2">{d}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: startWeekday }).map((_, i) => (
            <div key={`pad-${i}`} className="min-h-[88px] border-b border-r border-slate-100 bg-slate-50/40" />
          ))}
          {Array.from({ length: daysInMonth }).map((_, idx) => {
            const day = idx + 1;
            const date = new Date(year, month, day);
            const iso = date.toISOString().slice(0, 10);
            const isSun = date.getDay() === 0;
            const holiday = holidaySet.get(iso);
            const leaves = dayMap.get(iso) || [];
            const isToday = iso === new Date().toISOString().slice(0, 10);
            return (
              <div key={iso}
                className={`min-h-[88px] border-b border-r border-slate-100 p-1.5 text-xs ${holiday ? 'bg-rose-50/60' : isSun ? 'bg-slate-50/60' : 'bg-white'} ${isToday ? 'ring-2 ring-inset ring-indigo-500' : ''}`}>
                <div className="mb-1 flex items-center justify-between">
                  <span className={`text-[11px] font-semibold ${holiday ? 'text-rose-700' : isSun ? 'text-slate-500' : 'text-slate-700'}`}>{day}</span>
                  {holiday && <span className="rounded-full bg-rose-200 px-1 text-[9px] font-bold uppercase text-rose-800" title={holiday.name}>H</span>}
                </div>
                {leaves.slice(0, 3).map((l, i) => (
                  <div key={i} className="mb-0.5 truncate rounded bg-indigo-100 px-1 py-0.5 text-[10px] text-indigo-900" title={`${l.name} — ${l.type}`}>
                    {l.name}
                  </div>
                ))}
                {leaves.length > 3 && (
                  <div className="text-[10px] font-semibold text-slate-500">+{leaves.length - 3} more</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
        <span className="font-semibold">Legend:</span>
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded bg-indigo-100" /> On Leave</span>
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded bg-rose-100" /> Holiday</span>
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded bg-slate-100" /> Weekly Off</span>
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded ring-2 ring-indigo-500" /> Today</span>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
 *  TAB 5 — POLICY RULES
 * ═════════════════════════════════════════════════════════════════════════ */

function PolicyRulesTab() {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left">Leave Type</th>
            <th className="px-3 py-2 text-right">Annual</th>
            <th className="px-3 py-2 text-right">Monthly accrual</th>
            <th className="px-3 py-2 text-center">Carry-fwd</th>
            <th className="px-3 py-2 text-center">Encashable</th>
            <th className="px-3 py-2 text-right">Notice (days)</th>
            <th className="px-3 py-2 text-right">Max continuous</th>
            <th className="px-3 py-2 text-center">Attachment</th>
            <th className="px-3 py-2 text-left">Approval levels</th>
            <th className="px-3 py-2 text-left">Applicable</th>
            <th className="px-3 py-2 text-left">Probation rule</th>
            <th className="px-3 py-2 text-left">Holiday / WO counting</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {LEAVE_TYPES.map(t => (
            <tr key={t.code} className="hover:bg-slate-50">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${TYPE_DOT[t.color] || TYPE_DOT.slate}`} />
                  <div>
                    <div className="font-semibold text-slate-900">{t.label}</div>
                    <div className="text-[10px] text-slate-500">{t.desc}</div>
                  </div>
                </div>
              </td>
              <td className="px-3 py-2 text-right font-semibold">{t.entitled || '—'}</td>
              <td className="px-3 py-2 text-right text-xs">{t.bucket === 'EARNED' ? '1.5' : t.bucket === 'SICK' ? '1.0' : '—'}</td>
              <td className="px-3 py-2 text-center text-xs">{['EARNED','SICK'].includes(t.bucket) ? 'Yes' : 'No'}</td>
              <td className="px-3 py-2 text-center text-xs">{t.bucket === 'EARNED' ? 'Yes' : 'No'}</td>
              <td className="px-3 py-2 text-right text-xs">{t.notice}</td>
              <td className="px-3 py-2 text-right text-xs">{t.bucket === 'STAT' ? '182' : t.bucket === 'EARNED' ? '15' : '5'}</td>
              <td className="px-3 py-2 text-center">
                {t.attach
                  ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">Required</span>
                  : <span className="text-xs text-slate-400">No</span>}
              </td>
              <td className="px-3 py-2 text-xs">Supervisor → Manager → HR</td>
              <td className="px-3 py-2 text-xs">
                {t.code === 'MATERNITY' ? 'Female employees'
                  : t.code === 'PATERNITY' ? 'Male employees'
                  : 'All'}
              </td>
              <td className="px-3 py-2 text-xs">{['STAT','UNPAID'].includes(t.bucket) ? 'Allowed' : 'After probation (6 mo)'}</td>
              <td className="px-3 py-2 text-xs">Sandwiched holidays counted as paid leave</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
 *  TAB 6 — APPROVAL AUDIT
 * ═════════════════════════════════════════════════════════════════════════ */

function ApprovalAuditTab({ requests, staffList }) {
  const rows = useMemo(() => {
    const out = [];
    (requests || []).forEach(r => {
      const staff = staffList.find(s => s.id === r.staff || s.id === r.staff_id);
      out.push({
        when: r.created_at,
        requestId: r.id,
        action: 'Submitted',
        prev: '—',
        next: 'Pending',
        by: staff?.full_name || r.staff_name || '—',
        role: 'Employee',
        remarks: r.reason || '',
      });
      if (r.status === 'APPROVED') {
        out.push({
          when: r.approval_date || r.updated_at,
          requestId: r.id,
          action: 'Approved',
          prev: 'Pending',
          next: 'Approved',
          by: r.approver_name || 'HR / Manager',
          role: 'Approver',
          remarks: r.approval_remarks || '',
        });
      } else if (r.status === 'REJECTED') {
        out.push({
          when: r.approval_date || r.updated_at,
          requestId: r.id,
          action: 'Rejected',
          prev: 'Pending',
          next: 'Rejected',
          by: r.approver_name || 'HR / Manager',
          role: 'Approver',
          remarks: r.approval_remarks || '',
        });
      }
    });
    return out.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
  }, [requests, staffList]);

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left">Date & Time</th>
            <th className="px-3 py-2 text-left">Request ID</th>
            <th className="px-3 py-2 text-left">Action</th>
            <th className="px-3 py-2 text-left">Previous</th>
            <th className="px-3 py-2 text-left">New</th>
            <th className="px-3 py-2 text-left">By</th>
            <th className="px-3 py-2 text-left">Role</th>
            <th className="px-3 py-2 text-left">Remarks</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 && (
            <tr><td colSpan={8} className="px-3 py-8 text-center text-xs text-slate-400">No audit entries yet.</td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-slate-50">
              <td className="px-3 py-2 text-xs text-slate-600">{fmtDateTime(r.when)}</td>
              <td className="px-3 py-2 font-mono text-xs">LR-{String(r.requestId || '').slice(0, 8).toUpperCase()}</td>
              <td className="px-3 py-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  r.action === 'Approved' ? 'bg-emerald-100 text-emerald-700'
                  : r.action === 'Rejected' ? 'bg-red-100 text-red-700'
                  : 'bg-slate-100 text-slate-700'
                }`}>{r.action}</span>
              </td>
              <td className="px-3 py-2 text-xs text-slate-600">{r.prev}</td>
              <td className="px-3 py-2 text-xs font-semibold">{r.next}</td>
              <td className="px-3 py-2 text-xs">{r.by}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{r.role}</td>
              <td className="px-3 py-2 max-w-[260px] truncate text-xs text-slate-500" title={r.remarks}>{r.remarks || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
 *  DETAIL DRAWER
 * ═════════════════════════════════════════════════════════════════════════ */

function LeaveDetailDrawer({ requestId, requests, staffList, onClose, onRefetch }) {
  if (!requestId) return null;
  const r = (requests || []).find(x => x.id === requestId);
  if (!r) return null;
  const staff = (staffList || []).find(s => s.id === r.staff || s.id === r.staff_id);
  const meta = STATUS_META[r.status] || STATUS_META.PENDING;
  const richType = parseRichType(r.reason, r.leave_type);
  const cleanReason = String(r.reason || '').replace(/^\[[^\]]+\]\s*/, '').replace(/\([^)]+\)\s*/, '');

  const withdraw = async () => {
    if (!confirm('Withdraw this leave request?')) return;
    try {
      await apiClient.delete(`/api/hr/leave/${r.id}/`);
      toast.success('Leave request withdrawn.');
      onClose(); onRefetch?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Could not withdraw.');
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Leave Request</p>
            <h2 className="text-lg font-bold text-slate-900">LR-{String(r.id).slice(0, 8).toUpperCase()}</h2>
            <span className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.tone}`}>{meta.label}</span>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"><XIcon size={18} /></button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {/* Employee */}
          <DrawerSection title="Employee Information" icon={UserIcon}>
            <KV label="Employee">{staff?.full_name || r.staff_name || '—'}</KV>
            <KV label="ID">{staff?.staff_id || '—'}</KV>
            <KV label="Department">{staff?.department || '—'}</KV>
            <KV label="Designation">{staff?.designation || '—'}</KV>
            <KV label="Work location">{staff?.location_name || '—'}</KV>
            <KV label="Reporting manager">{staff?.hr_owner_name || '—'}</KV>
          </DrawerSection>

          {/* Leave info */}
          <DrawerSection title="Leave Information" icon={CalendarIcon}>
            <KV label="Type">{richType}</KV>
            <KV label="Applied date">{fmtDateTime(r.created_at)}</KV>
            <KV label="From">{fmtDate(r.start_date)}</KV>
            <KV label="To">{fmtDate(r.end_date || r.start_date)}</KV>
            <KV label="Total days">{r.days_requested ?? '—'}</KV>
            <KV label="LOP days">{r.lop_days ?? '0'}</KV>
            <KV label="Reason" wide>{cleanReason || '—'}</KV>
          </DrawerSection>

          {/* Policy / balance */}
          <DrawerSection title="Policy & Balance Validation" icon={ShieldCheck}>
            <KV label="Quota at request">{r.balance_before ?? '—'}</KV>
            <KV label="Balance after">{r.balance_after ?? '—'}</KV>
            <KV label="Policy">Standard SME — Factories Act</KV>
            <KV label="Weekly off / holiday">Excluded from count</KV>
            <KV label="Notice met">{r.notice_met === false ? 'No (emergency)' : 'Yes'}</KV>
          </DrawerSection>

          {/* Approval timeline */}
          <DrawerSection title="Approval Timeline" icon={History}>
            <ol className="space-y-2 text-sm">
              <TimelineStep
                done at={r.created_at}
                title="Submitted by employee"
                by={staff?.full_name || '—'} />
              <TimelineStep
                done={r.status === 'APPROVED' || r.status === 'REJECTED'}
                at={r.approval_date}
                title={r.status === 'APPROVED' ? 'Approved by HR' : r.status === 'REJECTED' ? 'Rejected by HR' : 'Awaiting HR review'}
                by={r.approver_name || (r.status === 'PENDING' ? '—' : 'HR')}
                remarks={r.approval_remarks} />
            </ol>
          </DrawerSection>

          {/* Attachments */}
          <DrawerSection title="Attachments" icon={Paperclip}>
            <p className="text-xs text-slate-500">Attachments are stored alongside the request once the document service is wired up. No files on this record.</p>
          </DrawerSection>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
          {r.status === 'PENDING' && (
            <button onClick={withdraw}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100">
              <Trash2 size={13} /> Withdraw
            </button>
          )}
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            <Download size={13} /> Download PDF
          </button>
          <button onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700">
            Close
          </button>
        </footer>
      </aside>
    </>
  );
}

function DrawerSection({ title, icon: Icon, children }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
      <h4 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-600">
        {Icon && <Icon size={13} className="text-indigo-500" />}{title}
      </h4>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">{children}</div>
    </section>
  );
}

function KV({ label, children, wide }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-0.5 text-sm text-slate-800">{children}</p>
    </div>
  );
}

function TimelineStep({ done, at, title, by, remarks }) {
  return (
    <li className="flex gap-3">
      <div className={`mt-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
        {done ? <CheckCircle size={14} /> : <Hourglass size={12} />}
      </div>
      <div className="flex-1">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <p className="text-xs text-slate-500">{by} · {fmtDateTime(at)}</p>
        {remarks && (
          <p className="mt-1 rounded-md bg-white px-2 py-1 text-xs italic text-slate-600 border border-slate-200">
            <MessageSquare size={11} className="mr-1 inline opacity-60" />{remarks}
          </p>
        )}
      </div>
    </li>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Shared mini-components
 * ─────────────────────────────────────────────────────────────────────── */

function Field({ label, required, hint, children, className = '' }) {
  return (
    <div className={className}>
      <Label required={required}>{label}</Label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

function Label({ required, children }) {
  return (
    <label className="block text-xs font-semibold text-slate-700">
      {children}{required && <span className="ml-0.5 text-red-500">*</span>}
    </label>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
      <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${checked ? 'bg-indigo-600' : 'bg-slate-300'}`}>
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${checked ? 'translate-x-4' : 'translate-x-1'}`} />
      </span>
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only" />
    </label>
  );
}

function StaffPickerField({ staffList, excludeId, value, onChange, placeholder, disabled }) {
  return (
    <CustomSelect value={value || ''}
      onChange={(e) => {
        const id = e.target.value;
        const s = staffList.find(x => x.id === id);
        const name = s ? (s.full_name || [s.first_name, s.last_name].filter(Boolean).join(' ')) : '';
        onChange(id, name);
      }}
      disabled={disabled}
      className="input disabled:bg-slate-50 disabled:text-slate-400">
      <option value="">{placeholder || 'Select'}</option>
      {(staffList || []).filter(s => s.id !== excludeId && s.is_active !== false).map(s => {
        const name = s.full_name || [s.first_name, s.last_name].filter(Boolean).join(' ');
        return <option key={s.id} value={s.id}>{s.staff_id} — {name}</option>;
      })}
    </CustomSelect>
  );
}

function Panel({ title, icon: Icon, children }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-600">
        {Icon && <Icon size={13} className="text-indigo-500" />}{title}
      </p>
      {children}
    </div>
  );
}

function EmptyState({ icon: Icon, title, hint, inline }) {
  const Wrap = inline ? 'div' : 'section';
  return (
    <Wrap className={inline ? '' : 'rounded-2xl border border-dashed border-slate-300 bg-slate-50/50 p-12 text-center'}>
      {Icon && <Icon size={36} className="mx-auto mb-3 text-slate-300" />}
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Wrap>
  );
}
