import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, AlertTriangle, Package, ExternalLink } from 'lucide-react';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useApiData from '../../../hooks/useApiData.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

// ── Static enums (mirror backend) ─────────────────────────────────────────

// Every product category — available for both the finished product and each
// ingredient line. Blank ("All Categories") shows every product.
const PRODUCT_CATEGORIES = [
  { value: '', label: 'All Categories' },
  { value: 'RAW_MATERIAL', label: 'Raw Material' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'FINISHED_GOOD', label: 'Finished Good' },
  { value: 'SEMI_FINISHED', label: 'Semi Finished' },
  { value: 'TRADED_PRODUCTS', label: 'Traded Products' },
  { value: 'CAPITAL_GOOD', label: 'Capital Good' },
  { value: 'MACHINE_SPARES', label: 'Machine Spares' },
  { value: 'CONSUMABLES', label: 'Consumables' },
];

const UOM_OPTIONS = [
  { value: 'PCS',  label: 'Pieces' },
  { value: 'KG',   label: 'Kilogram' },
  { value: 'LTR',  label: 'Liters' },
  { value: 'MTR',  label: 'Meters' },
  { value: 'SQM',  label: 'Square Meter' },
  { value: 'CUM',  label: 'Cubic Meter' },
  { value: 'BOX',  label: 'Box' },
  { value: 'PACK', label: 'Pack' },
  { value: 'MTS',  label: 'Metric Ton' },
];

const STATUS_OPTIONS = [
  { value: 'DRAFT',    label: 'Draft' },
  { value: 'ACTIVE',   label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
];

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const inputClassReadOnly = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-700';
// Visual treatment for a field locked READ_ONLY by field permissions.
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));

// ── Helpers ──────────────────────────────────────────────────────────────

function deriveTemplateName(productName) {
  if (!productName) return '';
  return `${productName} Standard BOM`;
}

function deriveTemplateId(productSkuCode, productName, companyCode) {
  // Prefer SKU code over product name because the SKU is unique and
  // stable: two products can share a display name (or a name can be
  // edited later) but a SKU is the actual identity. Previously we
  // slugged the name and ended up with stale IDs like BOM-UAI-MCP-001
  // sticking to a row whose finished product had been changed to NCP.
  const seed = productSkuCode || productName;
  if (!seed) return '';
  const slug = String(seed).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30);
  const prefix = companyCode ? `BOM-${companyCode}` : 'BOM';
  return `${prefix}-${slug}-001`;
}

function newIngredientRow() {
  return {
    category: '',          // per-row goods_sub_type filter
    ingredient_product: '',
    uom: '',
    remarks: '',
  };
}

// ─────────────────────────────────────────────────────────────────────────

export default function CreateBom() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('BOM Request');
  const [params] = useSearchParams();
  // Query-param pre-fill: when launched from the SO Stock Check matrix
  // we get `?finished_product=<id>&warehouse=<id>`. Read once at mount
  // and seed the form so the factory user only fills ingredients +
  // template name.
  const prefillProductId   = params.get('finished_product') || '';
  const prefillWarehouseId = params.get('warehouse') || '';
  const { options: companyOptions, raw: companies } = useLookup('/api/companies/');
  const { data: allProducts } = useApiData('/api/products/');

  // Field-level permissions for the BOM Request header — hide HIDDEN
  // inputs and lock READ_ONLY ones for the current user's role.
  const { isHidden, isReadOnly } = useFieldPermissions('BOM Request');

  const [selectedCompany, setSelectedCompany] = useState('');
  const [productCategory, setProductCategory] = useState('');
  const { options: warehouses } = useLookup(
    selectedCompany ? `/api/warehouses/?company=${selectedCompany}&scope=true` : null,
  );

  const [formData, setFormData] = useState({
    warehouse: prefillWarehouseId,
    finished_product: prefillProductId,
    output_uom: '',
    template_id: '',
    template_name: '',
    batch_size: '1',
    effective_from: '',
    status: 'DRAFT',
  });

  // When launched from the SO matrix we know the warehouse id but not
  // the company — derive it once the warehouses list loads. The lookup
  // call only fires once selectedCompany is set, so we have to hit the
  // warehouse endpoint directly here to read warehouse.company_id.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current) return;
    if (!prefillWarehouseId) { prefilledRef.current = true; return; }
    let cancelled = false;
    apiClient.get(`/api/warehouses/${prefillWarehouseId}/`)
      .then((res) => {
        if (cancelled) return;
        const companyId = res.data?.company || '';
        if (companyId) setSelectedCompany(companyId);
        prefilledRef.current = true;
      })
      .catch(() => { prefilledRef.current = true; });
    return () => { cancelled = true; };
  }, [prefillWarehouseId]);

  // Derived prefill: once the finished product + company have resolved,
  // run the same auto-fill that `handleFinishedProductChange` performs
  // when the user picks a product manually — output_uom, template_id,
  // template_name, plus the Category filter so the dropdown narrows to
  // products in the same goods_sub_type. Fires exactly once after the
  // dependent data loads.
  const prefillDerivedRef = useRef(false);

  const [ingredients, setIngredients] = useState([newIngredientRow()]);
  const [isSaving, setIsSaving] = useState(false);
  const [duplicate, setDuplicate] = useState(null); // { template_id, template_code, ... }

  // ── Derived: products by id, finished-good auto-fill data ─────────────

  const productsById = useMemo(() => {
    const map = {};
    (allProducts || []).forEach((p) => { map[p.id] = p; });
    return map;
  }, [allProducts]);

  const finishedGoodOptions = useMemo(() => {
    let list = allProducts || [];
    if (productCategory) {
      list = list.filter((p) => p.goods_sub_type === productCategory);
    }
    return list.map((p) => ({ value: p.id, label: p.product_name || p.sku_code || p.id }));
  }, [allProducts, productCategory]);

  // Ingredient dropdown — exclude the finished product itself.
  const ingredientOptions = useMemo(() => {
    return (allProducts || [])
      .filter((p) => p.id !== formData.finished_product)
      .map((p) => ({
        value: p.id,
        label: p.product_name || p.sku_code || p.id,
        category: p.goods_sub_type || '',
        uom: p.uom || '',
      }));
  }, [allProducts, formData.finished_product]);

  // Per-row ingredient list. With a category picked we narrow by
  // goods_sub_type, but if that yields zero matches (e.g. products in the
  // master don't have goods_sub_type set), fall back to the full list so
  // the user can still pick something — the strict-empty filter has been
  // a recurring footgun.
  const ingredientOptionsFor = (categoryValue) => {
    if (!categoryValue) return ingredientOptions;
    const narrowed = ingredientOptions.filter((o) => o.category === categoryValue);
    return narrowed.length > 0 ? narrowed : ingredientOptions;
  };

  // ── Prefill auto-fill: mirror handleFinishedProductChange for the
  //    SO-matrix entry path. Waits until products + companies are
  //    loaded AND the company has been resolved from the warehouse,
  //    then derives output_uom + template_name + template_id + the
  //    Category filter from the prefilled finished product. Runs once.
  useEffect(() => {
    if (prefillDerivedRef.current) return;
    if (!prefillProductId || !selectedCompany) return;
    if (!allProducts || allProducts.length === 0) return;
    if (!companies || companies.length === 0) return;
    const product = productsById[prefillProductId];
    if (!product) return;
    const company = companies.find((c) => c.id === selectedCompany);
    setProductCategory(product.goods_sub_type || '');
    setFormData((prev) => ({
      ...prev,
      output_uom: product.uom || '',
      template_name: deriveTemplateName(product.product_name),
      template_id: deriveTemplateId(product.sku_code, product.product_name, company?.company_code),
    }));
    prefillDerivedRef.current = true;
  }, [prefillProductId, selectedCompany, allProducts, companies, productsById]);

  // ── Duplicate-template check (fires when company + finished_product set) ──

  useEffect(() => {
    if (!selectedCompany || !formData.finished_product) {
      setDuplicate(null);
      return;
    }
    let cancelled = false;
    apiClient.get('/api/production/bom-templates/check-duplicate/', {
      params: { company_id: selectedCompany, finished_product_id: formData.finished_product },
    })
      .then((res) => { if (!cancelled) setDuplicate(res.data?.exists ? res.data : null); })
      .catch(() => { if (!cancelled) setDuplicate(null); });
    return () => { cancelled = true; };
  }, [selectedCompany, formData.finished_product]);

  // ── Header field mutation ─────────────────────────────────────────────

  const handleHeaderChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleFinishedProductChange = (e) => {
    const value = e.target.value;
    const product = productsById[value];
    const company = companies?.find((c) => c.id === selectedCompany);
    // Always re-derive the template id and name when the finished
    // product changes. Previously a stale `prev.template_id` would
    // stick to the form even after the user switched products, which
    // is how BOM-UAI-MCP-001 ended up on a row whose finished product
    // had been changed to NCP. The user can still edit the field by
    // hand afterwards if they want a custom code.
    setFormData((prev) => ({
      ...prev,
      finished_product: value,
      output_uom: product?.uom || '',
      template_name: deriveTemplateName(product?.product_name),
      template_id: deriveTemplateId(product?.sku_code, product?.product_name, company?.company_code),
    }));
  };

  // ── Ingredient row mutation ───────────────────────────────────────────

  const updateRow = (idx, patch) => {
    setIngredients((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  };

  const handleIngredientPick = (idx, productId) => {
    const product = productsById[productId];
    updateRow(idx, {
      ingredient_product: productId,
      uom: product?.uom || '',
      // Keep the row's category in sync with the chosen product so the
      // Category column reflects the actual product's sub-type even when
      // the user picked the product without a category filter first.
      category: product?.goods_sub_type || '',
    });
  };

  const handleRowCategoryChange = (idx, categoryValue) => {
    setIngredients((prev) => prev.map((row, i) => {
      if (i !== idx) return row;
      // Clearing the previous ingredient when category changes prevents
      // a stale out-of-category product from staying silently selected.
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

  // ── Validation + submit ───────────────────────────────────────────────

  const validate = () => {
    if (!selectedCompany) return 'Company is required.';
    if (!formData.warehouse) return 'Warehouse is required.';
    if (!formData.finished_product) return 'Finished Goods Product is required.';
    if (!formData.template_id?.trim()) return 'Production Template ID is required.';
    if (!formData.template_name?.trim()) return 'Template Name is required.';
    if (num(formData.batch_size) <= 0) return 'Batch Size must be greater than zero.';
    if (duplicate) return 'A BOM Template already exists for this finished product.';

    const filled = ingredients.filter((r) => r.ingredient_product);
    if (filled.length === 0) return 'At least one ingredient is required.';

    const seen = new Set();
    for (let i = 0; i < filled.length; i += 1) {
      const r = filled[i];
      if (r.ingredient_product === formData.finished_product) {
        return `Row ${i + 1}: a finished product cannot be its own ingredient.`;
      }
      if (seen.has(r.ingredient_product)) {
        return `Row ${i + 1}: duplicate ingredient. Each ingredient can appear only once.`;
      }
      seen.add(r.ingredient_product);
    }
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }
    setIsSaving(true);
    try {
      const payload = {
        company: selectedCompany,
        warehouse: formData.warehouse,
        finished_product: formData.finished_product,
        template_id: formData.template_id.trim(),
        template_name: formData.template_name.trim(),
        batch_size: num(formData.batch_size),
        output_uom: formData.output_uom || '',
        effective_from: formData.effective_from || null,
        status: formData.status || 'DRAFT',
        items: ingredients
          .filter((r) => r.ingredient_product)
          .map((r, idx) => ({
            ingredient_product: r.ingredient_product,
            uom: r.uom || '',
            remarks: r.remarks || '',
            sort_order: idx,
          })),
      };
      await apiClient.post('/api/production/bom-templates/', payload);
      toast.success('BOM Template created successfully.');
      navigate('/production/bom');
    } catch (err) {
      const data = err?.response?.data || {};
      if (data?.finished_product) {
        toast.error('BOM Template already exists for this finished goods product.');
      } else {
        toast.error(getApiErrorMessage(err) || 'Failed to create BOM Template');
      }
    } finally {
      setIsSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────

  const finishedProductObj = productsById[formData.finished_product];

  return (
    <MainLayout>
      <PageHeader
        title="Create Bill of Materials"
        subtitle="Define the standard recipe (ingredients, wastage, cost) for a finished goods product."
        breadcrumbs={[
          { label: 'Production', href: '/production' },
          { label: 'BOM', href: '/production/bom' },
          { label: 'New' },
        ]}
      />

      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
        {/* Duplicate warning banner */}
        {duplicate && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
            <div className="flex-1">
              <p className="font-semibold text-red-800">BOM Template already exists for this product.</p>
              <p className="text-sm text-red-700 mt-1">
                A template <span className="font-mono">{duplicate.template_code}</span>
                {duplicate.template_name ? ` (${duplicate.template_name})` : ''} is already configured.
                You cannot create another one for the same finished goods product. Edit the existing one to add a new revision.
              </p>
              <button
                type="button"
                onClick={() => navigate(`/production/bom/${duplicate.template_id}`)}
                className="inline-flex items-center gap-1 mt-2 text-sm text-red-700 hover:text-red-900 font-medium"
              >
                <ExternalLink size={14} /> View Existing Template
              </button>
            </div>
          </div>
        )}

        {/* ── BOM Header ───────────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">BOM Details</h3>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {!isHidden('company') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
              <CustomSelect
                value={selectedCompany}
                onChange={(e) => { setSelectedCompany(e.target.value); setFormData((p) => ({ ...p, warehouse: '' })); }}
                required disabled={isReadOnly('company')}
                className={isReadOnly('company') ? lockedInputClass : inputClass}
              >
                <option value="">Select Company...</option>
                {companyOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
            </div>
            )}

            {!isHidden('warehouse') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
              <CustomSelect
                name="warehouse" value={formData.warehouse} onChange={handleHeaderChange}
                required disabled={!selectedCompany || isReadOnly('warehouse')}
                className={`${isReadOnly('warehouse') ? lockedInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}
              >
                <option value="">{selectedCompany ? 'Select Warehouse...' : 'Select company first...'}</option>
                {warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </CustomSelect>
            </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Product Category</label>
              <CustomSelect
                value={productCategory}
                onChange={(e) => { setProductCategory(e.target.value); setFormData((p) => ({ ...p, finished_product: '' })); }}
                className={inputClass}
              >
                {PRODUCT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
            </div>

            <div className="col-span-2 md:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Main Product / Finished Goods Product <span className="text-red-500">*</span>
              </label>
              <CustomSelect
                value={formData.finished_product} onChange={handleFinishedProductChange}
                required className={inputClass}
              >
                <option value="">
                  {productCategory
                    ? (finishedGoodOptions.length ? 'Select Product...' : 'No products in this category')
                    : 'Select Product...'}
                </option>
                {finishedGoodOptions.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </CustomSelect>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">UOM (auto)</label>
              <CustomSelect
                name="output_uom" value={formData.output_uom} onChange={handleHeaderChange}
                className={`${inputClass} ${finishedProductObj?.uom ? 'bg-slate-50' : ''}`}
                disabled={!formData.finished_product}
              >
                <option value="">{formData.finished_product ? 'Select UOM' : 'Pick a product first'}</option>
                {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>

            {!isHidden('production_template_id') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Production Template ID <span className="text-red-500">*</span></label>
              <input
                type="text" name="template_id" value={formData.template_id} onChange={handleHeaderChange}
                placeholder="e.g. BOM-ANANDHAM-25KG-001" required disabled={isReadOnly('production_template_id')}
                className={isReadOnly('production_template_id') ? lockedInputClass : inputClass}
              />
              <p className="text-xs text-slate-400 mt-1">Auto-generated from product name; you can override.</p>
            </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Template Name <span className="text-red-500">*</span></label>
              <input
                type="text" name="template_name" value={formData.template_name} onChange={handleHeaderChange}
                placeholder="e.g. Anandham 25 kg Standard BOM" required className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Batch Size / Standard Output Qty <span className="text-red-500">*</span></label>
              <input
                type="number" step="0.0001" min="0.0001" name="batch_size"
                value={formData.batch_size} onChange={handleHeaderChange} required className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Effective From</label>
              <CustomDatePicker name="effective_from" value={formData.effective_from} onChange={handleHeaderChange}
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
              <CustomSelect name="status" value={formData.status} onChange={handleHeaderChange} className={inputClass}>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
          </div>
        </div>

        {/* ── Ingredients table ───────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <div className="flex items-center justify-between mb-4 pb-2 border-b">
            <div className="flex items-center gap-2">
              <Package size={18} className="text-slate-500" />
              <h3 className="text-lg font-semibold text-slate-800">Standard Ingredients / Raw Materials</h3>
              <span className="text-xs text-slate-400">({ingredients.filter((r) => r.ingredient_product).length} item(s))</span>
            </div>
            <button
              type="button" onClick={addIngredient}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100"
            >
              <Plus size={16} /> Add Ingredient
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: '700px' }}>
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                  <th className="px-2 py-2 text-left font-semibold text-slate-600">Category</th>
                  <th className="px-2 py-2 text-left font-semibold text-slate-600">Ingredient <span className="text-red-500">*</span></th>
                  <th className="px-2 py-2 text-left font-semibold text-slate-600">UOM</th>
                  <th className="px-2 py-2 text-left font-semibold text-slate-600">Remarks</th>
                  <th className="px-2 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {ingredients.map((row, idx) => {
                  const rowIngredientOptions = ingredientOptionsFor(row.category);
                  // Fallback fires when a category was picked but no
                  // product in master matches → we show all products
                  // instead. Tell the user so it's not silent.
                  const narrowedToCategory = row.category
                    ? ingredientOptions.filter((o) => o.category === row.category)
                    : null;
                  const fellBackToAll = !!row.category && narrowedToCategory?.length === 0 && rowIngredientOptions.length > 0;
                  return (
                    <tr key={idx} className="border-b hover:bg-blue-50/30">
                      <td className="px-2 py-2 text-slate-400 font-mono">{idx + 1}</td>
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.category}
                          onChange={(e) => handleRowCategoryChange(idx, e.target.value)}
                          className={inputClass} style={{ minWidth: '130px' }}
                        >
                          {PRODUCT_CATEGORIES.map((c) => (
                            <option key={c.value || 'all'} value={c.value}>{c.label}</option>
                          ))}
                        </CustomSelect>
                      </td>
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.ingredient_product}
                          onChange={(e) => handleIngredientPick(idx, e.target.value)}
                          className={inputClass} style={{ minWidth: '200px' }}
                        >
                          <option value="">
                            {rowIngredientOptions.length === 0
                              ? 'No products in master'
                              : 'Select Ingredient'}
                          </option>
                          {rowIngredientOptions.map((o) => (
                            <option
                              key={o.value} value={o.value}
                              disabled={ingredients.some((r, j) => j !== idx && r.ingredient_product === o.value)}
                            >
                              {o.label}
                            </option>
                          ))}
                        </CustomSelect>
                        {fellBackToAll && (
                          <p className="mt-1 text-xs text-amber-600">
                            No products tagged as this category — showing all products.
                          </p>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.uom} onChange={(e) => updateRow(idx, { uom: e.target.value })}
                          className={inputClass} style={{ minWidth: '80px' }}
                        >
                          <option value="">UOM</option>
                          {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text" value={row.remarks}
                          onChange={(e) => updateRow(idx, { remarks: e.target.value })}
                          className={inputClass} style={{ minWidth: '160px' }}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <button
                          type="button" onClick={() => removeIngredient(idx)}
                          disabled={ingredients.length <= 1}
                          className="p-1.5 text-red-500 hover:bg-red-50 rounded disabled:opacity-30"
                          title="Remove row"
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Footer actions ──────────────────────────────────────────── */}
        <div className="flex justify-end gap-3">
          <button
            type="button" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/production/bom')}
            className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving || !!duplicate}
            className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : 'Save BOM Template'}
          </button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
