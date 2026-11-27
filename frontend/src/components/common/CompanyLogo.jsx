import ssbiochemLogo from '../../assets/logos/ssbiochem.svg';

// Company logo resolver. SS Biochem uses its real brand mark (recolored to the
// app's teal so it reads on cream/white); United Agro (UAI) uses a teal "UAI"
// monogram badge until the real United Agro logo file is supplied — drop that
// file in src/assets/logos/ and add it to LOGOS below to swap it in.
const LOGOS = {
  ssbiochem: ssbiochemLogo,
  // unitedagro: unitedAgroLogo,   // TODO: add the real UAI logo file here
};

// Normalise a company name to a key.
function keyFor(name) {
  const n = String(name || '').toLowerCase();
  if (/biochem/.test(n)) return 'ssbiochem';
  if (/united\s*agro|^uai$|\buai\b/.test(n)) return 'unitedagro';
  return '';
}

/**
 * Renders the company's logo. Falls back to a teal monogram badge when no
 * image is available (e.g. United Agro until its file is added).
 *
 *   name    company name ("SS Biochem", "United Agro", …)
 *   height  pixel height of the logo image (default 34)
 */
export default function CompanyLogo({ name, height = 34, className = '' }) {
  const key = keyFor(name);
  const src = LOGOS[key];

  if (src) {
    return (
      <img
        src={src}
        alt={name || 'Company logo'}
        style={{ height }}
        className={`w-auto ${className}`}
      />
    );
  }

  // Fallback monogram badge (teal) — used for United Agro / unknown companies.
  const mono = /united\s*agro|uai/i.test(name || '') ? 'UAI'
    : (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  return (
    <span
      style={{ height, minWidth: height }}
      className={`inline-flex items-center justify-center rounded-lg bg-primary-600 text-white font-extrabold px-2 text-sm tracking-wide ${className}`}
    >
      {mono}
    </span>
  );
}
