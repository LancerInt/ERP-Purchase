import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import CustomSelect from '@/components/ui/CustomSelect';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const emptyLine = { category: '', product: '', batch: '', quantity: '', uom: '', reason: '' };
const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

// Product categories (Product.goods_sub_type) — strict match against the
// product master, same convention as the PR / Packing forms.
const CATEGORY_OPTIONS = [
  { value: 'RAW_MATERIAL', label: 'Raw Material' },
  { value: 'SEMI_FINISHED', label: 'Semi Finished' },
  { value: 'FINISHED_GOOD', label: 'Finished Good' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'CONSUMABLES', label: 'Consumables' },
];

export default function ProductionDamageNew() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Production Damage');
  const { options: companies } = useLookup('/api/companies/');
  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  // Source products from the OPEN item catalogue — not the module-gated
  // /api/products/, which returns nothing for roles without Product access
  // (the same fix already applied to the Movement Request & Packing forms).
  // Normalise each catalogue row to the product shape this form expects.
  const { raw: catalogRaw } = useLookup('/api/purchase/items/');
  const productsRaw = useMemo(() => (catalogRaw || [])
    .filter((it) => it.item_type === 'PRODUCT')
    .map((it) => ({
      id: it.item_id,
      product_name: it.item_name,
      sku_code: it.item_code,
      goods_sub_type: it.category,
      uom: it.uom,
    })), [catalogRaw]);
  const { raw: processesRaw } = useLookup('/api/production/processes/');
  const { raw: workOrdersRaw } = useLookup('/api/production/work-orders/');

  const [form, setForm] = useState({ company: '', warehouse: '', godown: '', process: '', work_order: '', remarks: '' });
  const { options: godowns } = useLookup(form.warehouse ? `/api/godowns/?warehouse=${form.warehouse}` : null);
  const [lines, setLines] = useState([{ ...emptyLine }]);
  const [saving, setSaving] = useState(false);
  // Product ids that belong to the selected work order (its inputs + outputs +
  // finished product). null = no WO filter.
  const [woProductIds, setWoProductIds] = useState(null);

  // Warehouses for the selected company only (and same-named ones collapsed,
  // since the master can hold duplicates across companies).
  const warehouses = useMemo(() => {
    const seen = new Set();
    return (warehousesRaw || [])
      .filter((w) => !form.company || String(w.company) === String(form.company))
      .filter((w) => {
        const k = (w.name || '').trim().toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((w) => ({ value: w.id, label: w.name }));
  }, [warehousesRaw, form.company]);

  // Processes scoped to the chosen company (and warehouse, if picked).
  const processes = useMemo(() => {
    return (processesRaw || [])
      .filter((p) => !form.company || String(p.company) === String(form.company))
      .filter((p) => !form.warehouse || String(p.warehouse) === String(form.warehouse))
      .map((p) => ({ value: p.id, label: p.process_name || p.process_code }));
  }, [processesRaw, form.company, form.warehouse]);

  // Work orders scoped to company → warehouse → process, in that order.
  const workOrderOptions = useMemo(() => {
    return (workOrdersRaw || [])
      .filter((wo) => !form.company || String(wo.company) === String(form.company))
      .filter((wo) => !form.warehouse || String(wo.warehouse) === String(form.warehouse))
      .filter((wo) => !form.process || String(wo.process) === String(form.process))
      .map((wo) => ({
        value: wo.id,
        label: `${wo.work_order_no || wo.batch_id || wo.id}${wo.finished_product_name ? ' — ' + wo.finished_product_name : ''}`,
      }));
  }, [workOrdersRaw, form.company, form.warehouse, form.process]);

  // Fetch the selected work order's products (inputs + outputs + finished) and
  // restrict the product picker to them.
  useEffect(() => {
    if (!form.work_order) { setWoProductIds(null); return; }
    let cancelled = false;
    apiClient.get(`/api/production/work-orders/${form.work_order}/`)
      .then((res) => {
        if (cancelled) return;
        const d = res.data || {};
        const ids = new Set();
        (d.input_consumptions || []).forEach((r) => r.product && ids.add(String(r.product)));
        (d.output_products || []).forEach((r) => r.product && ids.add(String(r.product)));
        if (d.finished_product) ids.add(String(d.finished_product));
        setWoProductIds(ids);
      })
      .catch(() => { if (!cancelled) setWoProductIds(null); });
    return () => { cancelled = true; };
  }, [form.work_order]);

  const setField = (k, v) => setForm((p) => ({
    ...p,
    [k]: v,
    // Each level resets everything scoped below it.
    ...(k === 'company' ? { warehouse: '', godown: '', process: '', work_order: '' } : {}),
    ...(k === 'warehouse' ? { godown: '', process: '', work_order: '' } : {}),
    ...(k === 'process' ? { work_order: '' } : {}),
  }));

  // Strict product options for a line: optionally constrained by the work
  // order's products AND by the line's category (exact goods_sub_type).
  const productOptionsFor = (category) => {
    return (productsRaw || [])
      .filter((p) => (woProductIds ? woProductIds.has(String(p.id)) : true))
      .filter((p) => (category ? p.goods_sub_type === category : true))
      .map((p) => ({ value: p.id, label: `${p.sku_code ? p.sku_code + ' — ' : ''}${p.product_name}` }));
  };

  const setLine = (i, k, v) => setLines((prev) => prev.map((l, idx) => {
    if (idx !== i) return l;
    if (k === 'category') return { ...l, category: v, product: '', uom: '' };  // re-pick product for the new category
    if (k === 'product') {
      const p = (productsRaw || []).find((x) => String(x.id) === String(v));
      return { ...l, product: v, uom: p?.uom || l.uom || '' };
    }
    return { ...l, [k]: v };
  }));

  const addLine = () => setLines((p) => [...p, { ...emptyLine }]);
  const removeLine = (i) => setLines((p) => (p.length > 1 ? p.filter((_, idx) => idx !== i) : p));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.company || !form.warehouse) { toast.error('Company and Warehouse are required.'); return; }
    const items = lines.filter((l) => l.product && Number(l.quantity) > 0);
    if (items.length === 0) { toast.error('Add at least one damaged product with a quantity greater than 0.'); return; }
    setSaving(true);
    try {
      const payload = {
        company: form.company,
        warehouse: form.warehouse,
        godown: form.godown || null,
        remarks: form.remarks,
        damage_items: items.map((l, idx) => ({
          product: l.product, batch: l.batch || '', quantity: l.quantity,
          uom: l.uom || '', reason: l.reason || '', sort_order: idx,
        })),
      };
      const res = await apiClient.post('/api/production/damages/', payload);
      toast.success('Damage entry created.');
      navigate(`/production/damage/${res.data.id}`);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="New Damage Entry"
        subtitle="Record products damaged during production / packing"
        breadcrumbs={[{ label: 'Production' }, { label: 'Damage', href: '/production/damage' }, { label: 'New' }]}
      />
      <form onSubmit={submit} className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
        {/* Header */}
        <div>
          <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 pb-2 border-b">Details</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
              <CustomSelect value={form.company} onChange={(e) => setField('company', e.target.value)} required className={inputClass}>
                <option value="">Select…</option>
                {companies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
              <CustomSelect value={form.warehouse} onChange={(e) => setField('warehouse', e.target.value)} required className={inputClass}>
                <option value="">Select…</option>
                {warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Godown</label>
              <CustomSelect value={form.godown} onChange={(e) => setField('godown', e.target.value)} disabled={!form.warehouse} className={inputClass}>
                <option value="">{form.warehouse ? 'Select…' : 'Pick a warehouse first'}</option>
                {godowns.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Process</label>
              <CustomSelect value={form.process} onChange={(e) => setField('process', e.target.value)} className={inputClass}>
                <option value="">All processes</option>
                {processes.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Work Order</label>
              <CustomSelect value={form.work_order} onChange={(e) => setField('work_order', e.target.value)} className={inputClass}>
                <option value="">All work orders</option>
                {workOrderOptions.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </CustomSelect>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Stock is deducted from this warehouse/godown on approval (the warehouse's first godown is used if none is set).
            {' '}Process &amp; Work Order narrow the product list below to that production run.
          </p>
        </div>

        {/* Line items */}
        <div>
          <div className="flex items-center justify-between mb-3 pb-2 border-b">
            <h3 className="text-base sm:text-lg font-semibold text-slate-800">Damaged Products</h3>
            <button type="button" onClick={addLine} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50">
              <Plus size={14} /> Add Line
            </button>
          </div>
          {/* desktop / tablet: table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                  <th className="px-3 py-2 font-medium w-44">Category</th>
                  <th className="px-3 py-2 font-medium min-w-[220px]">Product <span className="text-red-500">*</span></th>
                  <th className="px-3 py-2 font-medium w-28">Batch</th>
                  <th className="px-3 py-2 font-medium w-28">Qty <span className="text-red-500">*</span></th>
                  <th className="px-3 py-2 font-medium w-24">UOM</th>
                  <th className="px-3 py-2 font-medium min-w-[160px]">Reason</th>
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="px-3 py-2">
                      <CustomSelect value={line.category} onChange={(e) => setLine(i, 'category', e.target.value)} className={inputClass} style={{ minWidth: '150px' }}>
                        <option value="">All</option>
                        {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </CustomSelect>
                    </td>
                    <td className="px-3 py-2">
                      <CustomSelect value={line.product} onChange={(e) => setLine(i, 'product', e.target.value)} className={inputClass} style={{ minWidth: '200px' }}>
                        <option value="">Select product…</option>
                        {productOptionsFor(line.category).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </CustomSelect>
                    </td>
                    <td className="px-3 py-2"><input type="text" value={line.batch} onChange={(e) => setLine(i, 'batch', e.target.value)} placeholder="—" className={inputClass} /></td>
                    <td className="px-3 py-2"><input type="number" min="0.0001" step="any" value={line.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} placeholder="0" className={`${inputClass} text-right`} /></td>
                    <td className="px-3 py-2"><input type="text" value={line.uom} onChange={(e) => setLine(i, 'uom', e.target.value)} placeholder="UOM" className={inputClass} /></td>
                    <td className="px-3 py-2"><input type="text" value={line.reason} onChange={(e) => setLine(i, 'reason', e.target.value)} placeholder="e.g. spillage, contamination" className={inputClass} /></td>
                    <td className="px-3 py-2 text-center">
                      <button type="button" onClick={() => removeLine(i)} className="text-red-500 hover:text-red-700 disabled:opacity-30" disabled={lines.length === 1} title="Remove line">
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* mobile: each damaged product as a stacked card */}
          <div className="md:hidden space-y-3">
            {lines.map((line, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500">Item {i + 1}</span>
                  <button type="button" onClick={() => removeLine(i)} disabled={lines.length === 1} className="text-red-500 hover:text-red-700 disabled:opacity-30" title="Remove line">
                    <Trash2 size={15} />
                  </button>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Category</label>
                  <CustomSelect value={line.category} onChange={(e) => setLine(i, 'category', e.target.value)} className={inputClass}>
                    <option value="">All</option>
                    {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </CustomSelect>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Product <span className="text-red-500">*</span></label>
                  <CustomSelect value={line.product} onChange={(e) => setLine(i, 'product', e.target.value)} className={inputClass}>
                    <option value="">Select product…</option>
                    {productOptionsFor(line.category).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </CustomSelect>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Qty <span className="text-red-500">*</span></label>
                    <input type="number" min="0.0001" step="any" value={line.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} placeholder="0" className={`${inputClass} text-right`} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">UOM</label>
                    <input type="text" value={line.uom} onChange={(e) => setLine(i, 'uom', e.target.value)} placeholder="UOM" className={inputClass} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Batch</label>
                  <input type="text" value={line.batch} onChange={(e) => setLine(i, 'batch', e.target.value)} placeholder="—" className={inputClass} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Reason</label>
                  <input type="text" value={line.reason} onChange={(e) => setLine(i, 'reason', e.target.value)} placeholder="e.g. spillage, contamination" className={inputClass} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Remarks */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
          <textarea value={form.remarks} onChange={(e) => setField('remarks', e.target.value)} rows={2} className={inputClass} placeholder="Optional notes about the damage…" />
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <button type="button" onClick={() => navigate('/production/damage')} className="px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={saving} className="px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save (Draft)'}</button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
