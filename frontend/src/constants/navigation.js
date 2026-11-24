/**
 * Single source of truth for app navigation.
 *
 * Both the desktop Sidebar and the mobile bottom-tab nav consume
 * NAV_SECTIONS, so a module added here shows up in both. Each section
 * also carries a `groupIcon` (for the bottom-tab bar) and a `defaultPath`
 * (where a role lands when this is their primary module).
 *
 * Role logic:
 *   - ROLE_PRIMARY maps a role name -> the section it should open into.
 *   - getRoleNavOrder() hoists that section to the front so it's the
 *     first bottom tab (role-adaptive tabs).
 *   - getLandingPath() returns the post-login destination for a role.
 */
import {
  LayoutDashboard, ShoppingCart, Package, DollarSign,
  BarChart3, Settings,
  FileText, Send, MessageSquare, ClipboardCheck, Truck, Receipt,
  CreditCard, FileCheck, Users, Building2, Factory, Box,
  UserCircle, Mail, Briefcase, Shield,
  Warehouse, Tags, Calculator, BookOpen, Wrench, Handshake, Map,
  GitBranch, CalendarDays, ArrowDownLeft, ArrowUpRight, Wallet,
  TrendingUp, Database, BadgeCheck, Repeat, AlertTriangle, Archive,
  Coins, ScanLine, FlaskConical, Percent, Download,
} from 'lucide-react';

export const NAV_SECTIONS = [
  {
    id: 'freight_wage',
    label: 'FREIGHT/WAGE BILLING',
    tabLabel: 'Freight',
    groupIcon: Truck,
    items: [
      { name: 'Analytics', path: '/freight/dashboard', module: 'Freight Analytics', icon: BarChart3 },
      // ONE Freight entry — the list page already carries Inward / Outward /
      // Local as tabs, so three separate sidebar items were redundant. The
      // dedicated direction routes still exist for the tabs and deep links.
      { name: 'Freight', path: '/freight/inward', module: 'Freight Advice', icon: Truck },
      { name: 'Freight Bills', path: '/freight/bills', module: 'Freight Advice', icon: Receipt },
      { name: 'Two-way', path: '/freight/two-way', module: 'Freight Advice', icon: Repeat },
      { name: 'Lorry Freight Review', path: '/freight/lorry-review', module: 'Sales Freight', icon: Truck },
      { name: 'Loading/Unloading Wages', path: '/freight/wages', module: 'Wage Entry', icon: Users },
      { name: 'Wage Payments', path: '/freight/wages/payments', module: 'Wage Payment', icon: CreditCard },
      { name: 'Freight Payments', path: '/freight/payments', module: 'Freight Payment', icon: CreditCard },
      // Payee Mappings moved to Import Data › Mappings (/import/mappings).
    ],
  },
  {
    // Reports — cross-module read-only views. Sits above Purchase per the
    // owner's layout. Vendor-Customer is the home for the sales-offset figures
    // that used to crowd the Bills list; the Purchase/Sales/Freight/Expense
    // reports land here next.
    id: 'reports',
    label: 'REPORTS',
    tabLabel: 'Reports',
    groupIcon: BarChart3,
    items: [
      { name: 'Vendor-Customer', path: '/reports/vendor-customer', module: 'Vendor-Customer', icon: Handshake },
      { name: 'Reports', path: '/reports/summary', module: 'Reports', icon: BarChart3 },
      // Moved here from Import Data (same /import/ledgers page). Now gated by
      // its own 'Ledger' module (REPORTS category) — grandfathered from
      // 'Import Data' so existing access is preserved.
      { name: 'Ledger', path: '/import/ledgers', module: 'Ledger', icon: BookOpen },
      // Moved here from Finance (same /finance/deviations page). Keeps its
      // own 'Deviations' module gate so access doesn't change.
      { name: 'Deviations', path: '/finance/deviations', module: 'Deviations', icon: AlertTriangle },
    ],
  },
  {
    // Sourcing — the pre-bill procurement cycle owned by warehouse staff and
    // the purchase coordinator: request -> RFQ -> quotes -> evaluate -> PO ->
    // receive. (Routes stay under /purchase/* so links are unchanged.)
    id: 'sourcing',
    label: 'SOURCING',
    tabLabel: 'Sourcing',
    groupIcon: Send,
    items: [
      { name: 'Requests (PR)', path: '/purchase/requests', module: 'Purchase Request', icon: FileText },
      { name: 'RFQ', path: '/purchase/rfq', module: 'RFQ', icon: Send },
      { name: 'Quotes', path: '/purchase/quotes', module: 'Quote', icon: MessageSquare },
      { name: 'Evaluations', path: '/purchase/evaluations', module: 'Quote Evaluation', icon: ClipboardCheck },
      { name: 'Orders (PO)', path: '/purchase/orders', module: 'Purchase Order', icon: ShoppingCart },
      { name: 'Receipts', path: '/purchase/receipts', module: 'Receipt Advice', icon: Package },
    ],
  },
  {
    id: 'purchase',
    label: 'PURCHASE',
    tabLabel: 'Purchase',
    groupIcon: ShoppingCart,
    items: [
      { name: 'Analytics', path: '/purchase/dashboard', module: 'Purchase Analytics', icon: BarChart3 },
      { name: 'Vendor Insights', path: '/purchase/vendor-insights', module: 'Vendor Insights', icon: Users },
      { name: 'Bills', path: '/purchase/bills', module: 'Vendor Bill', icon: Receipt },
      // Scan Inbox lives under its own IMPORT DATA group (data ingestion).
      // 'Expense Reconcile' removed from the menu (route kept so old links don't 404).
      // Standalone (no Tally): Email Bill Inbox, Mappings removed.
      { name: 'Payment Entries', path: '/purchase/payment-entries', module: 'Payment Entries', icon: CreditCard },
      { name: 'Stock', path: '/purchase/stock', module: 'Stock', icon: Box },
      { name: 'Reports', path: '/purchase/reports', module: 'Consolidated Report', icon: BarChart3 },
    ],
  },
  {
    // Freight — inward (material coming in) + local freight, owned by the
    // purchase/logistics side. Uses the existing freight pages.
    id: 'freight',
    label: 'FREIGHT',
    tabLabel: 'Freight',
    groupIcon: Truck,
    items: [
      // One tabbed Freight page (Inward / Local tabs, like Bills) + Payments + Analytics.
      { name: 'Freight', path: '/freight/inward', module: 'Freight Advice', icon: Truck },
      { name: 'Freight Payments', path: '/freight/payments', module: 'Freight Payment', icon: CreditCard },
      { name: 'Analytics', path: '/freight/dashboard', module: 'Freight Analytics', icon: BarChart3 },
    ],
  },
  {
    // Tax / Compliance — month-end filing tasks owned by accounts, not the
    // purchase team: they read purchase data but exist for GST/TDS returns.
    id: 'tax',
    label: 'TAX / COMPLIANCE',
    tabLabel: 'Tax',
    groupIcon: Percent,
    items: [
      { name: 'GST 2B Match', path: '/purchase/gst2b', module: 'GST 2B Match', icon: FileCheck },
      { name: 'TDS Summary', path: '/purchase/tds', module: 'TDS Summary', icon: Percent },
    ],
  },
  {
    // Import Data — every data-ingestion flow in one place. Scan Inbox and
    // Payments Made MOVED here from Purchase (old /purchase/* routes still
    // redirect). Gated by the single 'Import Data' module (migration 0063).
    id: 'import_data',
    label: 'IMPORT DATA',
    tabLabel: 'Import',
    groupIcon: Database,
    items: [
      // Standalone (no Tally): Scan Inbox (invoice OCR) + Payments Made.
      // Overview, Mappings, bank-statement import and the Tally Import pages
      // removed (they need the Tally/finance plumbing not shipped here).
      { name: 'Scan Inbox', path: '/import/scan', module: 'Import Scan Inbox', icon: ScanLine },
      // Payments Made moved to the FINANCE group (it's an accounts task).
    ],
  },
  {
    id: 'sales',
    label: 'SALES',
    tabLabel: 'Sales',
    groupIcon: TrendingUp,
    items: [
      { name: 'Dashboard', path: '/sales/overview', module: 'Sales Dashboard', icon: LayoutDashboard },
      { name: 'Analytics', path: '/sales/dashboard', module: 'Sales Analytics', icon: BarChart3 },
      { name: 'Customer Insights', path: '/sales/customer-insights', module: 'Customer Insights', icon: Users },
      { name: 'Customer 360', path: '/sales/customer-360', module: 'Customer Insights', icon: Users },
      { name: 'Company 360', path: '/sales/company-360', module: 'Customer Insights', icon: Building2 },
      { name: 'Sales Quote', path: '/sales/quotes', module: 'Sales Quote', icon: MessageSquare },
      { name: 'Customer PO', path: '/sales/customer-po', module: 'Customer PO', icon: FileText },
      { name: 'Sales Orders', path: '/sales/orders', module: 'Sales Order', icon: ShoppingCart },
      { name: 'Multi-PO Sales Order', path: '/sales/orders/multi-po', module: 'Sales Order', icon: GitBranch },
      { name: 'Flow Dashboard', path: '/sales/flow', module: 'Sales Flow Dashboard', icon: GitBranch },
      { name: 'Dispatch Challan', path: '/sales/dc', module: 'Dispatch Challan', icon: Truck },
      { name: 'Invoice', path: '/sales/invoices', module: 'Sales Invoice', icon: Receipt },
      { name: 'Debit / Credit Notes', path: '/sales/debit-notes', module: 'Sales Invoice', icon: FileText },
      { name: 'GSTR-1 Match', path: '/sales/gstr1', module: 'GSTR-1 Match', icon: FileCheck },
      { name: 'E-Way Bill Check', path: '/sales/ewb-einvoice', module: 'E-Way Bill Check', icon: Truck },
      { name: 'Receivables', path: '/sales/receivables', module: 'Receivable', icon: DollarSign },
      { name: 'Receipts', path: '/sales/receipts', module: 'Receipts', icon: Wallet },
      { name: 'Debtors', path: '/sales/debtors', module: 'Debtors', icon: Percent },
      { name: 'Ledger', path: '/sales/ledger', module: 'Receivable', icon: BookOpen },
      { name: 'TDS 194Q', path: '/sales/tds', module: 'Receivable', icon: Percent },
      { name: 'Customer Advances', path: '/sales/advances', module: 'Receivable', icon: Wallet },
    ],
  },
  {
    id: 'bank',
    label: 'BANK',
    tabLabel: 'Bank',
    groupIcon: Building2,
    items: [
      { name: 'Dashboard', path: '/bank/dashboard', module: 'Bank Dashboard', icon: LayoutDashboard },
      { name: 'Bank Accounts', path: '/bank/accounts', module: 'Bank Account', icon: Building2 },
      { name: 'Sales · Receipts', path: '/bank/receipts', module: 'Bank Receipt', icon: ArrowDownLeft },
      { name: 'Purchase · Payments', path: '/bank/payments', module: 'Bank Payment', icon: ArrowUpRight },
      { name: 'Transfers', path: '/bank/transfers', module: 'Bank Payment', icon: Repeat },
      { name: 'Reconcile Statement', path: '/bank/reconcile', module: 'Reconcile Statement', icon: FileCheck },
    ],
  },
  {
    id: 'production',
    label: 'PRODUCTION',
    tabLabel: 'Production',
    groupIcon: Factory,
    items: [
      { name: 'BOM', path: '/production/bom', module: 'BOM Request', icon: ClipboardCheck },
      { name: 'Processes', path: '/production/processes', module: 'Process', icon: Settings },
      { name: 'Work Orders', path: '/production/work-orders', module: 'Work Order', icon: Briefcase },
      { name: 'Packing Process', path: '/production/packing-processes', module: 'Packing Process', icon: Package },
      { name: 'Wage Vouchers', path: '/production/wage-vouchers', module: 'Wage Voucher', icon: CreditCard },
      { name: 'Material Issues', path: '/production/material-issues', module: 'Material Issue', icon: Package },
      { name: 'Damage', path: '/production/damage', module: 'Production Damage', icon: AlertTriangle },
      { name: 'Gate Register', path: '/production/gate-register', module: 'Gate Register', icon: Truck },
      { name: 'Shift Labor', path: '/production/shift-labor', module: 'Shift Labor', icon: Users },
      { name: 'Daily Report (DPR)', path: '/production/dpr', module: 'Work Order', icon: ClipboardCheck },
      // ── Extraction submodule (SLP PLANT Azadirachtin workflow) ──
      // Locally wired only — pull this line into its own commit
      // before shipping so the sidebar entry doesn't appear on prod
      // until the extraction pages are signed off. Piggybacks on the
      // 'Work Order' module permission so RBAC-restricted users see
      // it the same as other production entries.
      { name: 'Extraction (SLP PLANT)', path: '/production/extraction/manufacturing-batches', module: 'Work Order', icon: FlaskConical },
    ],
  },
  {
    id: 'quality',
    label: 'QUALITY',
    tabLabel: 'Quality',
    groupIcon: BadgeCheck,
    items: [
      { name: 'QC Params', path: '/quality/params', module: 'QC Parameter', icon: Settings },
      { name: 'QC Requests', path: '/quality/requests', module: 'QC Request', icon: FileText },
      { name: 'Lab Jobs', path: '/quality/lab-jobs', module: 'QC Lab Job', icon: Briefcase },
      { name: 'Reports', path: '/quality/reports', module: 'QC Report', icon: BarChart3 },
      { name: 'Counter Samples', path: '/quality/counter-samples', module: 'Counter Sample', icon: Box },
    ],
  },
  {
    id: 'inventory',
    label: 'SHIFTING PURPOSE',
    tabLabel: 'Shifting',
    groupIcon: Repeat,
    items: [
      { name: 'Stock Ledger', path: '/inventory/stock-ledger', module: 'Inventory Ledger', icon: BookOpen },
      { name: 'Production Stock', path: '/inventory/production-stock', module: 'Production Stock', icon: Box },
      { name: 'Production Entries', path: '/inventory/production-entries', module: 'Production Entry', icon: GitBranch },
      { name: 'Additional Wages', path: '/production/additional-wages', module: 'Wage Voucher', icon: CreditCard },
      { name: 'Wages Ledger', path: '/production/wages-ledger', module: 'Additional Wages', icon: CreditCard },
      { name: 'Movement Requests', path: '/inventory/stock-movement', module: 'Stock Movement Request', icon: Repeat },
      { name: 'Transfers', path: '/inventory/transfers', module: 'Stock Transfer', icon: Truck },
      { name: 'Shifting', path: '/inventory/shifting', module: 'Shifting', icon: Package },
      { name: 'Job Work', path: '/inventory/job-work', module: 'Job Work Order', icon: Briefcase },
      { name: 'Returns', path: '/inventory/returns', module: 'Sales Return', icon: FileCheck },
      { name: 'Adjustments', path: '/inventory/adjustments', module: 'Stock Adjustment', icon: Calculator },
    ],
  },
  {
    id: 'finance',
    label: 'FINANCE',
    tabLabel: 'Finance',
    groupIcon: Wallet,
    items: [
      // Standalone finance/accounts pages that work on purchase data (no Tally,
      // no separate ledger tables). Full ERP's GST / petty cash / customer /
      // expense ledgers need the finance backend not shipped here.
      { name: 'Payments Made', path: '/import/payments', module: 'Import Payments Made', icon: CreditCard },
      { name: 'Vendor Ledger', path: '/finance/vendor-ledger', module: 'Vendor Ledger', icon: BookOpen },
      { name: 'Vendor Dues', path: '/purchase/vendor-dues', module: 'Vendor Dues', icon: DollarSign },
      { name: 'Vendor Notes & Advances', path: '/purchase/vendor-credits', module: 'Vendor Credit', icon: FileCheck },
    ],
  },
  {
    id: 'expenses',
    label: 'EXPENSES',
    tabLabel: 'Expenses',
    groupIcon: Coins,
    items: [
      { name: 'Analytics', path: '/expenses/analytics', module: 'Expense Register', icon: BarChart3 },
      { name: 'Expenses', path: '/purchase/expenses', module: 'Expense Register', icon: Coins },
      { name: 'Expense Bills', path: '/expenses/bills', module: 'Expense Register', icon: Receipt },
      { name: 'Imprest', path: '/expenses/imprest', module: 'Imprest', icon: CreditCard },
      { name: 'Voucher', path: '/expenses/voucher', module: 'Voucher', icon: Wallet },
      { name: 'Expense Register', path: '/expenses/register', module: 'Expense Register', icon: BookOpen },
      { name: 'Spend by Category', path: '/expenses/spend-by-category', module: 'Expense Register', icon: BarChart3 },
      { name: 'Consumables', path: '/expenses/consumables', module: 'Consumables', icon: Package },
      // Relocated from Masters — machinery expense heads live with the rest of
      // the expense workflow. Route/model unchanged; only the nav grouping moved.
      { name: 'Machinery Expense', path: '/masters/machinery-expense', module: 'Machinery Expense', icon: Receipt },
    ],
  },
  {
    id: 'hr',
    label: 'HR',
    tabLabel: 'HR',
    groupIcon: Users,
    items: [
      // Standalone carve-out: only the Staff page has a backend here;
      // attendance / leave / overtime / shifts / payroll are not shipped.
      { name: 'Staff', path: '/hr/staff', module: 'Staff', icon: Users },
    ],
  },
  {
    id: 'masters',
    label: 'MASTERS',
    tabLabel: 'Master',
    groupIcon: Database,
    defaultCollapsed: true,
    items: [
      { name: 'Company', path: '/masters/company', module: 'Company', icon: Building2 },
      { name: 'Warehouse', path: '/masters/warehouse', module: 'Warehouse', icon: Warehouse },
      { name: 'Godown', path: '/masters/godown', module: 'Godown', icon: Box },
      // Machinery master retired — machine spares live in the Products master
      // (product_type=MACHINERY). Machinery Division stays (products reference it).
      { name: 'Machinery Division', path: '/masters/machinery-division', module: 'Machinery Division', icon: GitBranch },
      { name: 'Products', path: '/masters/products', module: 'Product', icon: Package },
      { name: 'Vendors', path: '/masters/vendor', module: 'Vendor', icon: Users },
      { name: 'Transporters', path: '/masters/transporter', module: 'Transporter', icon: Truck },
      // Standalone (purchase-focused): Brokers, Customers, Price List, State
      // Groups, Tax, Templates, Service Catalogue removed from the menu.
    ],
  },
  {
    id: 'admin',
    label: 'ADMIN',
    tabLabel: 'Admin',
    groupIcon: Shield,
    defaultCollapsed: true,
    adminOnly: true,
    items: [
      { name: 'Users', path: '/admin/users', module: 'User Management', icon: Users },
      { name: 'Roles', path: '/admin/roles', module: 'Role Management', icon: Shield },
      { name: 'Permissions', path: '/admin/permissions', module: 'Permission Management', icon: Shield },
      { name: 'Audit Logs', path: '/admin/audit-logs', module: 'Audit Log', icon: BookOpen },
    ],
  },
  {
    id: 'archive',
    label: 'ARCHIVE',
    tabLabel: 'Archive',
    groupIcon: Archive,
    defaultCollapsed: true,
    // No `module` on the item → always visible: every user has their own
    // archive of things they deleted (admins / granted users see everyone's).
    items: [
      { name: 'Deleted Items', path: '/archive', icon: Archive },
    ],
  },
];

// --- Standalone carve-out: this app only ships Admin (Users/Roles),
// Masters, and HR Staff. Hide every other module from the sidebar so the
// nav matches what actually has a backend here. Mutate in place so the
// SECTION_BY_ID map and all helpers below see the trimmed list.
const STANDALONE_SECTION_IDS = ['sourcing', 'purchase', 'freight', 'finance', 'tax', 'import_data', 'masters', 'hr', 'admin'];
NAV_SECTIONS.splice(
  0,
  NAV_SECTIONS.length,
  ...NAV_SECTIONS.filter((s) => STANDALONE_SECTION_IDS.includes(s.id)),
);

// Each section's default destination = its first item.
NAV_SECTIONS.forEach((s) => { s.defaultPath = s.items[0]?.path; });

const SECTION_BY_ID = Object.fromEntries(NAV_SECTIONS.map((s) => [s.id, s]));

// Role name (lowercased) -> section id the role primarily works in.
export const ROLE_PRIMARY = {
  'purchase manager': 'purchase',
  // Sourcing (PR -> RFQ -> quotes -> evaluate -> PO -> receive) is owned by the
  // purchase coordinator and warehouse staff, so they land there on login.
  'purchase coordinator': 'sourcing',
  'warehouse manager': 'sourcing',
  'warehouse coordinator': 'sourcing',
  'warehouse supervisor': 'sourcing',
  'warehouse coordinator (office)': 'sourcing',
  'sales manager': 'sales',
  'sales coordinator': 'sales',
  'finance manager': 'finance',
  'accounts manager': 'finance',
  'freight coordinator': 'freight_wage',
  'qc manager': 'quality',
  'qc coordinator': 'quality',
  'qc analyst': 'quality',
  'production manager': 'production',
  'production coordinator': 'production',
  'hr coordinator (office)': 'hr',
  'warehouse hr coordinator': 'hr',
  'office manager': 'sales',
  'it admin': 'admin',
};

// Default left-to-right order of the bottom tabs (before the role's
// primary module is hoisted to the front).
const DEFAULT_TAB_ORDER = [
  // Explicit owner-requested order for the top of the list:
  // Reports → Import Data → Sales → Purchase → Expenses → Freight,
  // then the remaining modules in their prior relative order.
  'reports', 'import_data', 'sales', 'purchase', 'expenses', 'freight_wage',
  'production', 'quality', 'finance', 'bank', 'inventory', 'masters', 'hr', 'admin',
];

const normaliseRole = (role) =>
  (typeof role === 'string' ? role : role?.role_name || role?.name || '')
    .trim()
    .toLowerCase();

/**
 * Per-role trimmed sidebar menus.
 *
 * Some roles get a hand-curated subset of the sidebar instead of the
 * full permission-filtered list. The map is keyed by the LOWERCASED
 * role name and lists, in display order, which sections appear and
 * which item paths show inside each section (also in display order).
 *
 * NOTE: 'Office Management' is the hand-made role office staff actually
 * hold (distinct from the predefined 'Office Manager' — see
 * backend/apps/core/mixins.py). Only the one listed here is trimmed.
 *
 * This is a UI convenience only — it never grants access. An item still
 * appears only if the role also passes the normal permission check
 * (canView(module)) in the Sidebar, so RBAC stays the source of truth.
 */
export const ROLE_ITEM_WHITELIST = {
  'office management': [
    { section: 'reports', items: [
      '/import/ledgers',        // Ledger
      '/reports/summary',       // Reports
      '/finance/deviations',    // Deviations
    ] },
    { section: 'sales', items: [
      '/sales/dashboard',           // Analytics (Sales Analytics)
      '/sales/customer-insights',   // Customer Insights
      '/sales/invoices',            // Invoice
      '/sales/receipts',            // Receipts
    ] },
    { section: 'purchase', items: [
      '/purchase/dashboard',        // Analytics (Purchase Analytics)
      '/purchase/bills',            // Bills
      '/purchase/payment-entries',  // Payment Entries
      '/purchase/vendor-insights',  // Vendor Insights
    ] },
    { section: 'expenses', items: [
      '/expenses/analytics',        // Analytics (Expense Analytics)
      '/expenses/bills',            // Expense Bills
    ] },
    { section: 'freight_wage', items: [
      '/freight/dashboard',         // Analytics (Freight Analytics)
      '/freight/bills',             // Freight Bills
      '/freight/payments',          // Freight Payments
    ] },
    { section: 'import_data', items: [
      '/import/overview',           // Overview
      '/import/scan',               // Scan Inbox
      '/import/payments',           // Payments Made
      '/import/mappings',           // Mappings
      '/import/sales-tally',        // Sales Tally Import
      '/import/purchase-tally',     // Purchase Tally Import
    ] },
  ],
};

/**
 * If the role has a curated menu, return its ordered sections with only
 * the whitelisted items (each item object comes straight from
 * NAV_SECTIONS, so icon/module/name are preserved). Returns null for
 * roles that should see the normal full, permission-filtered sidebar.
 *
 * Permission filtering is still applied by the Sidebar on top of this.
 */
export function getRoleMenu(role) {
  const spec = ROLE_ITEM_WHITELIST[normaliseRole(role)];
  if (!spec) return null;
  const sections = [];
  for (const { section: sectionId, items: paths } of spec) {
    const section = SECTION_BY_ID[sectionId];
    if (!section) continue;
    // Keep the requested item order, skipping any path that no longer exists.
    const items = paths
      .map((p) => section.items.find((i) => i.path === p))
      .filter(Boolean);
    if (items.length) sections.push({ ...section, items });
  }
  return sections;
}

export function getRolePrimarySectionId(role) {
  return ROLE_PRIMARY[normaliseRole(role)] || 'purchase';
}

/** Section id order for a role: primary first, then the default order. */
export function getRoleNavOrder(role) {
  const primary = getRolePrimarySectionId(role);
  return [primary, ...DEFAULT_TAB_ORDER.filter((id) => id !== primary)];
}

// Admin / superuser preferred section order: these groups surface first
// (owner's layout), then every remaining section in the default order.
// Nothing is hidden — admins keep the full sidebar, just reprioritised.
const ADMIN_NAV_LEAD = ['admin', 'purchase', 'sales', 'expenses', 'freight_wage', 'reports'];

/**
 * Section id order for an admin / superuser: the lead groups above first,
 * then the rest of DEFAULT_TAB_ORDER (minus any already led with), so no
 * section drops off the list.
 */
export function getAdminNavOrder() {
  const rest = DEFAULT_TAB_ORDER.filter((id) => !ADMIN_NAV_LEAD.includes(id));
  // 'admin' isn't in DEFAULT_TAB_ORDER's tail either, so include any
  // remaining known sections explicitly after the default tail.
  const known = NAV_SECTIONS.map((s) => s.id);
  const tail = known.filter((id) => !ADMIN_NAV_LEAD.includes(id) && !rest.includes(id));
  return [...ADMIN_NAV_LEAD, ...rest, ...tail];
}

/** Post-login destination for a role (its primary module's first page). */
export function getLandingPath(role) {
  const section = SECTION_BY_ID[getRolePrimarySectionId(role)];
  return section?.defaultPath || '/purchase/requests';
}

/**
 * First nav page the user can actually view, in role order. Used to
 * redirect a denied user somewhere useful instead of a dead-end
 * "Permission Denied" screen. Returns null if they can view nothing.
 */
export function getFirstAccessiblePath(role, canView) {
  for (const id of getRoleNavOrder(role)) {
    const section = SECTION_BY_ID[id];
    if (!section) continue;
    for (const item of section.items) {
      if (!item.module || canView(item.module)) return item.path;
    }
  }
  return null;
}

/** The section (module) id that owns a given route, or null. */
export function getSectionIdForPath(pathname) {
  const section = NAV_SECTIONS.find((s) =>
    s.items.some((i) => pathname === i.path || pathname.startsWith(i.path + '/')),
  );
  return section?.id || null;
}

export { SECTION_BY_ID };
