/**
 * Sales-module UOM dropdown options.
 *
 * One curated list, used by every UOM <select> inside src/pages/sales.
 * Other modules (Master, Purchase, Inventory, etc.) keep their own
 * conventions — this file ONLY drives the sales side, per the
 * standardisation ask.
 *
 * Order: the four primary units sales actually trades in
 * (MTS / KG / NOS / LTRS) come first, then bulk + grouping units,
 * then mass / volume sub-divisions.
 */

export const SALES_UOM_OPTIONS = [
  // Primary trading units — MTS is the canonical abbreviation for
  // metric tons across the sales module. (TON / MT were dropped per
  // user instruction since all three mean the same thing; keeping
  // them all just cluttered the dropdown.)
  { value: 'MTS',  label: 'MTS — Metric Tons' },
  { value: 'KG',   label: 'KG — Kilograms' },
  { value: 'NOS',  label: 'NOS — Number / Pieces' },
  { value: 'LTRS', label: 'LTRS — Litres (bulk)' },

  // Bulk / grouping. Packaging-shape units (DRUM, BUCKET, POUCH,
  // CARTON) were removed — they appear inside product names already
  // (e.g. "EMP 5 KG BUCKET"), so the UOM column stays dimensional
  // (mass / count / volume) and doesn't duplicate the shape.
  { value: 'BAG',  label: 'BAG' },
  { value: 'BOX',  label: 'BOX' },
  { value: 'SET',  label: 'SET' },
  { value: 'PCS',  label: 'PCS — Pieces' },

  // Smaller-volume / mass sub-divisions
  { value: 'LTR',  label: 'LTR — Litre (singular)' },
  { value: 'ML',   label: 'ML — Millilitres' },
  { value: 'GM',   label: 'GM — Grams' },
];

/** Just the canonical values, in case a caller needs `Set` membership. */
export const SALES_UOM_VALUES = SALES_UOM_OPTIONS.map(o => o.value);
