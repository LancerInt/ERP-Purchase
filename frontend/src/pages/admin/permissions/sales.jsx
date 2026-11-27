import CustomSelect from "@/components/ui/CustomSelect";
/**
 * Sales-only Permission Management.
 *
 * A dedicated view of the existing RolePermission system, scoped to
 * Sales-category modules and organised into the structure the team
 * sketched in the Phase 2 spec:
 *
 *   Sales Module
 *     ├── Page Permissions     (View / Create / Edit / Delete)
 *     ├── Button Permissions   (Approve / Reject / Confirm / Close /
 *     │                         Cancel / Issue / Convert / Email /
 *     │                         Export / Print)
 *     ├── Field Permissions    (placeholder for Phase 3)
 *     └── Data Permissions     (per-user warehouse_scope editor —
 *                              the admin surface for the Phase 1
 *                              warehouse row-level access feature)
 *
 * The backend permission shape is unchanged — this page reads and
 * writes the same `RolePermission` rows the main `/admin/permissions`
 * page does. The Sales-only filter and the Page/Button split are
 * purely a UI restructuring so admins can focus on Sales without
 * being distracted by 60 other modules.
 *
 * The Data Permissions tab is the only NEW capability here — it
 * exposes `StakeholderUser.warehouse_scope` so a non-engineer admin
 * can configure who-sees-what without touching the Django admin.
 */
import { useState, useEffect, useMemo, Fragment } from 'react';
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

// ── Permission definitions ───────────────────────────────────────────
// PAGE_PERMS = the 4 CRUD flags. These are "can the user open the page
// and do basic record operations at all". BUTTON_PERMS = the 10
// workflow + utility flags — each maps to a clickable button in the
// sales UI (Approve, Reject, etc.). Together they cover all 14 perms
// the backend RolePermission model stores.
const PAGE_PERMS = [
  { key: 'can_view',   label: 'View',   color: 'text-blue-600' },
  { key: 'can_create', label: 'Create', color: 'text-green-600' },
  { key: 'can_edit',   label: 'Edit',   color: 'text-amber-600' },
  { key: 'can_delete', label: 'Delete', color: 'text-red-600' },
];

const BUTTON_PERMS = [
  { key: 'can_approve',     label: 'Approve',     color: 'text-emerald-600' },
  { key: 'can_reject',      label: 'Reject',      color: 'text-rose-600' },
  { key: 'can_confirm',     label: 'Confirm',     color: 'text-teal-600' },
  { key: 'can_acknowledge', label: 'Acknowledge', color: 'text-lime-600' },
  { key: 'can_create_dc',   label: 'Create DC',   color: 'text-amber-700' },
  { key: 'can_create_so',   label: 'Create SO',   color: 'text-blue-700' },
  { key: 'can_view_inbox',  label: 'View Inbox',  color: 'text-pink-700' },
  { key: 'can_create_freight', label: 'Create Freight', color: 'text-orange-700' },
  { key: 'can_close',       label: 'Close',       color: 'text-slate-600' },
  { key: 'can_cancel',      label: 'Cancel',      color: 'text-orange-600' },
  { key: 'can_issue',       label: 'Issue',       color: 'text-indigo-600' },
  { key: 'can_convert',     label: 'Convert',     color: 'text-purple-600' },
  { key: 'can_send_email',  label: 'Email',       color: 'text-sky-600' },
  { key: 'can_export',      label: 'Export',      color: 'text-cyan-600' },
  { key: 'can_print',       label: 'Print',       color: 'text-violet-600' },
  { key: 'can_push_tally',  label: 'Push Tally',  color: 'text-emerald-700' },
];

// Per-module map of button permissions that map to an actual button or
// action on a real page in the Sales module. Cells outside this set
// render disabled — picking, say, "Approve" on Sales Dashboard has no
// effect anywhere in the app, so showing the box as tickable just
// confuses admins. Page permissions (View/Create/Edit/Delete) aren't
// gated by this — every module has a list/detail/edit surface, so
// CRUD applies everywhere.
//
// Maintenance: when a new button is added to a sales page and gated on
// `usePermissions().canXxx('<module name>')`, add the matching key to
// that module's set here so the admin grid lets admins toggle it.
const APPLICABLE_BUTTON_PERMS = {
  // Pure read-only KPI views. No buttons are gated by RolePermission
  // flags on these pages today.
  'Sales Dashboard':       new Set([]),
  'Sales Flow Dashboard':  new Set([]),
  // GSTR-1 Match is a reconciliation tool page — View shows it, Create
  // gates the upload, Delete gates removing an upload. No workflow buttons.
  'GSTR-1 Match':          new Set([]),
  // E-Way Bill Check is the same shape: View shows the page, Create gates
  // running a check, Delete gates removing one. Export gates the .xlsx report.
  'E-Way Bill Check':      new Set(['can_export']),
  // Customer PO inbox/list/detail. Real buttons on the detail page:
  //   Confirm (can_confirm, DRAFT→CONFIRMED), Cancel (can_reject),
  //   Create SO (can_create_so). Plus the IMAP Inbox view (can_view_inbox)
  //   and send-to-customer / list export / print. NOTE: the detail page has
  //   NO Approve or Convert button — those flags were dead columns that
  //   misled admins into ticking Approve when the Confirm button is what
  //   gates the workflow, so they're dropped in favour of can_confirm.
  'Customer PO':           new Set(['can_confirm', 'can_reject', 'can_create_so', 'can_view_inbox', 'can_send_email', 'can_export', 'can_print']),
  // Sales Quote: Approve(=Accept)/Reject the customer's response, Convert
  // (Quote → Sales Order), plus Email/Export/Print for the quote document.
  'Sales Quote':           new Set(['can_approve', 'can_reject', 'can_convert', 'can_send_email', 'can_export', 'can_print']),
  // Sales Order: full lifecycle. Approve/Reject on header; Acknowledge
  // for factory stock check; Create DC (dedicated SO→DC button gate);
  // Cancel; Convert (generic SO conversions); Email/Export/Print.
  'Sales Order':           new Set(['can_approve', 'can_reject', 'can_acknowledge', 'can_create_dc', 'can_cancel', 'can_convert', 'can_send_email', 'can_export', 'can_print']),
  // Dispatch Challan: Issue (dispatch), Cancel, Confirm, Convert (DC→Invoice),
  // dedicated Create Freight flag for the DC→Outward Freight button,
  // and the standard utility set.
  'Dispatch Challan':      new Set(['can_confirm', 'can_cancel', 'can_issue', 'can_convert', 'can_create_freight', 'can_send_email', 'can_export', 'can_print']),
  // Sales Invoice: Approve, Issue, Cancel, Confirm + utility set, plus the
  // dedicated "Push Tally" flag for the "Go to Tally" button.
  'Sales Invoice':         new Set(['can_approve', 'can_confirm', 'can_cancel', 'can_issue', 'can_send_email', 'can_export', 'can_print', 'can_push_tally']),
  // Receivable: Close (when fully paid), Cancel write-off, Email
  // reminders, Export ledger.
  'Receivable':            new Set(['can_close', 'can_cancel', 'can_send_email', 'can_export']),
  // Sales Freight (Outward Freight) — warehouse → customer leg. Page
  // lives under /freight/outward but permission ownership is sales.
  // Approve + Cancel toggles on the detail page + utility set for export/print.
  'Sales Freight':         new Set(['can_approve', 'can_cancel', 'can_send_email', 'can_export', 'can_print']),
  // Newer AR pages — read/list surfaces with no workflow buttons today, so no
  // button flags apply (View/Create/Edit/Delete on the Page tab still do).
  'Sales Ledger':          new Set([]),
  'TDS 194Q':              new Set([]),
  'Customer Advances':     new Set([]),
};

const ALL_PERMS = [...PAGE_PERMS, ...BUTTON_PERMS];

// Slugs that count as "Sales" for this page. We prefer the API's
// `category === 'SALES'` filter when available; this list is a
// belt-and-braces fallback for instances where the category field
// hasn't been backfilled yet.
const SALES_SLUG_FALLBACK = new Set([
  'customer-po', 'sales-order', 'dispatch-challan',
  'sales-invoice', 'receivable',
  'sales-dashboard', 'sales-flow-dashboard',
  'gstr1-match',
  // Outward Freight permission lives under the sales module — the
  // page itself sits at /freight/outward but is sales team-managed.
  'sales-freight',
  // Newer AR pages (seeded in rbac migration 0048): the debtors ledger,
  // the 194Q TDS ledger and customer advances.
  'sales-ledger', 'sales-tds', 'customer-advances',
]);

const TABS = [
  { key: 'page',     label: 'Page Permissions',   icon: FileText,      desc: 'View / Create / Edit / Delete' },
  { key: 'button',   label: 'Button Permissions', icon: MousePointer2, desc: 'Approve · Reject · Confirm · Print · Export …' },
  { key: 'field',    label: 'Field Permissions',  icon: Eye,           desc: 'Hide / lock individual fields per role' },
  { key: 'data',     label: 'Data Permissions',   icon: Database,      desc: 'Warehouse access per user' },
  { key: 'override', label: 'User Overrides',     icon: UserCog,       desc: 'Per-user grant / deny on top of role' },
];

// Field-permission access values mirror the backend RoleFieldPermission
// model. Keep wording short for the dropdown — descriptive labels
// live in the helper text below the table.
const FIELD_ACCESS_OPTIONS = [
  { value: 'VIEW',      label: 'Visible' },
  { value: 'READ_ONLY', label: 'Read-only' },
  { value: 'HIDDEN',    label: 'Hidden' },
];

export default function SalesPermissionsPage() {
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

  // Filter modules to Sales-category only. Prefer the API's
  // `category` field; fall back to a hardcoded slug list when the
  // field is empty (some legacy modules predate the categorisation).
  const salesModules = useMemo(() => {
    return modules.filter(m => {
      if (m.category === 'SALES') return true;
      return SALES_SLUG_FALLBACK.has(m.slug);
    });
  }, [modules]);

  // Fetch role's permissions when role changes; build a grid limited
  // to the sales modules only.
  useEffect(() => {
    if (!selectedRole || salesModules.length === 0) {
      setPermissionGrid([]);
      return;
    }
    setIsLoadingPerms(true);
    apiClient.get(`/api/rbac/role-permissions/?role=${selectedRole}`)
      .then(res => {
        const rolePerms = res.data?.results || res.data || [];
        const grid = salesModules.map(mod => {
          const perm = rolePerms.find(p =>
            String(p.module) === String(mod.id)
            || String(p.module_id) === String(mod.id)
            || p.module_name === mod.name,
          );
          const row = { module_id: mod.id, module_name: mod.name };
          ALL_PERMS.forEach(f => { row[f.key] = perm?.[f.key] || false; });
          return row;
        });
        setPermissionGrid(grid);
      })
      .catch(() => {
        toast.error('Failed to load Sales permissions');
        setPermissionGrid([]);
      })
      .finally(() => setIsLoadingPerms(false));
  }, [selectedRole, salesModules]);

  const togglePerm = (moduleId, key) => {
    setPermissionGrid(prev =>
      prev.map(r => r.module_id === moduleId ? { ...r, [key]: !r[key] } : r),
    );
  };

  // toggleColumn flips a single permission across rows. When the
  // caller (Button tab) supplies an `applicableModuleIds` set, rows
  // outside it are left alone — so clicking the column header on
  // "Approve" won't pointlessly write True onto Sales Dashboard,
  // which has no Approve button. Page tab passes nothing and gets
  // the original "every row" behavior.
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
          return perm;
        }),
      };
      await apiClient.post('/api/rbac/role-permissions/bulk/', payload);
      toast.success('Sales permissions saved');
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Sales Module Permissions"
        subtitle="Dedicated permission controls for the Sales module — page, button, field and warehouse-based data access"
        breadcrumbs={[
          { label: 'Admin' },
          { label: 'Permissions', path: '/admin/permissions' },
          { label: 'Sales' },
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
          {activeTab === 'page' || activeTab === 'button' ? (
            <PermTab
              perms={activeTab === 'page' ? PAGE_PERMS : BUTTON_PERMS}
              tabLabel={activeTab === 'page' ? 'Page' : 'Button'}
              roleOptions={roleOptions}
              selectedRole={selectedRole}
              setSelectedRole={setSelectedRole}
              modules={salesModules}
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
            <DataTab />
          ) : (
            <UserOverridesTab />
          )}
        </div>
      </div>
    </MainLayout>
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
  // Whether `permKey` actually maps to a real button on `moduleName`'s
  // pages. Page tab is always applicable (every module has CRUD); only
  // the Button tab consults the catalog. Modules not in the catalog
  // (legacy / not-yet-mapped) default to applicable so we never hide
  // toggles by accident.
  const isPermApplicable = (moduleName, permKey) => {
    if (tabLabel !== 'Button') return true;
    const set = APPLICABLE_BUTTON_PERMS[moduleName];
    if (!set) return true;
    return set.has(permKey);
  };
  // Aggregate helpers count only the applicable cells so the All
  // checkbox can be "fully on" when every relevant cell is ticked
  // without needing every theoretical cell ticked too.
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
        <p className="text-sm text-slate-500 italic">Pick a role to see its Sales {tabLabel.toLowerCase()} permissions.</p>
      ) : isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : modules.length === 0 ? (
        <p className="text-sm text-slate-500">No Sales modules registered yet.</p>
      ) : (
        <>
        {/* Mobile-stacked permission cards — one card per module with
            permissions as toggleable chips. Replaces the wide table
            on small screens. */}
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
                  Sales Module
                </th>
                <th className="text-center px-2 py-2 font-medium text-slate-500 w-12">All</th>
                {perms.map(f => {
                  // IDs of modules where this permission actually maps
                  // to a button. We pass this set to toggleColumn so
                  // the column-header toggle skips non-applicable rows
                  // (e.g. ticking the Approve header column doesn't
                  // write True onto Sales Dashboard).
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
                // For the Button tab, narrow the per-row "All" toggle
                // to only the perms the module actually exposes. On
                // the Page tab this is just `perms` unchanged because
                // every module has CRUD pages.
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
// Catalog of manageable fields comes from
// `/api/rbac/manageable-sales-fields/` so adding a field to the
// Phase 3 catalog server-side surfaces it in the UI automatically
// — no frontend rebuild needed. Saves go through the bulk endpoint
// `/api/rbac/role-field-permissions/bulk/` which replaces the rows
// for one (role, module) atomically.
function FieldTab({ roleOptions, selectedRole, setSelectedRole }) {
  const [catalog, setCatalog] = useState([]);
  const [currentPerms, setCurrentPerms] = useState({});  // { 'Sales Order:approval_status' -> 'READ_ONLY' }
  const [isLoading, setIsLoading] = useState(true);
  const [savingModule, setSavingModule] = useState(null);

  // Catalog is static — fetch once on mount.
  useEffect(() => {
    setIsLoading(true);
    apiClient.get('/api/rbac/manageable-sales-fields/')
      .then(res => setCatalog(res.data?.modules || []))
      .catch(() => toast.error('Failed to load field catalog'))
      .finally(() => setIsLoading(false));
  }, []);

  // When the role changes, refresh the existing overrides for that
  // role across every Sales module we manage. The default 'VIEW' is
  // implicit — only HIDDEN / READ_ONLY rows live in the DB.
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
      const permissions = fields
        .map(f => ({
          field_name: f.key,
          access: currentPerms[`${moduleName}:${f.key}`] || 'VIEW',
        }))
        // Drop VIEW rows — those are the absence of an override and
        // the backend deletes them on bulk save anyway. Keeps the
        // payload small and matches the server-side semantics.
        .filter(p => p.access !== 'VIEW');
      await apiClient.post('/api/rbac/role-field-permissions/bulk/', {
        role_id: parseInt(selectedRole, 10),
        module_name: moduleName,
        permissions,
      });
      toast.success(`${moduleName} field permissions saved`);
    } catch (e) {
      toast.error(getApiErrorMessage(e));
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

      <div className="mb-4 p-3 bg-indigo-50/40 border border-indigo-200 rounded-lg text-xs text-slate-700">
        <p>
          <strong>Per-field access overrides.</strong> Each field defaults
          to <em>Visible</em>. Set it to <em>Read-only</em> to keep the
          field on screen but block edits, or <em>Hidden</em> to strip it
          from API responses entirely.
        </p>
        <p className="mt-1 text-slate-500">
          Superusers and unconfigured legacy users always see every field
          — overrides only apply to assigned roles.
        </p>
      </div>

      {!selectedRole ? (
        <p className="text-sm text-slate-500 italic">Pick a role to configure its field permissions.</p>
      ) : isLoading ? (
        <p className="text-sm text-slate-500">Loading catalog…</p>
      ) : catalog.length === 0 ? (
        <p className="text-sm text-slate-500">No manageable fields configured.</p>
      ) : (
        <div className="space-y-4">
          {catalog.map(({ name: moduleName, fields }) => (
            <div key={moduleName} className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-800">{moduleName}</h4>
                <button
                  type="button"
                  onClick={() => saveModule(moduleName, fields)}
                  disabled={savingModule === moduleName}
                  className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Save size={11} />
                  {savingModule === moduleName ? 'Saving…' : `Save ${moduleName}`}
                </button>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-primary-50 border-b-2 border-slate-300 text-xs">
                    <th className="text-left px-4 py-2 font-medium text-slate-600">Field</th>
                    <th className="text-left px-4 py-2 font-medium text-slate-600 w-40">Access</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map(f => {
                    const current = currentPerms[`${moduleName}:${f.key}`] || 'VIEW';
                    return (
                      <tr key={f.key} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-4 py-2">
                          <div className="font-medium text-slate-800">{f.label}</div>
                          <div className="text-[11px] text-slate-500 font-mono">{f.key}</div>
                        </td>
                        <td className="px-4 py-2">
                          <CustomSelect
                            value={current}
                            onChange={(e) => setAccess(moduleName, f.key, e.target.value)}
                            className={`w-full px-2 py-1 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-indigo-500 ${
                              current === 'HIDDEN'   ? 'bg-red-50 text-red-700' :
                              current === 'READ_ONLY' ? 'bg-amber-50 text-amber-700' :
                              'bg-white text-slate-700'
                            }`}
                          >
                            {FIELD_ACCESS_OPTIONS.map(o => (
                              <option key={o.value} value={o.value}>{o.label}</option>
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

// ── User Overrides tab — per-user grant/deny + field overrides ──────
//
// Pick a user → see their effective role → configure surgical
// exceptions on top of that role. Three concepts on one page:
//   1. Module-action overrides (GRANT / DENY) — flip specific
//      buttons / pages for this one user.
//   2. Field overrides (Visible / Read-only / Hidden) — match the
//      role-field UI but applied per-user. Useful when one senior
//      person needs to see a field everyone else on the role can't.
// Backend semantics: DENY wins over GRANT for the same action,
// per-user field overrides REPLACE the role's field policy.
function UserOverridesTab() {
  const [users, setUsers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [moduleOverrides, setModuleOverrides] = useState({}); // 'Sales Order:can_approve' -> 'GRANT' | 'DENY'
  const [fieldOverrides, setFieldOverrides] = useState({});   // 'Sales Order:grand_total' -> 'VIEW' | 'READ_ONLY' | 'HIDDEN'
  const [isLoading, setIsLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);

  useEffect(() => {
    setIsLoading(true);
    Promise.all([
      apiClient.get('/api/rbac/users/?page_size=500'),
      apiClient.get('/api/rbac/manageable-sales-fields/'),
    ]).then(([uRes, cRes]) => {
      const u = uRes.data?.results || uRes.data || [];
      setUsers(u);
      setCatalog(cRes.data?.modules || []);
    }).catch(() => toast.error('Failed to load users / catalog'))
      .finally(() => setIsLoading(false));
  }, []);

  // Refresh both override sets whenever the selected user changes.
  useEffect(() => {
    if (!selectedUserId) {
      setModuleOverrides({});
      setFieldOverrides({});
      return;
    }
    Promise.all([
      apiClient.get(`/api/rbac/user-permission-overrides/?user=${selectedUserId}`),
      apiClient.get(`/api/rbac/user-field-permission-overrides/?user=${selectedUserId}`),
    ]).then(([modRes, fldRes]) => {
      const modRows = modRes.data?.results || modRes.data || [];
      const fldRows = fldRes.data?.results || fldRes.data || [];
      const m = {};
      modRows.forEach(r => { m[`${r.module_name}:${r.action}`] = r.mode; });
      setModuleOverrides(m);
      const f = {};
      fldRows.forEach(r => { f[`${r.module_name}:${r.field_name}`] = r.access; });
      setFieldOverrides(f);
    }).catch(() => toast.error('Failed to load overrides for user'));
  }, [selectedUserId]);

  // The available module-action axis = the same 14-perm list defined
  // at the top of this file. We re-use ALL_PERMS so the override
  // controls cover the exact set of actions the role layer offers.
  const moduleAxis = useMemo(() => {
    return catalog.map(({ name }) => ({
      name,
      actions: ALL_PERMS,
    }));
  }, [catalog]);

  const setModuleOverride = (moduleName, actionKey, mode) => {
    const k = `${moduleName}:${actionKey}`;
    setModuleOverrides(prev => {
      const next = { ...prev };
      if (!mode) delete next[k];
      else next[k] = mode;
      return next;
    });
  };

  const setFieldOverride = (moduleName, fieldKey, access) => {
    const k = `${moduleName}:${fieldKey}`;
    setFieldOverrides(prev => {
      const next = { ...prev };
      if (!access || access === 'DEFAULT') delete next[k];
      else next[k] = access;
      return next;
    });
  };

  const saveModuleOverrides = async (moduleName) => {
    if (!selectedUserId) return;
    setSavingKey(`mod:${moduleName}`);
    try {
      const overrides = ALL_PERMS
        .map(p => ({
          action: p.key,
          mode: moduleOverrides[`${moduleName}:${p.key}`],
        }))
        .filter(o => o.mode === 'GRANT' || o.mode === 'DENY');
      await apiClient.post('/api/rbac/user-permission-overrides/bulk/', {
        user_id: parseInt(selectedUserId, 10),
        module_name: moduleName,
        overrides,
      });
      toast.success(`${moduleName} action overrides saved`);
    } catch (e) {
      toast.error(getApiErrorMessage(e));
    } finally {
      setSavingKey(null);
    }
  };

  const saveFieldOverrides = async (moduleName, fields) => {
    if (!selectedUserId) return;
    setSavingKey(`fld:${moduleName}`);
    try {
      const overrides = fields
        .map(f => ({
          field_name: f.key,
          access: fieldOverrides[`${moduleName}:${f.key}`] || 'VIEW',
        }))
        .filter(o => o.access !== 'VIEW');
      await apiClient.post('/api/rbac/user-field-permission-overrides/bulk/', {
        user_id: parseInt(selectedUserId, 10),
        module_name: moduleName,
        overrides,
      });
      toast.success(`${moduleName} field overrides saved`);
    } catch (e) {
      toast.error(getApiErrorMessage(e));
    } finally {
      setSavingKey(null);
    }
  };

  const selectedUser = users.find(u => String(u.id) === String(selectedUserId));

  if (isLoading) {
    return <p className="text-sm text-slate-500">Loading users…</p>;
  }

  return (
    <>
      <div className="mb-4 p-3 bg-indigo-50/40 border border-indigo-200 rounded-lg text-xs text-slate-700">
        <p>
          <strong>Per-user overrides.</strong> Pick a user and surgically
          flip individual actions or fields on top of their role.
        </p>
        <p className="mt-1 text-slate-500">
          <strong>DENY</strong> wins over <strong>GRANT</strong> when both
          exist on the same action. Field overrides REPLACE the role's
          field policy (use <em>Visible</em> to restore a field the role hides).
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div className="flex-1 min-w-[240px] max-w-md">
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Select User
          </label>
          <CustomSelect
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">Select a user…</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>
                {u.username || u.email || `User #${u.id}`}
                {u.role?.name && ` — ${u.role.name}`}
              </option>
            ))}
          </CustomSelect>
        </div>
        {selectedUser?.role?.name && (
          <p className="text-xs text-slate-600 mb-2">
            Base role: <strong>{selectedUser.role.name}</strong>
          </p>
        )}
      </div>

      {!selectedUserId ? (
        <p className="text-sm text-slate-500 italic">Pick a user to configure overrides.</p>
      ) : moduleAxis.length === 0 ? (
        <p className="text-sm text-slate-500">No Sales modules registered.</p>
      ) : (
        <div className="space-y-4 sm:space-y-5">
          {/* ── Module-action overrides ── */}
          <section>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Module / Action Overrides</h3>
            <div className="space-y-3">
              {moduleAxis.map(({ name: moduleName }) => (
                <div key={moduleName} className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-slate-800">{moduleName}</h4>
                    <button
                      type="button"
                      onClick={() => saveModuleOverrides(moduleName)}
                      disabled={savingKey === `mod:${moduleName}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Save size={11} />
                      {savingKey === `mod:${moduleName}` ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 p-3 text-xs">
                    {ALL_PERMS.map(p => {
                      const k = `${moduleName}:${p.key}`;
                      const current = moduleOverrides[k] || '';
                      return (
                        <div key={p.key} className="flex items-center gap-2 p-2 border border-slate-100 rounded">
                          <span className={`font-medium ${p.color} min-w-[60px]`}>{p.label}</span>
                          <CustomSelect
                            value={current}
                            onChange={(e) => setModuleOverride(moduleName, p.key, e.target.value)}
                            className={`flex-1 px-1.5 py-0.5 border border-slate-300 rounded text-[11px] ${
                              current === 'DENY'  ? 'bg-red-50 text-red-700' :
                              current === 'GRANT' ? 'bg-emerald-50 text-emerald-700' :
                              'bg-white text-slate-500'
                            }`}
                          >
                            <option value="">Use role</option>
                            <option value="GRANT">Grant</option>
                            <option value="DENY">Deny</option>
                          </CustomSelect>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── Field-level user overrides ── */}
          <section>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Field Overrides</h3>
            <div className="space-y-3">
              {catalog.map(({ name: moduleName, fields }) => (
                <div key={moduleName} className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-slate-800">{moduleName}</h4>
                    <button
                      type="button"
                      onClick={() => saveFieldOverrides(moduleName, fields)}
                      disabled={savingKey === `fld:${moduleName}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Save size={11} />
                      {savingKey === `fld:${moduleName}` ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-primary-50 border-b-2 border-slate-300 text-xs">
                        <th className="text-left px-4 py-2 font-medium text-slate-600">Field</th>
                        <th className="text-left px-4 py-2 font-medium text-slate-600 w-40">Override</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map(f => {
                        const k = `${moduleName}:${f.key}`;
                        const current = fieldOverrides[k] || 'DEFAULT';
                        return (
                          <tr key={f.key} className="border-b border-slate-100 last:border-b-0">
                            <td className="px-4 py-2">
                              <div className="font-medium text-slate-800">{f.label}</div>
                              <div className="text-[11px] text-slate-500 font-mono">{f.key}</div>
                            </td>
                            <td className="px-4 py-2">
                              <CustomSelect
                                value={current}
                                onChange={(e) => setFieldOverride(moduleName, f.key, e.target.value)}
                                className={`w-full px-2 py-1 border border-slate-300 rounded text-sm ${
                                  current === 'HIDDEN'    ? 'bg-red-50 text-red-700' :
                                  current === 'READ_ONLY' ? 'bg-amber-50 text-amber-700' :
                                  current === 'VIEW'      ? 'bg-emerald-50 text-emerald-700' :
                                  'bg-white text-slate-500'
                                }`}
                              >
                                <option value="DEFAULT">Use role</option>
                                <option value="VIEW">Visible (force show)</option>
                                <option value="READ_ONLY">Read-only</option>
                                <option value="HIDDEN">Hidden</option>
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
          </section>
        </div>
      )}
    </>
  );
}

// ── Data tab — warehouse_scope editor per user ───────────────────────
//
// Lists every StakeholderUser, exposes their current warehouse_scope,
// and lets the admin add or remove warehouses from that scope. The
// changes hit `/api/users/{id}/assign_warehouse_scope/` — already
// implemented in `apps.core.views.StakeholderUserViewSet`. No backend
// work needed for this tab.
function DataTab() {
  const [users, setUsers] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [savingUserId, setSavingUserId] = useState(null);
  const [savingAll, setSavingAll] = useState(false);
  // Per-user baseline of the last-saved warehouse scope, keyed by user id
  // and stored as a sorted comma-joined id string. A row is "dirty" (its
  // Save button enabled) only when its current scope differs from this
  // baseline. Seeded on load and refreshed after every successful save so
  // the button disables itself the moment the row matches what's persisted.
  const [baseline, setBaseline] = useState({});
  // Per-user "Saved HH:MM" stamp shown next to a clean row, plus the most
  // recent save time for the page-level Save All control.
  const [savedAt, setSavedAt] = useState({});
  const [lastSavedAt, setLastSavedAt] = useState('');

  const scopeIds = (user) => (user.warehouse_scope || []).map(w => (typeof w === 'object' ? w.id : w));
  const scopeKey = (ids) => [...ids].map(String).sort().join(',');
  const isDirty = (user) => scopeKey(scopeIds(user)) !== (baseline[user.id] ?? '');
  const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Initial fetch — users + warehouses. Both small lookups, fast.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    Promise.all([
      apiClient.get('/api/users/?page_size=500'),
      apiClient.get('/api/warehouses/?page_size=500'),
    ]).then(([uRes, wRes]) => {
      if (cancelled) return;
      const u = uRes.data?.results || uRes.data || [];
      const w = wRes.data?.results || wRes.data || [];
      setUsers(u);
      setWarehouses(w);
      // Seed each row's baseline from the persisted scope so nothing reads
      // as dirty until the admin actually changes it.
      const base = {};
      u.forEach(usr => {
        base[usr.id] = [...(usr.warehouse_scope || []).map(x => (typeof x === 'object' ? x.id : x))]
          .map(String).sort().join(',');
      });
      setBaseline(base);
    }).catch(() => {
      if (!cancelled) toast.error('Failed to load users / warehouses');
    }).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return users;
    return users.filter(u => {
      // The serializer flattens user fields to top-level keys (username,
      // full_name, user_first_name, user_last_name). The old code also
      // tried `u.user?.username` for an earlier nested shape — kept as
      // a fallback so an in-flight schema migration doesn't blank the
      // search.
      const username = (u.username || u.user?.username || '').toLowerCase();
      const fullName = (
        u.full_name
        || `${u.user_first_name || u.user?.first_name || ''} ${u.user_last_name || u.user?.last_name || ''}`
        || u.primary_email
        || ''
      ).toLowerCase();
      return username.includes(term) || fullName.includes(term);
    });
  }, [users, search]);

  const setUserScope = (userId, warehouseIds) => {
    setUsers(prev => prev.map(u =>
      u.id === userId ? { ...u, warehouse_scope: warehouseIds } : u,
    ));
  };

  const toggleWarehouseForUser = (user, warehouseId) => {
    const current = (user.warehouse_scope || []).map(w =>
      typeof w === 'object' ? w.id : w,
    );
    const next = current.includes(warehouseId)
      ? current.filter(id => id !== warehouseId)
      : [...current, warehouseId];
    setUserScope(user.id, next);
  };

  const saveUserScope = async (user) => {
    setSavingUserId(user.id);
    try {
      const ids = scopeIds(user);
      await apiClient.post(
        `/api/users/${user.id}/assign_warehouse_scope/`,
        { warehouse_ids: ids },
      );
      const t = nowTime();
      setBaseline(prev => ({ ...prev, [user.id]: scopeKey(ids) }));
      setSavedAt(prev => ({ ...prev, [user.id]: t }));
      setLastSavedAt(t);
      toast.success(
        `Warehouse access updated for ${user.username || user.user?.username || user.id}`,
      );
    } catch (e) {
      toast.error(getApiErrorMessage(e));
    } finally {
      setSavingUserId(null);
    }
  };

  // Save every row that differs from its baseline in one request batch.
  // Runs the per-user scope POSTs in parallel, then refreshes all their
  // baselines + stamps so each Save button disables itself again.
  const saveAll = async () => {
    const dirty = users.filter(isDirty);
    if (dirty.length === 0) return;
    setSavingAll(true);
    try {
      await Promise.all(dirty.map(u =>
        apiClient.post(`/api/users/${u.id}/assign_warehouse_scope/`, { warehouse_ids: scopeIds(u) }),
      ));
      const t = nowTime();
      setBaseline(prev => {
        const next = { ...prev };
        dirty.forEach(u => { next[u.id] = scopeKey(scopeIds(u)); });
        return next;
      });
      setSavedAt(prev => {
        const next = { ...prev };
        dirty.forEach(u => { next[u.id] = t; });
        return next;
      });
      setLastSavedAt(t);
      toast.success(`Saved warehouse access for ${dirty.length} user${dirty.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast.error(getApiErrorMessage(e));
    } finally {
      setSavingAll(false);
    }
  };

  if (isLoading) {
    return <p className="text-sm text-slate-500">Loading users and warehouses…</p>;
  }
  if (warehouses.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No warehouses found. Create at least one warehouse in Master → Warehouses before configuring data access.
      </p>
    );
  }

  const dirtyCount = users.filter(isDirty).length;

  return (
    <>
      <div className="mb-4 p-3 bg-indigo-50/40 border border-indigo-200 rounded-lg text-xs text-slate-700">
        <p>
          <strong>Per-user warehouse access.</strong> Each user only sees Sales records
          whose warehouse is in their assigned scope. Users with no scope
          assigned see every warehouse (legacy admins are unaffected until
          you opt them in here).
        </p>
        <p className="mt-1 text-slate-500">
          Bypass roles (Sales Manager, Office Manager, Finance, Accounts, IT
          Admin) see every warehouse <em>by default</em>, but ticking
          a specific warehouse below for one of them now wins —
          the per-user assignment always takes precedence over the
          role's open access.
        </p>
      </div>

      <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by username or name…"
          className="w-full sm:max-w-md px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
        />
        {/* One Save All control replaces hunting for the right row's
            button. Shows the unsaved-row count, the last-saved time, and
            disables (with an explanatory tooltip) once everything is in
            sync with the server. */}
        <div className="flex items-center gap-3 sm:ml-auto">
          {lastSavedAt && (
            <span className="text-xs text-slate-400 whitespace-nowrap">Last saved {lastSavedAt}</span>
          )}
          <span className={`text-xs whitespace-nowrap ${dirtyCount > 0 ? 'text-amber-600 font-medium' : 'text-slate-400'}`}>
            {dirtyCount > 0 ? `${dirtyCount} unsaved` : 'All changes saved'}
          </span>
          <span
            className="inline-block"
            title={dirtyCount > 0 ? `Save ${dirtyCount} changed row${dirtyCount > 1 ? 's' : ''}` : 'All changes saved'}
          >
            <button
              type="button"
              onClick={saveAll}
              disabled={savingAll || dirtyCount === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save size={14} />
              {savingAll ? 'Saving…' : `Save All${dirtyCount > 0 ? ` (${dirtyCount})` : ''}`}
            </button>
          </span>
        </div>
      </div>

      {/* Mobile-stacked: one card per user with warehouses as
          toggle chips, since the full N-column table doesn't fit. */}
      <div className="sm:hidden space-y-3">
        {filteredUsers.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4 sm:py-5">No users match this search.</p>
        ) : filteredUsers.map(user => {
          const scope = (user.warehouse_scope || []).map(w => typeof w === 'object' ? w.id : w);
          const username = user.username || user.user?.username || `User #${user.id}`;
          const displayName = [user.user_first_name || user.user?.first_name, user.user_last_name || user.user?.last_name].filter(Boolean).join(' ');
          return (
            <div key={`m-${user.id}`} className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-sm text-slate-800 truncate">{username}</div>
                  {displayName && <div className="text-xs text-slate-500 truncate">{displayName}</div>}
                  {scope.length === 0 && <div className="text-[11px] text-amber-700 italic">No scope → sees all</div>}
                  {!isDirty(user) && savedAt[user.id] && <div className="text-[10px] text-emerald-600">Saved {savedAt[user.id]}</div>}
                </div>
                <span
                  className="inline-block shrink-0"
                  title={isDirty(user) ? 'Save warehouse access' : 'All changes saved'}
                >
                  <button
                    type="button"
                    onClick={() => saveUserScope(user)}
                    disabled={savingUserId === user.id || savingAll || !isDirty(user)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Save size={11} />
                    {savingUserId === user.id ? 'Saving…' : 'Save'}
                  </button>
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {warehouses.map(w => {
                  const on = scope.includes(w.id);
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => toggleWarehouseForUser(user, w.id)}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border transition ${on ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'bg-slate-50 text-slate-500 border-slate-200'}`}
                    >
                      {on && <Check size={10} />}
                      {w.name}
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
              <th className="text-left px-4 py-2 font-semibold text-slate-700">User</th>
              {warehouses.map(w => (
                <th key={w.id} className="text-center px-2 py-2 font-medium text-slate-600 text-xs">
                  {w.name}
                  <div className="text-[10px] font-normal text-slate-400">{w.warehouse_code}</div>
                </th>
              ))}
              <th className="text-center px-2 py-2 w-24">Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={warehouses.length + 2} className="px-4 py-4 sm:py-5 text-center text-sm text-slate-400">
                  No users match this search.
                </td>
              </tr>
            ) : (
              filteredUsers.map(user => {
                const scope = (user.warehouse_scope || []).map(w =>
                  typeof w === 'object' ? w.id : w,
                );
                const username = user.username || user.user?.username || `User #${user.id}`;
                const displayName = [
                  user.user_first_name || user.user?.first_name,
                  user.user_last_name  || user.user?.last_name,
                ].filter(Boolean).join(' ');
                return (
                  <tr key={user.id} className="border-b border-slate-100 hover:bg-indigo-50/20">
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-800">{username}</div>
                      {displayName && (
                        <div className="text-xs text-slate-500">{displayName}</div>
                      )}
                      {scope.length === 0 && (
                        <div className="text-[11px] text-amber-700 italic mt-0.5">
                          No scope → sees all
                        </div>
                      )}
                    </td>
                    {warehouses.map(w => (
                      <td key={w.id} className="text-center px-2 py-2">
                        <input
                          type="checkbox"
                          checked={scope.includes(w.id)}
                          onChange={() => toggleWarehouseForUser(user, w.id)}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      </td>
                    ))}
                    <td className="text-center px-2 py-2">
                      <span
                        className="inline-block"
                        title={isDirty(user) ? `Save warehouse access for ${username}` : 'All changes saved'}
                      >
                        <button
                          type="button"
                          onClick={() => saveUserScope(user)}
                          disabled={savingUserId === user.id || savingAll || !isDirty(user)}
                          className="inline-flex items-center gap-1 px-3 py-1 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Save size={11} />
                          {savingUserId === user.id ? 'Saving…' : 'Save'}
                        </button>
                      </span>
                      {!isDirty(user) && savedAt[user.id] && (
                        <div className="text-[10px] text-emerald-600 mt-0.5 whitespace-nowrap">Saved {savedAt[user.id]}</div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
