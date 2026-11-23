/**
 * PeriodNavigator — the Today / Week / Month / FY / Custom period widget used on
 * the Sales Analytics top bar. Extracted verbatim from that page so any screen
 * (e.g. the Ledger) gets the identical, proven behaviour.
 *
 * Usage — prefer the hook, which owns all four pieces of state:
 *   const period = usePeriodFilter();          // 'all' by default
 *   <PeriodNavigator allowAll {...period.navProps} />
 *   rows.filter(r => period.match(r.bill_date))
 *
 * `allowAll` adds an "All" pill and is what LIST pages want: the period starts
 * off, so nothing is hidden until asked. Report pages omit it and pass an
 * initial period instead — usePeriodFilter('month').
 *
 * Long form, still supported:
 *   const eff = effWindow(period, anchor, from, to);   // {from, to} | null
 *   <PeriodNavigator period={period} setPeriod={setPeriod} anchor={anchor}
 *      setAnchor={setAnchor} customFrom={from} customTo={to}
 *      setCustomFrom={setFrom} setCustomTo={setTo} />
 */
import { useState } from 'react';

import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import { CTRL_H } from './controls';

export const todayISO = () => new Date().toISOString().slice(0, 10);

// Local-date ISO (avoids the UTC shift toISOString() would cause).
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = (s) => { const [y, m, d] = (s || todayISO()).split('-').map(Number); return new Date(y, m - 1, d); };
const monthRangeOf = (anchorISO) => {
  const d = parseISO(anchorISO);
  return { from: isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
};
const weekRangeOf = (anchorISO) => {
  const d = parseISO(anchorISO);
  const dow = (d.getDay() + 6) % 7;            // Monday = 0
  const mon = new Date(d); mon.setDate(d.getDate() - dow);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { from: isoOf(mon), to: isoOf(sun) };
};
// Indian financial year: 1 Apr → 31 Mar.
const fyStartYearOf = (d) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1);
const FY_SEP = '..';
const fyRangeOf = (token) => { const [f, t] = String(token || '').split(FY_SEP); return { from: f, to: t }; };
const fyLabel = (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
export const fyTokenFor = (d) => { const y = fyStartYearOf(d); return `${y}-04-01${FY_SEP}${y + 1}-03-31`; };
const fyOptions = (count = 3) => {
  const today = todayISO();
  const cy = fyStartYearOf(new Date()); const out = [];
  for (let i = 0; i < count; i++) {
    const y = cy - i; const l = fyLabel(y);
    out.push({ value: `${y}-04-01${FY_SEP}${y + 1}-03-31`, label: i === 0 ? `FY ${l} (to date)` : `FY ${l}` });
    out.push({ value: `${y}-04-01${FY_SEP}${y}-09-30`, label: `FY ${l} · H1 Apr–Sep` });
    out.push({ value: `${y}-10-01${FY_SEP}${y + 1}-03-31`, label: `FY ${l} · H2 Oct–Mar` });
  }
  return out.filter((o) => fyRangeOf(o.value).from <= today);
};
const rangeFor = (period, anchorRaw) => {
  const today = todayISO();
  const cap = (t) => (t > today ? today : t);
  const mismatched = String(anchorRaw).includes(FY_SEP) !== (period === 'fy');
  const anchorISO = mismatched ? (period === 'fy' ? fyTokenFor(new Date()) : today) : anchorRaw;
  if (period === 'today') return { from: anchorISO, to: anchorISO };
  if (period === 'week') { const r = weekRangeOf(anchorISO); return { from: r.from, to: cap(r.to) }; }
  if (period === 'month') { const r = monthRangeOf(anchorISO); return { from: r.from, to: cap(r.to) }; }
  if (period === 'fy') {
    const r = fyRangeOf(anchorISO);
    return { from: r.from, to: (r.from <= today && r.to > today) ? today : r.to };
  }
  return null;  // custom handled separately
};
const monthOptions = (count = 12) => {
  const now = new Date(); const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ value: isoOf(d), label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) });
  }
  return out;
};
const weekOptions = (count = 10) => {
  const now = new Date(); const dow = (now.getDay() + 6) % 7;
  const thisMon = new Date(now); thisMon.setDate(now.getDate() - dow);
  const out = [];
  for (let i = 0; i < count; i++) {
    const mon = new Date(thisMon); mon.setDate(thisMon.getDate() - i * 7);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const lbl = `${mon.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${sun.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`;
    out.push({ value: isoOf(mon), label: i === 0 ? `${lbl} (this week)` : lbl });
  }
  return out;
};

/**
 * Effective {from, to} for a period + navigator anchor (custom uses its pickers).
 *
 * RETURNS NULL for period 'all' — "no window", not "an empty window". Callers
 * MUST use `eff?.from`.
 *
 * This bit me: 'all' was added for list pages, and before that effWindow always
 * returned an object, so the two existing callers (Sales TDS, Sales Ledger)
 * dereferenced `eff.from` directly. Both guarded the USE with
 * `period !== 'all'`, which looks safe and isn't — a useEffect dependency array
 * is evaluated on every render regardless of any guard inside the effect, so
 * `[..., eff.from]` threw the moment period was 'all'. Sales TDS defaults to
 * 'all', so it crashed on load.
 */
export const effWindow = (period, anchor, customFrom, customTo) =>
  period === 'all'
    ? null
    : period === 'custom'
      ? { from: customFrom, to: customTo }
      : (rangeFor(period, anchor) || { from: customFrom, to: customTo });

/** Does a row's date fall inside `range`? A null range accepts everything. */
export const inWindow = (value, range) => {
  if (!range) return true;
  const d = String(value || '').slice(0, 10);
  if (!d) return false;          // undated row cannot belong to a period
  return (!range.from || d >= range.from) && (!range.to || d <= range.to);
};

/**
 * The whole period control as one value: state, the props the navigator wants,
 * the resolved window, and the row predicate.
 *
 *   const period = usePeriodFilter();
 *   <PeriodNavigator allowAll {...period.navProps} />
 *   rows.filter(r => period.match(r.bill_date))
 *
 * Defaults to 'all' because LIST pages must not silently hide rows — an
 * analytics page opening on "this month" is a report; a Bills page doing it
 * looks like missing data. Analytics callers pass their own initial period.
 */
// `init` lets a caller seed the whole window, not just the period name, so a
// page that keeps its filters in the URL can restore exactly what was showing
// -- which month, which financial year, which custom range. Every field is
// optional and falls back to what this hook always used, so the callers that
// pass nothing behave exactly as before.
export function usePeriodFilter(initial = 'all', init = {}) {
  const [period, setPeriod] = useState(initial);
  const [anchor, setAnchor] = useState(
    init.anchor || (initial === 'fy' ? fyTokenFor(new Date()) : todayISO()));
  const [customFrom, setCustomFrom] = useState(init.customFrom || todayISO());
  const [customTo, setCustomTo] = useState(init.customTo || todayISO());
  const range = effWindow(period, anchor, customFrom, customTo);
  return {
    period, range,
    navProps: { period, setPeriod, anchor, setAnchor, customFrom, customTo, setCustomFrom, setCustomTo },
    match: (value) => inWindow(value, range),
  };
}

// Re-exported so the callers that already import CTRL_H from here keep working;
// the single definition lives in ./controls.js with the rest of the toolbar
// vocabulary.
export { CTRL_H };

export function PeriodNavigator({ period, setPeriod, anchor, setAnchor, customFrom, customTo, setCustomFrom, setCustomTo, allowAll = false }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className={`flex rounded-lg border border-slate-300 overflow-hidden ${CTRL_H}`}>
        {[...(allowAll ? [{ v: 'all', l: 'All' }] : []),
          { v: 'today', l: 'Today' }, { v: 'week', l: 'Week' }, { v: 'month', l: 'Month' }, { v: 'fy', l: 'FY' }, { v: 'custom', l: 'Custom' }].map((p, i) => (
          <button key={p.v} type="button" onClick={() => { setPeriod(p.v); setAnchor(p.v === 'fy' ? fyTokenFor(new Date()) : todayISO()); }}
            title={p.v === 'fy' ? 'Financial year (1 Apr – 31 Mar)' : undefined}
            className={`px-2.5 text-xs ${i > 0 ? 'border-l border-slate-200' : ''} ${period === p.v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{p.l}</button>
        ))}
      </div>
      {period === 'today' && (
        <CustomDatePicker value={anchor} onChange={e => setAnchor(e.target.value || todayISO())} max={todayISO()}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white max-w-[150px] ${CTRL_H}`} />
      )}
      {period === 'week' && (
        <CustomSelect value={weekRangeOf(anchor).from} onChange={e => setAnchor(e.target.value)}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white max-w-[190px] ${CTRL_H}`} title="Select week">
          {weekOptions().map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </CustomSelect>
      )}
      {period === 'month' && (
        <CustomSelect value={monthRangeOf(anchor).from} onChange={e => setAnchor(e.target.value)}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white max-w-[140px] ${CTRL_H}`} title="Select month">
          {monthOptions().map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </CustomSelect>
      )}
      {period === 'fy' && (
        <CustomSelect value={anchor} onChange={e => setAnchor(e.target.value)}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white max-w-[210px] ${CTRL_H}`} title="Select financial year / half">
          {fyOptions().map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </CustomSelect>
      )}
      {period === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs">
          <CustomDatePicker value={customFrom} onChange={e => setCustomFrom(e.target.value)} max={customTo}
            className={`border border-slate-300 rounded px-2 text-xs ${CTRL_H}`} />
          <span className="text-slate-400">to</span>
          <CustomDatePicker value={customTo} onChange={e => setCustomTo(e.target.value)} min={customFrom} max={todayISO()}
            className={`border border-slate-300 rounded px-2 text-xs ${CTRL_H}`} />
        </div>
      )}
    </div>
  );
}
