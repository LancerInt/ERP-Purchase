import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, Package, Edit2, Save, X, History, ArrowLeft } from 'lucide-react';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { confirm } from '@/components/common/confirm';
import { formatDateTime } from '@/utils/formatters';

// ── Static enums (mirror backend) ─────────────────────────────────────────

const PRODUCT_CATEGORIES = [
  { value: '',                label: 'All Categories' },
  { value: 'RAW_MATERIAL',    label: 'Raw Material' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'FINISHED_GOOD',   label: 'Finished Good' },
  { value: 'SEMI_FINISHED',   label: 'Semi Finished' },
  { value: 'TRADED_PRODUCTS', label: 'Traded Products' },
  { value: 'CAPITAL_GOOD',    label: 'Capital Good' },
  { value: 'MACHINE_SPARES',  label: 'Machine Spares' },
  { value: 'CONSUMABLES',     label: 'Consumables' },
];

const UOM_OPTIONS = [
  { value: 'PCS',  label: 'Pieces' }, { value: 'KG',   label: 'Kilogram' },
  { value: 'LTR',  label: 'Liters' }, { value: 'MTR',  label: 'Meters' },
  { value: 'SQM',  label: 'Square Meter' }, { value: 'CUM', label: 'Cubic Meter' },
  { value: 'BOX',  label: 'Box' }, { value: 'PACK', label: 'Pack' },
  { value: 'MTS',  label: 'Metric Ton' },
];

const STATUS_OPTIONS = [
  { value: 'DRAFT',    label: 'Draft' },
  { value: 'ACTIVE',   label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
];

// ── Helpers ───────────────────────────────────────────────────────────────

const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));
const fmtMoney = (v) => `₹${num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty = (v) => num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtDateTime = (v) => v ? formatDateTime(v) : '-';

function newIngredientRow() {
  return {
    category: '', ingredient_product: '', uom: '', remarks: '',
  };
}

// ─────────────────────────────────────────────────────────────────────────

export default function BOMTemplateDetail() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { canEdit, canDelete, isAdmin } = usePermissions();
  const editable = canEdit('BOM Request');
  // Field-level permissions for the BOM header — hide HIDDEN inputs and
  // lock READ_ONLY ones for the current user's role.
  const { isHidden, isReadOnly } = useFieldPermissions('BOM Request');

  const { data: allProducts } = useApiData('/api/products/');
  const { options: companyOptions } = useLookup('/api/companies/');

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [original, setOriginal] = useState(null); // original API payload, used for cancel
  const [formData, setFormData] = useState(null);
  const [ingredients, setIngredients] = useState([]);

  // Companies' warehouses depend on the chosen company.
  const { options: warehouses } = useLookup(
    formData?.company ? `/api/warehouses/?company=${formData.company}&scope=true` : null,
  );

  // ── Initial fetch ────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    apiClient.get(`/api/production/bom-templates/${id}/`)
      .then((res) => {
        if (cancelled) return;
        const d = res.data;
        setOriginal(d);
        setFormData({
          company: d.company || '',
          warehouse: d.warehouse || '',
          finished_product: d.finished_product || '',
          finished_product_name: d.finished_product_name || '',
          finished_product_uom: d.finished_product_uom || '',
          template_id: d.template_id || '',
          template_name: d.template_name || '',
          batch_size: String(d.batch_size ?? '1'),
          output_uom: d.output_uom || '',
          effective_from: d.effective_from || '',
          status: d.status || 'DRAFT',
          // Read-only revision metadata
          revision_no: d.revision_no || 1,
          last_revised_date: d.last_revised_date || null,
          revised_by_name: d.revised_by_name || '',
          revision_remarks: d.revision_remarks || '',
        });
        setIngredients(
          (d.items || []).map((it) => ({
            category: it.ingredient_category || '',
            ingredient_product: it.ingredient_product,
            // Keep the server-rendered label alongside the FK so the
            // dropdown can show the saved value even while the products
            // list (paginated, 2k+ rows) is still loading — without it
            // the cell renders as "Select Ingredient" for several seconds.
            ingredient_product_name: it.ingredient_product_name || '',
            uom: it.uom || '',
            remarks: it.remarks || '',
          })),
        );
      })
      .catch(() => toast.error('Failed to load BOM template'))
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // ── Derived helpers ──────────────────────────────────────────────────

  const productsById = useMemo(() => {
    const map = {};
    (allProducts || []).forEach((p) => { map[p.id] = p; });
    return map;
  }, [allProducts]);

  const ingredientOptions = useMemo(() => (
    (allProducts || [])
      .filter((p) => p.id !== formData?.finished_product)
      .map((p) => ({
        value: p.id,
        label: p.product_name || p.sku_code || p.id,
        category: p.goods_sub_type || '',
        uom: p.uom || '',
      }))
  ), [allProducts, formData?.finished_product]);

  const ingredientOptionsFor = (categoryValue) => (
    categoryValue
      ? ingredientOptions.filter((o) => o.category === categoryValue)
      : ingredientOptions
  );

  // ── Mutations ────────────────────────────────────────────────────────

  const handleHeaderChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const updateRow = (idx, patch) => {
    setIngredients((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  };

  const handleIngredientPick = (idx, productId) => {
    const product = productsById[productId];
    updateRow(idx, {
      ingredient_product: productId,
      uom: product?.uom || '',
      category: product?.goods_sub_type || '',
    });
  };

  const handleRowCategoryChange = (idx, categoryValue) => {
    setIngredients((prev) => prev.map((row, i) => {
      if (i !== idx) return row;
      const stillValid = (() => {
        if (!row.ingredient_product) return false;
        const p = productsById[row.ingredient_product];
        return p && (!categoryValue || p.goods_sub_type === categoryValue);
      })();
      return {
        ...row,
        category: categoryValue,
        ingredient_product: stillValid ? row.ingredient_product : '',
        uom: stillValid ? row.uom : '',
      };
    }));
  };

  const addIngredient = () => setIngredients((prev) => [...prev, newIngredientRow()]);
  const removeIngredient = (idx) => setIngredients((prev) => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  // ── Save / Cancel / Delete ───────────────────────────────────────────

  const validate = () => {
    if (!formData.company) return 'Company is required.';
    if (!formData.warehouse) return 'Warehouse is required.';
    if (!formData.finished_product) return 'Finished Goods Product is required.';
    if (!formData.template_id?.trim()) return 'Production Template ID is required.';
    if (!formData.template_name?.trim()) return 'Template Name is required.';
    if (num(formData.batch_size) <= 0) return 'Batch Size must be greater than zero.';

    const filled = ingredients.filter((r) => r.ingredient_product);
    if (filled.length === 0) return 'At least one ingredient is required.';

    const seen = new Set();
    for (let i = 0; i < filled.length; i += 1) {
      const r = filled[i];
      if (r.ingredient_product === formData.finished_product) {
        return `Row ${i + 1}: a finished product cannot be its own ingredient.`;
      }
      if (seen.has(r.ingredient_product)) {
        return `Row ${i + 1}: duplicate ingredient.`;
      }
      seen.add(r.ingredient_product);
    }
    return null;
  };

  const handleSave = async (e) => {
    e?.preventDefault?.();
    const error = validate();
    if (error) { toast.error(error); return; }

    setIsSaving(true);
    try {
      const payload = {
        company: formData.company,
        warehouse: formData.warehouse,
        finished_product: formData.finished_product,
        template_id: formData.template_id.trim(),
        template_name: formData.template_name.trim(),
        batch_size: num(formData.batch_size),
        output_uom: formData.output_uom || '',
        effective_from: formData.effective_from || null,
        status: formData.status || 'DRAFT',
        revision_remarks: formData.revision_remarks || '',
        items: ingredients.filter((r) => r.ingredient_product).map((r, idx) => ({
          ingredient_product: r.ingredient_product,
          uom: r.uom || '',
          remarks: r.remarks || '',
          sort_order: idx,
        })),
      };
      const res = await apiClient.put(`/api/production/bom-templates/${id}/`, payload);
      // Refresh from response so the user immediately sees the new revision
      // number, last_revised_date, and recomputed totals.
      const d = res.data;
      setOriginal(d);
      setFormData((prev) => ({
        ...prev,
        revision_no: d.revision_no,
        last_revised_date: d.last_revised_date,
        revised_by_name: d.revised_by_name,
        revision_remarks: d.revision_remarks,
      }));
      toast.success(`BOM Template saved (revision v${d.revision_no}).`);
      setIsEditing(false);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to save BOM Template');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (!original) return;
    setFormData({
      company: original.company || '',
      warehouse: original.warehouse || '',
      finished_product: original.finished_product || '',
      finished_product_name: original.finished_product_name || '',
      finished_product_uom: original.finished_product_uom || '',
      template_id: original.template_id || '',
      template_name: original.template_name || '',
      batch_size: String(original.batch_size ?? '1'),
      output_uom: original.output_uom || '',
      effective_from: original.effective_from || '',
      status: original.status || 'DRAFT',
      revision_no: original.revision_no || 1,
      last_revised_date: original.last_revised_date || null,
      revised_by_name: original.revised_by_name || '',
      revision_remarks: original.revision_remarks || '',
    });
    setIngredients(
      (original.items || []).map((it) => ({
        category: it.ingredient_category || '',
        ingredient_product: it.ingredient_product,
        uom: it.uom || '',
        remarks: it.remarks || '',
      })),
    );
    setIsEditing(false);
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete BOM template "${formData.template_name}"? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/production/bom-templates/${id}/`);
      toast.success('BOM Template deleted.');
      navigate('/production/bom');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete');
    }
  };

  // ── Render ────────────────────────────────────────────────────────────

  if (isLoading || !formData) {
    return <MainLayout><div className="text-center py-16 text-slate-500">Loading…</div></MainLayout>;
  }

  const inputClass = isEditing
    ? 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500'
    : 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-700';
  // Visual treatment for a field locked READ_ONLY by field permissions.
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

  const finishedProductLabel = formData.finished_product_name
    || productsById[formData.finished_product]?.product_name
    || formData.finished_product;

  return (
    <MainLayout>
      <PageHeader
        title={`BOM Template — ${formData.template_id}`}
        subtitle={`${formData.template_name} (Revision v${formData.revision_no})`}
        breadcrumbs={[
          { label: 'Production', href: '/production' },
          { label: 'BOM Templates', href: '/production/bom' },
          { label: formData.template_id },
        ]}
      />

      <form onSubmit={handleSave}>
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
        {/* ── Action bar ──────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between bg-white rounded-lg border border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/production/bom'))}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 self-start"
          >
            <ArrowLeft size={14} /> Back to list
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={formData.status} />
            {!isEditing && canEdit('BOM Request') && (
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="inline-flex items-center gap-1 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700"
              >
                <Edit2 size={14} /> Edit
              </button>
            )}
            {!isEditing && (isAdmin || canDelete('BOM Request')) && (
              <button
                type="button"
                onClick={handleDelete}
                className="inline-flex items-center gap-1 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
              >
                <Trash2 size={14} /> Delete
              </button>
            )}
            {isEditing && (
              <>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="inline-flex items-center gap-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  <X size={14} /> Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="inline-flex items-center gap-1 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Save size={14} /> {isSaving ? 'Saving…' : 'Save Changes'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── BOM header card ─────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">BOM Details</h3>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {!isHidden('company') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
              <CustomSelect
                name="company"
                value={formData.company}
                onChange={handleHeaderChange}
                disabled={!isEditing || isReadOnly('company')}
                className={isReadOnly('company') ? lockedInputClass : inputClass}
              >
                <option value="">Select Company</option>
                {companyOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('warehouse') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse</label>
              <CustomSelect
                name="warehouse"
                value={formData.warehouse}
                onChange={handleHeaderChange}
                disabled={!isEditing || isReadOnly('warehouse')}
                className={isReadOnly('warehouse') ? lockedInputClass : inputClass}
              >
                <option value="">Select Warehouse</option>
                {warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </CustomSelect>
            </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Finished Goods Product</label>
              <input type="text" value={finishedProductLabel} readOnly className={inputClass} />
              <p className="text-xs text-slate-400 mt-1">Cannot be changed once a template is created.</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">UOM</label>
              <CustomSelect
                name="output_uom"
                value={formData.output_uom}
                onChange={handleHeaderChange}
                disabled={!isEditing}
                className={inputClass}
              >
                <option value="">UOM</option>
                {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            {!isHidden('production_template_id') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Production Template ID</label>
              <input
                type="text" name="template_id" value={formData.template_id} onChange={handleHeaderChange}
                readOnly={!isEditing || isReadOnly('production_template_id')}
                className={isReadOnly('production_template_id') ? lockedInputClass : inputClass}
              />
            </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Template Name</label>
              <input
                type="text" name="template_name" value={formData.template_name} onChange={handleHeaderChange}
                readOnly={!isEditing} className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Batch Size</label>
              <input
                type="number" step="0.0001" min="0.0001" name="batch_size"
                value={formData.batch_size} onChange={handleHeaderChange}
                readOnly={!isEditing} className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Effective From</label>
              <CustomDatePicker name="effective_from" value={formData.effective_from || ''} onChange={handleHeaderChange}
                readOnly={!isEditing} className={inputClass}
              />
            </div>
            {!isHidden('approval_status') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
              <CustomSelect name="status" value={formData.status} onChange={handleHeaderChange}
                disabled={!isEditing || isReadOnly('approval_status')}
                className={isReadOnly('approval_status') ? lockedInputClass : inputClass}>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            )}

            {/* Revision history — sits right next to Status on the same row */}
            <div className="self-end bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm">
              <div className="flex items-center gap-2 text-violet-800">
                <History size={14} /> <span className="font-semibold">Revision v{formData.revision_no}</span>
              </div>
              {formData.last_revised_date && (
                <div className="text-slate-700">Last revised: <strong>{fmtDateTime(formData.last_revised_date)}</strong></div>
              )}
              {formData.revised_by_name && (
                <div className="text-slate-700">By: <strong>{formData.revised_by_name}</strong></div>
              )}
              {formData.revision_remarks && (
                <div className="text-slate-700">— {formData.revision_remarks}</div>
              )}
            </div>

            {isEditing && !isHidden('remarks') && (
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Revision Remarks <span className="text-xs text-slate-400">(saved with the next revision bump)</span>
                </label>
                <input
                  type="text" name="revision_remarks" value={formData.revision_remarks}
                  onChange={handleHeaderChange}
                  readOnly={isReadOnly('remarks')}
                  className={isReadOnly('remarks') ? lockedInputClass : inputClass}
                  placeholder="Why is this template being revised?"
                />
              </div>
            )}
          </div>
        </div>

        {/* ── Ingredients ─────────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 mb-3 pb-2 border-b">
            <div className="flex items-center gap-1.5 min-w-0">
              <Package size={16} className="text-slate-500 shrink-0" />
              <h3 className="text-sm sm:text-lg font-semibold text-slate-800 leading-tight">Standard Ingredients / Raw Materials</h3>
              <span className="text-[10px] sm:text-xs text-slate-400 shrink-0">({ingredients.filter((r) => r.ingredient_product).length})</span>
            </div>
            {isEditing && (
              <button
                type="button" onClick={addIngredient}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-xs sm:text-sm font-medium hover:bg-primary-100 shrink-0 whitespace-nowrap"
              >
                <Plus size={14} /> Add Ingredient
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: '700px' }}>
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                  <th className="px-2 py-2 text-left font-semibold text-slate-600">Category</th>
                  <th className="px-2 py-2 text-left font-semibold text-slate-600">Ingredient</th>
                  <th className="px-2 py-2 text-left font-semibold text-slate-600">UOM</th>
                  <th className="px-2 py-2 text-left font-semibold text-slate-600">Remarks</th>
                  {isEditing && <th className="px-2 py-2 w-10"></th>}
                </tr>
              </thead>
              <tbody>
                {ingredients.map((row, idx) => {
                  const rowOptions = ingredientOptionsFor(row.category);
                  return (
                    <tr key={idx} className="border-b hover:bg-blue-50/30">
                      <td className="px-2 py-2 text-slate-400 font-mono">{idx + 1}</td>
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.category}
                          onChange={(e) => handleRowCategoryChange(idx, e.target.value)}
                          disabled={!isEditing}
                          className={inputClass} style={{ minWidth: '130px' }}
                        >
                          {PRODUCT_CATEGORIES.map((c) => <option key={c.value || 'all'} value={c.value}>{c.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.ingredient_product}
                          onChange={(e) => handleIngredientPick(idx, e.target.value)}
                          disabled={!isEditing}
                          className={inputClass} style={{ minWidth: '200px' }}
                        >
                          <option value="">Select Ingredient</option>
                          {/* Sticky option for the saved ingredient when it
                              isn't in rowOptions yet — either products are
                              still paginating in or the row category narrows
                              the list past it. Without this the dropdown shows
                              the placeholder even though a real value is set. */}
                          {row.ingredient_product
                            && !rowOptions.some((o) => o.value === row.ingredient_product)
                            && (
                              <option value={row.ingredient_product}>
                                {row.ingredient_product_name || 'Loading…'}
                              </option>
                            )}
                          {rowOptions.map((o) => (
                            <option
                              key={o.value} value={o.value}
                              disabled={ingredients.some((r, j) => j !== idx && r.ingredient_product === o.value)}
                            >
                              {o.label}
                            </option>
                          ))}
                        </CustomSelect>
                      </td>
                      <td className="px-2 py-2">
                        <CustomSelect value={row.uom} onChange={(e) => updateRow(idx, { uom: e.target.value })} disabled={!isEditing} className={inputClass} style={{ minWidth: '80px' }}>
                          <option value="">UOM</option>
                          {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text" value={row.remarks}
                          onChange={(e) => updateRow(idx, { remarks: e.target.value })}
                          readOnly={!isEditing}
                          className={inputClass} style={{ minWidth: '160px' }}
                        />
                      </td>
                      {isEditing && (
                        <td className="px-2 py-2">
                          <button
                            type="button" onClick={() => removeIngredient(idx)}
                            disabled={ingredients.length <= 1}
                            className="p-1.5 text-red-500 hover:bg-red-50 rounded disabled:opacity-30"
                            title="Remove"
                          ><Trash2 size={16} /></button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
