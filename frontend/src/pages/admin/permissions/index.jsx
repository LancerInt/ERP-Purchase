import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Layers, X, Check, Search, Plus, Trash2 } from 'lucide-react';
import CustomSelect from '@/components/ui/CustomSelect';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';

// Permission management is split into one dedicated page per module —
// each card below is the entry point for that module's Page / Button /
// Field permissions (and, for Sales, per-user warehouse Data access).
//
// There is intentionally NO generic "pick a role → 14-column grid" on
// this page: every module that needs role permissions is reached
// through its own card, so admins never edit the same RolePermission
// rows from two competing surfaces. Categories without a card
// (Quality / Admin) are still managed in Django admin.

// Categories that have a dedicated permission card below. A module added to
// one of these shows up on that card's grid straight away. Keep in step with
// the cards rendered on this page and ERPModule.CATEGORY_CHOICES.
const CARD_CATEGORIES = [
  { value: 'SALES',      label: 'Sales',          path: '/admin/permissions/sales' },
  { value: 'PURCHASE',   label: 'Purchase',       path: '/admin/permissions/purchase' },
  { value: 'FREIGHT',    label: 'Freight / Wage', path: '/admin/permissions/freight' },
  { value: 'PRODUCTION', label: 'Production',     path: '/admin/permissions/production' },
  { value: 'INVENTORY',  label: 'Inventory',      path: '/admin/permissions/inventory' },
  { value: 'HR',         label: 'HR',             path: '/admin/permissions/hr' },
  { value: 'FINANCE',    label: 'Finance',        path: '/admin/permissions/finance' },
  { value: 'BANK',       label: 'Bank',           path: '/admin/permissions/bank' },
  { value: 'MASTERS',    label: 'Masters',        path: '/admin/permissions/masters' },
  { value: 'REPORTS',    label: 'Reports',        path: '/admin/permissions/reports' },
  { value: 'EXPENSES',   label: 'Expenses',       path: '/admin/permissions/expenses' },
  { value: 'IMPORT',     label: 'Import Data',    path: '/admin/permissions/import' },
];

// value → label for showing a module's current card (covers categories that
// have no card too, so moves read clearly).
const CAT_LABEL = {
  ...Object.fromEntries(CARD_CATEGORIES.map(c => [c.value, c.label])),
  ADMIN: 'Admin', QUALITY: 'Quality', IMPORT: 'Import Data', '': 'No card',
};
const catLabel = (cat) => CAT_LABEL[cat || ''] ?? (cat || 'No card');

export default function PermissionManagement() {
  const [showAssign, setShowAssign] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  return (
    <MainLayout>
      <PageHeader
        title="Role Permission Management"
        subtitle="Pick a module to manage its role-based permissions"
        breadcrumbs={[{ label: 'Admin' }, { label: 'Permissions' }]}
      />

      {/* Assign which existing sub-modules belong to each card — without a code
          change / migration. Pick a card, tick its sub-modules, save. */}
      <div className="flex justify-end gap-2 mb-3">
        {/* Create brand-new permission modules — one row per sub-module, each
            registered SEPARATELY (no shared gate), assigned to a card. */}
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-indigo-200 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-50 transition"
        >
          <Plus size={15} />
          New Module
        </button>
        <button
          type="button"
          onClick={() => setShowAssign(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
        >
          <Layers size={15} />
          Assign Modules
        </button>
      </div>

      {/* Module permission shortcuts — each opens a dedicated page with
          Page / Button / Field tabs scoped to that module. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Link
          to="/admin/permissions/sales"
          className="flex flex-col px-4 py-4 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition"
        >
          <p className="text-sm font-semibold text-indigo-900 leading-tight">Sales Module Permissions</p>
          <p className="text-xs text-indigo-700 leading-snug mt-1">Page / Button / Field tabs + warehouse access per user</p>
        </Link>
        <Link
          to="/admin/permissions/purchase"
          className="flex flex-col px-4 py-4 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition"
        >
          <p className="text-sm font-semibold text-emerald-900 leading-tight">Purchase Module Permissions</p>
          <p className="text-xs text-emerald-700 leading-snug mt-1">Page / Button / Field tabs for PR · RFQ · Quote · PO · Receipt · Bills · Vendor Credit</p>
        </Link>
        {/* Freight covers Inward Freight, Freight Payments and the two wage
            flows. Outward Freight lives on the Sales page (warehouse →
            customer leg is owned by Sales). */}
        <Link
          to="/admin/permissions/freight"
          className="flex flex-col px-4 py-4 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition"
        >
          <p className="text-sm font-semibold text-amber-900 leading-tight">Freight Module Permissions</p>
          <p className="text-xs text-amber-700 leading-snug mt-1">Page / Button tabs for Inward Freight · Freight Payments · Loading/Unloading Wages · Wage Payments</p>
          <span className="block text-xs text-amber-600 mt-1">Outward Freight is managed on the Sales page.</span>
        </Link>

        {/* Production covers Work Orders, Packing Processes, Wage Vouchers,
            BOM Requests, Processes and Material Issues. */}
        <Link
          to="/admin/permissions/production"
          className="flex flex-col px-4 py-4 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition"
        >
          <p className="text-sm font-semibold text-indigo-900 leading-tight">Production Module Permissions</p>
          <p className="text-xs text-indigo-700 leading-snug mt-1">Page / Button / Field tabs for BOM · Work Order · Packing Process · Wage Voucher · Process · Material Issue</p>
        </Link>

        {/* Inventory covers the stock ledger, transfers, shifting, job work,
            returns and adjustments. */}
        <Link
          to="/admin/permissions/inventory"
          className="flex flex-col px-4 py-4 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition"
        >
          <p className="text-sm font-semibold text-cyan-900 leading-tight">Inventory Module Permissions</p>
          <p className="text-xs text-cyan-700 leading-snug mt-1">Page / Button / Field tabs for Stock Ledger · Movement Request · Transfers · Shifting · Job Work · Returns · Adjustments</p>
        </Link>

        {/* HR covers Staff, Attendance, Leave, Overtime, Shift, Payroll and
            the Holiday Calendar. The Field tab is the important one here —
            it hides salary, bank, ID-proof and payroll figures per role. */}
        <Link
          to="/admin/permissions/hr"
          className="flex flex-col px-4 py-4 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 transition"
        >
          <p className="text-sm font-semibold text-teal-900 leading-tight">HR Module Permissions</p>
          <p className="text-xs text-teal-700 leading-snug mt-1">Page / Button / Field tabs for Staff · Attendance · Leave · Overtime · Shift · Payroll · Holiday Calendar</p>
          <span className="block text-xs text-teal-600 mt-1">Field tab hides salary, bank, PII &amp; payroll figures per role.</span>
        </Link>

        {/* Finance covers the ledgers (Vendor / Customer / Freight / Wage),
            Payments, Bank, GST, Petty Cash and Credit/Debit Notes. Finance
            isn't warehouse-scoped or field-gated, so it has Page / Button
            tabs only. */}
        <Link
          to="/admin/permissions/finance"
          className="flex flex-col px-4 py-4 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 transition"
        >
          <p className="text-sm font-semibold text-rose-900 leading-tight">Finance Module Permissions</p>
          <p className="text-xs text-rose-700 leading-snug mt-1">Page / Button tabs for Vendor Ledger · Customer Ledger · Freight Ledger · Wage Ledger · Payments · Bank · GST · Petty Cash</p>
        </Link>

        {/* Bank covers the standalone Bank module (/bank/*) — Bank Accounts,
            Sales Receipts, Purchase Payments, the Bank Dashboard, and
            Reconcile Statement (bank-statement-vs-Tally reconciliation).
            Page / Button tabs per role. */}
        <Link
          to="/admin/permissions/bank"
          className="flex flex-col px-4 py-4 bg-sky-50 border border-sky-200 rounded-lg hover:bg-sky-100 transition"
        >
          <p className="text-sm font-semibold text-sky-900 leading-tight">Bank Module Permissions</p>
          <p className="text-xs text-sky-700 leading-snug mt-1">Page / Button tabs for Bank Dashboard · Bank Accounts · Receipts · Payments · Reconcile Statement</p>
        </Link>

        {/* Masters covers the reference data — Company, Warehouse, Product,
            Vendor, Customer, Price List, Tax, etc. Page (CRUD) + Button
            (Import / Export / Print) per role. */}
        <Link
          to="/admin/permissions/masters"
          className="flex flex-col px-4 py-4 bg-violet-50 border border-violet-200 rounded-lg hover:bg-violet-100 transition"
        >
          <p className="text-sm font-semibold text-violet-900 leading-tight">Master Module Permissions</p>
          <p className="text-xs text-violet-700 leading-snug mt-1">Page / Button tabs for Company · Warehouse · Godown · Product · Vendor · Customer · Price List · Tax · Transporter · Broker</p>
        </Link>

        {/* Expenses covers the expense workflow — the Expense Register, Imprest,
            Vouchers, Consumables and Machinery Expense. Page (CRUD) + Button
            (Approve / Pay / Export / Print) per role. */}
        <Link
          to="/admin/permissions/expenses"
          className="flex flex-col px-4 py-4 bg-orange-50 border border-orange-200 rounded-lg hover:bg-orange-100 transition"
        >
          <p className="text-sm font-semibold text-orange-900 leading-tight">Expenses Module Permissions</p>
          <p className="text-xs text-orange-700 leading-snug mt-1">Page / Button tabs for Expense Register · Imprest · Voucher · Consumables · Machinery Expense</p>
        </Link>

        {/* Reports covers the cross-module read-only views in the Reports group:
            the consolidated Reports page, the Vendor-Customer report, the party
            Ledger, and Deviations. Each is its own module so an admin can grant
            or hide a single report without touching the Purchase / Import pages
            they used to borrow their gate from. */}
        <Link
          to="/admin/permissions/reports"
          className="flex flex-col px-4 py-4 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition"
        >
          <p className="text-sm font-semibold text-slate-900 leading-tight">Reports Module Permissions</p>
          <p className="text-xs text-slate-700 leading-snug mt-1">Page / Button tabs for Reports · Vendor-Customer · Ledger · Deviations</p>
        </Link>

        {/* Import Data covers the whole ingestion section (Ledger triage inbox,
            Scan Inbox, Payments import, Sales / Purchase Tally import, Overview)
            behind one gate. View / Import + Export per role. */}
        <Link
          to="/admin/permissions/import"
          className="flex flex-col px-4 py-4 bg-lime-50 border border-lime-200 rounded-lg hover:bg-lime-100 transition"
        >
          <p className="text-sm font-semibold text-lime-900 leading-tight">Import Data Module Permissions</p>
          <p className="text-xs text-lime-700 leading-snug mt-1">Page / Button tabs for the Import Data section · Ledger Inbox · Scan Inbox · Payments · Sales / Purchase Tally · Overview</p>
        </Link>
      </div>

      {showAssign && <AssignModulesModal onClose={() => setShowAssign(false)} />}
      {showAdd && <AddModulesModal onClose={() => setShowAdd(false)} />}
    </MainLayout>
  );
}

// ── Assign Modules modal ────────────────────────────────────────────
// Pick a card (category), then tick which existing sub-modules belong to it.
// Ticking a module moves it onto this card; unticking one that's currently on
// this card removes it (back to "no card"). Saving re-categorizes the changed
// modules — the UI equivalent of the migrations that used to do this. Nothing
// about what a module GATES changes; only which card it is managed from.
function AssignModulesModal({ onClose }) {
  const { data: modules, isLoading } = useApiData('/api/rbac/modules/');
  const [card, setCard] = useState('');
  const [picked, setPicked] = useState([]);       // module ids ticked for this card
  const [query, setQuery] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Active modules, name-sorted. The modules endpoint already excludes
  // inactive ones.
  const allModules = useMemo(
    () => [...(modules || [])].sort((a, b) => a.name.localeCompare(b.name)),
    [modules],
  );

  // When the card changes, pre-tick the modules already in that category.
  useEffect(() => {
    if (!card) { setPicked([]); return; }
    setPicked(allModules.filter(m => (m.category || '') === card).map(m => m.id));
  }, [card, allModules]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allModules;
    return allModules.filter(m =>
      m.name.toLowerCase().includes(q) || (m.slug || '').toLowerCase().includes(q));
  }, [allModules, query]);

  const toggle = (id) =>
    setPicked(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  // Rows that will actually change when saved.
  const changes = useMemo(() => {
    if (!card) return [];
    const out = [];
    for (const m of allModules) {
      const inCard = (m.category || '') === card;
      const ticked = picked.includes(m.id);
      if (ticked && !inCard) out.push({ m, to: card });     // move onto this card
      else if (!ticked && inCard) out.push({ m, to: '' });  // remove from this card
    }
    return out;
  }, [allModules, picked, card]);

  const handleSave = async () => {
    if (!card) { toast.error('Pick a card first'); return; }
    if (changes.length === 0) { toast('No changes to save'); onClose(); return; }
    setIsSaving(true);
    try {
      await Promise.all(changes.map(c =>
        apiClient.patch(`/api/rbac/modules/${c.m.id}/`, { category: c.to })));
      const cardLabel = CARD_CATEGORIES.find(c => c.value === card)?.label || card;
      const added = changes.filter(c => c.to).length;
      const removed = changes.length - added;
      toast.success(
        `${cardLabel}: ${added} added${removed ? `, ${removed} removed` : ''}`);
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <h3 className="text-base font-semibold text-slate-900">Assign Modules to a Card</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Card <span className="text-red-500">*</span>
            </label>
            <CustomSelect
              value={card}
              onChange={(e) => setCard(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">Select a card…</option>
              {CARD_CATEGORIES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </CustomSelect>
          </div>

          {card && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-slate-700">
                  Sub-modules on this card
                </label>
                <span className="text-[11px] text-slate-500">{picked.length} selected</span>
              </div>

              {/* Search */}
              <div className="relative mb-2">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search modules…"
                  className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>

              {/* Checklist */}
              <div className="border border-slate-200 rounded-lg max-h-64 overflow-y-auto divide-y divide-slate-100">
                {isLoading ? (
                  <p className="text-sm text-slate-500 px-3 py-6 text-center">Loading modules…</p>
                ) : visible.length === 0 ? (
                  <p className="text-sm text-slate-500 px-3 py-6 text-center">No modules match “{query}”.</p>
                ) : visible.map(m => {
                  const on = picked.includes(m.id);
                  const here = (m.category || '') === card;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggle(m.id)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-indigo-50/40"
                    >
                      <span className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center ${on ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 bg-white'}`}>
                        {on && <Check size={11} className="text-white" />}
                      </span>
                      <span className="flex-1 text-sm text-slate-800 truncate">{m.name}</span>
                      {/* current card, unless it's already this one */}
                      {!here && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                          {catLabel(m.category)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <p className="text-[11px] text-slate-500 mt-2">
                Ticking a module moves it onto this card (it leaves its current one).
                Unticking a module that's on this card removes it to <em>No card</em>.
                This changes only where a module is managed — not what it gates.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-slate-200 shrink-0">
          <span className="text-xs text-slate-500">
            {card && changes.length > 0 ? `${changes.length} change${changes.length > 1 ? 's' : ''} pending` : ' '}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || !card || changes.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              <Check size={14} />
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── New Module modal ────────────────────────────────────────────────
// Create brand-new permission modules WITHOUT a code change / migration.
// Pick a card (category), then add one row per sub-module. Each row is
// registered as its OWN module (its own slug + RolePermission rows) — never
// wired together under one shared gate — so every sub-module can be granted,
// denied and overridden on its own. New modules start ungranted; once created
// they appear on the chosen card's grid immediately.
const slugify = (s) => String(s || '').toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function AddModulesModal({ onClose }) {
  const [card, setCard] = useState('');
  const [rows, setRows] = useState([{ name: '' }, { name: '' }]);
  const [isSaving, setIsSaving] = useState(false);

  const setRow = (i, name) => setRows(prev => prev.map((r, k) => (k === i ? { name } : r)));
  const addRow = () => setRows(prev => [...prev, { name: '' }]);
  const removeRow = (i) => setRows(prev => (prev.length > 1 ? prev.filter((_, k) => k !== i) : prev));

  const named = rows.map(r => r.name.trim()).filter(Boolean);
  // Flag duplicate names / slugs inside this batch so two rows can't collide.
  const slugs = named.map(slugify);
  const dupSlug = slugs.find((s, i) => s && slugs.indexOf(s) !== i);

  const handleSave = async () => {
    if (!card) { toast.error('Pick a card first'); return; }
    if (named.length === 0) { toast.error('Add at least one sub-module name'); return; }
    if (dupSlug) { toast.error('Two sub-modules resolve to the same name'); return; }
    setIsSaving(true);
    // Create each sub-module as its OWN module. Report per-row outcome so a
    // single clash (e.g. an existing name) doesn't hide the ones that worked.
    const results = await Promise.allSettled(named.map(name =>
      apiClient.post('/api/rbac/modules/', {
        name, slug: slugify(name), category: card, is_active: true, description: '',
      })));
    setIsSaving(false);
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.map((r, i) => ({ r, name: named[i] }))
      .filter(x => x.r.status === 'rejected');
    const cardLabel = CARD_CATEGORIES.find(c => c.value === card)?.label || card;
    if (ok) toast.success(`${cardLabel}: ${ok} sub-module${ok > 1 ? 's' : ''} created`);
    if (failed.length) {
      toast.error(`Couldn't create: ${failed.map(f => f.name).join(', ')} (name/slug may already exist)`);
    }
    if (!failed.length) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <h3 className="text-base font-semibold text-slate-900">New Module</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Card <span className="text-red-500">*</span></label>
            <CustomSelect value={card} onChange={(e) => setCard(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500">
              <option value="">Select a card…</option>
              {CARD_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-slate-700">Sub-modules</label>
              <span className="text-[11px] text-slate-500">each is registered separately</span>
            </div>
            <div className="space-y-2">
              {rows.map((r, i) => {
                const s = slugify(r.name);
                return (
                  <div key={i}>
                    <div className="flex items-center gap-2">
                      <input
                        type="text" value={r.name}
                        onChange={(e) => setRow(i, e.target.value)}
                        placeholder={`Sub-module ${i + 1} name`}
                        className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                      />
                      <button type="button" onClick={() => removeRow(i)} disabled={rows.length <= 1}
                        className="p-2 text-slate-400 hover:text-rose-600 disabled:opacity-30" aria-label="Remove row">
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {r.name.trim() && <p className="text-[10px] text-slate-400 mt-0.5 ml-1">slug: {s || '—'}</p>}
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={addRow}
              className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-800">
              <Plus size={14} /> Add another sub-module
            </button>
            <p className="text-[11px] text-slate-500 mt-2">
              Each row becomes its own permission module with its own View / Create / Export
              controls — not merged into one gate. New modules start with no roles granted;
              grant them per role on the card, or per user on its User Overrides tab.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-slate-200 shrink-0">
          <span className="text-xs text-slate-500">{named.length ? `${named.length} to create` : ' '}</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900">Cancel</button>
            <button type="button" onClick={handleSave} disabled={isSaving || !card || named.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              <Check size={14} />
              {isSaving ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
