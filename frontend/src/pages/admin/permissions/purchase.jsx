import CustomSelect from "@/components/ui/CustomSelect";
/**
 * Purchase-only Permission Management.
 *
 * Mirror of /admin/permissions/sales scoped to Purchase-category modules.
 * Reads and writes the same RBAC tables (RolePermission /
 * RoleFieldPermission / UserPermissionOverride) — this page is purely a
 * UI restructuring so admins can focus on Purchase without scrolling
 * through every module in the org.
 *
 *   Purchase Module
 *     ├── Page Permissions   (View / Create / Edit / Delete)
 *     ├── Button Permissions (Approve / Reject / Convert / Email …)
 *     ├── Field Permissions  (Hide / Read-only per role per field)
 *     ├── Data Permissions   (per-user warehouse_scope editor)
 *     └── User Overrides     (per-user GRANT/DENY + field overrides)
 *
 * The Data / Override tabs host the same per-user editors as the Sales
 * page (warehouse access and per-user grants are user-level, not
 * per-module) via the shared `sharedUserTabs.jsx` components, so a
 * Purchase admin can manage everything without leaving this page.
 */
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Save, Check, FileText, MousePointer2, Database, Eye, UserCog,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useApiData from '../../../hooks/useApiData.js';
import { DataTab, UserOverridesTab } from './sharedUserTabs.jsx';

// ── Permission definitions ───────────────────────────────────────────
// The shared RolePermission table has the same 14 flags whether the
// module is Sales or Purchase. We split them into Page (CRUD) and
// Button (workflow / utility) buckets for the UI — identical to the
// Sales page. APPLICABLE_BUTTON_PERMS narrows the button grid so the
// admin doesn't see toggles for buttons that don't exist on a given
// page.
const PAGE_PERMS = [
  { key: 'can_view',   label: 'View',   color: 'text-blue-600' },
  { key: 'can_create', label: 'Create', color: 'text-green-600' },
  { key: 'can_edit',   label: 'Edit',   color: 'text-amber-600' },
  { key: 'can_delete', label: 'Delete', color: 'text-red-600' },
];

const BUTTON_PERMS = [
  { key: 'can_approve',         label: 'Approve',        color: 'text-emerald-600' },
  { key: 'can_reject',          label: 'Reject',         color: 'text-rose-600' },
  { key: 'can_submit',          label: 'Submit (PR)',    color: 'text-blue-600' },
  { key: 'can_proceed_approval', label: 'Proceed to Approve (PR)', color: 'text-amber-600' },
  { key: 'can_confirm',         label: 'Confirm',        color: 'text-teal-600' },
  { key: 'can_close',           label: 'Close',          color: 'text-slate-600' },
  { key: 'can_cancel',          label: 'Cancel',         color: 'text-orange-600' },
  { key: 'can_issue',           label: 'Issue',          color: 'text-indigo-600' },
  { key: 'can_convert',         label: 'Convert',        color: 'text-purple-600' },
  { key: 'can_skip_rfq',        label: 'Skip RFQ',       color: 'text-amber-600' },
  { key: 'can_direct_receipt',  label: 'Direct Receipt', color: 'text-amber-600' },
  { key: 'can_request_amendment', label: 'Request Amendment', color: 'text-amber-600' },
  { key: 'can_approve_amendment', label: 'Approve Amendment', color: 'text-emerald-600' },
  { key: 'can_quote_response',  label: 'Quote Response', color: 'text-fuchsia-600' },
  { key: 'can_evaluate',        label: 'Evaluate',       color: 'text-violet-600' },
  { key: 'can_create_bill',     label: 'Bill',           color: 'text-emerald-600' },
  { key: 'can_create_wage',     label: 'Wage',           color: 'text-amber-600' },
  { key: 'can_create_freight',  label: 'Freight',        color: 'text-orange-600' },
  { key: 'can_record_payment',  label: 'Record Payment', color: 'text-green-600' },
  { key: 'can_apply_debit',     label: 'Apply Debit',    color: 'text-purple-600' },
  { key: 'can_apply_credit',    label: 'Apply Credit',   color: 'text-indigo-600' },
  { key: 'can_apply_advance',   label: 'Apply Advance',  color: 'text-teal-600' },
  { key: 'can_apply_to_bill',   label: 'Apply to Vendor Bill', color: 'text-fuchsia-600' },
  { key: 'can_send_email',      label: 'Email',          color: 'text-sky-600' },
  { key: 'can_export',          label: 'Export',         color: 'text-cyan-600' },
  { key: 'can_print',           label: 'Print',          color: 'text-violet-600' },
];

// Per-Purchase-module map of which button permissions correspond to an
// actual button on a real page. Cells outside this set render disabled.
// Maintenance: when a new Purchase button is gated on
// `usePermissions().canXxx('<module>')` in the codebase, add the matching
// flag key here so admins can toggle it.
const APPLICABLE_BUTTON_PERMS = {
  // PR: Approve / Reject on header; Cancel; Export list; Print; legacy
  // generic Convert for the PR→PO direct flow.
  'Purchase Request':   new Set(['can_submit', 'can_proceed_approval', 'can_approve', 'can_reject', 'can_skip_rfq', 'can_cancel', 'can_convert', 'can_export', 'can_print']),
  // RFQ: Send to vendors (Email), capture vendor reply (Quote Response),
  // Cancel/Close after evaluation, Export / Print for vendor packets.
  'RFQ':                new Set(['can_send_email', 'can_quote_response', 'can_close', 'can_cancel', 'can_export', 'can_print']),
  // Quote response: rarely approved on its own — Cancel / Email / Export /
  // Print cover the realistic actions. Evaluate kicks off a Quote
  // Evaluation against a specific quote row.
  'Quote':              new Set(['can_cancel', 'can_evaluate', 'can_send_email', 'can_export', 'can_print']),
  // Evaluation: Approve picks the recommended vendor; Reject sends back
  // for re-evaluation. Convert is the "evaluate → PO" trigger.
  'Quote Evaluation':   new Set(['can_approve', 'can_reject', 'can_convert', 'can_export', 'can_print']),
  // PO: full workflow. Approve, Issue (send PDF to vendor counts as
  // Email + Issue), Cancel, Confirm; utilities Email / Export / Print.
  'Purchase Order':     new Set(['can_approve', 'can_reject', 'can_confirm', 'can_issue', 'can_cancel', 'can_request_amendment', 'can_approve_amendment', 'can_send_email', 'can_export', 'can_print']),
  // Receipt: Approve receipt → posts stock ledger. Reject; Cancel.
  // Each inline conversion button has its own dedicated flag — Bill
  // (Receipt → Vendor Bill), Wage (Receipt → Wage Entry for loading /
  // unloading), Freight (Receipt → Inward Freight). Email / Export /
  // Print round out the row. Convert is preserved for backward compat.
  'Receipt Advice':     new Set(['can_approve', 'can_reject', 'can_cancel', 'can_convert', 'can_create_bill', 'can_apply_debit', 'can_direct_receipt', 'can_create_wage', 'can_create_freight', 'can_send_email', 'can_export', 'can_print']),
  // Material Rejection: Approve sends back to vendor; Reject overrides;
  // Cancel; Email / Export / Print.
  'Material Rejection': new Set(['can_approve', 'can_reject', 'can_cancel', 'can_send_email', 'can_export', 'can_print']),
  // Bill: Approve to post for payment; Cancel; Convert (Bill → Payment).
  // Each detail-page settlement button has its own dedicated flag —
  // Record Payment, Apply Debit, Apply Credit, Apply Advance — so a
  // role can be granted only the settlement actions they need.
  'Vendor Bill':        new Set(['can_approve', 'can_reject', 'can_cancel', 'can_convert', 'can_record_payment', 'can_apply_debit', 'can_apply_credit', 'can_apply_advance', 'can_send_email', 'can_export', 'can_print']),
  // Payment Made: Approve releases payment; Cancel reverses; Email
  // (remittance advice); Export / Print.
  'Payment Made':       new Set(['can_approve', 'can_reject', 'can_cancel', 'can_send_email', 'can_export', 'can_print']),
  // Vendor Credit: Approve to make it applicable to bills; Cancel;
  // Apply to Vendor Bill (settles a bill from the credit's side).
  'Vendor Credit':      new Set(['can_approve', 'can_reject', 'can_cancel', 'can_apply_to_bill', 'can_send_email', 'can_export', 'can_print']),
  // Vendor Dues is a read-only dashboard — only Export / Print apply.
  'Vendor Dues':        new Set(['can_export', 'can_print']),
  // Inward Freight (backend module name = "Freight Advice" — the
  // backend HasModulePermission check stays hardcoded on that string,
  // but on this admin page we expose the friendlier label via
  // MODULE_DISPLAY_NAMES). Approve, Cancel, Convert (advice →
  // payment), Email (remittance), Export / Print.
  //
  // Both keys are listed so the permission-applicability lookup works
  // whether the row is rendered with the backend name or the display
  // override.
  'Freight Advice':     new Set(['can_approve', 'can_reject', 'can_cancel', 'can_convert', 'can_send_email', 'can_export', 'can_print']),
  'Inward Freight':     new Set(['can_approve', 'can_reject', 'can_cancel', 'can_convert', 'can_send_email', 'can_export', 'can_print']),
  // GST 2B Match is a reconciliation tool page — View shows it, Create
  // gates the upload, Delete gates removing an upload. No workflow buttons.
  'GST 2B Match':       new Set([]),
};

// Friendly labels for modules whose stored `module.name` differs from
// what the operator expects to see on this page. The DB row is left
// alone (renaming would break the backend's hardcoded module_name
// permission checks) — we just substitute on render. Add entries here
// when you want to display a row with a different label than the
// backend's canonical name.
const MODULE_DISPLAY_NAMES = {
  // 'Freight Advice' → 'Inward Freight' moved to the Freight permissions page.
};

const ALL_PERMS = [...PAGE_PERMS, ...BUTTON_PERMS];

// Requirement-type ROW scope — only meaningful on the 'Purchase Request' row.
// Ticking a subset limits the role (and the whole PR→RFQ→Quote→Eval→PO chain)
// to those requirement types; leaving ALL unticked = no restriction (all types).
const REQ_SCOPE_PERMS = [
  { key: 'req_scope_goods',     label: 'Goods' },
  { key: 'req_scope_services',  label: 'Services' },
  { key: 'req_scope_machinery', label: 'Machinery' },
];

// Slugs counted as "Purchase" for this page. Prefer the API's
// `category === 'PURCHASE'` filter; this list is a belt-and-braces
// fallback for legacy modules without a category set.
const PURCHASE_SLUG_FALLBACK = new Set([
  'purchase-request', 'rfq', 'quote', 'quote-evaluation',
  'purchase-order', 'receipt-advice', 'material-rejection',
  'vendor-bill', 'payment-made',
  // vendor-credit / vendor-dues moved to the FINANCE category (their pages live
  // under the Finance sidebar) — managed on the Finance permissions page now.
  'gst-2b-match',
  // Freight Advice (Inward Freight) was shown here for convenience, but its
  // sidebar items (Freight / Freight Bills / Two-way) live under FREIGHT, so
  // its control now lives on the Freight permissions page instead — keeping
  // the toggle where the menu items are and avoiding two edit points.
]);

const TABS = [
  { key: 'page',     label: 'Page Permissions',   icon: FileText,      desc: 'View / Create / Edit / Delete' },
  { key: 'button',   label: 'Button Permissions', icon: MousePointer2, desc: 'Approve · Reject · Convert · Quote Response · Evaluate · Bill · Wage · Freight · Record Payment · Apply Debit/Credit/Advance · Email · Export · Print' },
  { key: 'field',    label: 'Field Permissions',  icon: Eye,           desc: 'Hide / lock individual fields per role' },
  { key: 'data',     label: 'Data Permissions',   icon: Database,      desc: 'Warehouse access per user' },
  { key: 'override', label: 'User Overrides',     icon: UserCog,       desc: 'Per-user grant / deny + field overrides on top of role' },
];

const FIELD_ACCESS_OPTIONS = [
  { value: 'VIEW',      label: 'Visible' },
  { value: 'READ_ONLY', label: 'Read-only' },
  { value: 'HIDDEN',    label: 'Hidden' },
];

export default function PurchasePermissionsPage() {
  const [activeTab, setActiveTab] = useState('page');
  const [selectedRole, setSelectedRole] = useState('');
  const [permissionGrid, setPermissionGrid] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingPerms, setIsLoadingPerms] = useState(false);

  const { options: roleOptions } = useLookup('/api/rbac/roles/', {
    labelField: 'name',
    valueField: 'id',
  });
  const { data: modules, isLoading: modulesLoading } = useApiData('/api/rbac/modules/');

  // Filter modules to Purchase-category only. Prefer the API's
  // `category` field; fall back to a hardcoded slug list when the
  // field is empty (some legacy modules predate the categorisation).
  const purchaseModules = useMemo(() => {
    return modules
      .filter(m => {
        if (m.category === 'PURCHASE') return true;
        return PURCHASE_SLUG_FALLBACK.has(m.slug);
      })
      // Apply friendly display-name overrides — only changes the
      // visible label. `m.name` keys (used by APPLICABLE_BUTTON_PERMS
      // and isPermApplicable below) still reference the canonical
      // backend name so all permission lookups keep working.
      .map(m => MODULE_DISPLAY_NAMES[m.name]
        ? { ...m, name: MODULE_DISPLAY_NAMES[m.name], _backendName: m.name }
        : m
      );
  }, [modules]);

  // Fetch role's permissions when role changes; build a grid limited
  // to the purchase modules only.
  useEffect(() => {
    if (!selectedRole || purchaseModules.length === 0) {
      setPermissionGrid([]);
      return;
    }
    setIsLoadingPerms(true);
    apiClient.get(`/api/rbac/role-permissions/?role=${selectedRole}`)
      .then(res => {
        const rolePerms = res.data?.results || res.data || [];
        const grid = purchaseModules.map(mod => {
          const perm = rolePerms.find(p =>
            String(p.module) === String(mod.id)
            || String(p.module_id) === String(mod.id)
            || p.module_name === mod.name,
          );
          const row = { module_id: mod.id, module_name: mod.name };
          ALL_PERMS.forEach(f => { row[f.key] = perm?.[f.key] || false; });
          REQ_SCOPE_PERMS.forEach(f => { row[f.key] = perm?.[f.key] || false; });
          return row;
        });
        setPermissionGrid(grid);
      })
      .catch(() => {
        toast.error('Failed to load Purchase permissions');
        setPermissionGrid([]);
      })
      .finally(() => setIsLoadingPerms(false));
  }, [selectedRole, purchaseModules]);

  const togglePerm = (moduleId, key) => {
    setPermissionGrid(prev =>
      prev.map(r => r.module_id === moduleId ? { ...r, [key]: !r[key] } : r),
    );
  };

  // toggleColumn flips a single permission across rows. When the
  // caller supplies `applicableModuleIds`, rows outside it are left
  // alone — so clicking the column header on a button column won't
  // pointlessly write True onto a module whose page doesn't have
  // that button.
  const toggleColumn = (key, applicableModuleIds = null) => {
    const inScope = (r) =>
      applicableModuleIds == null || applicableModuleIds.has(r.module_id);
    const allChecked = permissionGrid.filter(inScope).every(r => r[key]);
    setPermissionGrid(prev => prev.map(r => (
      inScope(r) ? { ...r, [key]: !allChecked } : r
    )));
  };

  const toggleRow = (moduleId, perms) => {
    const row = permissionGrid.find(r => r.module_id === moduleId);
    if (!row) return;
    const allChecked = perms.every(f => row[f.key]);
    setPermissionGrid(prev =>
      prev.map(r => {
        if (r.module_id !== moduleId) return r;
        const updated = { ...r };
        perms.forEach(f => { updated[f.key] = !allChecked; });
        return updated;
      }),
    );
  };

  const handleSave = async () => {
    if (!selectedRole) return;
    setIsSaving(true);
    try {
      // The bulk endpoint expects the FULL 14-perm shape per module.
      // We only modify the visible subset on each tab, but the saved
      // payload echoes every flag from the grid (so values from the
      // other tab aren't lost when one tab is saved).
      const payload = {
        role_id: parseInt(selectedRole, 10),
        permissions: permissionGrid.map(row => {
          const perm = { module_id: row.module_id };
          ALL_PERMS.forEach(f => { perm[f.key] = row[f.key]; });
          REQ_SCOPE_PERMS.forEach(f => { perm[f.key] = row[f.key]; });
          return perm;
        }),
      };
      await apiClient.post('/api/rbac/role-permissions/bulk/', payload);
      toast.success('Purchase permissions saved');
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Purchase Module Permissions"
        subtitle="Dedicated permission controls for the Purchase module — page, button, field and warehouse-based data access"
        breadcrumbs={[
          { label: 'Admin' },
          { label: 'Permissions', path: '/admin/permissions' },
          { label: 'Purchase' },
        ]}
      />


      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {/* Tabs */}
        <div className="border-b border-slate-200 bg-slate-50 px-4 flex flex-wrap gap-1">
          {TABS.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`inline-flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition ${
                  isActive
                    ? 'border-indigo-600 text-indigo-700'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
                title={tab.desc}
              >
                <Icon size={14} />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="p-4 sm:p-5">
          {activeTab === 'page' && selectedRole && (
            <RequirementTypeAccessCard grid={permissionGrid} onToggle={togglePerm} />
          )}
          {activeTab === 'page' || activeTab === 'button' ? (
            <PermTab
              perms={activeTab === 'page' ? PAGE_PERMS : BUTTON_PERMS}
              tabLabel={activeTab === 'page' ? 'Page' : 'Button'}
              roleOptions={roleOptions}
              selectedRole={selectedRole}
              setSelectedRole={setSelectedRole}
              modules={purchaseModules}
              permissionGrid={permissionGrid}
              isLoading={modulesLoading || isLoadingPerms}
              isSaving={isSaving}
              onTogglePerm={togglePerm}
              onToggleColumn={toggleColumn}
              onToggleRow={toggleRow}
              onSave={handleSave}
            />
          ) : activeTab === 'field' ? (
            <FieldTab
              roleOptions={roleOptions}
              selectedRole={selectedRole}
              setSelectedRole={setSelectedRole}
            />
          ) : activeTab === 'data' ? (
            // Warehouse access is user-level (applies across every module
            // a user can see). Same editor as the Sales page, hosted here
            // so Purchase admins don't have to leave the page.
            <DataTab />
          ) : (
            // Per-user GRANT/DENY action + field overrides, scoped to the
            // Purchase module catalog.
            <UserOverridesTab
              fieldsEndpoint="/api/rbac/manageable-purchase-fields/"
              allPerms={ALL_PERMS}
              moduleLabel="Purchase"
            />
          )}
        </div>
      </div>
    </MainLayout>
  );
}

// ── Requirement-type access card (Purchase Request row) ─────────────
// Admin-configurable row scope: tick the requirement types this role may
// access. Edits the shared permissionGrid; the tab's Save button persists it.
function RequirementTypeAccessCard({ grid, onToggle }) {
  const prRow = grid.find(r => r.module_name === 'Purchase Request');
  if (!prRow) return null;
  const checked = REQ_SCOPE_PERMS.filter(f => prRow[f.key]);
  return (
    <div className="mb-5 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Requirement-type access — Purchase Request</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Restrict this role to specific requirement types across the whole chain
            (PR → RFQ → Quote → Evaluation → PO). Leave all unchecked to allow{' '}
            <strong>all types</strong>.
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
          checked.length ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'
        }`}>
          {checked.length ? checked.map(f => f.label).join(', ') : 'All Types'}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        {REQ_SCOPE_PERMS.map(f => (
          <label key={f.key} className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={!!prRow[f.key]}
              onChange={() => onToggle(prRow.module_id, f.key)}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            {f.label}
          </label>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">Click <strong>Save</strong> below to apply.</p>
    </div>
  );
}

// ── Page / Button tab ───────────────────────────────────────────────
// Shared component — same grid layout, different column list.
function PermTab({
  perms, tabLabel, roleOptions, selectedRole, setSelectedRole,
  modules, permissionGrid, isLoading, isSaving,
  onTogglePerm, onToggleColumn, onToggleRow, onSave,
}) {
  const getRow = (id) => permissionGrid.find(r => r.module_id === id);
  const isPermApplicable = (moduleName, permKey) => {
    if (tabLabel !== 'Button') return true;
    const set = APPLICABLE_BUTTON_PERMS[moduleName];
    if (!set) return true;
    return set.has(permKey);
  };
  const isColAllChecked = (key) => {
    const applicableRows = permissionGrid.filter(r => {
      const mod = modules.find(m => m.id === r.module_id);
      return mod && isPermApplicable(mod.name, key);
    });
    return applicableRows.length > 0 && applicableRows.every(r => r[key]);
  };
  const isRowAllChecked = (id) => {
    const row = getRow(id);
    if (!row) return false;
    const mod = modules.find(m => m.id === id);
    const applicable = perms.filter(f => mod && isPermApplicable(mod.name, f.key));
    return applicable.length > 0 && applicable.every(f => row[f.key]);
  };

  return (
    <>
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div className="flex-1 min-w-[240px] max-w-md">
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Select Role
          </label>
          <CustomSelect
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">Select a role…</option>
            {roleOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </CustomSelect>
        </div>
        {selectedRole && (
          <button
            type="button"
            onClick={onSave}
            disabled={isSaving}
            className="inline-flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            <Save size={14} />
            {isSaving ? 'Saving…' : 'Save Permissions'}
          </button>
        )}
      </div>

      {!selectedRole ? (
        <p className="text-sm text-slate-500 italic">Pick a role to see its Purchase {tabLabel.toLowerCase()} permissions.</p>
      ) : isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : modules.length === 0 ? (
        <p className="text-sm text-slate-500">No Purchase modules registered yet.</p>
      ) : (
        <>
        {/* Mobile-stacked permission cards — chip toggles per module. */}
        <div className="sm:hidden space-y-3">
          {modules.map(mod => {
            const row = getRow(mod.id);
            if (!row) return null;
            const applicablePerms = tabLabel === 'Button'
              ? perms.filter(f => isPermApplicable(mod.name, f.key))
              : perms;
            const rowHasAnyApplicable = applicablePerms.length > 0;
            return (
              <div key={`m-${mod.id}`} className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-800 truncate">{mod.name}</span>
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-500 shrink-0">
                    All
                    <input
                      type="checkbox"
                      checked={isRowAllChecked(mod.id)}
                      onChange={() => onToggleRow(mod.id, applicablePerms)}
                      disabled={!rowHasAnyApplicable}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {perms.map(f => {
                    const applicable = isPermApplicable(mod.name, f.key);
                    const on = applicable && !!row[f.key];
                    return (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => applicable && onTogglePerm(mod.id, f.key)}
                        disabled={!applicable}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border transition disabled:opacity-30 disabled:cursor-not-allowed ${on ? 'bg-indigo-50 border-indigo-300 ' + f.color : 'bg-slate-50 text-slate-500 border-slate-200'}`}
                      >
                        {on && <Check size={10} />}
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="hidden sm:block overflow-auto border border-slate-200 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-primary-50 border-b-2 border-slate-300">
                <th className="text-left px-4 py-2 font-semibold text-slate-700 min-w-[200px] sticky left-0 z-20 bg-slate-100">
                  Purchase Module
                </th>
                <th className="text-center px-2 py-2 font-medium text-slate-500 w-12">All</th>
                {perms.map(f => {
                  const applicableIds = new Set(
                    modules
                      .filter(m => tabLabel !== 'Button' || isPermApplicable(m.name, f.key))
                      .map(m => m.id),
                  );
                  const applicableCount = applicableIds.size;
                  return (
                    <th key={f.key} className="text-center px-1 py-2 min-w-[80px]">
                      <button
                        type="button"
                        onClick={() => applicableCount > 0 && onToggleColumn(f.key, applicableIds)}
                        disabled={applicableCount === 0}
                        className="hover:bg-slate-200 rounded px-1 py-0.5 text-xs leading-tight w-full disabled:opacity-40 disabled:cursor-not-allowed"
                        title={applicableCount > 0
                          ? `Toggle ${f.label} on every applicable module`
                          : `${f.label} doesn't apply to any module in this tab`}
                      >
                        <div className={`font-medium ${f.color}`}>{f.label}</div>
                        <div className="mt-0.5">
                          {isColAllChecked(f.key) ? (
                            <Check size={10} className="inline text-green-600" />
                          ) : (
                            <span className="inline-block w-2.5 h-2.5 border border-slate-300 rounded-sm" />
                          )}
                        </div>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {modules.map(mod => {
                const row = getRow(mod.id);
                if (!row) return null;
                const applicablePerms = tabLabel === 'Button'
                  ? perms.filter(f => isPermApplicable(mod.name, f.key))
                  : perms;
                const rowHasAnyApplicable = applicablePerms.length > 0;
                return (
                  <tr key={mod.id} className="border-b border-slate-100 hover:bg-indigo-50/30">
                    <td className="px-4 py-2 font-medium text-slate-800 sticky left-0 z-10 bg-white">
                      {mod.name}
                    </td>
                    <td className="text-center px-2 py-2">
                      <input
                        type="checkbox"
                        checked={isRowAllChecked(mod.id)}
                        onChange={() => onToggleRow(mod.id, applicablePerms)}
                        disabled={!rowHasAnyApplicable}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
                        title={rowHasAnyApplicable
                          ? `Toggle every ${tabLabel} permission for ${mod.name}`
                          : `${mod.name} has no ${tabLabel.toLowerCase()} actions`}
                      />
                    </td>
                    {perms.map(f => {
                      const applicable = isPermApplicable(mod.name, f.key);
                      return (
                        <td key={f.key} className="text-center px-1 py-2">
                          <input
                            type="checkbox"
                            checked={applicable ? !!row[f.key] : false}
                            disabled={!applicable}
                            onChange={() => applicable && onTogglePerm(mod.id, f.key)}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={applicable
                              ? `${f.label} on ${mod.name}`
                              : `${f.label} doesn't apply to ${mod.name}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </>
  );
}

// ── Field tab — per-(role, module, field) access editor ────────────
//
// Catalog comes from /api/rbac/manageable-purchase-fields/ so adding a
// field to the Purchase catalog server-side surfaces it in the UI
// automatically. Saves go through /api/rbac/role-field-permissions/bulk/
// which is the same generic endpoint Sales uses.
function FieldTab({ roleOptions, selectedRole, setSelectedRole }) {
  const [catalog, setCatalog] = useState([]);
  const [currentPerms, setCurrentPerms] = useState({});  // { 'Purchase Order:po_no' -> 'READ_ONLY' }
  const [isLoading, setIsLoading] = useState(true);
  const [savingModule, setSavingModule] = useState(null);

  // Catalog is static — fetch once on mount.
  useEffect(() => {
    setIsLoading(true);
    apiClient.get('/api/rbac/manageable-purchase-fields/')
      .then(res => setCatalog(res.data?.modules || []))
      .catch(() => toast.error('Failed to load field catalog'))
      .finally(() => setIsLoading(false));
  }, []);

  // When role changes, refresh overrides for that role across every
  // Purchase module we manage. Default 'VIEW' is implicit — only
  // HIDDEN / READ_ONLY rows live in the DB.
  useEffect(() => {
    if (!selectedRole) {
      setCurrentPerms({});
      return;
    }
    apiClient.get(`/api/rbac/role-field-permissions/?role=${selectedRole}`)
      .then(res => {
        const rows = res.data?.results || res.data || [];
        const map = {};
        rows.forEach(r => {
          map[`${r.module_name}:${r.field_name}`] = r.access;
        });
        setCurrentPerms(map);
      })
      .catch(() => toast.error('Failed to load field permissions'));
  }, [selectedRole]);

  const setAccess = (moduleName, fieldKey, value) => {
    setCurrentPerms(prev => ({
      ...prev,
      [`${moduleName}:${fieldKey}`]: value,
    }));
  };

  const saveModule = async (moduleName, fields) => {
    if (!selectedRole) return;
    setSavingModule(moduleName);
    try {
      const permissions = fields.map(f => ({
        field_name: f.key,
        access: currentPerms[`${moduleName}:${f.key}`] || 'VIEW',
      }));
      await apiClient.post('/api/rbac/role-field-permissions/bulk/', {
        role_id: parseInt(selectedRole, 10),
        module_name: moduleName,
        permissions,
      });
      toast.success(`Saved ${moduleName} field permissions`);
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setSavingModule(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div className="flex-1 min-w-[240px] max-w-md">
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Select Role
          </label>
          <CustomSelect
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">Select a role…</option>
            {roleOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </CustomSelect>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-500">Loading field catalog…</p>
      ) : !selectedRole ? (
        <p className="text-sm text-slate-500 italic">Pick a role to see its Purchase field permissions.</p>
      ) : catalog.length === 0 ? (
        <p className="text-sm text-slate-500">No Purchase fields registered for management yet.</p>
      ) : (
        <div className="space-y-4 sm:space-y-5">
          {catalog.map(mod => (
            <div key={mod.name} className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="bg-slate-50 px-4 py-2 flex items-center justify-between border-b border-slate-200">
                <h3 className="font-semibold text-slate-800">{mod.name}</h3>
                <button
                  type="button"
                  onClick={() => saveModule(mod.name, mod.fields)}
                  disabled={savingModule === mod.name}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Save size={11} />
                  {savingModule === mod.name ? 'Saving…' : 'Save this module'}
                </button>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-white border-b border-slate-100">
                    <th className="text-left px-4 py-2 font-medium text-slate-600">Field</th>
                    <th className="text-left px-4 py-2 font-medium text-slate-500 w-24">Kind</th>
                    <th className="text-left px-4 py-2 font-medium text-slate-600 w-40">Access</th>
                  </tr>
                </thead>
                <tbody>
                  {mod.fields.map(f => {
                    const current = currentPerms[`${mod.name}:${f.key}`] || 'VIEW';
                    return (
                      <tr key={f.key} className="border-b border-slate-100 hover:bg-indigo-50/30">
                        <td className="px-4 py-2">
                          <div className="font-medium text-slate-800">{f.label}</div>
                          <div className="text-xs text-slate-400 font-mono">{f.key}</div>
                        </td>
                        <td className="px-4 py-2 text-xs text-slate-500">{f.kind || '-'}</td>
                        <td className="px-4 py-2">
                          <CustomSelect
                            value={current}
                            onChange={(e) => setAccess(mod.name, f.key, e.target.value)}
                            className={`text-sm px-2 py-1 border rounded ${
                              current === 'HIDDEN' ? 'border-red-300 bg-red-50 text-red-700'
                              : current === 'READ_ONLY' ? 'border-amber-300 bg-amber-50 text-amber-700'
                              : 'border-slate-300'
                            }`}
                          >
                            {FIELD_ACCESS_OPTIONS.map(opt => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </CustomSelect>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

