// Shared module → category helpers.
//
// The RBAC API returns each module/permission with a `module_slug` but the
// `category` field is often blank, so we resolve a category from the slug.
// (The role permissions grid keeps its own copy of this map for the editable
// grid; this util is the reusable one for read-only groupings like the user
// detail page.)

export const SLUG_CATEGORY = {
  'company': 'MASTERS', 'warehouse': 'MASTERS', 'godown': 'MASTERS', 'machinery': 'MASTERS',
  'product': 'MASTERS', 'service-catalogue': 'MASTERS', 'vendor': 'MASTERS', 'customer': 'MASTERS',
  'transporter': 'MASTERS', 'price-list': 'MASTERS', 'tax-master': 'MASTERS', 'template': 'MASTERS',
  'purchase-request': 'PURCHASE', 'rfq': 'PURCHASE', 'quote': 'PURCHASE', 'quote-evaluation': 'PURCHASE',
  'purchase-order': 'PURCHASE', 'receipt-advice': 'PURCHASE', 'vendor-bill': 'PURCHASE',
  'payment-made': 'PURCHASE', 'vendor-credit': 'PURCHASE', 'vendor-dues': 'PURCHASE',
  'freight-advice': 'FREIGHT', 'freight-payment': 'FREIGHT', 'wage-entry': 'FREIGHT',
  'customer-po': 'SALES', 'sales-order': 'SALES', 'dispatch-challan': 'SALES',
  'sales-invoice': 'SALES', 'receivable': 'SALES',
  'sales-dashboard': 'SALES', 'sales-flow-dashboard': 'SALES',
  'sales-freight': 'SALES',
  'bom-request': 'PRODUCTION', 'work-order': 'PRODUCTION', 'wage-voucher': 'PRODUCTION',
  'material-issue': 'PRODUCTION', 'yield-log': 'PRODUCTION',
  'qc-parameter': 'QUALITY', 'qc-request': 'QUALITY', 'qc-lab-job': 'QUALITY',
  'qc-report': 'QUALITY', 'counter-sample': 'QUALITY',
  'inventory-ledger': 'INVENTORY', 'stock-transfer': 'INVENTORY',
  'shifting': 'INVENTORY', 'job-work-order': 'INVENTORY',
  'sales-return': 'INVENTORY', 'stock-adjustment': 'INVENTORY',
  'vendor-ledger': 'FINANCE', 'customer-ledger': 'FINANCE', 'payment-advice': 'FINANCE',
  'bank-statement': 'FINANCE', 'credit-debit-note': 'FINANCE', 'gst-report': 'FINANCE',
  'petty-cash': 'FINANCE', 'freight-ledger': 'FINANCE', 'wage-ledger': 'FINANCE',
  'expense-ledger': 'FINANCE', 'petty-cash-ledger': 'FINANCE',
  'staff': 'HR', 'shift': 'HR', 'attendance': 'HR', 'leave': 'HR', 'overtime': 'HR', 'payroll': 'HR',
  'dashboard': 'ADMIN', 'audit-log': 'ADMIN', 'user-management': 'ADMIN',
  'role-management': 'ADMIN', 'permission-management': 'ADMIN', 'email-template': 'ADMIN',
};

export const CATEGORY_LABELS = {
  SALES: 'SALES',
  PURCHASE: 'PURCHASE',
  FREIGHT: 'FREIGHT / WAGE BILLING',
  PRODUCTION: 'PRODUCTION',
  QUALITY: 'QUALITY',
  INVENTORY: 'INVENTORY',
  FINANCE: 'FINANCE',
  HR: 'HR',
  MASTERS: 'MASTERS',
  ADMIN: 'ADMIN',
  OTHER: 'OTHER',
};

// Display order for read-only groupings (includes SALES + OTHER).
export const CATEGORY_ORDER = [
  'SALES', 'PURCHASE', 'FREIGHT', 'PRODUCTION', 'QUALITY',
  'INVENTORY', 'FINANCE', 'HR', 'MASTERS', 'ADMIN', 'OTHER',
];

// Resolve a category code from a slug (and optional API category).
export function categoryForSlug(slug, apiCategory) {
  return apiCategory || SLUG_CATEGORY[slug] || 'OTHER';
}

/**
 * Bucket `items` into ordered category groups.
 * @param {Array} items
 * @param {(item) => string} getCategory — returns the category code for an item
 * @returns {Array<{ key, label, items }>} groups in CATEGORY_ORDER (extras last)
 */
export function groupByCategory(items, getCategory) {
  const buckets = {};
  for (const it of items) {
    const cat = getCategory(it);
    (buckets[cat] = buckets[cat] || []).push(it);
  }
  const groups = [];
  for (const cat of CATEGORY_ORDER) {
    if (buckets[cat]?.length) {
      groups.push({ key: cat, label: CATEGORY_LABELS[cat] || cat, items: buckets[cat] });
      delete buckets[cat];
    }
  }
  for (const [cat, list] of Object.entries(buckets)) {
    if (list.length) groups.push({ key: cat, label: CATEGORY_LABELS[cat] || cat, items: list });
  }
  return groups;
}
