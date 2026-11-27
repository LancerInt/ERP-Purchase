import CustomSelect from "@/components/ui/CustomSelect";
/**
 * HR-only Permission Management.
 *
 * Sibling of /admin/permissions/purchase scoped to HR-category modules
 * (Staff · Attendance · Leave · Overtime · Shift · Payroll · Holiday
 * Calendar). Reads and writes the same RBAC tables (RolePermission /
 * RoleFieldPermission / UserPermissionOverride) — purely a UI surface so
 * admins can manage HR without scrolling every module.
 *
 *   HR Module
 *     ├── Page Permissions   (View / Create / Edit / Delete)
 *     ├── Button Permissions (Approve / Export — the only real HR buttons)
 *     ├── Field Permissions  (Hide / lock salary, bank, PII, payroll figures)
 *     └── User Overrides     (per-user GRANT/DENY + field overrides)
 *
 * NOTE: the warehouse "Data Permissions" tab is intentionally omitted —
 * warehouse_scope is a global, user-level setting managed on the Sales /
 * Purchase pages; surfacing it here would imply an HR-specific scope that
 * doesn't exist.
 */
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Save, Check, FileText, MousePointer2, Eye, UserCog,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useApiData from '../../../hooks/useApiData.js';
import { UserOverridesTab } from './sharedUserTabs.jsx';

// ── Permission definitions ───────────────────────────────────────────
// The RolePermission table carries the same flags for every module; we
// split them into Page (CRUD) and Button (workflow) buckets for the UI.
const PAGE_PERMS = [
  { key: 'can_view',   label: 'View',   color: 'text-blue-600' },
  { key: 'can_create', label: 'Create', color: 'text-green-600' },
  { key: 'can_edit',   label: 'Edit',   color: 'text-amber-600' },
  { key: 'can_delete', label: 'Delete', color: 'text-red-600' },
];

// HR has a thin workflow surface — Approve (Leave / Overtime / Attendance)
// and Export. Reject is NOT a separate flag: every HR Reject button is
// gated on can_approve in the codebase, so granting Approve also grants
// Reject. We don't surface a dead can_reject toggle.
const BUTTON_PERMS = [
  { key: 'can_approve', label: 'Approve', color: 'text-emerald-600' },
  { key: 'can_export',  label: 'Export',  color: 'text-cyan-600' },
];

// Per-HR-module set of which button permissions correspond to a real
// button in the app. Cells outside this set render disabled.
// Maintenance: add a flag here only when an HR button is gated on
// `usePermissions().canXxx('<module>')` somewhere in the codebase.
const APPLICABLE_BUTTON_PERMS = {
  // Staff: list export is gated by canExport('Staff'). No approve.
  'Staff':            new Set(['can_export']),
  // Attendance: per-row + drawer Approve (canApprove). The "Export
  // Report" button is ungated (always shown) — so can_export is NOT a
  // real toggle here.
  'Attendance':       new Set(['can_approve']),
  // Leave: Approve (also gates Reject) + list Export.
  'Leave':            new Set(['can_approve', 'can_export']),
  // Overtime: Approve (also gates Reject) + list Export.
  'Overtime':         new Set(['can_approve', 'can_export']),
  // Shift / Holiday Calendar: pure CRUD, no workflow buttons.
  'Shift':            new Set([]),
  'Holiday Calendar': new Set([]),
  // Payroll: Run/Generate rides can_create; Export is gated by
  // canExport('Payroll'). Regenerate/Download are ungated.
  'Payroll':          new Set(['can_export']),
};

// HR module names already read cleanly — no display-name overrides.
const MODULE_DISPLAY_NAMES = {};

const ALL_PERMS = [...PAGE_PERMS, ...BUTTON_PERMS];

// Slugs counted as "HR" — belt-and-braces fallback for modules whose
// API `category` is somehow empty (they are seeded as category='HR').
const HR_SLUG_FALLBACK = new Set([
  'staff', 'shift', 'attendance', 'leave', 'overtime', 'payroll', 'holiday-calendar',
]);

const TABS = [
  { key: 'page',     label: 'Page Permissions',   icon: FileText,      desc: 'View / Create / Edit / Delete' },
  { key: 'button',   label: 'Button Permissions', icon: MousePointer2, desc: 'Approve · Export' },
  { key: 'field',    label: 'Field Permissions',  icon: Eye,           desc: 'Hide / lock salary, bank, PII and payroll figures per role' },
  { key: 'override', label: 'User Overrides',     icon: UserCog,       desc: 'Per-user grant / deny + field overrides on top of role' },
];

const FIELD_ACCESS_OPTIONS = [
  { value: 'VIEW',      label: 'Visible' },
  { value: 'READ_ONLY', label: 'Read-only' },
  { value: 'HIDDEN',    label: 'Hidden' },
];

export default function HRPermissionsPage() {
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

  // Filter modules to the HR category. Prefer the API `category`; fall
  // back to the hardcoded slug list for safety.
  const hrModules = useMemo(() => {
    return modules
      .filter(m => {
        if (m.category === 'HR') return true;
        return HR_SLUG_FALLBACK.has(m.slug);
      })
      .map(m => MODULE_DISPLAY_NAMES[m.name]
        ? { ...m, name: MODULE_DISPLAY_NAMES[m.name], _backendName: m.name }
        : m
      );
  }, [modules]);

  useEffect(() => {
    if (!selectedRole || hrModules.length === 0) {
      setPermissionGrid([]);
      return;
    }
    setIsLoadingPerms(true);
    apiClient.get(`/api/rbac/role-permissions/?role=${selectedRole}`)
      .then(res => {
        const rolePerms = res.data?.results || res.data || [];
        const grid = hrModules.map(mod => {
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
        toast.error('Failed to load HR permissions');
        setPermissionGrid([]);
      })
      .finally(() => setIsLoadingPerms(false));
  }, [selectedRole, hrModules]);

  const togglePerm = (moduleId, key) => {
    setPermissionGrid(prev =>
      prev.map(r => r.module_id === moduleId ? { ...r, [key]: !r[key] } : r),
    );
  };

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
      const payload = {
        role_id: parseInt(selectedRole, 10),
        permissions: permissionGrid.map(row => {
          const perm = { module_id: row.module_id };
          ALL_PERMS.forEach(f => { perm[f.key] = row[f.key]; });
          return perm;
        }),
      };
      await apiClient.post('/api/rbac/role-permissions/bulk/', payload);
      toast.success('HR permissions saved');
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="HR Module Permissions"
        subtitle="Dedicated permission controls for HR — page, button and field-level access (salary, bank, PII, payroll figures) per role"
        breadcrumbs={[
          { label: 'Admin' },
          { label: 'Permissions', path: '/admin/permissions' },
          { label: 'HR' },
        ]}
      />


      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
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
                    ? 'border-teal-600 text-teal-700'
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
              modules={hrModules}
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
          ) : (
            <UserOverridesTab
              fieldsEndpoint="/api/rbac/manageable-hr-fields/"
              allPerms={ALL_PERMS}
              moduleLabel="HR"
            />
          )}
        </div>
      </div>
    </MainLayout>
  );
}

// ── Page / Button tab ───────────────────────────────────────────────
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
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-500"
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
            className="inline-flex items-center gap-2 px-5 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50"
          >
            <Save size={14} />
            {isSaving ? 'Saving…' : 'Save Permissions'}
          </button>
        )}
      </div>

      {!selectedRole ? (
        <p className="text-sm text-slate-500 italic">Pick a role to see its HR {tabLabel.toLowerCase()} permissions.</p>
      ) : isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : modules.length === 0 ? (
        <p className="text-sm text-slate-500">No HR modules registered yet.</p>
      ) : (
        <>
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
                      className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-40 disabled:cursor-not-allowed"
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
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border transition disabled:opacity-30 disabled:cursor-not-allowed ${on ? 'bg-teal-50 border-teal-300 ' + f.color : 'bg-slate-50 text-slate-500 border-slate-200'}`}
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
                  HR Module
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
                  <tr key={mod.id} className="border-b border-slate-100 hover:bg-teal-50/30">
                    <td className="px-4 py-2 font-medium text-slate-800 sticky left-0 z-10 bg-white">
                      {mod.name}
                    </td>
                    <td className="text-center px-2 py-2">
                      <input
                        type="checkbox"
                        checked={isRowAllChecked(mod.id)}
                        onChange={() => onToggleRow(mod.id, applicablePerms)}
                        disabled={!rowHasAnyApplicable}
                        className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-40 disabled:cursor-not-allowed"
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
                            className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-30 disabled:cursor-not-allowed"
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
// Catalog comes from /api/rbac/manageable-hr-fields/. Saves go through
// the generic /api/rbac/role-field-permissions/bulk/ endpoint.
function FieldTab({ roleOptions, selectedRole, setSelectedRole }) {
  const [catalog, setCatalog] = useState([]);
  const [currentPerms, setCurrentPerms] = useState({});  // { 'Staff:salary_per_day' -> 'HIDDEN' }
  const [isLoading, setIsLoading] = useState(true);
  const [savingModule, setSavingModule] = useState(null);

  useEffect(() => {
    setIsLoading(true);
    apiClient.get('/api/rbac/manageable-hr-fields/')
      .then(res => setCatalog(res.data?.modules || []))
      .catch(() => toast.error('Failed to load field catalog'))
      .finally(() => setIsLoading(false));
  }, []);

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
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-500"
          >
            <option value="">Select a role…</option>
            {roleOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </CustomSelect>
        </div>
      </div>

      <div className="mb-4 p-3 bg-teal-50 border border-teal-200 rounded-lg text-xs text-teal-800">
        Hide or lock the most sensitive HR data per role — salary, bank account, ID-proof numbers,
        biometric/geo capture and payroll figures. <strong>Hidden</strong> strips the field from API
        responses; <strong>Read-only</strong> shows it but blocks writes. Default is Visible (no row stored).
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-500">Loading field catalog…</p>
      ) : !selectedRole ? (
        <p className="text-sm text-slate-500 italic">Pick a role to see its HR field permissions.</p>
      ) : catalog.length === 0 ? (
        <p className="text-sm text-slate-500">No HR fields registered for management yet.</p>
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
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50"
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
                      <tr key={f.key} className="border-b border-slate-100 hover:bg-teal-50/30">
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
