// Shared item-name normaliser — used by every purchase view that lists/charts
// products, so a Tamil/Hindi master name never leaks to the UI and the same raw
// material isn't split a dozen ways.
//
// Collapses the many spellings of RAW neem seed/fruit — English (Neem Seed /
// Fruit / Seeds / Kernel / "Neem Fruit-Seed - SLP"), Tamil (வேப்பபழம் / நீம),
// Hindi (नीम / लिंब / Limbodi / Limdi) — into ONE English name. PROCESSED neem
// (Oil / Cake / Concentrate / Extract / Azadirachtin) stays separate — it's a
// different product.
export function itemDisplay(name) {
  const s = String(name ?? '').trim();
  const low = s.toLowerCase();
  const isNeem = /neem|limbod|limdi|limbd/.test(low) || /வேப்ப|வேம்ப|நீம|नीम|लिंब/.test(s);
  if (!isNeem) return s || '—';
  if (/\boil\b|cake|de-?oil|deoil|concentrat|extract|azadiracht|technical|powder/.test(low)) return s;
  return 'Neem Seed / Fruit';
}

export default itemDisplay;
