// Global company chips — pick a company and it sticks across the whole app.
// Place in a page header; it reads/writes the shared global company filter.
import { useGlobalCompany } from '../../hooks/useGlobalCompany.js';

// Short label for a company (trade name if set, else a tidy legal name).
const shortName = (c) => c.trade_name || c.legal_name || c.company_code || '—';

export default function CompanyFilter({ className = '', onDark = false }) {
  const { company, setCompany, companies } = useGlobalCompany();
  if (!companies || companies.length < 2) return null;  // nothing to switch

  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`}>
      {companies.map((c) => {
        const active = String(company) === String(c.id);
        // On a dark/teal band the chips invert: active = solid white with teal
        // text (so it reads), inactive = translucent white outline.
        const cls = onDark
          ? (active
              ? 'bg-white text-[#12463c] border-white shadow-sm'
              : 'bg-white/10 text-white border-white/40 hover:bg-white/20')
          : (active
              ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
              : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600');
        return (
          <button key={c.id} type="button"
            // Toggle: clicking the active company deselects it → all companies.
            onClick={() => setCompany(active ? '' : String(c.id))}
            title={c.legal_name}
            className={`px-2.5 py-1.5 ${onDark ? 'rounded' : 'rounded-lg'} text-xs font-semibold border transition whitespace-nowrap ${cls}`}>
            {shortName(c)}
          </button>
        );
      })}
    </div>
  );
}
