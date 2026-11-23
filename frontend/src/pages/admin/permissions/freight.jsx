import CustomSelect from "@/components/ui/CustomSelect";
/**
 * Freight-only Permission Management.
 *
 * Mirror of /admin/permissions/sales scoped to Freight-category modules.
 * Reads and writes the same RBAC tables (RolePermission /
 * RoleFieldPermission / UserPermissionOverride) — this page is purely a
 * UI restructuring so admins can focus on Freight without scrolling
 * through every module in the org.
 *
 *   Freight Module
 *     ├── Page Permissions   (View / Create / Edit / Delete)
 *     ├── Button Permissions (Approve / Reject / Confirm / Email …)
 *     ├── Field Permissions  (placeholder — backend catalog pending)
 *     ├── Data Permissions   (per-user warehouse_scope — shared with Sales page)
 *     └── User Overrides     (per-user GRANT/DENY — shared with Sales page)
 *
 * IMPORTANT: Outward Freight is intentionally excluded — its permission
 * is owned by the SALES module ("Sales Freight" slug, sales-freight), so
 * it lives on the Sales Permissions page. This page strictly handles the
 * four Freight-category modules:
 *   • Freight Advice  (Inward Freight)
 *   • Freight Payment
 *   • Wage Entry      (Loading/Unloading Wages)
 *   • Wage Payment
 *
 * The Data / Override tabs are deliberately shared between Sales /
 * Purchase / Freight: warehouse access and per-user grants apply across
 * the whole user, not per-module. Linking to the Sales page for those
 * editors avoids duplicating UI that already works.
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

// ── Permission definitions ───────────────────────────────────────────
// The shared RolePermission table has the same 14 flags regardless of
// module category. Split into Page (CRUD) and Button (workflow /
// utility) buckets for the UI — identical to the Sales / Purchase
// pages. APPLICABLE_BUTTON_PERMS narrows the button grid so the admin
// doesn't see toggles for buttons that don't exist on a given page.
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
  { key: 'can_close',       label: 'Close',       color: 'text-slate-600' },
  { key: 'can_cancel',      label: 'Cancel',      color: 'text-orange-600' },
  { key: 'can_issue',       label: 'Issue',       color: 'text-indigo-600' },
  { key: 'can_convert',     label: 'Convert',     color: 'text-purple-600' },
  { key: 'can_send_email',  label: 'Email',       color: 'text-sky-600' },
  { key: 'can_export',      label: 'Export',      color: 'text-cyan-600' },
  { key: 'can_print',       label: 'Print',       color: 'text-violet-600' },
];

// Per-Freight-module map of which button permissions correspond to an
// actual button on a real page. Cells outside this set render disabled.
// Maintenance: when a new freight button is gated on
// `usePermissions().canXxx('<module>')` in the codebase, add the
// matching flag key here so admins can toggle it.
const APPLICABLE_BUTTON_PERMS = {
  // Inward Freight (backend module name = "Freight Advice") — the inbound
  // freight-advice group (Freight / Freight Bills / Two-way in the sidebar).
  // Moved here from the Purchase page so its controls live where the menu
  // items do. Both keys are listed so the applicability lookup resolves
  // whether a row is rendered with the backend name or the display label.
  'Freight Advice': new Set(['can_approve', 'can_reject', 'can_cancel', 'can_convert', 'can_send_email', 'can_export', 'can_print']),
  'Inward Freight': new Set(['can_approve', 'can_reject', 'can_cancel', 'can_convert', 'can_send_email', 'can_export', 'can_print']),
  // Freight Payment. Approve releases payment; Reject sends back;
  // Cancel reverses; Email (remittance advice); Export / Print.
  'Freight Payment': new Set(['can_approve', 'can_reject', 'can_cancel', 'can_send_email', 'can_export', 'can_print']),
  // Loading/Unloading Wages (Wage Entry). Approve the contractor's
  // wage claim; Reject; Cancel; Export / Print muster + payslips.
  'Wage Entry': new Set(['can_approve', 'can_reject', 'can_cancel', 'can_send_email', 'can_export', 'can_print']),
  // Wage Payment — periodic contractor wage settlements. Approve to
  // release; Reject sends back to wage-entry stage; Cancel reverses;
  // Email remittance; Export / Print.
  'Wage Payment': new Set(['can_approve', 'can_reject', 'can_cancel', 'can_send_email', 'can_export', 'can_print']),
  // Local Freight — standalone freight/charges bills. Just Export / Print
  // (no approval workflow).
  'Local Freight': new Set(['can_export', 'can_print']),
};

const ALL_PERMS = [...PAGE_PERMS, ...BUTTON_PERMS];

// Slugs counted as "Freight" for this page. We prefer the API's
// `category === 'FREIGHT'` filter; this list is a belt-and-braces
// fallback for legacy modules without a category set. Sales Freight
// (slug: sales-freight) is deliberately omitted — owned by the Sales
// page.
const FREIGHT_SLUG_FALLBACK = new Set([
  'freight-advice',
  'freight-payment',
  'wage-entry', 'wage-payment',
  'local-freight',
]);

// Friendly labels for modules whose stored `module.name` differs from
// what the operator expects to see here. The DB row is left alone
// (renaming would break the backend's hardcoded module_name checks) —
// we only substitute on render.
const MODULE_DISPLAY_NAMES = {
  'Freight Advice': 'Inward Freight',
};
const labelOf = (name) => MODULE_DISPLAY_NAMES[name] || name;

const TABS = [
  { key: 'page',     label: 'Page Permissions',   icon: FileText,      desc: 'View / Create / Edit / Delete' },
  { key: 'button',   label: 'Button Permissions', icon: MousePointer2, desc: 'Approve · Reject · Confirm · Email · Export · Print' },
  { key: 'field',    label: 'Field Permissions',  icon: Eye,           desc: 'Hide / lock individual fields per role' },
  { key: 'data',     label: 'Data Permissions',   icon: Database,      desc: 'Warehouse access per user' },
  { key: 'override', label: 'User Overrides',     icon: UserCog,       desc: 'Per-user grant / deny on top of role' },
];

// Field-access values mirror the backend RoleFieldPermission model.
// Keep wording short for the dropdown — descriptive labels live in
// the helper text below the table.
const FIELD_ACCESS_OPTIONS = [
  { value: 'VIEW',      label: 'Visible' },
  { value: 'READ_ONLY', label: 'Read-only' },
  { value: 'HIDDEN',    label: 'Hidden' },
];

export default function FreightPermissionsPage() {
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

  // Filter modules to Freight-category only. Prefer the API's
  // `category` field; fall back to a hardcoded slug list when the
  // field is empty (some legacy modules predate the categorisation).
  // EXPLICITLY excludes:
  //  • 'sales-freight'   — owned by the Sales permissions page.
  // 'freight-advice' (Inward Freight) is now managed HERE: its sidebar
  // items (Freight / Freight Bills / Two-way) live under FREIGHT, so its
  // control was moved off the Purchase card onto this one.
  const freightModules = useMemo(() => {
    return modules.filter(m => {
      if (m.slug === 'sales-freight') return false;
      if (m.category === 'FREIGHT') return true;
      return FREIGHT_SLUG_FALLBACK.has(m.slug);
    });
  }, [modules]);

  // Fetch role's permissions when role changes; build a grid limited
  // to the freight modules only.
  useEffect(() => {
    if (!selectedRole || freightModules.length === 0) {
      setPermissionGrid([]);
      return;
    }
    setIsLoadingPerms(true);
    apiClient.get(`/api/rbac/role-permissions/?role=${selectedRole}`)
      .then(res => {
        const rolePerms = res.data?.results || res.data || [];
        const grid = freightModules.map(mod => {
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
        toast.error('Failed to load Freight permissions');
        setPermissionGrid([]);
      })
      .finally(() => setIsLoadingPerms(false));
  }, [selectedRole, freightModules]);

  const togglePerm = (moduleId, key) => {
    setPermissionGrid(prev =>
      prev.map(r => r.module_id === moduleId ? { ...r, [key]: !r[key] } : r),
    );
  };

  // Column toggle is restricted to rows where the perm is applicable
  // (passed in from the table header), so clicking, say, "Convert"
  // doesn't pointlessly tick it on Freight Payment (no Convert button).
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
      // payload echoes every flag from the grid so values from the
      // other tab aren't lost when one tab is saved.
      const payload = {
        role_id: parseInt(selectedRole, 10),
        permissions: permissionGrid.map(row => {
          const perm = { module_id: row.module_id };
          ALL_PERMS.forEach(f => { perm[f.key] = row[f.key]; });
          return perm;
        }),
      };
      await apiClient.post('/api/rbac/role-permissions/bulk/', payload);
      toast.success('Freight permissions saved');
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Freight Module Permissions"
        subtitle="Dedicated permission controls for the Freight module — page, button, field and warehouse-based data access"
        breadcrumbs={[
          { label: 'Admin' },
          { label: 'Permissions', path: '/admin/permissions' },
          { label: 'Freight' },
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
              modules={freightModules}
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
            // Warehouse scope is user-level (same store the Sales page
            // writes to), so any edit here flows through to Sales and
            // Purchase visibility too — they share the same scope.
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
// Identical in shape to the Sales / Purchase PermTab. When this grows
// into a third copy of the same code it should be lifted into a
// `components/admin/PermTab.jsx` shared by all three category pages.
function PermTab({
  perms, tabLabel, roleOptions, selectedRole, setSelectedRole,
  modules, permissionGrid, isLoading, isSaving,
  onTogglePerm, onToggleColumn, onToggleRow, onSave,
}) {
  const getRow = (id) => permissionGrid.find(r => r.module_id === id);
  // Page tab always applicable (every module has CRUD); only Button
  // tab consults APPLICABLE_BUTTON_PERMS. Modules not in the catalog
  // (legacy / not-yet-mapped) default to applicable so we never hide
  // toggles by accident.
  const isPermApplicable = (moduleName, permKey) => {
    if (tabLabel !== 'Button') return true;
    const set = APPLICABLE_BUTTON_PERMS[moduleName];
    if (!set) return true;
    return set.has(permKey);
  };
  // Aggregate helpers count only applicable cells so the "All" header
  // shows as fully-on when every relevant cell is ticked, without
  // needing every theoretical cell to be ticked too.
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
        <p className="text-sm text-slate-500 italic">Pick a role to see its Freight {tabLabel.toLowerCase()} permissions.</p>
      ) : isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : modules.length === 0 ? (
        <p className="text-sm text-slate-500">No Freight modules registered yet.</p>
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
                  <span className="text-sm font-semibold text-slate-800 truncate">{labelOf(mod.name)}</span>
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
              <tr className="bg-slate-100 border-b border-slate-200">
                <th className="text-left px-4 py-2 font-semibold text-slate-700 min-w-[200px] sticky left-0 z-20 bg-slate-100">
                  Freight Module
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
                      {labelOf(mod.name)}
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
// Catalog comes from `/api/rbac/manageable-freight-fields/` so adding
// a field to the Freight catalog server-side
// (apps/purchase/freight_field_permissions.py:MANAGEABLE_FREIGHT_FIELDS)
// surfaces it in the UI automatically — no frontend rebuild needed.
// Saves go through the shared `/api/rbac/role-field-permissions/bulk/`
// endpoint that Sales and Purchase already use; it replaces the rows
// for one (role, module) atomically.
function FieldTab({ roleOptions, selectedRole, setSelectedRole }) {
  const [catalog, setCatalog] = useState([]);
  const [currentPerms, setCurrentPerms] = useState({});  // { 'Freight Advice:advice_no' -> 'READ_ONLY' }
  const [isLoading, setIsLoading] = useState(true);
  const [savingModule, setSavingModule] = useState(null);

  // Catalog is static — fetch once on mount.
  useEffect(() => {
    setIsLoading(true);
    apiClient.get('/api/rbac/manageable-freight-fields/')
      .then(res => setCatalog(res.data?.modules || []))
      .catch(() => toast.error('Failed to load field catalog'))
      .finally(() => setIsLoading(false));
  }, []);

  // When the role changes, refresh existing overrides for that role
  // across every Freight module we manage. The default 'VIEW' is
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
        <p className="text-sm text-slate-500 italic">Pick a role to see its Freight field permissions.</p>
      ) : catalog.length === 0 ? (
        <p className="text-sm text-slate-500">No Freight fields registered for management yet.</p>
      ) : (
        <div className="space-y-4 sm:space-y-5">
          {catalog.map(mod => (
            <div key={mod.name} className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="bg-slate-50 px-4 py-2 flex items-center justify-between border-b border-slate-200">
                <h3 className="font-semibold text-slate-800">{labelOf(mod.name)}</h3>
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

// ── Data tab — warehouse_scope editor per user ───────────────────────
//
// Lists every StakeholderUser, exposes their current warehouse_scope,
// and lets the admin add or remove warehouses from that scope. The
// changes hit `/api/users/{id}/assign_warehouse_scope/` — already
// implemented in `apps.core.views.StakeholderUserViewSet`. No backend
// work needed for this tab.
//
// IMPORTANT: warehouse_scope is user-level, not module-scoped, so the
// edits here flow through to Sales / Purchase / Freight visibility
// alike. Same backing field as the Sales page's Data tab.
function DataTab() {
  const [users, setUsers] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [savingUserId, setSavingUserId] = useState(null);

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
      // Serializer flattens user fields to top-level keys; fall back
      // to the older nested shape so an in-flight schema migration
      // doesn't blank the search.
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
      const ids = (user.warehouse_scope || []).map(w =>
        typeof w === 'object' ? w.id : w,
      );
      await apiClient.post(
        `/api/users/${user.id}/assign_warehouse_scope/`,
        { warehouse_ids: ids },
      );
      toast.success(
        `Warehouse access updated for ${user.username || user.user?.username || user.id}`,
      );
    } catch (e) {
      toast.error(getApiErrorMessage(e));
    } finally {
      setSavingUserId(null);
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

  return (
    <>
      <div className="mb-4 p-3 bg-indigo-50/40 border border-indigo-200 rounded-lg text-xs text-slate-700">
        <p>
          <strong>Per-user warehouse access.</strong> Each user only sees Freight
          records whose warehouse is in their assigned scope. Users with no
          scope assigned see every warehouse (legacy admins are unaffected
          until you opt them in here).
        </p>
        <p className="mt-1 text-slate-500">
          Bypass roles (Sales Manager, Office Manager, Finance, Accounts, IT
          Admin) always see every warehouse regardless of this setting. The
          same scope applies on the Sales and Purchase pages — editing here
          updates all three.
        </p>
      </div>

      <div className="mb-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by username or name…"
          className="w-full max-w-md px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {/* Mobile-stacked: one card per user with warehouses as toggle
          chips — the wide table doesn't fit on phones. */}
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
                </div>
                <button
                  type="button"
                  onClick={() => saveUserScope(user)}
                  disabled={savingUserId === user.id}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 shrink-0"
                >
                  <Save size={11} />
                  {savingUserId === user.id ? 'Saving…' : 'Save'}
                </button>
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
            <tr className="bg-slate-100 border-b border-slate-200">
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
                      <button
                        type="button"
                        onClick={() => saveUserScope(user)}
                        disabled={savingUserId === user.id}
                        className="inline-flex items-center gap-1 px-3 py-1 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
                      >
                        <Save size={11} />
                        {savingUserId === user.id ? 'Saving…' : 'Save'}
                      </button>
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

// ── User Overrides tab — per-user grant/deny + field overrides ──────
//
// Pick a user → see their effective role → configure surgical
// exceptions on top of that role. Two override layers on one page:
//   1. Module-action overrides (GRANT / DENY) — flip specific
//      buttons / pages for this one user.
//   2. Field overrides (Visible / Read-only / Hidden) — match the
//      role-field UI but applied per-user. Useful when one senior
//      person needs to see a field everyone else on the role can't.
// Backend semantics: DENY wins over GRANT for the same action,
// per-user field overrides REPLACE the role's field policy.
//
// Catalog comes from `/api/rbac/manageable-freight-fields/` so this
// tab is scoped to Freight modules only — the matching Sales tab
// covers Sales modules, and vice-versa.
function UserOverridesTab() {
  const [users, setUsers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [moduleOverrides, setModuleOverrides] = useState({}); // 'Freight Advice:can_approve' -> 'GRANT' | 'DENY'
  const [fieldOverrides, setFieldOverrides] = useState({});   // 'Freight Advice:freight_terms' -> 'VIEW' | 'READ_ONLY' | 'HIDDEN'
  const [isLoading, setIsLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);

  useEffect(() => {
    setIsLoading(true);
    Promise.all([
      apiClient.get('/api/rbac/users/?page_size=500'),
      apiClient.get('/api/rbac/manageable-freight-fields/'),
    ]).then(([uRes, cRes]) => {
      const u = uRes.data?.results || uRes.data || [];
      setUsers(u);
      setCatalog(cRes.data?.modules || []);
    }).catch(() => toast.error('Failed to load users / catalog'))
      .finally(() => setIsLoading(false));
  }, []);

  // Refresh both override sets whenever the selected user changes.
  // We pull ALL of the user's overrides (across every module) and
  // filter to freight modules in the render — keeps the request count
  // at 2 regardless of how many freight modules exist.
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

  // The module-action axis = ALL_PERMS (14 flags). We expose every
  // flag for every freight module so admins can flip any action —
  // even ones that aren't currently bound to a button — without
  // having to wait for new APPLICABLE_BUTTON_PERMS entries.
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
          flip individual freight actions or fields on top of their role.
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
        <p className="text-sm text-slate-500">No Freight modules registered.</p>
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
                      <tr className="bg-slate-100 border-b border-slate-200 text-xs">
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
