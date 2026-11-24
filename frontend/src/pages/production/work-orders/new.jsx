import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Plus, Trash2, RefreshCcw, ExternalLink,
  XCircle, Package, FileText, Layers, Paperclip, Upload, X,
} from 'lucide-react';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useApiData from '../../../hooks/useApiData.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { confirm } from '@/components/common/confirm';

// ── Constants ───────────────────────────────────────────────────────────

const PRODUCT_CATEGORY_LABEL = {
  RAW_MATERIAL: 'Raw Material',
  PACKING_MATERIAL: 'Packing Material',
  FINISHED_GOOD: 'Finished Good',
  SEMI_FINISHED: 'Semi Finished',
  TRADED_PRODUCTS: 'Traded Products',
  CAPITAL_GOOD: 'Capital Good',
  MACHINE_SPARES: 'Machine Spares',
  CONSUMABLES: 'Consumables',
};

const WAGE_METHOD_OPTIONS = [
  { value: 'TEMPLATE_RATE', label: 'Template Rate' },
  { value: 'HEADCOUNT', label: 'Per Headcount' },
  { value: 'PRODUCTION_GROUP', label: 'Production Group' },
];

const UOM_OPTIONS = ['PCS', 'KG', 'LTR', 'MTR', 'SQM', 'CUM', 'BOX', 'PACK', 'MTS'];

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
// Visual treatment for a field locked READ_ONLY by field permissions.
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));
const fmtQty   = (v) => num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtCat   = (v) => PRODUCT_CATEGORY_LABEL[v] || v || '-';

// ────────────────────────────────────────────────────────────────────────

export default function CreateWorkOrder() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Work Order');
  // Lookups
  const { data: bomTemplates, isLoading: loadingBoms } = useApiData('/api/production/bom-templates/');
  const { data: allProducts } = useApiData('/api/products/');
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: salesOrders } = useLookup('/api/sales/orders/');

  const productsById = useMemo(() => {
    const m = {};
    (allProducts || []).forEach((p) => { m[p.id] = p; });
    return m;
  }, [allProducts]);

  const productOptions = useMemo(() => (
    (allProducts || []).map((p) => ({
      value: p.id,
      label: p.product_name || p.sku_code || p.id,
      category: p.goods_sub_type || '',
      uom: p.uom || '',
    }))
  ), [allProducts]);

  // Categories actually present in the product master — keeps the dropdown
  // honest (no orphan options that would filter to zero results).
  const categoryOptions = useMemo(() => {
    const seen = new Set();
    productOptions.forEach((o) => { if (o.category) seen.add(o.category); });
    return Array.from(seen).sort().map((c) => ({
      value: c,
      label: PRODUCT_CATEGORY_LABEL[c] || c,
    }));
  }, [productOptions]);

  // Product options for one subform row, category-filtered. If the row
  // already references a product that ISN'T in the active product list —
  // e.g. a BOM ingredient that was later soft-deleted (the products
  // endpoint hides inactive rows by default) — surface it anyway, flagged
  // "(inactive)", so the assigned value still DISPLAYS instead of silently
  // blanking. New manual picks still only ever see active products.
  const optionsForRow = useCallback((row) => {
    const filtered = productOptions.filter(
      (o) => !row.product_category || o.category === row.product_category,
    );
    if (row.product && !filtered.some((o) => String(o.value) === String(row.product))) {
      return [
        {
          value: row.product,
          label: `${row.product_name || 'Selected item'} (inactive)`,
          category: row.product_category || '',
          _inactive: true,
        },
        ...filtered,
      ];
    }
    return filtered;
  }, [productOptions]);

  // Field-level permissions for the Work Order header — hide HIDDEN
  // inputs and lock READ_ONLY ones for the current user's role.
  const { isHidden, isReadOnly } = useFieldPermissions('Work Order');
  // Line-item field permissions — the Input/Output product tables are
  // their own modules ('Work Order Input' / 'Work Order Output'), so a
  // hidden column drops both its header cell and the cell in every row.
  const { isHidden: isInHidden, isReadOnly: isInRO } = useFieldPermissions('Work Order Input');
  const { isHidden: isOutHidden, isReadOnly: isOutRO } = useFieldPermissions('Work Order Output');

  // BOM-template-driven state — populated from /scaffold-from-bom.
  const [selectedTemplate, setSelectedTemplate] = useState(null); // full scaffold response
  const [isFetchingScaffold, setIsFetchingScaffold] = useState(false);
  const [search, setSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  const [formData, setFormData] = useState({
    bom_template: '',
    company: '',
    warehouse: '',
    finished_product: '',
    finished_product_name: '',
    process: '',
    process_name_snapshot: '',
    date: new Date().toISOString().slice(0, 10),
    production_date: '',
    machine_name: '',
    batch_id: '',
    work_order_no: '',
    template_revision: '',
    linked_sales_order: '',
    wage_method: 'TEMPLATE_RATE',
    notes: '',
  });

  // ── Preview the next auto-generated WO number ────────────────────────
  // Counts existing WOs for the chosen Company and renders WO-{count+1}.
  // Just a preview — the server still generates the final number on save,
  // so a race between two users is resolved server-side.
  const [previewWoNo, setPreviewWoNo] = useState('');
  // Batch ID is auto-generated server-side too (BATCH-NNNN per company),
  // sharing the same per-company sequence as the WO number.
  const [previewBatchId, setPreviewBatchId] = useState('');

  useEffect(() => {
    if (!formData.company) {
      setPreviewWoNo('');
      setPreviewBatchId('');
      return undefined;
    }
    let cancelled = false;
    apiClient.get('/api/production/work-orders/', {
      params: { company: formData.company, page_size: 1 },
    })
      .then((res) => {
        if (cancelled) return;
        // Handle paginated and non-paginated responses.
        const count = typeof res.data?.count === 'number'
          ? res.data.count
          : (Array.isArray(res.data) ? res.data.length : (res.data?.results?.length || 0));
        const seq = String(count + 1).padStart(4, '0');
        setPreviewWoNo(`WO-${seq}`);
        setPreviewBatchId(`BATCH-${seq}`);
      })
      .catch(() => { if (!cancelled) { setPreviewWoNo(''); setPreviewBatchId(''); } });
    return () => { cancelled = true; };
  }, [formData.company]);

  // ── Process Master (Active rows for the chosen Warehouse only) ──
  // Processes are filtered by WAREHOUSE alone — the company is not part
  // of the filter, so every Active process registered at the selected
  // warehouse shows regardless of which company is picked.
  const [processList, setProcessList] = useState([]);
  const [loadingProcesses, setLoadingProcesses] = useState(false);

  const fetchProcesses = useCallback(async (warehouseId) => {
    if (!warehouseId) {
      setProcessList([]);
      return;
    }
    setLoadingProcesses(true);
    try {
      const res = await apiClient.get('/api/production/processes/', {
        params: {
          // Fold by warehouse NAME across companies (e.g. both "NKP"
          // warehouses) — company is never part of the filter.
          warehouse_group: warehouseId,
          status: 'Active',
          page_size: 500,
        },
      });
      const rows = res.data?.results || res.data || [];
      setProcessList(rows);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Unable to load Process list.');
    } finally {
      setLoadingProcesses(false);
    }
  }, []);

  useEffect(() => {
    fetchProcesses(formData.warehouse);
  }, [formData.warehouse, fetchProcesses]);

  const processOptions = useMemo(() => (
    processList.map((p) => ({
      value: p.id,
      label: p.process_name,
      code: p.process_code,
      status: p.status,
    }))
  ), [processList]);

  const handleProcessChange = (val, opt) => {
    setFormData((prev) => ({
      ...prev,
      process: val || '',
      process_name_snapshot: opt?.label || '',
    }));
  };

  const [outputs, setOutputs] = useState([]);
  const [inputs, setInputs] = useState([]);
  const [isSaving, setIsSaving] = useState(false);

  // Attachments staged in-memory until the WO is saved, then uploaded one by
  // one with the new work_order id as the polymorphic record_id.
  const [attachments, setAttachments] = useState([]); // [{ file, name, size, type }]

  const addAttachments = (fileList) => {
    const incoming = Array.from(fileList || []);
    if (incoming.length === 0) return;
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => `${a.name}|${a.size}`));
      const merged = [...prev];
      incoming.forEach((f) => {
        const key = `${f.name}|${f.size}`;
        if (!seen.has(key)) {
          merged.push({ file: f, name: f.name, size: f.size, type: f.type || '' });
          seen.add(key);
        }
      });
      return merged;
    });
  };

  const removeAttachment = (idx) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const fmtBytes = (bytes) => {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Cascading warehouse list — depends on the company the user picked,
  // not the company that the BOM template belongs to.
  const { options: warehouses } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}&scope=true` : null,
  );

  // Godowns scoped to the chosen warehouse — used for the Machine Name field.
  // Show the descriptive godown_name (with the code as a fallback for legacy
  // rows that may not have a name set).
  const { options: godowns } = useLookup(
    formData.warehouse ? `/api/godowns/?warehouse=${formData.warehouse}` : null,
    { labelField: 'godown_name', valueField: 'id' },
  );

  // Active templates, narrowed to the user's chosen Company + Warehouse so
  // the BOM Reference dropdown only offers templates that actually belong
  // to the production scope they're working in.
  const activeTemplates = useMemo(() => {
    return (bomTemplates || []).filter((t) => {
      if (t.status !== 'ACTIVE' && t.status !== 'DRAFT') return false;
      if (formData.company && t.company !== formData.company) return false;
      if (formData.warehouse && t.warehouse !== formData.warehouse) return false;
      return true;
    });
  }, [bomTemplates, formData.company, formData.warehouse]);

  const filteredTemplates = useMemo(() => {
    if (!search) return activeTemplates;
    const q = search.toLowerCase();
    return activeTemplates.filter((t) => {
      return [t.template_id, t.template_name, t.finished_product_name, t.finished_product_sku]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [activeTemplates, search]);

  // ── Pull BOM scaffold + populate form ─────────────────────────────────

  const loadFromBOM = async (templateId) => {
    if (!templateId) return;
    setIsFetchingScaffold(true);
    try {
      const params = { bom_template: templateId };
      const res = await apiClient.get('/api/production/work-orders/scaffold-from-bom/', { params });
      const d = res.data;
      setSelectedTemplate(d);
      // ONLY remember bookkeeping needed for the save payload — bom_template,
      // finished_product, template_revision. We DO NOT overwrite Company,
      // Warehouse, Planned Quantity, UOM — the user fills those manually.
      setFormData((prev) => ({
        ...prev,
        bom_template: d.bom_template,
        finished_product: d.finished_product,
        finished_product_name: d.finished_product_name,
        template_revision: d.revision_no,
      }));
      setOutputs((d.output_products || []).map((r) => ({ ...r, _fromBOM: true })));
      setInputs((d.input_products || []).map((r) => ({ ...r, _fromBOM: true })));
      toast.success('BOM Template loaded — Outputs & Inputs filled. Header is yours to enter.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Unable to load BOM Template.');
    } finally {
      setIsFetchingScaffold(false);
    }
  };

  // If the user changes Company/Warehouse to a scope the chosen BOM
  // doesn't belong to, drop the BOM and its scaffolded rows — silently,
  // since the dropdown will already show "no matches" and they can pick
  // a fresh one.
  useEffect(() => {
    if (!selectedTemplate) return;
    const tplCompany = selectedTemplate.company || null;
    const tplWarehouse = selectedTemplate.warehouse || null;
    const mismatch = (
      (formData.company && tplCompany && formData.company !== tplCompany)
      || (formData.warehouse && tplWarehouse && formData.warehouse !== tplWarehouse)
    );
    if (mismatch) {
      setSelectedTemplate(null);
      setFormData((prev) => ({
        ...prev,
        bom_template: '', finished_product: '', finished_product_name: '',
        template_revision: '',
      }));
      setOutputs([]);
      setInputs([]);
    }
  }, [formData.company, formData.warehouse, selectedTemplate]);

  // ── Header field mutations ───────────────────────────────────────────

  const handleHeaderChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      const updated = { ...prev, [name]: value };
      // Process is scoped to (company, warehouse). Reset on either change.
      // Machine Name (Godown) is scoped to warehouse — reset on warehouse change.
      if (name === 'company') {
        updated.warehouse = '';
        updated.process = '';
        updated.process_name_snapshot = '';
        updated.machine_name = '';
      }
      if (name === 'warehouse') {
        updated.process = '';
        updated.process_name_snapshot = '';
        updated.machine_name = '';
      }
      return updated;
    });
  };

  // ── Input/Output row mutations ───────────────────────────────────────

  const updateInput = (idx, patch) => {
    setInputs((prev) => prev.map((row, i) => {
      if (i !== idx) return row;
      return { ...row, ...patch };
    }));
  };

  const removeInput = (idx) => setInputs((prev) => prev.filter((_, i) => i !== idx));
  const removeOutput = (idx) => setOutputs((prev) => prev.filter((_, i) => i !== idx));

  // ── Add empty rows ──────────────────────────────────────────────────

  const newEmptyOutput = () => {
    const defaultPlanned = num(selectedTemplate?.batch_size) || 1;
    return {
      product: '', product_name: '', product_category: '', uom: '',
      planned_output_qty: String(defaultPlanned),
      expected_output_qty: String(defaultPlanned),
      available_stock: '0',
      warehouse: formData.warehouse || '',
      remarks: '',
      _fromBOM: false,
    };
  };
  const newEmptyInput = () => ({
    product: '', product_name: '', product_category: '', uom: '',
    bom_standard_qty: '0', available_stock: '0',
    remarks: '',
    _fromBOM: false,
  });
  const addOutput = () => setOutputs((prev) => [...prev, newEmptyOutput()]);
  const addInput  = () => setInputs((prev) => [...prev, newEmptyInput()]);

  // ── Picking a product on a manual input row ─────────────────────────

  const handleManualInputProductPick = (idx, productId) => {
    const product = productsById[productId];
    if (!product) {
      updateInput(idx, { product: '' });
      return;
    }
    if (productId === formData.finished_product) {
      toast.error('Finished product cannot be used as its own input.');
      return;
    }
    if (inputs.some((r, j) => j !== idx && r.product === productId)) {
      toast.error('That ingredient is already on the input list.');
      return;
    }
    updateInput(idx, {
      product: productId,
      product_name: product.product_name || product.sku_code || '',
      product_category: product.goods_sub_type || '',
      uom: product.uom || '',
    });
  };

  // ── Picking an output product on a manual output row ────────────────
  // If the picked product has its own BOM template, scaffold its inputs
  // and merge them into the input table (deduping by product id).

  const handleManualOutputProductPick = async (idx, productId) => {
    const product = productsById[productId];
    if (!product) {
      setOutputs((prev) => prev.map((r, i) => i === idx ? { ...r, product: '' } : r));
      return;
    }
    if (outputs.some((r, j) => j !== idx && r.product === productId)) {
      toast.error('That product is already on the output list.');
      return;
    }
    // Update the row with the chosen product's master data first.
    setOutputs((prev) => prev.map((r, i) => {
      if (i !== idx) return r;
      const planned = num(r.planned_output_qty) || num(selectedTemplate?.batch_size) || 1;
      return {
        ...r,
        product: productId,
        product_name: product.product_name || product.sku_code || '',
        product_category: product.goods_sub_type || '',
        uom: product.uom || '',
        planned_output_qty: String(planned),
        expected_output_qty: String(planned.toFixed(4)),
      };
    }));

    // Look up an active BOM template for this finished product.
    const matchTpl = (bomTemplates || []).find(
      (t) => t.finished_product === productId
        && (t.status === 'ACTIVE' || t.status === 'DRAFT'),
    );
    if (!matchTpl) {
      toast.success(`Output added. No BOM template found for ${product.product_name}.`);
      return;
    }

    try {
      const res = await apiClient.get('/api/production/work-orders/scaffold-from-bom/', {
        params: { bom_template: matchTpl.id },
      });
      const data = res.data;
      const incoming = (data.input_products || []).map((r) => ({ ...r, _fromBOM: true }));

      // Merge: keep existing inputs, append only those whose product isn't
      // already present. This protects manual edits on shared ingredients.
      setInputs((prev) => {
        const seen = new Set(prev.map((r) => r.product).filter(Boolean));
        const merged = [...prev];
        let added = 0;
        for (const row of incoming) {
          if (!seen.has(row.product)) {
            merged.push(row);
            seen.add(row.product);
            added += 1;
          }
        }
        if (added) {
          toast.success(`Added ${added} ingredient(s) from BOM "${matchTpl.template_name}".`);
        } else {
          toast.success(`No new ingredients to add — all already on the list.`);
        }
        return merged;
      });
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load ingredients from BOM.');
    }
  };

  const updateOutput = (idx, patch) => {
    setOutputs((prev) => prev.map((row, i) => {
      if (i !== idx) return row;
      const updated = { ...row, ...patch };
      // No yield % anymore — expected output equals planned output.
      updated.expected_output_qty = num(updated.planned_output_qty).toFixed(4);
      return updated;
    }));
  };

  // ── Refresh from BOM (re-fetch scaffold for one batch) ───────────────

  const handleRefreshBOM = async () => {
    if (!formData.bom_template) return;
    await loadFromBOM(formData.bom_template);
  };

  const handleClearBOM = async () => {
    if (!(await confirm({ message: 'Clearing the BOM selection will remove all auto-filled inputs and outputs. Continue?', isDangerous: true }))) return;
    setSelectedTemplate(null);
    setFormData((prev) => ({
      ...prev,
      bom_template: '', finished_product: '', finished_product_name: '',
      template_revision: '',
    }));
    setOutputs([]);
    setInputs([]);
  };

  const handleViewBOM = () => {
    if (formData.bom_template) navigate(`/production/bom/${formData.bom_template}`);
  };

  // ── Live stock fetch ────────────────────────────────────────────────
  // Stock columns on both the Output and Input subforms are read-only
  // mirrors of the Inventory Ledger — no manual entry, no chance of
  // operators typing yesterday's number and forgetting. Whenever the
  // warehouse or any line's product changes we re-query the
  // /stock-balance endpoint per line and write the result back into
  // `available_stock`. The fetch keys on `${product}|${warehouse}` so
  // we only re-fetch when one of those actually moves.
  useEffect(() => {
    const wh = formData.warehouse;
    if (!wh) return;
    inputs.forEach((row, idx) => {
      if (!row.product) return;
      apiClient.get('/api/inventory/stock-ledger/stock-balance/', {
        params: { warehouse: wh, product: row.product },
      })
        .then((res) => {
          const balance = res.data?.balance ?? '0';
          setInputs((prev) => prev.map((r, i) => {
            if (i !== idx) return r;
            if (r.product !== row.product) return r; // line changed mid-flight
            return { ...r, available_stock: String(balance) };
          }));
        })
        .catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.warehouse, inputs.map((r) => r.product).join('|')]);

  useEffect(() => {
    const wh = formData.warehouse;
    if (!wh) return;
    outputs.forEach((row, idx) => {
      if (!row.product) return;
      apiClient.get('/api/inventory/stock-ledger/stock-balance/', {
        params: { warehouse: wh, product: row.product },
      })
        .then((res) => {
          const balance = res.data?.balance ?? '0';
          setOutputs((prev) => prev.map((r, i) => {
            if (i !== idx) return r;
            if (r.product !== row.product) return r;
            return { ...r, available_stock: String(balance) };
          }));
        })
        .catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.warehouse, outputs.map((r) => r.product).join('|')]);

  // ── Summary ──────────────────────────────────────────────────────────

  const summary = useMemo(() => {
    let totalStd = 0, totalStock = 0;
    inputs.forEach((row) => {
      totalStd += num(row.bom_standard_qty);
      totalStock += num(row.available_stock);
    });
    return {
      count: inputs.length,
      totalStd, totalStock,
    };
  }, [inputs]);

  // Mass balance: the total input quantity must equal the total output
  // quantity. Compared at 4-decimal precision so tiny float noise doesn't
  // trip it. Drives the Total row's colour and blocks save when off.
  const totalOutputQty = useMemo(
    () => outputs.reduce((s, r) => s + num(r.planned_output_qty), 0),
    [outputs],
  );
  const inputBalanced = Math.round(summary.totalStd * 10000) === Math.round(totalOutputQty * 10000);

  // ── Validation ───────────────────────────────────────────────────────

  const validate = () => {
    if (!formData.bom_template) return 'BOM Reference is required.';
    if (!formData.company) return 'Company is required.';
    if (!formData.warehouse) return 'Warehouse is required.';
    if (!formData.process) return 'Process Name is required.';
    if (!formData.production_date) return 'Production Date is required.';
    if (!formData.finished_product) return 'Finished product is required.';
    // batch_id is auto-generated server-side — no longer a required input.
    if (outputs.length === 0) return 'Output Product is required.';
    if (inputs.length === 0) return 'Input Products are required.';

    const seen = new Set();
    for (let i = 0; i < inputs.length; i += 1) {
      const r = inputs[i];
      if (!r.product) return `Input row ${i + 1}: product is required.`;
      if (seen.has(r.product)) return `Input row ${i + 1}: duplicate input product.`;
      seen.add(r.product);
      if (r.product === formData.finished_product) return `Input row ${i + 1}: finished product cannot be its own input.`;
      if (num(r.bom_standard_qty) <= 0) return `Input row ${i + 1}: std qty must be greater than zero.`;
    }

    // Mass balance — total input qty must equal total output qty.
    const totalInput = inputs.reduce((s, r) => s + num(r.bom_standard_qty), 0);
    const totalOutput = outputs.reduce((s, r) => s + num(r.planned_output_qty), 0);
    if (Math.round(totalInput * 10000) !== Math.round(totalOutput * 10000)) {
      return `Input total (${fmtQty(totalInput)}) must equal the Output quantity (${fmtQty(totalOutput)}). Adjust the quantities so they balance before saving.`;
    }
    return null;
  };

  // ── Submit ───────────────────────────────────────────────────────────

  const handleSubmit = async (e) => {
    e.preventDefault();
    const err = validate();
    if (err) { toast.error(err); return; }

    setIsSaving(true);
    try {
      const payload = {
        bom_template: formData.bom_template,
        company: formData.company || null,
        warehouse: formData.warehouse,
        process: formData.process,
        process_name_snapshot: formData.process_name_snapshot || '',
        finished_product: formData.finished_product,
        date: formData.date || null,
        production_date: formData.production_date || null,
        machine_name: formData.machine_name || null,
        // Leave blank to let the server auto-generate BATCH-NNNN per company.
        batch_id: '',
        // Leave blank to let the server auto-generate WO-NNNN per company.
        work_order_no: (formData.work_order_no || '').trim(),
        template_revision: Number(formData.template_revision) || 1,
        linked_sales_order: formData.linked_sales_order || null,
        wage_method: formData.wage_method || 'TEMPLATE_RATE',
        notes: formData.notes || '',
        output_products: outputs.map((r) => ({
          product: r.product,
          uom: r.uom || '',
          planned_output_qty: num(r.planned_output_qty),
          expected_output_qty: num(r.expected_output_qty),
          available_stock: num(r.available_stock),
          warehouse: r.warehouse || null,
          remarks: r.remarks || '',
        })),
        input_products: inputs.map((r) => ({
          product: r.product,
          uom: r.uom || '',
          bom_standard_qty: num(r.bom_standard_qty),
          available_stock: num(r.available_stock),
          issue_warehouse: r.issue_warehouse || formData.warehouse,
          remarks: r.remarks || '',
        })),
      };
      const res = await apiClient.post('/api/production/work-orders/', payload);
      const newWoId = res.data?.id;

      // Upload any staged attachments. Failures don't roll back the WO —
      // the WO is already saved; we surface a warning so the user can retry
      // from the detail page.
      if (newWoId && attachments.length > 0) {
        const failed = [];
        for (const a of attachments) {
          try {
            const fd = new FormData();
            fd.append('module', 'WORK_ORDER');
            fd.append('record_id', newWoId);
            fd.append('file', a.file, a.name);
            await apiClient.post('/api/production/attachments/', fd, {
              headers: { 'Content-Type': 'multipart/form-data' },
            });
          } catch {
            failed.push(a.name);
          }
        }
        if (failed.length > 0) {
          toast.error(`Uploaded with ${failed.length} attachment(s) failing: ${failed.join(', ')}`);
        }
      }

      toast.success('Work Order created successfully.');
      navigate('/production/work-orders');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Unable to create Work Order.');
    } finally {
      setIsSaving(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────

  const tplOption = activeTemplates.find((t) => t.id === formData.bom_template);

  return (
    <MainLayout>
      <PageHeader
        title="Create Work Order"
        subtitle="Pick a BOM Template — the rest of the form scaffolds itself"
        breadcrumbs={[
          { label: 'Production', href: '/production' },
          { label: 'Work Orders', href: '/production/work-orders' },
          { label: 'New' },
        ]}
      />

      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
        {/* ── Work Order Scope (Company / Warehouse / Process Name) ──── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Work Order Details</h3>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {!isHidden('company') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company *</label>
              <CustomSelect name="company" value={formData.company} onChange={handleHeaderChange}
                disabled={isReadOnly('company')}
                className={isReadOnly('company') ? lockedInputClass : inputClass} required>
                <option value="">Select Company...</option>
                {companyOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('warehouse') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse *</label>
              <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleHeaderChange}
                disabled={!formData.company || isReadOnly('warehouse')}
                className={`${isReadOnly('warehouse') ? lockedInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`} required>
                <option value="">{formData.company ? 'Select Warehouse...' : 'Select company first...'}</option>
                {warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('process') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Process Name *</label>
              <CustomSelect
                name="process"
                value={formData.process}
                onChange={(e) => {
                  const opt = processOptions.find((o) => String(o.value) === String(e.target.value));
                  handleProcessChange(e.target.value, opt);
                }}
                disabled={!formData.warehouse || isReadOnly('process')}
                required
                className={`${isReadOnly('process') ? lockedInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}
              >
                <option value="">
                  {!formData.warehouse
                    ? 'Select warehouse first...'
                    : loadingProcesses
                      ? 'Loading processes...'
                      : processOptions.length === 0
                        ? 'No active processes for this warehouse'
                        : 'Select a process...'}
                </option>
                {processOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </CustomSelect>
              {(!formData.warehouse) ? (
                <p className="mt-1 text-xs text-slate-500">
                  Pick a Warehouse to load its processes.
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">
                  Don't see your process?{' '}
                  <Link
                    to="/production/processes/new"
                    className="text-primary-600 hover:underline font-medium"
                  >
                    Add one in Process Master
                  </Link>
                </p>
              )}
            </div>
            )}
            {!isHidden('date') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Date</label>
              <CustomDatePicker name="date" value={formData.date} disabled={isReadOnly('date')}
                onChange={handleHeaderChange} className={isReadOnly('date') ? lockedInputClass : inputClass} />
            </div>
            )}
            {!isHidden('production_date') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Production Date *</label>
              <CustomDatePicker name="production_date" value={formData.production_date} disabled={isReadOnly('production_date')}
                onChange={handleHeaderChange} className={isReadOnly('production_date') ? lockedInputClass : inputClass} required />
            </div>
            )}
            {!isHidden('machine_name') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Machine Name</label>
              <CustomSelect name="machine_name" value={formData.machine_name}
                onChange={handleHeaderChange}
                disabled={!formData.warehouse || isReadOnly('machine_name')}
                className={`${isReadOnly('machine_name') ? lockedInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                <option value="">{formData.warehouse ? 'Select Machine...' : 'Select warehouse first...'}</option>
                {godowns.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </CustomSelect>
            </div>
            )}
          </div>
        </div>

        {/* ── BOM Reference (driver) ─────────────────────────────────── */}
        <div className="rounded-lg border-2 border-primary-300 bg-gradient-to-br from-primary-50 to-white p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-3">
            <Layers size={18} className="text-primary-700" />
            <h3 className="text-lg font-semibold text-primary-900">BOM Reference</h3>
            <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full">main driver</span>
          </div>

          <div className="relative">
            <input
              type="text"
              value={tplOption ? `${tplOption.template_name} — ${tplOption.template_id} — Rev ${tplOption.revision_no}` : search}
              onChange={(e) => { setSearch(e.target.value); setShowDropdown(true); }}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
              placeholder={
                loadingBoms ? 'Loading templates…'
                  : (!formData.company && !formData.warehouse)
                    ? 'Pick Company / Warehouse first to filter templates, or type to search…'
                    : 'Search by template name, ID or finished product…'
              }
              className={`${inputClass} bg-white text-base font-medium`}
            />
            {showDropdown && !tplOption && (
              <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-auto z-20">
                {filteredTemplates.length > 0 ? filteredTemplates.slice(0, 30).map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSearch('');
                      setShowDropdown(false);
                      loadFromBOM(t.id);
                    }}
                    className="block w-full text-left px-3 py-2 hover:bg-primary-50 border-b border-slate-100 last:border-b-0"
                  >
                    <div className="text-sm font-medium text-slate-800">
                      {t.template_name} <span className="text-slate-400">— {t.template_id}</span>
                    </div>
                    <div className="text-xs text-slate-500">
                      {t.finished_product_name || t.finished_product_sku} · Rev {t.revision_no} · {t.status}
                    </div>
                  </button>
                )) : (
                  <div className="px-3 py-3 text-sm text-slate-500">
                    {(formData.company || formData.warehouse)
                      ? 'No active BOM templates match the chosen Company / Warehouse.'
                      : 'No active BOM templates available.'}
                  </div>
                )}
              </div>
            )}
          </div>
          {(formData.company || formData.warehouse) && (
            <p className="mt-1 text-xs text-primary-700">
              Showing only templates for the selected
              {formData.company && ' Company'}{formData.company && formData.warehouse && ' &'}
              {formData.warehouse && ' Warehouse'}.
            </p>
          )}

          {/* Selected template chips + actions */}
          {selectedTemplate && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="px-2 py-0.5 bg-violet-100 text-violet-700 rounded font-mono text-xs">{selectedTemplate.bom_template_code}</span>
              <span className="text-slate-700"><strong>{selectedTemplate.bom_template_name}</strong></span>
              <span className="text-slate-500">→ Finished: <strong>{selectedTemplate.finished_product_name}</strong></span>
              <span className="text-slate-500">Batch: {fmtQty(selectedTemplate.batch_size)}</span>
              <span className="text-slate-500">Rev v{selectedTemplate.revision_no}</span>
              <div className="ml-auto flex gap-2">
                <button type="button" onClick={handleViewBOM} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800">
                  <ExternalLink size={12} /> View
                </button>
                <button type="button" onClick={handleRefreshBOM} disabled={isFetchingScaffold} className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-800 disabled:opacity-50">
                  <RefreshCcw size={12} /> Refresh
                </button>
                <button type="button" onClick={handleClearBOM} className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-800">
                  <XCircle size={12} /> Clear
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Production Plan (batch / wage / remarks) ────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Production Plan</h3>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Batch ID</label>
              <input
                type="text"
                name="batch_id"
                value={previewBatchId}
                readOnly
                className={`${inputClass} bg-slate-50 text-slate-700 cursor-not-allowed font-mono`}
                placeholder={formData.company ? '…' : 'Select Company first'}
              />
              <p className="mt-1 text-xs text-slate-500">
                Preview — final batch is assigned by the server on save.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Work Order No</label>
              <input
                type="text"
                name="work_order_no"
                value={previewWoNo}
                readOnly
                className={`${inputClass} bg-slate-50 text-slate-700 cursor-not-allowed font-mono`}
                placeholder={formData.company ? '…' : 'Select Company first'}
              />
              <p className="mt-1 text-xs text-slate-500">
                Preview — final number is assigned by the server on save.
              </p>
            </div>
            {!isHidden('wage_method') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Wage Method</label>
              <CustomSelect name="wage_method" value={formData.wage_method} onChange={handleHeaderChange}
                disabled={isReadOnly('wage_method')}
                className={isReadOnly('wage_method') ? lockedInputClass : inputClass}>
                {WAGE_METHOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            )}

            {!isHidden('notes') && (
            <div className="col-span-2 md:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
              <textarea name="notes" value={formData.notes} onChange={handleHeaderChange} rows={2}
                disabled={isReadOnly('notes')}
                className={isReadOnly('notes') ? lockedInputClass : inputClass} />
            </div>
            )}
          </div>
        </div>

        {/* ── Output Product subform ─────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-4 pb-2 border-b">
            <Package size={18} className="text-emerald-600" />
            <h3 className="text-lg font-semibold text-slate-800">Output Product</h3>
            <span className="text-xs text-slate-400">{outputs.length} item(s)</span>
            <button
              type="button"
              onClick={addOutput}
              className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg text-sm font-medium hover:bg-emerald-100 border border-emerald-200"
              title="Picking a product with its own BOM Template will auto-load its ingredients into the Input table."
            >
              <Plus size={14} /> Add Output Product
            </button>
          </div>

          {outputs.length === 0 ? (
            <p className="text-sm text-slate-400 italic">Pick a BOM Template above, or click <strong>Add Output Product</strong> to start manually.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '900px' }}>
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Category</th>
                    {!isOutHidden('product') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Output Product</th>}
                    {!isOutHidden('uom') && <th className="px-2 py-2 text-left font-semibold text-slate-600">UOM</th>}
                    {!isOutHidden('available_stock') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Stocks Available</th>}
                    {!isOutHidden('planned_output_qty') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Output Qty</th>}
                    {!isOutHidden('expected_output_qty') && <th className="px-2 py-2 text-right font-semibold text-emerald-700">Expected Output</th>}
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Remarks</th>
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {outputs.map((row, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.product_category || ''}
                          onChange={(e) => {
                            const nextCat = e.target.value;
                            // Manual rows clear the picked product because the
                            // dropdown re-filters; BOM rows keep their product
                            // (locked from the BOM template), category just
                            // re-classifies it.
                            const patch = row._fromBOM
                              ? { product_category: nextCat }
                              : { product_category: nextCat, product: '', product_name: '', uom: '' };
                            updateOutput(idx, patch);
                          }}
                          className={inputClass} style={{ minWidth: '140px' }}
                        >
                          <option value="">All Categories</option>
                          {categoryOptions.map((c) => (
                            <option key={c.value} value={c.value}>{c.label}</option>
                          ))}
                        </CustomSelect>
                      </td>
                      {!isOutHidden('product') && (
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.product || ''}
                          onChange={(e) => handleManualOutputProductPick(idx, e.target.value)}
                          disabled={isOutRO('product')}
                          className={isOutRO('product') ? lockedInputClass : inputClass} style={{ minWidth: '200px' }}
                        >
                          <option value="">
                            {row.product_category
                              ? `Select ${PRODUCT_CATEGORY_LABEL[row.product_category] || row.product_category}…`
                              : 'Select Product'}
                          </option>
                          {optionsForRow(row).map((o) => (
                            <option key={o.value} value={o.value}
                              disabled={!o._inactive && (o.value === formData.finished_product || outputs.some((r, j) => j !== idx && r.product === o.value))}>
                              {o.label}
                            </option>
                          ))}
                        </CustomSelect>
                      </td>
                      )}
                      {!isOutHidden('uom') && (
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.uom || ''}
                          onChange={(e) => updateOutput(idx, { uom: e.target.value })}
                          disabled={isOutRO('uom')}
                          className={isOutRO('uom') ? lockedInputClass : inputClass} style={{ minWidth: '90px' }}
                        >
                          <option value="">—</option>
                          {UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </CustomSelect>
                      </td>
                      )}
                      {!isOutHidden('available_stock') && (
                      <td className="px-2 py-2 text-right tabular-nums text-slate-700" style={{ minWidth: '90px' }}>
                        {/* Read-only mirror of the Inventory Ledger — populated by the
                            live stock effect above. Not editable; the operator can't
                            "fix" stock by typing a different number here. */}
                        {fmtQty(row.available_stock || 0)}
                      </td>
                      )}
                      {!isOutHidden('planned_output_qty') && (
                      <td className="px-2 py-2">
                        <input type="number" step="0.0001" min="0" value={row.planned_output_qty}
                          onChange={(e) => updateOutput(idx, { planned_output_qty: e.target.value })}
                          disabled={isOutRO('planned_output_qty')}
                          className={`${isOutRO('planned_output_qty') ? lockedInputClass : inputClass} text-right`} style={{ minWidth: '100px' }} />
                      </td>
                      )}
                      {!isOutHidden('expected_output_qty') && (
                      <td className="px-2 py-2 text-right font-semibold text-emerald-700">{fmtQty(row.expected_output_qty)}</td>
                      )}
                      <td className="px-2 py-2">
                        <input type="text" value={row.remarks || ''}
                          onChange={(e) => updateOutput(idx, { remarks: e.target.value })}
                          className={inputClass} style={{ minWidth: '120px' }} />
                      </td>
                      <td className="px-2 py-2">
                        <button type="button" onClick={() => removeOutput(idx)}
                          disabled={outputs.length <= 1}
                          aria-label="Remove" title="Remove"
                          className="p-1.5 text-red-500 hover:bg-red-50 rounded disabled:opacity-30">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Input Products subform ─────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3 mb-4 pb-2 border-b">
            <FileText size={18} className="text-orange-600" />
            <h3 className="text-lg font-semibold text-slate-800">Input Products / Required Raw Materials</h3>
            <span className="text-xs text-slate-400">{inputs.length} item(s)</span>
            <button type="button" onClick={addInput} className="ml-auto inline-flex items-center gap-1 px-3 py-1 text-xs bg-orange-50 text-orange-700 rounded border border-orange-200 hover:bg-orange-100"
            >
              <Plus size={12} /> Add Input
            </button>
            <button type="button" onClick={handleRefreshBOM}
              disabled={!formData.bom_template || isFetchingScaffold}
              className="inline-flex items-center gap-1 px-3 py-1 text-xs bg-emerald-50 text-emerald-700 rounded border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50"
            >
              <RefreshCcw size={12} /> Refresh from BOM
            </button>
          </div>

          {inputs.length === 0 ? (
            <p className="text-sm text-slate-400 italic">Pick a BOM Template above to auto-load ingredients, or click <strong>Add Input</strong> to add one manually.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '1000px' }}>
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Category</th>
                    {!isInHidden('product') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Input Product</th>}
                    {!isInHidden('uom') && <th className="px-2 py-2 text-left font-semibold text-slate-600">UOM</th>}
                    {!isInHidden('bom_standard_qty') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Input Qty</th>}
                    {!isInHidden('available_stock') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Stock</th>}
                    <th className="px-2 py-2 text-left font-semibold text-slate-600">Remarks</th>
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {inputs.map((row, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.product_category || ''}
                          onChange={(e) => {
                            const nextCat = e.target.value;
                            const patch = row._fromBOM
                              ? { product_category: nextCat }
                              : { product_category: nextCat, product: '', product_name: '', uom: '' };
                            updateInput(idx, patch);
                          }}
                          className={inputClass} style={{ minWidth: '140px' }}
                        >
                          <option value="">All Categories</option>
                          {categoryOptions.map((c) => (
                            <option key={c.value} value={c.value}>{c.label}</option>
                          ))}
                        </CustomSelect>
                      </td>
                      {!isInHidden('product') && (
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.product || ''}
                          onChange={(e) => handleManualInputProductPick(idx, e.target.value)}
                          disabled={isInRO('product')}
                          className={isInRO('product') ? lockedInputClass : inputClass} style={{ minWidth: '200px' }}
                        >
                          <option value="">
                            {row.product_category
                              ? `Select ${PRODUCT_CATEGORY_LABEL[row.product_category] || row.product_category}…`
                              : 'Select Ingredient'}
                          </option>
                          {optionsForRow(row).map((o) => (
                            <option key={o.value} value={o.value}
                              disabled={!o._inactive && (o.value === formData.finished_product || inputs.some((r, j) => j !== idx && r.product === o.value))}>
                              {o.label}
                            </option>
                          ))}
                        </CustomSelect>
                      </td>
                      )}
                      {!isInHidden('uom') && (
                      <td className="px-2 py-2">
                        <CustomSelect
                          value={row.uom || ''}
                          onChange={(e) => updateInput(idx, { uom: e.target.value })}
                          disabled={isInRO('uom')}
                          className={isInRO('uom') ? lockedInputClass : inputClass} style={{ minWidth: '90px' }}
                        >
                          <option value="">—</option>
                          {UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </CustomSelect>
                      </td>
                      )}
                      {!isInHidden('bom_standard_qty') && (
                      <td className="px-2 py-2">
                        <input type="number" step="0.0001" min="0" value={row.bom_standard_qty}
                          onChange={(e) => updateInput(idx, { bom_standard_qty: e.target.value })}
                          disabled={isInRO('bom_standard_qty')}
                          className={`${isInRO('bom_standard_qty') ? lockedInputClass : inputClass} text-right`} style={{ minWidth: '90px' }} />
                      </td>
                      )}
                      {!isInHidden('available_stock') && (
                      <td className="px-2 py-2 text-right tabular-nums text-slate-700" style={{ minWidth: '85px' }}>
                        {/* Read-only mirror of the Inventory Ledger — populated by the
                            live stock effect above. Not editable. */}
                        {fmtQty(row.available_stock || 0)}
                      </td>
                      )}
                      <td className="px-2 py-2">
                        <input type="text" value={row.remarks || ''}
                          onChange={(e) => updateInput(idx, { remarks: e.target.value })}
                          className={inputClass} style={{ minWidth: '120px' }} />
                      </td>
                      <td className="px-2 py-2">
                        <button type="button" onClick={() => removeInput(idx)} aria-label="Remove" title="Remove" className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                    <td className="px-2 py-2 text-right text-slate-600" colSpan={4}>Total Input Qty</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${inputBalanced ? 'text-emerald-700' : 'text-red-600'}`}>
                      {fmtQty(summary.totalStd)}
                    </td>
                    <td className="px-2 py-2 text-xs font-normal" colSpan={3}>
                      {inputBalanced
                        ? <span className="text-emerald-600">✓ matches Output ({fmtQty(totalOutputQty)})</span>
                        : <span className="text-red-600">✗ must equal Output ({fmtQty(totalOutputQty)}) to save</span>}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* ── Attachments ────────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-4 pb-2 border-b">
            <Paperclip size={18} className="text-slate-600" />
            <h3 className="text-lg font-semibold text-slate-800">Attachments</h3>
            <span className="text-xs text-slate-400">{attachments.length} file(s)</span>
            <label
              className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 bg-slate-50 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 border border-slate-200 cursor-pointer"
            >
              <Upload size={14} /> Add Files
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  addAttachments(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </div>

          {attachments.length === 0 ? (
            <p className="text-sm text-slate-400 italic">
              No files attached. Files are uploaded after the Work Order is saved.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {attachments.map((a, idx) => (
                <li key={`${a.name}-${idx}`} className="flex items-center gap-3 py-2 text-sm">
                  <Paperclip size={14} className="text-slate-400 flex-shrink-0" />
                  <span className="flex-1 truncate text-slate-700">{a.name}</span>
                  <span className="text-xs text-slate-400">{fmtBytes(a.size)}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(idx)}
                    className="p-1 text-red-500 hover:bg-red-50 rounded"
                    title="Remove"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Summary cards ──────────────────────────────────────────── */}
        <div className="bg-gradient-to-br from-emerald-50 to-white rounded-lg border border-emerald-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-emerald-800 mb-4 pb-2 border-b border-emerald-200">Stock Summary</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-slate-500 mb-1">Inputs</p>
              <p className="text-lg font-semibold text-slate-800">{summary.count}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Total Std Qty</p>
              <p className="text-lg font-semibold text-slate-800">{fmtQty(summary.totalStd)}</p>
            </div>
          </div>
        </div>

        {/* ── Footer actions ─────────────────────────────────────────── */}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/production/work-orders')}
            className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button type="submit"
            disabled={isSaving || isFetchingScaffold || !formData.bom_template}
            className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
            {isSaving ? 'Saving…' : 'Save Work Order'}
          </button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
