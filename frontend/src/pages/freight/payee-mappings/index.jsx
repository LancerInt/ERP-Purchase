import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Upload, Loader2, Trash2, Search, Link2, AlertTriangle, Plus } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';

// Payee Mappings — maps a payee name as it appears on a bank statement (a
// person's personal account, or a name that differs from the firm's) to the
// real party, so the bank-statement import auto-assigns it. Two kinds:
//   • Freight   → the payee is a lorry owner, maps to a TRANSPORTER
//   • Purchase  → the payee maps to a VENDOR (supplier paid under another name)
// Learned in bulk from Tally XML (review first), then curated here. Nothing
// here posts a payment — it only maintains the name mapping.
const TARGETS = [
  { value: 'transporter', tab: 'Freight (transporter)', noun: 'transporter', master: 'transporter master' },
  { value: 'vendor', tab: 'Purchase (vendor)', noun: 'vendor', master: 'vendor master' },
  { value: 'expense', tab: 'Expense (category)', noun: 'expense category', master: 'expense categories' },
];

export default function PayeeMappings() {
  // Mode (kind) and company scope live in the URL so Back / refresh / sharing
  // restore the active tab and company filter.
  const [target, setTarget] = useUrlState('target', 'transporter');
  const isVendor = target === 'vendor';
  const isExpense = target === 'expense';
  const meta = useMemo(() => TARGETS.find((t) => t.value === target), [target]);

  const { options: transporterOptions } = useLookup('/api/transporters/', {
    labelField: 'name', valueField: 'id',
  });
  const { options: vendorOptions } = useLookup('/api/vendors/', { labelField: 'vendor_name', valueField: 'id' });
  const { options: expenseCategoryOptions } = useLookup('/api/expense-categories/', { labelField: 'name', valueField: 'id' });
  // Company scope: resolves a payee to THIS company's vendor (a UAI payee -> UAI
  // vendor, not a same-named SS one) and filters the saved list. Blank = all.
  const { options: companyOptions } = useLookup('/api/companies/', { labelField: 'company_code', valueField: 'company_code' });
  const [company, setCompany] = useUrlState('company', '');

  const [learning, setLearning] = useState(false);
  const [review, setReview] = useState(null);      // { mappings:[...], summary, payments_read }
  const [rows, setRows] = useState([]);            // local editable copy of review.mappings
  const [saving, setSaving] = useState(false);

  const [existing, setExisting] = useState([]);
  const [q, setQ] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  // Transporters created inline (from a Tally name not in the master yet) —
  // merged into the dropdowns without a full refetch. Freight only; we never
  // auto-create vendors from a bank-statement name.
  const [extraTransporters, setExtraTransporters] = useState([]);
  const allTransporterOptions = useMemo(
    () => [...transporterOptions, ...extraTransporters],
    [transporterOptions, extraTransporters]);
  // The dropdown for the current mode.
  const options = useMemo(
    () => (isExpense ? expenseCategoryOptions : isVendor ? vendorOptions : allTransporterOptions),
    [isExpense, isVendor, expenseCategoryOptions, vendorOptions, allTransporterOptions]);

  const loadExisting = useCallback(async () => {
    setLoadingList(true);
    try {
      const params = {};
      if (q) params.q = q;
      if (company) params.company = company;
      const { data } = await apiClient.get('/api/finance/payee-aliases/', { params });
      setExisting(data?.results || (Array.isArray(data) ? data : []));
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setLoadingList(false); }
  }, [q, company]);

  useEffect(() => { loadExisting(); }, [loadExisting]);

  // Saved mappings for the current mode only (a row belongs to vendor if it has
  // a vendor set, else it's a transporter mapping).
  const visibleExisting = useMemo(
    () => existing.filter((x) => (isExpense ? x.expense_category : isVendor ? x.vendor : x.transporter)),
    [existing, isExpense, isVendor]);

  const switchTarget = useCallback((val) => {
    setTarget(val);
    setReview(null); setRows([]);       // don't carry a half-reviewed batch across modes
  }, []);

  const onLearn = useCallback(async (files) => {
    if (!files?.length) return;
    setLearning(true); setReview(null); setRows([]);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append('files', f));
      fd.append('target', target);
      if (company) fd.append('company', company);
      const { data } = await apiClient.post('/api/finance/payee-aliases/learn/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setReview(data);
      setRows((data.mappings || []).map((m) => ({
        ...m,
        include: !!m.target_id,          // pre-tick the resolved ones
        pickId: m.target_id || '',
      })));
      toast.success(`Read ${data.payments_read} payments → ${data.summary.total} payees.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setLearning(false); }
  }, [target, company]);


  const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.payee_key === key ? { ...r, ...patch } : r)));

  const [creatingKey, setCreatingKey] = useState('');
  // Create the transporter from its Tally name (for a payee whose transporter
  // isn't in the ERP master) and select it on the row — one click. Freight only.
  const createTransporter = useCallback(async (row) => {
    const name = (row.tally_name || '').trim();
    if (!name) return;
    setCreatingKey(row.payee_key);
    try {
      const { data } = await apiClient.post('/api/finance/payee-aliases/create-transporter/', { name });
      setExtraTransporters((xs) => (xs.some((x) => String(x.value) === String(data.id)) ? xs : [...xs, { value: data.id, label: data.name }]));
      setRows((rs) => rs.map((r) => (r.payee_key === row.payee_key
        ? { ...r, pickId: data.id, target_id: data.id, target_name: data.name, include: true } : r)));
      toast.success(data.created ? `Created "${data.name}".` : `Linked to existing "${data.name}".`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setCreatingKey(''); }
  }, []);

  const includedCount = useMemo(() => rows.filter((r) => r.include && r.pickId).length, [rows]);

  const onSave = useCallback(async () => {
    const payload = rows.filter((r) => r.include && r.pickId).map((r) => ({
      payee_key: r.payee_key, payee_label: r.payee_label, target_id: r.pickId,
      seen_count: r.seen_count, needs_review: r.needs_review, source: 'tally',
    }));
    if (!payload.length) { toast.error(`Tick at least one row with a ${meta.noun}.`); return; }
    setSaving(true);
    try {
      const { data } = await apiClient.post('/api/finance/payee-aliases/bulk-save/', { rows: payload, target, company: company || undefined });
      toast.success(`Saved ${data.saved} mapping(s).`);
      setReview(null); setRows([]);
      loadExisting();
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setSaving(false); }
  }, [rows, loadExisting, target, meta, company]);

  const onDelete = useCallback(async (id) => {
    try {
      await apiClient.delete(`/api/finance/payee-aliases/${id}/`);
      setExisting((xs) => xs.filter((x) => x.id !== id));
    } catch (e) { toast.error(getApiErrorMessage(e)); }
  }, []);

  const onReassign = useCallback(async (row, newId) => {
    const field = isExpense ? 'expense_category' : isVendor ? 'vendor' : 'transporter';
    const nameKey = isExpense ? 'expense_category_name' : isVendor ? 'vendor_name' : 'transporter_name';
    const others = ['transporter', 'vendor', 'expense_category'].filter((f) => f !== field);
    const patch = { [field]: newId, needs_review: false };
    others.forEach((f) => { patch[f] = null; });
    try {
      await apiClient.patch(`/api/finance/payee-aliases/${row.id}/`, patch);
      setExisting((xs) => xs.map((x) => (x.id === row.id
        ? { ...x, [field]: newId, ...Object.fromEntries(others.map((f) => [f, null])), [nameKey]: options.find((o) => String(o.value) === String(newId))?.label || '', needs_review: false }
        : x)));
    } catch (e) { toast.error(getApiErrorMessage(e)); }
  }, [isExpense, isVendor, options]);

  return (
    <MainLayout>
      <PageHeader title="Payee Mappings" subtitle="Map a bank-statement payee name to the real transporter or vendor" />

      {/* Mode toggle + company scope */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {TARGETS.map((t) => (
            <button key={t.value} type="button" onClick={() => switchTarget(t.value)}
              className={`px-3.5 py-1.5 text-sm rounded-md transition ${target === t.value ? 'bg-white shadow-sm font-semibold text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
              {t.tab}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-500">Company</span>
          <CustomSelect value={company} onChange={(e) => { setCompany(e.target.value); setReview(null); setRows([]); }} className="w-44">
            <option value="">All Companies</option>
            {(companyOptions || []).map((co) => <option key={co.value} value={co.value}>{co.label}</option>)}
          </CustomSelect>
        </div>
      </div>

      {/* Learn from Tally — upload the account's Day Book to extract payee -> target */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-800">Learn from Tally</p>
            <p className="text-xs text-slate-500 mt-0.5">Upload the Tally {isExpense ? 'Expenses-account' : isVendor ? 'payment' : 'freight'} Day Book XML(s). We extract <strong>payee → {meta.noun}</strong> pairs for you to review — nothing is posted as a payment.</p>
            {isExpense && <p className="text-[11px] text-indigo-700 mt-1">Tip: expense mappings are also learned automatically when you record an expense on the bank import.</p>}
          </div>
          <label className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer ${learning ? 'bg-slate-300 text-slate-600' : 'bg-primary-600 text-white hover:bg-primary-700'}`}>
            {learning ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            {learning ? 'Reading…' : 'Upload Tally XML'}
            <input type="file" accept=".xml" multiple className="hidden" disabled={learning}
              onChange={(e) => { onLearn(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
      </div>

      {/* Review of a fresh upload */}
      {review && (
        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b border-slate-200">
            <p className="text-sm text-slate-700">
              <strong>{review.summary.total}</strong> payees · <span className="text-amber-700">{review.summary.conflicts} conflict(s)</span> · <span className="text-slate-500">{review.summary.unresolved} not found in {meta.master}</span>
            </p>
            <button type="button" onClick={onSave} disabled={saving || !includedCount}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />} Save {includedCount || ''} mapping(s)
            </button>
          </div>
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-10 px-3 py-2.5"></th>
                  <th className="text-left px-3 py-2.5 font-semibold">Payee (from statement)</th>
                  <th className="text-left px-3 py-2.5 font-semibold capitalize">{meta.noun}</th>
                  <th className="text-right px-3 py-2.5 font-semibold w-20">Seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.payee_key} className={`border-t border-slate-100 ${r.needs_review ? 'bg-amber-50/50' : ''}`}>
                    <td className="px-3 py-2.5 text-center">
                      <input type="checkbox" checked={r.include} onChange={(e) => setRow(r.payee_key, { include: e.target.checked })} />
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-medium text-slate-800">{r.payee_label}</span>
                      {r.needs_review && (
                        <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-amber-700" title={(r.alternatives || []).map((a) => `${a.name} (${a.count})`).join(', ')}>
                          <AlertTriangle size={11} /> conflict — pick one
                        </span>
                      )}
                      {r.already_mapped_to && <span className="ml-2 text-[10px] text-slate-400">already: {r.already_mapped_to}</span>}
                      <div className="text-[10px] text-slate-400">Tally: {r.tally_name}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <CustomSelect value={r.pickId || ''} onChange={(e) => setRow(r.payee_key, { pickId: e.target.value, include: !!e.target.value })} className="w-full" placeholder={r.target_id ? '' : `Pick ${meta.noun}…`}>
                        <option value="">— pick {meta.noun} —</option>
                        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                      {!isVendor && !isExpense && !r.pickId && r.tally_name && (
                        <button type="button" onClick={() => createTransporter(r)} disabled={creatingKey === r.payee_key}
                          className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary-600 hover:underline disabled:opacity-50">
                          {creatingKey === r.payee_key ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                          Create “{r.tally_name}”
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{r.seen_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Existing mappings */}
      <div className="bg-white rounded-lg border border-slate-200">
        <div className="flex items-center gap-2 p-3 border-b border-slate-200">
          <p className="text-sm font-semibold text-slate-800 mr-auto">Saved {meta.noun} mappings</p>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search payee…"
              className="pl-8 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg" />
          </div>
        </div>
        {loadingList ? (
          <div className="p-8 text-center text-slate-500"><Loader2 size={18} className="animate-spin inline" /></div>
        ) : visibleExisting.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-sm">No {meta.noun} mappings yet — upload a Tally XML above to learn them.</div>
        ) : (
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2.5 font-semibold">Payee</th>
                  <th className="text-left px-3 py-2.5 font-semibold capitalize">{meta.noun}</th>
                  <th className="text-right px-3 py-2.5 font-semibold w-20">Seen</th>
                  <th className="text-left px-3 py-2.5 font-semibold w-24">Source</th>
                  <th className="w-12 px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {visibleExisting.map((x) => (
                  <tr key={x.id} className={`border-t border-slate-100 ${x.needs_review ? 'bg-amber-50/50' : ''}`}>
                    <td className="px-3 py-2.5 font-medium text-slate-800">{x.payee_label}
                      {x.needs_review && <AlertTriangle size={11} className="inline ml-1.5 text-amber-600" />}
                    </td>
                    <td className="px-3 py-2.5">
                      <CustomSelect value={(isExpense ? x.expense_category : isVendor ? x.vendor : x.transporter) || ''} onChange={(e) => onReassign(x, e.target.value)} className="w-full">
                        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{x.seen_count}</td>
                    <td className="px-3 py-2.5 text-sm text-slate-400">{x.source}</td>
                    <td className="px-3 py-2.5 text-center">
                      <button type="button" onClick={() => onDelete(x.id)} className="text-slate-400 hover:text-red-600" title="Delete mapping">
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
