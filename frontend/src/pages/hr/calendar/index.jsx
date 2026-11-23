import CustomSelect from "@/components/ui/CustomSelect";
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Calendar as CalIcon, Plus, RefreshCw, X, Trash2, Save, ChevronLeft, ChevronRight,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatDate } from '@/utils/formatters';

// ─── Constants ───────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const HOLIDAY_TYPES = [
  { value: 'WEEKLY_OFF',       label: 'Weekly Off',       tone: 'slate' },
  { value: 'NATIONAL_HOLIDAY', label: 'National Holiday', tone: 'red' },
  { value: 'COMPANY_HOLIDAY',  label: 'Company Holiday',  tone: 'amber' },
  { value: 'RESTRICTED',       label: 'Restricted',       tone: 'violet' },
  { value: 'WORKING',          label: 'Working Day',      tone: 'emerald' },
];

const TYPE_BG = {
  WEEKLY_OFF:       'bg-slate-100 text-slate-700 border-slate-300',
  NATIONAL_HOLIDAY: 'bg-red-100 text-red-700 border-red-300',
  COMPANY_HOLIDAY:  'bg-amber-100 text-amber-700 border-amber-300',
  RESTRICTED:       'bg-violet-100 text-violet-700 border-violet-300',
  WORKING:          'bg-emerald-100 text-emerald-700 border-emerald-300',
};

// ─── Helpers ─────────────────────────────────────────────────────────────

const isoDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const buildMonthGrid = (year, monthIdx) => {
  // Returns 6 rows × 7 cols of Date objects, padded with prev/next month
  // leading/trailing days so each row is full.
  const first = new Date(year, monthIdx, 1);
  const firstDow = first.getDay(); // 0 = Sun
  const start = new Date(year, monthIdx, 1 - firstDow);
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
};

// ─── Page ────────────────────────────────────────────────────────────────

export default function HolidayCalendarPage() {
  const { canCreate, canEdit, canDelete } = usePermissions();
  const { options: companyOptions } = useLookup('/api/companies/');

  const today = new Date();
  // The viewed year lives in the URL so Back / refresh / sharing restore it.
  const [searchParams, setSearchParams] = useSearchParams();
  const [year, setYear] = useState(() => Number(searchParams.get('year')) || today.getFullYear());
  const [calendar, setCalendar] = useState(null); // active calendar object
  const [calendars, setCalendars] = useState([]); // all calendars for selected year
  const [loading, setLoading] = useState(false);
  const [editingDate, setEditingDate] = useState(null); // ISO string or null
  const [newCalendarOpen, setNewCalendarOpen] = useState(false);

  // ── Load calendars for the selected year ─────────────────────────────
  const loadCalendars = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/api/hr/holiday-calendars/', { params: { page_size: 100 } });
      const rows = res.data?.results || res.data || [];
      const yearRows = rows.filter((c) => c.year === year);
      setCalendars(yearRows);
      // Pick: default for this year, else first, else null
      const next = yearRows.find((c) => c.is_default) || yearRows[0] || null;
      setCalendar(next);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load calendars');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { loadCalendars(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [year]);

  // Mirror the viewed year into the URL (replace — only stored when it differs
  // from the current year so a plain visit stays on a clean URL).
  useEffect(() => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (year && year !== today.getFullYear()) p.set('year', String(year));
      else p.delete('year');
      return p;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  // ── Day → entry index ────────────────────────────────────────────────
  const datesByIso = useMemo(() => {
    const m = {};
    (calendar?.dates || []).forEach((d) => { m[d.date] = d; });
    return m;
  }, [calendar]);

  // ── Summary counters ─────────────────────────────────────────────────
  const counts = useMemo(() => {
    const out = { WEEKLY_OFF: 0, NATIONAL_HOLIDAY: 0, COMPANY_HOLIDAY: 0, RESTRICTED: 0, WORKING: 0 };
    (calendar?.dates || []).forEach((d) => { if (out[d.holiday_type] !== undefined) out[d.holiday_type] += 1; });
    const totalOff = out.WEEKLY_OFF + out.NATIONAL_HOLIDAY + out.COMPANY_HOLIDAY + out.RESTRICTED;
    return { ...out, totalOff };
  }, [calendar]);

  // ── Actions ──────────────────────────────────────────────────────────
  const reseedSundays = async () => {
    if (!calendar) return;
    try {
      const res = await apiClient.post(`/api/hr/holiday-calendars/${calendar.id}/seed-sundays/`);
      const added = res.data?.sundays_added ?? 0;
      toast.success(added > 0 ? `Seeded ${added} Sunday(s).` : 'All Sundays already marked.');
      loadCalendars();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to seed Sundays.');
    }
  };

  const seedNationalHolidays = async () => {
    if (!calendar) return;
    try {
      const res = await apiClient.post(`/api/hr/holiday-calendars/${calendar.id}/seed-national-holidays/`);
      const added = res.data?.national_added ?? 0;
      toast.success(added > 0
        ? `Added ${added} national holiday(s).`
        : 'National holidays already marked (or fall on days already set).');
      loadCalendars();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to seed national holidays.');
    }
  };

  const saveDay = async ({ date, holiday_type, name, is_paid }) => {
    if (!calendar) return;
    const existing = datesByIso[date];
    try {
      if (existing) {
        await apiClient.patch(`/api/hr/holiday-dates/${existing.id}/`, {
          holiday_type, name, is_paid,
        });
        toast.success(`Updated ${date}`);
      } else {
        await apiClient.post('/api/hr/holiday-dates/', {
          calendar: calendar.id, date, holiday_type, name, is_paid,
        });
        toast.success(`Marked ${date}`);
      }
      setEditingDate(null);
      loadCalendars();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to save holiday.');
    }
  };

  const removeDay = async (date) => {
    if (!calendar) return;
    const existing = datesByIso[date];
    if (!existing) { setEditingDate(null); return; }
    try {
      await apiClient.delete(`/api/hr/holiday-dates/${existing.id}/`);
      toast.success(`Cleared ${date}`);
      setEditingDate(null);
      loadCalendars();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to remove holiday.');
    }
  };

  const createCalendar = async ({ name, company, year: yr, description, is_default }) => {
    try {
      await apiClient.post('/api/hr/holiday-calendars/', {
        name: name.trim(),
        company: company || null,
        year: yr,
        is_default: !!is_default,
        description: description || '',
      });
      toast.success(`Created ${name}. Sundays auto-seeded.`);
      setNewCalendarOpen(false);
      if (yr !== year) setYear(yr); else loadCalendars();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to create calendar.');
    }
  };

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <MainLayout>
      <div className="space-y-5">
        <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs text-slate-500 mb-1">HR / Holiday Calendar</p>
            <h1 className="text-2xl font-bold text-slate-900">Holiday Calendar</h1>
            <p className="text-sm text-slate-600 mt-1">
              Yearly working-day template. Sundays are weekly offs by default — click any date to mark holidays, restricted days, or override a Sunday back to working.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canCreate('Holiday Calendar') && (
              <button onClick={() => setNewCalendarOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                <Plus size={15} /> New Calendar
              </button>
            )}
            {calendar && canEdit('Holiday Calendar') && (
              <button onClick={seedNationalHolidays}
                title="Fill Republic Day, Independence Day and Gandhi Jayanti for this year"
                className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
                <CalIcon size={15} /> Seed National Holidays
              </button>
            )}
            {calendar && canEdit('Holiday Calendar') && (
              <button onClick={reseedSundays}
                className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
                <RefreshCw size={15} /> Re-seed Sundays
              </button>
            )}
          </div>
        </header>

        {/* Year + calendar selector */}
        <section className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row gap-3 lg:items-end">
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Year</label>
            <div className="inline-flex items-center border border-slate-300 rounded-lg overflow-hidden">
              <button onClick={() => setYear((y) => y - 1)}
                className="px-2.5 py-2 text-slate-600 hover:bg-slate-50"><ChevronLeft size={16} /></button>
              <div className="px-4 py-2 font-semibold text-slate-800 border-x border-slate-300 min-w-[80px] text-center">{year}</div>
              <button onClick={() => setYear((y) => y + 1)}
                className="px-2.5 py-2 text-slate-600 hover:bg-slate-50"><ChevronRight size={16} /></button>
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <label className="block text-[11px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Calendar</label>
            {calendars.length === 0 ? (
              <p className="text-sm text-slate-500 italic">No calendar for {year} yet — click <strong>New Calendar</strong> to create one.</p>
            ) : (
              <CustomSelect value={calendar?.id || ''} onChange={(e) => setCalendar(calendars.find((c) => c.id === e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500">
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.company_name ? ` · ${c.company_name}` : ''}{c.is_default ? ' (default)' : ''}
                  </option>
                ))}
              </CustomSelect>
            )}
          </div>
          {/* KPI strip */}
          {calendar && (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 lg:gap-3">
              <Tile label="Weekly Off"  v={counts.WEEKLY_OFF}        tone="slate" />
              <Tile label="National"    v={counts.NATIONAL_HOLIDAY}  tone="red" />
              <Tile label="Company"     v={counts.COMPANY_HOLIDAY}   tone="amber" />
              <Tile label="Restricted"  v={counts.RESTRICTED}        tone="violet" />
              <Tile label="Working Ovr" v={counts.WORKING}           tone="emerald" />
            </div>
          )}
        </section>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-500">Legend:</span>
          {HOLIDAY_TYPES.map((t) => (
            <span key={t.value} className={`inline-flex items-center px-2 py-0.5 rounded-md border ${TYPE_BG[t.value]}`}>
              {t.label}
            </span>
          ))}
        </div>

        {/* Calendar grid */}
        {loading ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500">Loading calendar…</div>
        ) : !calendar ? (
          <div className="bg-white border border-dashed border-slate-300 rounded-xl p-12 text-center">
            <CalIcon size={28} className="mx-auto text-slate-300 mb-3" />
            <p className="text-sm font-semibold text-slate-700">No calendar configured for {year}</p>
            <p className="text-xs text-slate-500 mt-1">Create one to auto-seed every Sunday as a weekly off, then mark public holidays on top.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {MONTH_NAMES.map((monthName, idx) => (
              <MonthCard
                key={monthName}
                year={year}
                monthIdx={idx}
                monthName={monthName}
                datesByIso={datesByIso}
                onDayClick={(iso) => canEdit('Holiday Calendar') && setEditingDate(iso)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Day edit modal */}
      {editingDate && (
        <DayEditModal
          isoDate={editingDate}
          existing={datesByIso[editingDate]}
          onClose={() => setEditingDate(null)}
          onSave={saveDay}
          onRemove={() => removeDay(editingDate)}
          canDelete={canDelete('Holiday Calendar')}
        />
      )}

      {/* New calendar modal */}
      {newCalendarOpen && (
        <NewCalendarModal
          defaultYear={year}
          companies={companyOptions}
          onClose={() => setNewCalendarOpen(false)}
          onSave={createCalendar}
        />
      )}
    </MainLayout>
  );
}

// ─── Month card ──────────────────────────────────────────────────────────

function MonthCard({ year, monthIdx, monthName, datesByIso, onDayClick }) {
  const grid = useMemo(() => buildMonthGrid(year, monthIdx), [year, monthIdx]);
  const todayIso = isoDate(new Date());
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <header className="px-4 py-2.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">{monthName}</h3>
        <span className="text-xs text-slate-400">{year}</span>
      </header>
      <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase tracking-wide text-slate-400 border-b border-slate-100">
        {WEEKDAY_HEADERS.map((w, i) => (
          <div key={w} className={`py-1.5 ${i === 0 ? 'text-blue-500' : ''}`}>{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 p-1.5 gap-1">
        {grid.flat().map((d) => {
          const iso = isoDate(d);
          const inMonth = d.getMonth() === monthIdx;
          const entry = datesByIso[iso];
          const isSunday = d.getDay() === 0;
          const isToday = iso === todayIso;
          return (
            <button
              key={iso}
              onClick={() => onDayClick(iso)}
              disabled={!inMonth}
              title={entry ? `${entry.holiday_type_display || entry.holiday_type}${entry.name ? ` — ${entry.name}` : ''}` : ''}
              className={[
                'relative aspect-square rounded text-xs font-medium transition',
                inMonth ? 'cursor-pointer hover:ring-2 hover:ring-blue-300' : 'opacity-30 cursor-default',
                entry
                  ? `border ${TYPE_BG[entry.holiday_type] || 'bg-slate-100 text-slate-700 border-slate-300'}`
                  : (isSunday && inMonth ? 'bg-slate-50 text-slate-500 border border-slate-200' : 'text-slate-700 border border-transparent hover:border-slate-200'),
                isToday ? 'ring-1 ring-blue-500' : '',
              ].join(' ')}
            >
              <span className="block leading-none mt-1">{d.getDate()}</span>
              {entry?.name && inMonth && (
                <span className="block text-[8px] leading-none mt-0.5 truncate px-0.5" title={entry.name}>
                  {entry.name}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Day edit modal ──────────────────────────────────────────────────────

function DayEditModal({ isoDate: iso, existing, onClose, onSave, onRemove, canDelete }) {
  const [form, setForm] = useState({
    holiday_type: existing?.holiday_type || 'COMPANY_HOLIDAY',
    name: existing?.name || '',
    is_paid: existing ? !!existing.is_paid : true,
  });
  const niceDate = formatDate(iso);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label={existing ? 'Edit holiday' : 'Mark holiday'} className="bg-white rounded-xl shadow-2xl w-full max-w-md">
        <header className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 bg-blue-50">
          <div>
            <h3 className="text-lg font-bold text-blue-900">{existing ? 'Edit holiday' : 'Mark holiday'}</h3>
            <p className="text-xs text-blue-700/80">{niceDate}</p>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" className="p-1.5 text-slate-500 hover:bg-slate-200 rounded">
            <X size={18} />
          </button>
        </header>
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Holiday Type</label>
            <CustomSelect value={form.holiday_type} onChange={(e) => setForm((p) => ({ ...p, holiday_type: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500">
              {HOLIDAY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </CustomSelect>
            <p className="mt-1 text-[11px] text-slate-500">
              Use <strong>Working Day</strong> to override a Sunday or holiday back to a working day.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
            <input type="text" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder='e.g. "Independence Day", "Diwali", "Sunday"'
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={form.is_paid} onChange={(e) => setForm((p) => ({ ...p, is_paid: e.target.checked }))} />
            Paid holiday (counts towards salary)
          </label>
        </div>
        <footer className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-slate-200 bg-slate-50">
          <div>
            {existing && canDelete && (
              <button onClick={onRemove}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg text-sm font-medium">
                <Trash2 size={14} /> Clear
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100">
              Cancel
            </button>
            <button onClick={() => onSave({ date: iso, ...form })}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
              <Save size={14} /> Save
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ─── New calendar modal ──────────────────────────────────────────────────

function NewCalendarModal({ defaultYear, companies, onClose, onSave }) {
  const [form, setForm] = useState({
    name: `${defaultYear} Holiday Calendar`,
    company: '',
    year: defaultYear,
    description: '',
    is_default: true,
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label="New Holiday Calendar" className="bg-white rounded-xl shadow-2xl w-full max-w-md">
        <header className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 bg-blue-50">
          <div>
            <h3 className="text-lg font-bold text-blue-900">New Holiday Calendar</h3>
            <p className="text-xs text-blue-700/80">All Sundays will be marked as weekly offs automatically.</p>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" className="p-1.5 text-slate-500 hover:bg-slate-200 rounded">
            <X size={18} />
          </button>
        </header>
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Calendar Name *</label>
            <input type="text" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Year *</label>
            <input type="number" min="2020" max="2100" value={form.year}
              onChange={(e) => setForm((p) => ({ ...p, year: Number(e.target.value) }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Company (optional)</label>
            <CustomSelect value={form.company} onChange={(e) => setForm((p) => ({ ...p, company: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500">
              <option value="">— Org-wide —</option>
              {(companies || []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
            <textarea rows={2} value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              placeholder="Optional — e.g. 'India HQ — applies to all warehouses'" />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={form.is_default} onChange={(e) => setForm((p) => ({ ...p, is_default: e.target.checked }))} />
            Use as default calendar for {form.year}
          </label>
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-200 bg-slate-50">
          <button onClick={onClose}
            className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100">
            Cancel
          </button>
          <button onClick={() => form.name.trim() && onSave(form)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
            <Plus size={14} /> Create
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─── Small bits ──────────────────────────────────────────────────────────

function Tile({ label, v, tone }) {
  const toneMap = {
    slate:   'bg-slate-50 border-slate-200 text-slate-700',
    red:     'bg-red-50 border-red-200 text-red-700',
    amber:   'bg-amber-50 border-amber-200 text-amber-700',
    violet:  'bg-violet-50 border-violet-200 text-violet-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  };
  return (
    <div className={`rounded-lg border px-2 py-1.5 text-center ${toneMap[tone] || toneMap.slate}`}>
      <p className="text-[10px] font-medium opacity-80 uppercase tracking-wide leading-tight">{label}</p>
      <p className="text-base font-bold leading-tight">{v}</p>
    </div>
  );
}
