import useLookup from '../../hooks/useLookup.js';

// Short labels, identical to the Purchase Analytics header chips.
const shortName = (label) =>
  /biochem/i.test(label) ? 'SS Biochem'
  : /united\s*agro/i.test(label) ? 'United Agro'
  : label;

/**
 * Company quick-switch pills — SS Biochem / United Agro — styled to match the
 * Purchase Analytics header exactly. Drop it into a PageHeader's `actions.right`
 * so it sits compact in the top-right (NOT a big full-width row).
 *
 * Filters by company NAME (what every list row carries as `company_name`); click
 * the active chip again to clear (= all companies).
 *
 *   value     selected company name ('' = all)
 *   onChange  (name) => void
 */
export default function CompanyToggle({ value, onChange, className = '' }) {
  const { options } = useLookup('/api/companies/');
  const bio = (options || []).find((c) => /biochem/i.test(c.label));
  const uai = (options || []).find((c) => /united\s*agro/i.test(c.label));
  const quick = [...(bio ? [bio] : []), ...(uai ? [uai] : [])];
  if (!quick.length) return null;
  return (
    <div className={`flex items-center gap-1.5 shrink-0 ${className}`}>
      {quick.map((c) => {
        const active = String(value || '') === String(c.label);
        return (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange(active ? '' : c.label)}
            title={c.label}
            className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${
              active
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'
            }`}
          >
            {shortName(c.label)}
          </button>
        );
      })}
    </div>
  );
}
