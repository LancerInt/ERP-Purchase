import CustomSelect from "@/components/ui/CustomSelect";
/**
 * Shared per-user permission editors used by the module-scoped permission
 * pages (Purchase, and available to Sales / Production / Inventory).
 *
 *   DataTab           — per-user warehouse_scope editor (module-agnostic;
 *                       warehouse access applies across every module a
 *                       user can see).
 *   UserOverridesTab  — per-user GRANT/DENY action overrides + field
 *                       overrides, scoped to whichever module catalog the
 *                       caller passes via `fieldsEndpoint`.
 *
 * Both write the same generic RBAC endpoints the Sales page uses
 * (/api/users/{id}/assign_warehouse_scope/, /api/rbac/user-permission-
 * overrides/bulk/, /api/rbac/user-field-permission-overrides/bulk/), so
 * the behaviour is identical no matter which page hosts them.
 */
import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Save, Check } from 'lucide-react';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';

// ── User Overrides tab — per-user grant/deny + field overrides ───────
//
// Pick a user → surgically flip individual module actions (GRANT/DENY)
// or fields (Visible/Read-only/Hidden) on top of their role. Warehouse
// scope and per-user grants are user-level, but the module/field axis
// here is scoped to whichever catalog `fieldsEndpoint` returns. Writes
// hit the same generic /api/rbac/user-(permission|field-permission)-
// overrides/bulk/ endpoints Sales uses.
//
// Props:
//   fieldsEndpoint — catalog endpoint, e.g. '/api/rbac/manageable-purchase-fields/'
//   allPerms       — [{ key, label, color }] action axis for this module group
//   moduleLabel    — human label for banner copy (e.g. 'Purchase')
export function UserOverridesTab({ fieldsEndpoint, allPerms, moduleLabel = 'module' }) {
  const [users, setUsers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [moduleOverrides, setModuleOverrides] = useState({}); // 'Module:can_approve' -> 'GRANT' | 'DENY'
  const [fieldOverrides, setFieldOverrides] = useState({});   // 'Module:notes' -> 'VIEW' | 'READ_ONLY' | 'HIDDEN'
  const [isLoading, setIsLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);

  useEffect(() => {
    setIsLoading(true);
    Promise.all([
      apiClient.get('/api/rbac/users/?page_size=500'),
      apiClient.get(fieldsEndpoint),
    ]).then(([uRes, cRes]) => {
      const u = uRes.data?.results || uRes.data || [];
      setUsers(u);
      setCatalog(cRes.data?.modules || []);
    }).catch(() => toast.error('Failed to load users / catalog'))
      .finally(() => setIsLoading(false));
  }, [fieldsEndpoint]);

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

  const moduleAxis = useMemo(() => catalog.map(({ name }) => ({ name, actions: allPerms })), [catalog, allPerms]);

  const setModuleOverride = (moduleName, actionKey, mode) => {
    const k = `${moduleName}:${actionKey}`;
    setModuleOverrides(prev => {
      const next = { ...prev };
      if (!mode) delete next[k]; else next[k] = mode;
      return next;
    });
  };

  // Bulk-set every action for one module in a single click. "Grant all" lets the
  // admin open a module fully, then flip just the few actions they want to Deny
  // (DENY wins over GRANT), instead of toggling each action from "Use role".
  const setAllModuleOverrides = (moduleName, mode) => {
    setModuleOverrides(prev => {
      const next = { ...prev };
      allPerms.forEach(p => {
        const k = `${moduleName}:${p.key}`;
        if (!mode) delete next[k]; else next[k] = mode;
      });
      return next;
    });
  };

  const setFieldOverride = (moduleName, fieldKey, access) => {
    const k = `${moduleName}:${fieldKey}`;
    setFieldOverrides(prev => {
      const next = { ...prev };
      if (!access || access === 'DEFAULT') delete next[k]; else next[k] = access;
      return next;
    });
  };

  const saveModuleOverrides = async (moduleName) => {
    if (!selectedUserId) return;
    setSavingKey(`mod:${moduleName}`);
    try {
      const overrides = allPerms
        .map(p => ({ action: p.key, mode: moduleOverrides[`${moduleName}:${p.key}`] }))
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
        .map(f => ({ field_name: f.key, access: fieldOverrides[`${moduleName}:${f.key}`] || 'VIEW' }))
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
          flip individual {moduleLabel} actions or fields on top of their role.
        </p>
        <p className="mt-1 text-slate-500">
          <strong>DENY</strong> wins over <strong>GRANT</strong> when both
          exist on the same action. Field overrides REPLACE the role's
          field policy (use <em>Visible</em> to restore a field the role hides).
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div className="flex-1 min-w-[240px] max-w-md">
          <label className="block text-sm font-medium text-slate-700 mb-1">Select User</label>
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
        <p className="text-sm text-slate-500">No {moduleLabel} modules registered.</p>
      ) : (
        <div className="space-y-4 sm:space-y-5">
          {/* ── Module-action overrides ── */}
          <section>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Module / Action Overrides</h3>
            <div className="space-y-3">
              {moduleAxis.map(({ name: moduleName }) => (
                <div key={moduleName} className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2 flex-wrap">
                    <h4 className="text-sm font-semibold text-slate-800">{moduleName}</h4>
                    <div className="flex items-center gap-1.5">
                      <button type="button" onClick={() => setAllModuleOverrides(moduleName, 'GRANT')}
                        className="px-2 py-1 rounded text-[11px] font-medium border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        title="Grant every action — then flip the few you want to Deny">Grant all</button>
                      <button type="button" onClick={() => setAllModuleOverrides(moduleName, 'DENY')}
                        className="px-2 py-1 rounded text-[11px] font-medium border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                        title="Deny every action for this user">Deny all</button>
                      <button type="button" onClick={() => setAllModuleOverrides(moduleName, '')}
                        className="px-2 py-1 rounded text-[11px] font-medium border border-slate-200 bg-white text-slate-500 hover:bg-slate-100"
                        title="Clear overrides — fall back to the role">Use role</button>
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
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 p-3 text-xs">
                    {allPerms.map(p => {
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

// ── Data tab — warehouse_scope editor per user ───────────────────────
//
// Lists every user, exposes their current warehouse_scope, and lets the
// admin add / remove warehouses. Warehouse access is user-level (applies
// across Sales, Purchase and Production alike), so this is the same
// editor as the Sales page — changes hit /api/users/{id}/
// assign_warehouse_scope/.
export function DataTab() {
  const [users, setUsers] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [savingUserId, setSavingUserId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    Promise.all([
      apiClient.get('/api/users/?page_size=500'),
      apiClient.get('/api/warehouses/?page_size=500'),
    ]).then(([uRes, wRes]) => {
      if (cancelled) return;
      setUsers(uRes.data?.results || uRes.data || []);
      setWarehouses(wRes.data?.results || wRes.data || []);
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
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, warehouse_scope: warehouseIds } : u));
  };

  const toggleWarehouseForUser = (user, warehouseId) => {
    const current = (user.warehouse_scope || []).map(w => typeof w === 'object' ? w.id : w);
    const next = current.includes(warehouseId)
      ? current.filter(id => id !== warehouseId)
      : [...current, warehouseId];
    setUserScope(user.id, next);
  };

  const saveUserScope = async (user) => {
    setSavingUserId(user.id);
    try {
      const ids = (user.warehouse_scope || []).map(w => typeof w === 'object' ? w.id : w);
      await apiClient.post(`/api/users/${user.id}/assign_warehouse_scope/`, { warehouse_ids: ids });
      toast.success(`Warehouse access updated for ${user.username || user.user?.username || user.id}`);
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
          <strong>Per-user warehouse access.</strong> Warehouse scope applies
          across every module a user can see (Sales, Purchase and Production).
          Users with no scope assigned see every warehouse.
        </p>
        <p className="mt-1 text-slate-500">
          Bypass roles (Sales Manager, Office Manager, Finance, Accounts, IT
          Admin) see every warehouse <em>by default</em>, but ticking a
          specific warehouse below for one of them now wins — the per-user
          assignment always takes precedence over the role's open access.
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

      {/* Mobile-stacked: one card per user with warehouses as toggle chips. */}
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
                const scope = (user.warehouse_scope || []).map(w => typeof w === 'object' ? w.id : w);
                const username = user.username || user.user?.username || `User #${user.id}`;
                const displayName = [
                  user.user_first_name || user.user?.first_name,
                  user.user_last_name  || user.user?.last_name,
                ].filter(Boolean).join(' ');
                return (
                  <tr key={user.id} className="border-b border-slate-100 hover:bg-indigo-50/20">
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-800">{username}</div>
                      {displayName && <div className="text-xs text-slate-500">{displayName}</div>}
                      {scope.length === 0 && (
                        <div className="text-[11px] text-amber-700 italic mt-0.5">No scope → sees all</div>
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
