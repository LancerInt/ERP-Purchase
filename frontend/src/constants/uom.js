/**
 * Canonical UOM (unit-of-measure) list for product / line-item dropdowns
 * across the Purchase and Master modules.
 *
 * Keep this list authoritative — every UOM <select> in purchase requests,
 * RFQs, quotes, POs, receipts, bills, vendor credits, rejections, the
 * product master, and the price list pulls from here. If a UOM is added
 * or removed it should happen ONCE in this file and reflect everywhere.
 *
 * Note: warehouse / godown CAPACITY UOM (CBM, SQM, UNIT) is a different
 * concept (cubic-meter storage volume vs. sale-unit per item) and is NOT
 * sourced from this list.
 */
export const UOM_VALUES = [
  'MTS',
  'KG',
  'NOS',
  'LTRS',
  'BAG',
  'BOX',
  'SET',
  'PCS',
  'LTR',
  'ML',
  'GM',
];

export const UOM_OPTIONS = UOM_VALUES.map((v) => ({ value: v, label: v }));
