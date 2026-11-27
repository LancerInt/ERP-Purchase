import CustomSelect from "@/components/ui/CustomSelect";
/**
 * Import Data Permission Management.
 *
 * Mirror of /admin/permissions/reports scoped to the IMPORT-category
 * modules. Reads and writes the same RBAC table (RolePermission) through the
 * shared bulk endpoint — this page is purely a UI surface so admins can grant
 * the Import Data section to a role from its own card.
 *
 *   Import Data Module
 *     ├── Page Permissions   (View / Create / Edit / Delete)
 *     └── Button Permissions (Export / Print)
 *
 * Covered modules (category === 'IMPORT'):
 *   • Import Data  (the single gate for the whole ingestion section:
 *     Ledger triage inbox, Scan Inbox, Payments import, Sales/Purchase Tally
 *     import, Overview)
 *
 * Import Data is an ingestion + read section — you View it, you Create by
 * importing, and you can Export. Edit / Delete / Print don't exist on these
 * pages, so they stay disabled (shown struck-through) rather than implying an
 * action that isn't there.
 */
import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Save, Check, FileText, MousePointer2, UserCog } from 'lucide-react';
import { UserOverridesTab } from './sharedUserTabs.jsx';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useApiData from '../../../hooks/useApiData.js';

const PAGE_PERMS = [
  { key: 'can_view',   label: 'View',   color: 'text-blue-600' },
  { key: 'can_create', label: 'Import', color: 'text-green-600' },
  { key: 'can_edit',   label: 'Edit',   color: 'text-amber-600' },
  { key: 'can_delete', label: 'Delete', color: 'text-red-600' },
];

const BUTTON_PERMS = [
  { key: 'can_export', label: 'Export', color: 'text-cyan-600' },
  { key: 'can_print',  label: 'Print',  color: 'text-violet-600' },
];

const ALL_PERMS = [...PAGE_PERMS, ...BUTTON_PERMS];

// Each Import page is a View + Import(create) + Export section. Edit / Delete /
// Print aren't real actions here, so only the applicable ones are enabled. The
// umbrella 'Import Data' was split into one module per page (migration 0071).
const IMPORT_PAGE_MODULES = [
  'Import Overview', 'Import Scan Inbox', 'Import Payments Made',
  'Import Mappings', 'Sales Tally Import', 'Purchase Tally Import',
];
const APPLICABLE_PAGE_PERMS = Object.fromEntries(
  IMPORT_PAGE_MODULES.map((m) => [m, new Set(['can_view', 'can_create'])]),
);
const APPLICABLE_BUTTON_PERMS = Object.fromEntries(
  IMPORT_PAGE_MODULES.map((m) => [m, new Set(['can_export'])]),
);

// Friendly labels — the stored module.name carries an "Import " prefix to stay
// unique (e.g. a separate 'Scan Inbox' module already exists on the Purchase
// card); show the short page name here.
const MODULE_DISPLAY_NAMES = {
  'Import Overview': 'Overview',
  'Import Scan Inbox': 'Scan Inbox',
  'Import Payments Made': 'Payments Made',
  'Import Mappings': 'Mappings',
};
const labelOf = (name) => MODULE_DISPLAY_NAMES[name] || name;

// Slugs counted as "Import Data" for this page. We prefer the API's
// `category === 'IMPORT'` filter; this list is a belt-and-braces fallback for
// modules whose category field is empty. The retired umbrella 'import-data' is
// excluded — its six pages are managed as the granular modules above.
const IMPORT_SLUG_FALLBACK = new Set([
  'import-overview', 'import-scan-inbox', 'import-payments-made',
  'import-mappings', 'import-sales-tally', 'import-purchase-tally',
]);

const TABS = [
  { key: 'page',   label: 'Page Permissions',   icon: FileText,      desc: 'View / Import / Edit / Delete' },
  { key: 'button', label: 'Button Permissions', icon: MousePointer2, desc: 'Export · Print' },
  { key: 'override', label: 'User Overrides',   icon: UserCog,       desc: 'Grant / deny an import page to ONE user on top of their role' },
];

export default function ImportPermissionsPage() {
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

  // Filter modules to IMPORT-category only. Prefer the API's `category`
  // field; fall back to the slug list when the field is empty.
  const importModules = useMemo(() => {
    return modules.filter(m => {
      if (m.slug === 'import-data') return false;   // retired umbrella (0071)
      if (m.category === 'IMPORT') return true;
      return IMPORT_SLUG_FALLBACK.has(m.slug);
    });
  }, [modules]);

  useEffect(() => {
    if (!selectedRole || importModules.length === 0) {
      setPermissionGrid([]);
      return;
    }
    setIsLoadingPerms(true);
    apiClient.get(`/api/rbac/role-permissions/?role=${selectedRole}`)
      .then(res => {
        const rolePerms = res.data?.results || res.data || [];
        const grid = importModules.map(mod => {
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
        toast.error('Failed to load Import Data permissions');
        setPermissionGrid([]);
      })
      .finally(() => setIsLoadingPerms(false));
  }, [selectedRole, importModules]);

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
      toast.success('Import Data permissions saved');
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Import Data Module Permissions"
        subtitle="Dedicated permission controls for the Import Data section — page and button access per role"
        breadcrumbs={[
          { label: 'Admin' },
          { label: 'Permissions', path: '/admin/permissions' },
          { label: 'Import Data' },
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
          {activeTab === 'override' ? (
            // Per-user GRANT/DENY on top of the role — how you give one user in a
            // role access to an import page without granting the whole role.
            <UserOverridesTab
              fieldsEndpoint="/api/rbac/manageable-import-fields/"
              allPerms={ALL_PERMS}
              moduleLabel="Import"
            />
          ) : (
            <PermTab
              perms={activeTab === 'page' ? PAGE_PERMS : BUTTON_PERMS}
              tabLabel={activeTab === 'page' ? 'Page' : 'Button'}
              roleOptions={roleOptions}
              selectedRole={selectedRole}
              setSelectedRole={setSelectedRole}
              modules={importModules}
              permissionGrid={permissionGrid}
              isLoading={modulesLoading || isLoadingPerms}
              isSaving={isSaving}
              onTogglePerm={togglePerm}
              onToggleColumn={toggleColumn}
              onToggleRow={toggleRow}
              onSave={handleSave}
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
    const set = tabLabel === 'Button'
      ? APPLICABLE_BUTTON_PERMS[moduleName]
      : APPLICABLE_PAGE_PERMS[moduleName];
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
        <p className="text-sm text-slate-500 italic">Pick a role to see its Import Data {tabLabel.toLowerCase()} permissions.</p>
      ) : isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : modules.length === 0 ? (
        <p className="text-sm text-slate-500">No Import Data modules registered yet.</p>
      ) : (
        <>
        {/* Mobile-stacked permission cards — chip toggles per module. */}
        <div className="sm:hidden space-y-3">
          {modules.map(mod => {
            const row = getRow(mod.id);
            if (!row) return null;
            const applicablePerms = perms.filter(f => isPermApplicable(mod.name, f.key));
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
              <tr className="bg-primary-50 border-b-2 border-slate-300">
                <th className="text-left px-4 py-2 font-semibold text-slate-700 min-w-[200px] sticky left-0 z-20 bg-slate-100">
                  Import Data Module
                </th>
                <th className="text-center px-2 py-2 font-medium text-slate-500 w-12">All</th>
                {perms.map(f => {
                  const applicableIds = new Set(
                    modules
                      .filter(m => isPermApplicable(m.name, f.key))
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
                const applicablePerms = perms.filter(f => isPermApplicable(mod.name, f.key));
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
