import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';
import CustomSelect from '@/components/ui/CustomSelect';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// status → cell letter + colour. Only these four are stored values; the
// daily list derives extras (LATE/LEAVE/…) but the register shows what's
// actually persisted.
const STATUS_STYLE = {
  PRESENT:    { letter: 'P',  cls: 'bg-emerald-100 text-emerald-700' },
  ABSENT:     { letter: 'A',  cls: 'bg-red-100 text-red-700' },
  HALF_DAY:   { letter: 'H',  cls: 'bg-amber-100 text-amber-700' },
  PERMISSION: { letter: 'Pn', cls: 'bg-blue-100 text-blue-700' },
};

export default function AttendanceRegister() {
  const { options: warehouses } = useLookup('/api/warehouses/');
  const now = new Date();
  const [warehouse, setWarehouse] = useState('');
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1)); // 1-12
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  // Default to the first warehouse once the lookup resolves.
  useEffect(() => {
    if (!warehouse && warehouses.length) setWarehouse(String(warehouses[0].value));
  }, [warehouses, warehouse]);

  useEffect(() => {
    if (!warehouse) return;
    const mm = String(month).padStart(2, '0');
    setLoading(true);
    apiClient.get(`/api/hr/attendance/register/?warehouse=${warehouse}&month=${year}-${mm}`)
      .then(res => setData(res.data))
      .catch(e => { toast.error(getApiErrorMessage(e)); setData(null); })
      .finally(() => setLoading(false));
  }, [warehouse, year, month]);

  const days = data ? Array.from({ length: data.days_in_month }, (_, i) => i + 1) : [];
  const years = useMemo(() => {
    const y = now.getFullYear();
    return [y - 1, y, y + 1].map(String);
  }, [now]);

  // Present-day tally per staff (half day counts 0.5).
  const tally = (rowDays) => {
    let p = 0;
    Object.values(rowDays || {}).forEach(d => {
      if (d.status === 'PRESENT') p += 1;
      else if (d.status === 'HALF_DAY') p += 0.5;
    });
    return p;
  };

  return (
    <MainLayout>
      <PageHeader
        title="Attendance Register"
        subtitle="Monthly muster — staff × day"
        breadcrumbs={[{ label: 'HR' }, { label: 'Attendance', href: '/hr/attendance' }, { label: 'Register' }]}
      />

      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px]">
            <label className="block text-xs font-medium text-slate-600 mb-1">Warehouse</label>
            <CustomSelect value={warehouse} onChange={(e) => setWarehouse(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
              <option value="">Select…</option>
              {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
            </CustomSelect>
          </div>
          <div className="w-40">
            <label className="block text-xs font-medium text-slate-600 mb-1">Month</label>
            <CustomSelect value={month} onChange={(e) => setMonth(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
              {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
            </CustomSelect>
          </div>
          <div className="w-28">
            <label className="block text-xs font-medium text-slate-600 mb-1">Year</label>
            <CustomSelect value={year} onChange={(e) => setYear(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </CustomSelect>
          </div>
          <div className="flex items-center gap-2 text-[11px] ml-auto">
            {Object.entries(STATUS_STYLE).map(([k, v]) => (
              <span key={k} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${v.cls}`}>
                {v.letter}<span className="text-slate-500">{k.replace('_', ' ').toLowerCase()}</span>
              </span>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="animate-spin text-primary-600" /></div>
        ) : !data ? (
          <p className="text-sm text-slate-500 py-8 text-center">Pick a warehouse and month.</p>
        ) : data.staff.length === 0 ? (
          <p className="text-sm text-slate-500 py-8 text-center">No active staff at this warehouse.</p>
        ) : (
          <div className="overflow-auto border border-slate-200 rounded-lg">
            <table className="text-xs border-collapse">
              <thead>
                <tr className="bg-slate-100">
                  <th className="sticky left-0 bg-slate-100 z-10 text-left px-3 py-2 font-semibold text-slate-700 min-w-[180px] border-r border-slate-200">Staff</th>
                  {days.map(d => <th key={d} className="px-1 py-2 w-7 text-center font-medium text-slate-500">{d}</th>)}
                  <th className="px-2 py-2 text-center font-semibold text-slate-700 border-l border-slate-200">P</th>
                </tr>
              </thead>
              <tbody>
                {data.staff.map(s => (
                  <tr key={s.staff_id} className="border-t border-slate-100">
                    <td className="sticky left-0 bg-white z-10 px-3 py-1.5 border-r border-slate-200">
                      <div className="font-medium text-slate-800 truncate">{s.name}</div>
                      <div className="text-[10px] text-slate-400">{s.code}</div>
                    </td>
                    {days.map(d => {
                      const cell = s.days[d];
                      const st = cell ? STATUS_STYLE[cell.status] : null;
                      return (
                        <td key={d} className="text-center px-0.5 py-1">
                          {st ? (
                            <span
                              title={`${cell.status}${cell.in ? ` · in ${cell.in}` : ''}${cell.out ? ` · out ${cell.out}` : ''}`}
                              className={`inline-flex items-center justify-center w-6 h-6 rounded ${st.cls} font-semibold`}
                            >
                              {st.letter}
                            </span>
                          ) : <span className="text-slate-200">·</span>}
                        </td>
                      );
                    })}
                    <td className="text-center px-2 font-semibold text-slate-700 border-l border-slate-100">{tally(s.days)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
