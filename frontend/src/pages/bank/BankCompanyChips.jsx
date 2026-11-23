// Always-visible company chips (SS Biochem / United Agro / …) that scope a bank
// view to one company — mirrors the company quick-toggle on the Purchase/Sales
// dashboards. Presentational: pass the companies that actually have bank data.
import { Building2 } from 'lucide-react';

// Friendly short labels for the two known companies; anything else shows as-is.
export const shortCompany = (label) =>
  /biochem/i.test(label || '') ? 'SS Biochem'
    : /united\s*agro/i.test(label || '') ? 'United Agro'
      : (label || '');

export default function BankCompanyChips({ options = [], value = '', onChange, className = '' }) {
  if (!options || options.length === 0) return null;
  const chip = (active) =>
    `px-3 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active
      ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
      : 'bg-white text-slate-700 border-slate-200 hover:border-blue-300 hover:text-blue-600'}`;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-slate-400 font-medium mr-1">
        <Building2 size={13} /> Company
      </span>
      <button type="button" onClick={() => onChange('')} className={chip(!value)}>All</button>
      {options.map((o) => {
        const val = String(o.value);
        const active = String(value) === val;
        return (
          <button key={val} type="button" title={o.label}
            onClick={() => onChange(active ? '' : val)} className={chip(active)}>
            {shortCompany(o.label)}
          </button>
        );
      })}
    </div>
  );
}
