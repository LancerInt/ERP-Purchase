import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Plus, Trash2, Package, FileText, Paperclip, Upload, X,
  Layers, ExternalLink, RefreshCcw, XCircle,
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

const PACKING_STEPS = [
  { value: 'ONLY_FILLING', label: 'Only Filling' },
  { value: 'LABELS', label: 'Labels' },
  { value: 'SLEEVES', label: 'Sleeves' },
  { value: 'LEAFLET', label: 'Leaflet' },
  { value: 'CARTON_BOX', label: 'Carton Box' },
  { value: 'COMPLETED', label: 'Completed' },
];

const UOM_OPTIONS = ['PCS', 'KG', 'LTR', 'MTR', 'SQM', 'CUM', 'BOX', 'PACK', 'MTS'];

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
// Visual treatment for a field locked READ_ONLY by field permissions.
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));
const fmtQty = (v) => num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
// Clean stock display: up to 4 decimals, trailing zeros trimmed
// (48.9999000000000 -> 48.9999, 25.0000 -> 25). '' when empty.
const fmtStock = (v) => {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(4))) : '';
};
const fmtCat = (v) => PRODUCT_CATEGORY_LABEL[v] || v || '-';

export default function CreatePackingProcess() {
  const navigate = useNavigate();
  const { canCreate, canEdit } = usePermissions();
  // The route is reused for both /new (no id) and /:id/edit. When `id`
  // is present we're editing an existing record — load it, then PATCH
  // on save instead of POST.
  const { id: editingId } = useParams();
  const isEditMode = !!editingId;
  // Create mode gates fields on Create; edit mode gates on Edit.
  const editable = isEditMode ? canEdit('Packing Process') : canCreate('Packing Process');
  const { options: companyOptions } = useLookup('/api/companies/');
  const { data: allProducts } = useApiData('/api/products/');
  // BOM templates that drive auto-population of input/output rows.
  const { data: bomTemplates, isLoading: loadingBoms } = useApiData('/api/production/bom-templates/');

  // Field-level permissions for the Packing Process header — hide HIDDEN
  // inputs and lock READ_ONLY ones for the current user's role.
  const { isHidden, isReadOnly } = useFieldPermissions('Packing Process');
  // Line-item field permissions — the Input/Output product tables are
  // their own modules ('Packing Input' / 'Packing Output'), so a hidden
  // column drops both its header cell and the cell in every row.
  const { isHidden: isInHidden, isReadOnly: isInRO } = useFieldPermissions('Packing Input');
  const { isHidden: isOutHidden, isReadOnly: isOutRO } = useFieldPermissions('Packing Output');

  const [isLoadingRecord, setIsLoadingRecord] = useState(isEditMode);

  const [formData, setFormData] = useState({
    company: '',
    warehouse: '',
    process: '',
    process_name_snapshot: '',
    date: new Date().toISOString().slice(0, 10),
    production_date: '',
    batch_no: '',
    packing_steps: [],
    damage_or_process_loss: false,
    remarks: '',
    bom_template: '',
    // Source Work Order — the approved WO whose output (the bulk
    // semi-finished good) is being packed. Selecting one autofills
    // the WO's outputs as Packing inputs and chains in the WO's BOM
    // template so packing materials populate too.
    work_order: '',
    // Multi-WO: combine several approved WOs (same finished product) when one
    // WO's produced qty isn't enough. `work_order` stays the primary (first)
    // for back-compat; `work_orders` holds the full selected set.
    work_orders: [],
    // Header-level required output qty for the whole packing run —
    // completion is gated against this once daily output entries sum up.
    target_output_quantity: '',
    // Wage basis — drives the Packing wage voucher: PACKING_GROUP pays a
    // contractor a single amount; HEAD_COUNT pays per-person wage rows.
    wage_type: 'PACKING_GROUP',
  });

  const [inputs, setInputs] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [isSaving, setIsSaving] = useState(false);

  // BOM Reference state (mirrors the Work Order new page).
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [search, setSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [isFetchingScaffold, setIsFetchingScaffold] = useState(false);

  const { options: warehouses } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}&scope=true` : null,
  );

  // Approved Work Orders at the chosen warehouse — the "Work Order"
  // picker on the header reads from this list. Picking a WO auto-pulls
  // its output products (the bulk semi-finished goods to be packed)
  // into the Packing's Input Products section, and chains the WO's
  // BOM template through the existing loadFromBOM scaffold so packing
  // materials fill in too. Re-fetches whenever the warehouse changes.
  const workOrdersEndpoint = formData.warehouse
    ? `/api/production/work-orders/?warehouse=${formData.warehouse}&approval_status=APPROVED&with_pending=true`
    : null;
  const { data: warehouseWorkOrders } = useApiData(workOrdersEndpoint);

  // Live TOTAL warehouse stock for every product, scoped to the packing
  // warehouse (summed across its godowns) from the inventory ledger. Shown
  // in its own "Warehouse Stock" column — separate from the WO's
  // "Available Stock" (which stays the work-order figure).
  const stockEndpoint = formData.warehouse
    ? `/api/purchase/items/?warehouse=${formData.warehouse}`
    : null;
  const { data: liveStockData } = useApiData(stockEndpoint);
  const liveStockByProduct = useMemo(() => {
    const rows = Array.isArray(liveStockData) ? liveStockData : (liveStockData?.results || []);
    const m = {};
    rows.forEach((it) => {
      if (it && it.item_id != null && it.current_stock !== '' && it.current_stock != null) {
        m[String(it.item_id)] = String(it.current_stock);
      }
    });
    return m;
  }, [liveStockData]);

  const workOrderOptions = useMemo(() => {
    const rows = Array.isArray(warehouseWorkOrders)
      ? warehouseWorkOrders
      : (warehouseWorkOrders?.results || []);
    // Only "pending to pack" rows belong here: hide WOs that are CLOSED
    // (fully packed) and any whose remaining-to-pack qty has hit zero.
    // Keep the currently-selected WO visible even if it just closed, so
    // an in-progress edit doesn't lose its selection.
    return rows
      .filter((wo) => {
        if ((formData.work_orders || []).includes(wo.id)) return true;   // keep the current picks
        if (wo.stage_status === 'CLOSED') return false;   // fully packed
        // When the remaining-to-pack qty is known, require it to be > 0;
        // otherwise fail open so a missing value never hides a live WO.
        if (wo.pending_pack_qty !== null && wo.pending_pack_qty !== undefined) {
          return num(wo.pending_pack_qty) > 0;
        }
        return true;
      })
      .map((wo) => {
        const pending = wo.pending_pack_qty;
        const pendingLabel = (pending !== null && pending !== undefined)
          ? ` · ${fmtQty(pending)} pending`
          : '';
        return {
          value: wo.id,
          label: `${wo.work_order_no || wo.batch_id} — ${wo.finished_product_name || ''}${wo.bom_template_code ? ' (BOM ' + wo.bom_template_code + ')' : ''}${pendingLabel}`,
          bom_template: wo.bom_template || '',
        };
      });
  }, [warehouseWorkOrders, formData.work_orders]);

  // The "Select Process" packing-step checkboxes only apply to the TVP
  // warehouse. We match on the dropdown label (case-insensitive, trimmed)
  // so it works whether the backend exposes the code or the name.
  const isTvpWarehouse = useMemo(() => {
    const w = warehouses.find((w) => w.value === formData.warehouse);
    return String(w?.label || '').trim().toUpperCase() === 'TVP';
  }, [warehouses, formData.warehouse]);

  // Drop any packing steps if the user moves away from TVP — they wouldn't
  // be visible anymore and shouldn't end up in the save payload.
  useEffect(() => {
    if (!isTvpWarehouse && formData.packing_steps.length > 0) {
      setFormData((prev) => ({ ...prev, packing_steps: [] }));
    }
  }, [isTvpWarehouse, formData.packing_steps.length]);

  // Target Output Quantity does not apply to the NKP warehouse — the
  // field is hidden there. Same label-based match as the TVP rule above
  // (covers both NKP warehouses, WARH-01 and WARH-07).
  const isNkpWarehouse = useMemo(() => {
    const w = warehouses.find((w) => w.value === formData.warehouse);
    return String(w?.label || '').trim().toUpperCase() === 'NKP';
  }, [warehouses, formData.warehouse]);

  // Clear any typed target when the user moves to NKP so a stale value
  // never ships in the save payload (0 = "no header target" — completion
  // falls back to the per-output-row checks).
  useEffect(() => {
    if (isNkpWarehouse && formData.target_output_quantity !== '') {
      setFormData((prev) => ({ ...prev, target_output_quantity: '' }));
    }
  }, [isNkpWarehouse, formData.target_output_quantity]);

  // ── Edit mode: load existing record ─────────────────────────────────
  useEffect(() => {
    if (!editingId) return undefined;
    let cancelled = false;
    setIsLoadingRecord(true);
    apiClient.get(`/api/production/packing-processes/${editingId}/`)
      .then((res) => {
        if (cancelled) return;
        const d = res.data || {};
        setFormData({
          company: d.company || '',
          warehouse: d.warehouse || '',
          process: d.process || '',
          process_name_snapshot: d.process_name_snapshot || '',
          date: d.date || new Date().toISOString().slice(0, 10),
          production_date: d.production_date || '',
          batch_no: d.batch_no || '',
          packing_steps: Array.isArray(d.packing_steps) ? d.packing_steps : [],
          damage_or_process_loss: !!d.damage_or_process_loss,
          remarks: d.remarks || '',
          bom_template: '',
          work_order: d.work_order || '',
          work_orders: (d.wo_sources && d.wo_sources.length)
            ? d.wo_sources.map((s) => s.work_order)
            : (d.work_order ? [d.work_order] : []),
          target_output_quantity: d.target_output_quantity != null
            ? String(d.target_output_quantity)
            : '',
          wage_type: d.wage_type || 'PACKING_GROUP',
        });
        setInputs((d.input_products || []).map((r) => ({
          product: r.product || '',
          product_name: r.product_name || '',
          product_category: r.product_category || '',
          uom: r.uom || '',
          stock_available: String(r.stock_available ?? '0'),
          input_qty: String(r.input_qty ?? '0'),
          output_qty: '0',
        })));
        setOutputs((d.output_products || []).map((r) => ({
          product: r.product || '',
          product_name: r.product_name || '',
          product_category: r.product_category || '',
          uom: r.uom || '',
          stock_available: String(r.stock_available ?? '0'),
          input_qty: '0',
          output_qty: String(r.output_qty ?? '0'),
        })));
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(getApiErrorMessage(err) || 'Unable to load Packing Process.');
        navigate('/production/packing-processes');
      })
      .finally(() => { if (!cancelled) setIsLoadingRecord(false); });
    return () => { cancelled = true; };
  }, [editingId, navigate]);

  // Process Master, scoped to WAREHOUSE only — every Active process at
  // the selected warehouse shows regardless of the chosen company.
  const [processList, setProcessList] = useState([]);
  const [loadingProcesses, setLoadingProcesses] = useState(false);

  const fetchProcesses = useCallback(async (warehouseId) => {
    if (!warehouseId) { setProcessList([]); return; }
    setLoadingProcesses(true);
    try {
      const res = await apiClient.get('/api/production/processes/', {
        // Fold by warehouse NAME across companies (company is never part
        // of the filter) — both "NKP" warehouses share their processes.
        params: { warehouse_group: warehouseId, status: 'Active', page_size: 500 },
      });
      setProcessList(res.data?.results || res.data || []);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Unable to load processes.');
    } finally {
      setLoadingProcesses(false);
    }
  }, []);

  useEffect(() => {
    fetchProcesses(formData.warehouse);
  }, [formData.warehouse, fetchProcesses]);

  // Product master indexes for fast lookup + per-row category filter.
  const productOptions = useMemo(() => (
    (allProducts || []).map((p) => ({
      value: p.id,
      label: p.product_name || p.sku_code || p.id,
      category: p.goods_sub_type || '',
      uom: p.uom || '',
    }))
  ), [allProducts]);

  const categoryOptions = useMemo(() => {
    const seen = new Set();
    productOptions.forEach((o) => { if (o.category) seen.add(o.category); });
    return Array.from(seen).sort().map((c) => ({
      value: c,
      label: PRODUCT_CATEGORY_LABEL[c] || c,
    }));
  }, [productOptions]);

  // Product options for a row, category-filtered. If the row references a
  // product not in the active list (e.g. a WO/BOM ingredient that was
  // later soft-deleted — the products endpoint hides inactive rows), keep
  // it visible (flagged "(inactive)") so the value still DISPLAYS instead
  // of blanking. New manual picks still only see active products.
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

  const productsById = useMemo(() => {
    const m = {};
    (allProducts || []).forEach((p) => { m[p.id] = p; });
    return m;
  }, [allProducts]);

  // ── BOM Reference ───────────────────────────────────────────────────

  // Active templates narrowed to the chosen Company + Warehouse, so the
  // dropdown only offers BOMs that belong to the current scope.
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
    return activeTemplates.filter((t) => (
      [t.template_id, t.template_name, t.finished_product_name, t.finished_product_sku]
        .some((v) => String(v || '').toLowerCase().includes(q))
    ));
  }, [activeTemplates, search]);

  const tplOption = selectedTemplate
    ? {
      template_id: selectedTemplate.bom_template_code,
      template_name: selectedTemplate.bom_template_name,
      revision_no: selectedTemplate.revision_no,
    }
    : null;

  // Pulls the BOM scaffold from the WO endpoint and remaps the WO field
  // names (bom_standard_qty / planned_output_qty / available_stock) into
  // packing's row shape (input_qty / output_qty / stock_available).
  const loadFromBOM = async (templateId) => {
    if (!templateId) return;
    setIsFetchingScaffold(true);
    try {
      const res = await apiClient.get('/api/production/work-orders/scaffold-from-bom/', {
        params: { bom_template: templateId },
      });
      const d = res.data || {};
      setSelectedTemplate(d);
      setFormData((prev) => ({
        ...prev,
        bom_template: d.bom_template || templateId,
      }));
      const bomInputRows = (d.input_products || []).map((r) => ({
        product: r.product || '',
        product_name: r.product_name || '',
        product_category: r.product_category || '',
        uom: r.uom || '',
        stock_available: String(r.available_stock || '0'),
        input_qty: String(r.bom_standard_qty || '0'),
        output_qty: '0',
        _fromBOM: true,
      }));
      const bomOutputRows = (d.output_products || []).map((r) => ({
        product: r.product || '',
        product_name: r.product_name || '',
        product_category: r.product_category || '',
        uom: r.uom || '',
        stock_available: String(r.available_stock || '0'),
        input_qty: '0',
        output_qty: String(r.planned_output_qty || r.expected_output_qty || '0'),
        _fromBOM: true,
      }));
      // Preserve rows that came from the Work Order picker and any the
      // operator added manually — only swap out the existing BOM-tagged
      // rows for the new ones. WO rows stay at the top of Inputs so the
      // bulk-being-packed remains the first thing the operator sees.
      setInputs((prev) => {
        const woRows = prev.filter((r) => r._fromWorkOrder);
        const manualRows = prev.filter((r) => !r._fromWorkOrder && !r._fromBOM);
        return [...woRows, ...bomInputRows, ...manualRows];
      });
      setOutputs((prev) => {
        const manualOutRows = prev.filter((r) => !r._fromBOM);
        return [...bomOutputRows, ...manualOutRows];
      });
      toast.success('BOM Template loaded — Inputs & Outputs filled.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Unable to load BOM Template.');
    } finally {
      setIsFetchingScaffold(false);
    }
  };

  const handleRefreshBOM = () => {
    if (selectedTemplate?.bom_template) loadFromBOM(selectedTemplate.bom_template);
  };

  // ── Work Order autofill ─────────────────────────────────────────────
  // Picking a Work Order only pulls in the WO's *output products* (the
  // bulk semi-finished goods production actually made) and adds them as
  // Packing INPUT rows. The BOM picker stays the source of truth for
  // packing materials (inputs) and the packed finished good (outputs);
  // the two flows coexist so the operator can change the WO without
  // touching the BOM, or vice versa. Rows added here are tagged
  // `_fromWorkOrder` so swapping WOs (or clearing one) only affects
  // those rows.
  // Load / combine the selected Work Orders into ONE packing INPUT row.
  // Every picked WO shares the same finished product, so their pending-to-pack
  // quantities SUM into a single "Work Order Stock" figure — the bulk
  // available to pack across the combined orders.
  const loadFromWorkOrders = async (ids) => {
    const list = ids || [];
    if (list.length === 0) {
      setInputs((prev) => prev.filter((r) => !r._fromWorkOrder));
      if (!isNkpWarehouse) setFormData((prev) => ({ ...prev, target_output_quantity: '' }));
      return;
    }
    setIsFetchingScaffold(true);
    try {
      // Remaining-to-pack per WO comes from the picker rows (the list endpoint
      // is called with ?with_pending=true → pending_pack_qty per row).
      const pickerRows = Array.isArray(warehouseWorkOrders)
        ? warehouseWorkOrders
        : (warehouseWorkOrders?.results || []);
      const pendingOf = (id) => {
        const r = pickerRows.find((x) => x.id === id);
        const p = r?.pending_pack_qty;
        return (p !== null && p !== undefined) ? Number(p) : 0;
      };
      const totalPending = list.reduce((s, id) => s + pendingOf(id), 0);

      // Fetch the first WO for the bulk product's id / name / uom.
      const woRes = await apiClient.get(`/api/production/work-orders/${list[0]}/`);
      const wo = woRes.data || {};
      const bulkOp = (wo.output_products || []).find(
        (op) => wo.finished_product && op.product === wo.finished_product
      ) || (wo.output_products || [])[0];
      if (!bulkOp) {
        setInputs((prev) => prev.filter((r) => !r._fromWorkOrder));
        return;
      }
      const bulkRow = {
        product: bulkOp.product || '',
        product_name: bulkOp.product_name || '',
        product_category: bulkOp.product_category || '',
        uom: bulkOp.uom || '',
        // Work Order Stock = combined pending across every picked WO.
        stock_available: String(totalPending),
        input_qty: String(totalPending),
        output_qty: '0',
        _fromWorkOrder: true,
      };
      // Replace any prior WO row; leave BOM / manual rows intact.
      setInputs((prev) => [bulkRow, ...prev.filter((r) => !r._fromWorkOrder)]);
      if (!isNkpWarehouse && totalPending > 0) {
        setFormData((prev) => ({ ...prev, target_output_quantity: String(totalPending) }));
      }
      toast.success(
        list.length > 1
          ? `${list.length} Work Orders combined — Work Order Stock ${totalPending}.`
          : 'Work Order loaded — bulk output added to Inputs.'
      );
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Unable to load Work Orders.');
    } finally {
      setIsFetchingScaffold(false);
    }
  };

  // Toggle a Work Order in/out of the multi-select and reload the combined row.
  const toggleWorkOrder = (id) => {
    const current = formData.work_orders || [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    setFormData((prev) => ({ ...prev, work_orders: next, work_order: next[0] || '' }));
    loadFromWorkOrders(next);
  };

  const handleClearBOM = () => {
    setSelectedTemplate(null);
    setFormData((prev) => ({ ...prev, bom_template: '' }));
    // Drop BOM-scaffolded rows; keep manually-added ones intact.
    setInputs((prev) => prev.filter((r) => !r._fromBOM));
    setOutputs((prev) => prev.filter((r) => !r._fromBOM));
  };

  const handleViewBOM = () => {
    if (selectedTemplate?.bom_template) {
      window.open(`/production/bom-templates/${selectedTemplate.bom_template}`, '_blank');
    }
  };

  // If Company / Warehouse moves to a scope the picked BOM doesn't belong
  // to, drop the BOM + its scaffolded rows so the form doesn't hold a
  // mismatched template.
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
      setFormData((prev) => ({ ...prev, bom_template: '' }));
      setInputs((prev) => prev.filter((r) => !r._fromBOM));
      setOutputs((prev) => prev.filter((r) => !r._fromBOM));
    }
  }, [formData.company, formData.warehouse, selectedTemplate]);

  // ── Header changes ──────────────────────────────────────────────────

  const handleHeaderChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => {
      const next = { ...prev, [name]: type === 'checkbox' ? checked : value };
      if (name === 'company') {
        next.warehouse = '';
        next.process = '';
        next.process_name_snapshot = '';
        next.work_order = '';
        next.work_orders = [];
      }
      if (name === 'warehouse') {
        next.process = '';
        next.process_name_snapshot = '';
        // The WO list is scoped to the warehouse, so a stale WO id
        // from the prior warehouse is no longer valid — clear it and
        // drop any WO-scaffolded inputs at the same time.
        next.work_order = '';
        next.work_orders = [];
      }
      return next;
    });
    if (name === 'warehouse') {
      setInputs((prev) => prev.filter((r) => !r._fromWorkOrder));
    }
  };

  // Work Order selection is now multi-select — see toggleWorkOrder above.

  const handleProcessChange = (e) => {
    const id = e.target.value;
    const proc = processList.find((p) => p.id === id);
    setFormData((prev) => ({
      ...prev,
      process: id,
      process_name_snapshot: proc?.process_name || '',
    }));
  };

  const togglePackingStep = (key) => {
    setFormData((prev) => {
      const has = prev.packing_steps.includes(key);
      return {
        ...prev,
        packing_steps: has
          ? prev.packing_steps.filter((s) => s !== key)
          : [...prev.packing_steps, key],
      };
    });
  };

  // ── Input/Output rows ──────────────────────────────────────────────

  const newEmptyRow = () => ({
    product: '', product_name: '', product_category: '',
    uom: '', stock_available: '0', input_qty: '0', output_qty: '0',
  });

  const updateRow = (which, idx, patch) => {
    const setter = which === 'input' ? setInputs : setOutputs;
    setter((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  };

  const removeRow = (which, idx) => {
    const setter = which === 'input' ? setInputs : setOutputs;
    setter((prev) => prev.filter((_, i) => i !== idx));
  };

  const addInput = () => setInputs((prev) => [...prev, newEmptyRow()]);
  const addOutput = () => setOutputs((prev) => [...prev, newEmptyRow()]);

  // The packed finished-good OUTPUT qty must equal the finished-good INPUT
  // (bulk) qty — you can't pack more/less finished good than you take in.
  // Mirror it live as the input qty is edited; the output field is locked
  // while a finished-good input row exists (see outputQtyLocked below).
  const fgInputQty = useMemo(() => {
    const fg = inputs.find((r) => r.product_category === 'FINISHED_GOOD');
    return fg ? (fg.input_qty ?? '') : null;
  }, [inputs]);
  const hasFgInput = fgInputQty !== null;
  const outputQtyLocked = (row) => row.product_category === 'FINISHED_GOOD' && hasFgInput;

  useEffect(() => {
    if (fgInputQty === null) return;
    setOutputs((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        if (row.product_category === 'FINISHED_GOOD' && String(row.output_qty ?? '') !== String(fgInputQty)) {
          changed = true;
          return { ...row, output_qty: fgInputQty };
        }
        return row;
      });
      return changed ? next : prev;
    });
  }, [fgInputQty]);

  const handleProductPick = (which, idx, productId) => {
    const product = productsById[productId];
    const list = which === 'input' ? inputs : outputs;
    if (!product) {
      updateRow(which, idx, { product: '' });
      return;
    }
    if (list.some((r, j) => j !== idx && r.product === productId)) {
      toast.error('That product is already on the list.');
      return;
    }
    updateRow(which, idx, {
      product: productId,
      product_name: product.product_name || product.sku_code || '',
      product_category: product.goods_sub_type || '',
      uom: product.uom || '',
    });
  };

  // ── Total Packing Material Qty (display-only — server is authoritative) ──
  // Packing material scales with how much is actually OUTPUT, relative to
  // the first input row's planned qty — NOT a raw sum of all input rows
  // (which nonsensically added the semi-finished MTS qty to the bag PCS
  // count). E.g. first input 10 with 350 bags → producing 10 uses all 350;
  // producing 5 uses 175. Formula: packingMaterialQty × (output ÷ firstInput).
  const totalPackingQty = useMemo(() => {
    const firstInputQty = num(inputs[0]?.input_qty);
    const packingQty = inputs
      .filter((r) => r.product_category === 'PACKING_MATERIAL')
      .reduce((acc, r) => acc + num(r.input_qty), 0);
    const totalOutputQty = outputs.reduce((acc, r) => acc + num(r.output_qty), 0);
    if (!firstInputQty) return packingQty;  // avoid /0 — show the entered qty
    return packingQty * (totalOutputQty / firstInputQty);
  }, [inputs, outputs]);

  // ── Attachments ────────────────────────────────────────────────────

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

  // ── Validation + submit ────────────────────────────────────────────

  const validate = () => {
    if (!formData.company) return 'Company is required.';
    if (!formData.warehouse) return 'Warehouse is required.';
    if (!formData.date) return 'Date is required.';
    if (!formData.process) return 'Process is required.';
    if (inputs.length === 0) return 'At least one input product is required.';

    const seenIn = new Set();
    for (let i = 0; i < inputs.length; i += 1) {
      const r = inputs[i];
      if (!r.product) return `Input row ${i + 1}: product is required.`;
      if (seenIn.has(r.product)) return `Input row ${i + 1}: duplicate input product.`;
      seenIn.add(r.product);
      if (num(r.input_qty) <= 0) return `Input row ${i + 1}: input qty must be greater than zero.`;
    }
    const seenOut = new Set();
    for (let i = 0; i < outputs.length; i += 1) {
      const r = outputs[i];
      if (!r.product) return `Output row ${i + 1}: product is required.`;
      if (seenOut.has(r.product)) return `Output row ${i + 1}: duplicate output product.`;
      seenOut.add(r.product);
      if (num(r.output_qty) <= 0) return `Output row ${i + 1}: output qty must be greater than zero.`;
    }
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const err = validate();
    if (err) { toast.error(err); return; }

    setIsSaving(true);
    try {
      // Allocate the combined bulk qty across the picked Work Orders (FIFO by
      // their pending) so each WO's pending-to-pack decrements correctly.
      const woBulkRow = inputs.find((r) => r._fromWorkOrder);
      const woBulkQty = num(woBulkRow?.input_qty) || 0;
      const woPickerRows = Array.isArray(warehouseWorkOrders)
        ? warehouseWorkOrders : (warehouseWorkOrders?.results || []);
      let woRemaining = woBulkQty;
      const wo_sources = [];
      (formData.work_orders || []).forEach((id) => {
        if (woRemaining <= 0) return;
        const r = woPickerRows.find((x) => x.id === id);
        const pending = (r?.pending_pack_qty != null) ? Number(r.pending_pack_qty) : 0;
        const take = Math.min(pending, woRemaining);
        if (take > 0) { wo_sources.push({ work_order: id, quantity: take }); woRemaining -= take; }
      });
      const payload = {
        company: formData.company,
        warehouse: formData.warehouse,
        process: formData.process,
        process_name_snapshot: formData.process_name_snapshot || '',
        work_order: (formData.work_orders && formData.work_orders[0]) || formData.work_order || null,
        wo_sources,
        date: formData.date,
        production_date: formData.production_date || null,
        batch_no: formData.batch_no || '',
        packing_steps: formData.packing_steps,
        damage_or_process_loss: !!formData.damage_or_process_loss,
        remarks: formData.remarks || '',
        target_output_quantity: num(formData.target_output_quantity),
        wage_type: formData.wage_type || 'PACKING_GROUP',
        input_products: inputs.map((r, idx) => ({
          product: r.product,
          product_category: r.product_category || '',
          uom: r.uom || '',
          stock_available: num(r.stock_available),
          input_qty: num(r.input_qty),
          sort_order: idx,
        })),
        output_products: outputs.map((r, idx) => ({
          product: r.product,
          product_category: r.product_category || '',
          uom: r.uom || '',
          stock_available: num(r.stock_available),
          output_qty: num(r.output_qty),
          sort_order: idx,
        })),
      };
      const res = isEditMode
        ? await apiClient.patch(`/api/production/packing-processes/${editingId}/`, payload)
        : await apiClient.post('/api/production/packing-processes/', payload);
      const recordId = res.data?.id || editingId;

      if (recordId && attachments.length > 0) {
        const failed = [];
        for (const a of attachments) {
          try {
            const fd = new FormData();
            fd.append('module', 'PACKING_PROCESS');
            fd.append('record_id', recordId);
            fd.append('file', a.file, a.name);
            await apiClient.post('/api/production/attachments/', fd, {
              headers: { 'Content-Type': 'multipart/form-data' },
            });
          } catch {
            failed.push(a.name);
          }
        }
        if (failed.length > 0) {
          toast.error(`Saved with ${failed.length} attachment(s) failing: ${failed.join(', ')}`);
        }
      }

      toast.success(isEditMode ? 'Packing Process updated successfully.' : 'Packing Process created successfully.');
      navigate('/production/packing-processes');
    } catch (apiErr) {
      toast.error(getApiErrorMessage(apiErr) || (isEditMode ? 'Failed to update Packing Process.' : 'Failed to create Packing Process.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title={isEditMode ? 'Edit Packing Process' : 'New Packing Process'}
        subtitle="Capture a bulk → packed finished good run"
        breadcrumbs={[
          { label: 'Production', href: '/production' },
          { label: 'Packing Process', href: '/production/packing-processes' },
          { label: isEditMode ? 'Edit' : 'New' },
        ]}
      />
      {isLoadingRecord && (
        <div className="text-center py-8 text-slate-500">Loading Packing Process…</div>
      )}

      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Packing Details</h3>
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
            {!isHidden('date') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Date *</label>
              <CustomDatePicker name="date" value={formData.date} disabled={isReadOnly('date')}
                onChange={handleHeaderChange} className={isReadOnly('date') ? lockedInputClass : inputClass} required />
            </div>
            )}
            {!isHidden('production_date') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Packing Date</label>
              <CustomDatePicker name="production_date" value={formData.production_date} disabled={isReadOnly('production_date')}
                onChange={handleHeaderChange} className={isReadOnly('production_date') ? lockedInputClass : inputClass} />
            </div>
            )}
            {!isHidden('process') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Process *</label>
              <CustomSelect name="process" value={formData.process} onChange={handleProcessChange}
                disabled={!formData.warehouse || isReadOnly('process')}
                className={`${isReadOnly('process') ? lockedInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`} required>
                <option value="">
                  {!formData.warehouse ? 'Select warehouse first...'
                    : loadingProcesses ? 'Loading…'
                    : processList.length === 0 ? 'No active processes for this warehouse'
                    : 'Select Process...'}
                </option>
                {processList.map((p) => (
                  <option key={p.id} value={p.id}>{p.process_name}</option>
                ))}
              </CustomSelect>
              {formData.warehouse && (
                <p className="mt-1 text-xs text-slate-500">
                  Don't see your process?{' '}
                  <Link to="/production/processes/new" className="text-primary-600 hover:underline font-medium">
                    Add one in Process Master
                  </Link>
                </p>
              )}
            </div>
            )}
            {!isHidden('batch_no') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Batch No</label>
              <input type="text" name="batch_no" value={formData.batch_no}
                onChange={handleHeaderChange} disabled={isReadOnly('batch_no')}
                className={isReadOnly('batch_no') ? lockedInputClass : inputClass} placeholder="optional" />
            </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Wage Type *</label>
              <CustomSelect name="wage_type" value={formData.wage_type} onChange={handleHeaderChange}
                className={inputClass} required>
                <option value="HEAD_COUNT">Head Count</option>
                <option value="PACKING_GROUP">Packing Group</option>
              </CustomSelect>
              <p className="mt-1 text-xs text-slate-500">
                Head Count → per-person wages on the voucher. Packing Group → a contractor is paid (Contractor required).
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Work Order <span className="text-xs font-normal text-slate-400">(pick one or more — same product)</span>
              </label>
              <div className={`border border-slate-300 rounded-lg max-h-44 overflow-y-auto divide-y divide-slate-100 ${(!formData.warehouse || isFetchingScaffold) ? 'bg-slate-100 opacity-60 pointer-events-none' : 'bg-white'}`}>
                {!formData.warehouse ? (
                  <div className="px-3 py-2 text-sm text-slate-400">Select warehouse first…</div>
                ) : workOrderOptions.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-slate-400">No pending Work Orders</div>
                ) : (
                  workOrderOptions.map((o) => {
                    const checked = (formData.work_orders || []).includes(o.value);
                    return (
                      <label key={o.value}
                        className={`flex items-start gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50 ${checked ? 'bg-primary-50' : ''}`}>
                        <input type="checkbox" checked={checked} disabled={isFetchingScaffold}
                          onChange={() => toggleWorkOrder(o.value)} className="mt-0.5" />
                        <span>{o.label}</span>
                      </label>
                    );
                  })
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {(formData.work_orders || []).length > 1
                  ? `${formData.work_orders.length} Work Orders combined — their pending quantities add up into one Work Order Stock.`
                  : 'Pick one or more Work Orders (same product) to combine their pending output into the packing input.'}
              </p>
            </div>
            {/* Target Output Quantity doesn't apply at NKP — hidden there;
                completion then falls back to the per-output-row checks. */}
            {!isNkpWarehouse && !isHidden('target_output_quantity') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Target Output Quantity
                </label>
                <input
                  type="number" min="0" step="0.0001"
                  name="target_output_quantity"
                  value={formData.target_output_quantity}
                  onChange={handleHeaderChange}
                  placeholder="0.00"
                  disabled={isReadOnly('target_output_quantity')}
                  className={`${isReadOnly('target_output_quantity') ? lockedInputClass : inputClass} text-right`}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Required total output qty for the whole run. Packing can only be marked Completed once daily output entries reach this number.
                </p>
              </div>
            )}
          </div>

          {/* Packing Steps checkboxes — TVP warehouse only. Each selected
              step carries the Target Output Quantity as its target; per-step
              progress is recorded on the packing process page after saving.
              "Completed" stays disabled while any work step is selected
              (nothing can be finished yet at creation time). */}
          {isTvpWarehouse && !isHidden('packing_steps') && (
            <div className="mt-4">
              <label className="block text-sm font-medium text-slate-700 mb-2">Select Process</label>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
                {PACKING_STEPS.map((s) => {
                  const selected = formData.packing_steps.includes(s.value);
                  const target = num(formData.target_output_quantity);
                  const hasWorkStep = formData.packing_steps.some((k) => k !== 'COMPLETED');
                  const stepDisabled = isReadOnly('packing_steps') || (s.value === 'COMPLETED' && hasWorkStep);
                  return (
                    <label
                      key={s.value}
                      title={s.value === 'COMPLETED' && hasWorkStep ? 'Complete every step on the packing process page first' : undefined}
                      className={`flex flex-col gap-1 px-3 py-2 border border-slate-200 rounded-lg ${stepDisabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-slate-50'}`}
                    >
                      <span className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => togglePackingStep(s.value)}
                          disabled={stepDisabled}
                        />
                        <span className="text-sm text-slate-700">{s.label}</span>
                      </span>
                      {selected && s.value !== 'COMPLETED' && target > 0 && (
                        <span className="text-[11px] text-slate-500 pl-6">Target: {target}</span>
                      )}
                    </label>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                Each step's target = the Target Output Quantity. Record per-step progress on the packing process after saving; “Completed” unlocks once every step reaches its target.
              </p>
            </div>
          )}
        </div>

        {/* ── BOM Reference ──────────────────────────────────────────── */}
        <div className="rounded-lg border-2 border-primary-300 bg-gradient-to-br from-primary-50 to-white p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-3">
            <Layers size={18} className="text-primary-700" />
            <h3 className="text-lg font-semibold text-primary-900">BOM Reference</h3>
            <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full">optional</span>
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
              disabled={!!selectedTemplate}
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
          {(formData.company || formData.warehouse) && !selectedTemplate && (
            <p className="mt-1 text-xs text-primary-700">
              Showing only templates for the selected
              {formData.company && ' Company'}{formData.company && formData.warehouse && ' &'}
              {formData.warehouse && ' Warehouse'}.
            </p>
          )}

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

        {/* ── Input Products ─────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-4 pb-2 border-b">
            <FileText size={18} className="text-orange-600" />
            <h3 className="text-lg font-semibold text-slate-800">Input Products</h3>
            <span className="text-xs text-slate-400">{inputs.length} item(s)</span>
            <button type="button" onClick={addInput}
              className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 bg-orange-50 text-orange-700 rounded-lg text-sm font-medium hover:bg-orange-100 border border-orange-200">
              <Plus size={14} /> Add Input
            </button>
          </div>

          {inputs.length === 0 ? (
            <p className="text-sm text-slate-400 italic">Click <strong>Add Input</strong> to add a row.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '900px' }}>
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                    {!isInHidden('product_category') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Product Category</th>}
                    {!isInHidden('product') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Product Name</th>}
                    {!isInHidden('uom') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Unit</th>}
                    <th className="px-2 py-2 text-right font-semibold text-indigo-700">Available Stock</th>
                    {!isInHidden('stock_available') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Work Order Stock</th>}
                    {!isInHidden('input_qty') && <th className="px-2 py-2 text-right font-semibold text-emerald-700">Input Qty</th>}
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {inputs.map((row, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                      {!isInHidden('product_category') && (
                      <td className="px-2 py-2">
                        <CustomSelect value={row.product_category || ''}
                          onChange={(e) => updateRow('input', idx, { product_category: e.target.value, product: '', product_name: '', uom: '' })}
                          disabled={isInRO('product_category')}
                          className={isInRO('product_category') ? lockedInputClass : inputClass} style={{ minWidth: '140px' }}>
                          <option value="">All Categories</option>
                          {categoryOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </CustomSelect>
                      </td>
                      )}
                      {!isInHidden('product') && (
                      <td className="px-2 py-2">
                        <CustomSelect value={row.product || ''}
                          onChange={(e) => handleProductPick('input', idx, e.target.value)}
                          disabled={isInRO('product')}
                          className={isInRO('product') ? lockedInputClass : inputClass} style={{ minWidth: '200px' }}>
                          <option value="">
                            {row.product_category ? `Select ${fmtCat(row.product_category)}…` : 'Select Product'}
                          </option>
                          {optionsForRow(row).map((o) => (
                            <option key={o.value} value={o.value}
                              disabled={!o._inactive && inputs.some((r, j) => j !== idx && r.product === o.value)}>
                              {o.label}
                            </option>
                          ))}
                        </CustomSelect>
                      </td>
                      )}
                      {!isInHidden('uom') && (
                      <td className="px-2 py-2">
                        <CustomSelect value={row.uom || ''}
                          onChange={(e) => updateRow('input', idx, { uom: e.target.value })}
                          disabled={isInRO('uom')}
                          className={isInRO('uom') ? lockedInputClass : inputClass} style={{ minWidth: '90px' }}>
                          <option value="">—</option>
                          {UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </CustomSelect>
                      </td>
                      )}
                      <td className="px-2 py-2">
                        <input type="text"
                          value={fmtStock(liveStockByProduct[String(row.product)])} readOnly disabled
                          title="Available Stock — total for this product in this warehouse (live from the inventory ledger) — read-only"
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-right bg-indigo-50 text-indigo-700 cursor-not-allowed"
                          style={{ minWidth: '90px' }} />
                      </td>
                      {!isInHidden('stock_available') && (
                      <td className="px-2 py-2">
                        <input type="text" value={fmtStock(row.stock_available)} readOnly disabled
                          title="Work Order Stock — quantity produced by the selected Work Order(s) — read-only"
                          className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-right bg-sky-50 cursor-not-allowed ${num(row.stock_available) < 0 ? 'text-red-600 font-semibold' : 'text-sky-700'}`}
                          style={{ minWidth: '90px' }} />
                      </td>
                      )}
                      {!isInHidden('input_qty') && (
                      <td className="px-2 py-2">
                        <input type="number" step="0.0001" min="0" value={row.input_qty}
                          onChange={(e) => updateRow('input', idx, { input_qty: e.target.value })}
                          disabled={isInRO('input_qty')}
                          className={`${isInRO('input_qty') ? lockedInputClass : inputClass} text-right`} style={{ minWidth: '90px' }} />
                      </td>
                      )}
                      <td className="px-2 py-2">
                        <button type="button" onClick={() => removeRow('input', idx)}
                          aria-label="Remove" title="Remove"
                          className="p-1.5 text-red-500 hover:bg-red-50 rounded">
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

        {/* ── Output Products ────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-4 pb-2 border-b">
            <Package size={18} className="text-emerald-600" />
            <h3 className="text-lg font-semibold text-slate-800">Output Products</h3>
            <span className="text-xs text-slate-400">{outputs.length} item(s)</span>
            <button type="button" onClick={addOutput}
              className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg text-sm font-medium hover:bg-emerald-100 border border-emerald-200">
              <Plus size={14} /> Add Output
            </button>
          </div>

          {outputs.length === 0 ? (
            <p className="text-sm text-slate-400 italic">Click <strong>Add Output</strong> to add a row.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '900px' }}>
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                    {!isOutHidden('product_category') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Product Category</th>}
                    {!isOutHidden('product') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Output Product Name</th>}
                    {!isOutHidden('uom') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Unit</th>}
                    <th className="px-2 py-2 text-right font-semibold text-indigo-700">Available Stock</th>
                    {!isOutHidden('stock_available') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Work Order Stock</th>}
                    {!isOutHidden('output_qty') && <th className="px-2 py-2 text-right font-semibold text-emerald-700">Output Qty</th>}
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {outputs.map((row, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                      {!isOutHidden('product_category') && (
                      <td className="px-2 py-2">
                        <CustomSelect value={row.product_category || ''}
                          onChange={(e) => updateRow('output', idx, { product_category: e.target.value, product: '', product_name: '', uom: '' })}
                          disabled={isOutRO('product_category')}
                          className={isOutRO('product_category') ? lockedInputClass : inputClass} style={{ minWidth: '140px' }}>
                          <option value="">All Categories</option>
                          {categoryOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </CustomSelect>
                      </td>
                      )}
                      {!isOutHidden('product') && (
                      <td className="px-2 py-2">
                        <CustomSelect value={row.product || ''}
                          onChange={(e) => handleProductPick('output', idx, e.target.value)}
                          disabled={isOutRO('product')}
                          className={isOutRO('product') ? lockedInputClass : inputClass} style={{ minWidth: '200px' }}>
                          <option value="">
                            {row.product_category ? `Select ${fmtCat(row.product_category)}…` : 'Select Product'}
                          </option>
                          {optionsForRow(row).map((o) => (
                            <option key={o.value} value={o.value}
                              disabled={!o._inactive && outputs.some((r, j) => j !== idx && r.product === o.value)}>
                              {o.label}
                            </option>
                          ))}
                        </CustomSelect>
                      </td>
                      )}
                      {!isOutHidden('uom') && (
                      <td className="px-2 py-2">
                        <CustomSelect value={row.uom || ''}
                          onChange={(e) => updateRow('output', idx, { uom: e.target.value })}
                          disabled={isOutRO('uom')}
                          className={isOutRO('uom') ? lockedInputClass : inputClass} style={{ minWidth: '90px' }}>
                          <option value="">—</option>
                          {UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </CustomSelect>
                      </td>
                      )}
                      <td className="px-2 py-2">
                        <input type="text"
                          value={fmtStock(liveStockByProduct[String(row.product)])} readOnly disabled
                          title="Available Stock — total for this product in this warehouse (live from the inventory ledger) — read-only"
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-right bg-indigo-50 text-indigo-700 cursor-not-allowed"
                          style={{ minWidth: '90px' }} />
                      </td>
                      {!isOutHidden('stock_available') && (
                      <td className="px-2 py-2">
                        <input type="text" value={fmtStock(row.stock_available)} readOnly disabled
                          title="Work Order Stock — quantity produced by the selected Work Order(s) — read-only"
                          className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-right bg-sky-50 cursor-not-allowed ${num(row.stock_available) < 0 ? 'text-red-600 font-semibold' : 'text-sky-700'}`}
                          style={{ minWidth: '90px' }} />
                      </td>
                      )}
                      {!isOutHidden('output_qty') && (
                      <td className="px-2 py-2">
                        <input type="number" step="0.0001" min="0" value={row.output_qty}
                          onChange={(e) => updateRow('output', idx, { output_qty: e.target.value })}
                          disabled={isOutRO('output_qty') || outputQtyLocked(row)}
                          title={outputQtyLocked(row) ? 'Auto-filled from the finished-good input qty' : undefined}
                          className={`${(isOutRO('output_qty') || outputQtyLocked(row)) ? lockedInputClass : inputClass} text-right`} style={{ minWidth: '90px' }} />
                      </td>
                      )}
                      <td className="px-2 py-2">
                        <button type="button" onClick={() => removeRow('output', idx)}
                          aria-label="Remove" title="Remove"
                          className="p-1.5 text-red-500 hover:bg-red-50 rounded">
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

        {/* ── Footer fields ──────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Notes</h3>
          <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
            {!isHidden('damage_or_process_loss') && (
            <div className="col-span-2 md:col-span-2">
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" name="damage_or_process_loss"
                  checked={formData.damage_or_process_loss} onChange={handleHeaderChange}
                  disabled={isReadOnly('damage_or_process_loss')} />
                Damage or Process Loss
              </label>
            </div>
            )}
            {!isHidden('remarks') && (
            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
              <textarea name="remarks" value={formData.remarks}
                onChange={handleHeaderChange} rows={3} disabled={isReadOnly('remarks')}
                className={isReadOnly('remarks') ? lockedInputClass : inputClass} />
            </div>
            )}
            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Total Packing Material Qty</label>
              <input type="text" value={fmtQty(totalPackingQty)} readOnly
                className={`${inputClass} bg-slate-50 text-slate-700`} />
              <p className="mt-1 text-xs text-slate-500">Packing material scaled to output — packing qty × (output ÷ first input qty).</p>
            </div>
          </div>
        </div>

        {/* ── Attachments ───────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-4 pb-2 border-b">
            <Paperclip size={18} className="text-slate-600" />
            <h3 className="text-lg font-semibold text-slate-800">Attachments</h3>
            <span className="text-xs text-slate-400">{attachments.length} file(s)</span>
            <label className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 bg-slate-50 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 border border-slate-200 cursor-pointer">
              <Upload size={14} /> Add Files
              <input type="file" multiple className="hidden"
                onChange={(e) => { addAttachments(e.target.files); e.target.value = ''; }} />
            </label>
          </div>

          {attachments.length === 0 ? (
            <p className="text-sm text-slate-400 italic">
              No files attached. Files are uploaded after the Packing Process is saved.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {attachments.map((a, idx) => (
                <li key={`${a.name}-${idx}`} className="flex items-center gap-3 py-2 text-sm">
                  <Paperclip size={14} className="text-slate-400 flex-shrink-0" />
                  <span className="flex-1 truncate text-slate-700">{a.name}</span>
                  <span className="text-xs text-slate-400">{fmtBytes(a.size)}</span>
                  <button type="button" onClick={() => removeAttachment(idx)}
                    aria-label="Remove attachment"
                    className="p-1 text-red-500 hover:bg-red-50 rounded" title="Remove">
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Footer actions ──────────────────────────────────────────── */}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => navigate('/production/packing-processes')}
            className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button type="submit" disabled={isSaving}
            className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
            {isSaving
              ? 'Saving…'
              : isEditMode ? 'Update Packing Process' : 'Save Packing Process'}
          </button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
