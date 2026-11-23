import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import EditGate from '../../../components/common/EditGate.jsx';
import useLookup, { clearLookupCache } from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { UOM_OPTIONS, UOM_VALUES } from '../../../constants/uom.js';
import FileAttachments, { uploadPendingFiles } from '@/pages/sales/components/FileAttachments';

// Master-attachment endpoint powering product reference images (shared
// generic module + record_id backend at /api/product-attachments/).
const PRODUCT_ATTACH_URL = '/api/product-attachments/';

// Remembers the last-saved product's stocking location so the next New
// Product can reuse it in one click (adding many machine spares under the
// same Company / Warehouse / Godown / Division without re-picking each).
const LAST_CTX_KEY = 'last_product_location';

export default function CreateProduct() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEditMode = !!id;
  const { canCreate, canEdit } = usePermissions();
  // Create mode gates fields on Create; edit mode gates on Edit.
  const editable = isEditMode ? canEdit('Product') : canCreate('Product');
  const { options: templates } = useLookup('/api/templates/');
  const { raw: vendorList, isLoading: vendorsLoading } = useLookup('/api/vendors/');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [selectedVendors, setSelectedVendors] = useState([]);
  // Goods can be stocked in multiple warehouses (multi-select). The first
  // picked is sent as the primary `warehouse` FK for backward compat.
  const [selectedWarehouses, setSelectedWarehouses] = useState([]);
  const [vendorDropdownOpen, setVendorDropdownOpen] = useState(false);
  const [vendorSearch, setVendorSearch] = useState('');
  // Reference images / documents. In create mode they're held here and
  // uploaded once the product exists (needs its id); in edit mode the
  // component uploads straight away against the product id.
  const [pendingAttachments, setPendingAttachments] = useState([]);
  // Bumped after "Save & Add Another" to remount FileAttachments so its
  // internal staged-files list resets (they belong to the product just saved).
  const [attachKey, setAttachKey] = useState(0);

  const toggleVendor = (vendorId) => {
    setSelectedVendors(prev =>
      prev.includes(vendorId) ? prev.filter(id => id !== vendorId) : [...prev, vendorId]
    );
  };

  const removeVendor = (vendorId) => {
    setSelectedVendors(prev => prev.filter(id => id !== vendorId));
  };

  const filteredVendors = vendorList.filter(v => {
    const name = (v.vendor_name || v.name || '').toLowerCase();
    const code = (v.vendor_code || '').toLowerCase();
    return name.includes(vendorSearch.toLowerCase()) || code.includes(vendorSearch.toLowerCase());
  });
  const [formData, setFormData] = useState({
    sku_code: '',
    product_name: '',
    product_type: 'GOODS',
    goods_sub_type: '',
    service_sub_type: '',
    description: '',
    batch_tracking_required: false,
    sg_applicable: false,
    specific_gravity: '',
    // Pack size: bulk-per-pack for packed SKUs. Drives the packing
    // entry auto-fill (100 bags × pack_size_kg = expected bulk kg).
    // Leave 0/empty for bulk products, raw materials, or packaging
    // (labels / liners auto-fill 1:1 with output count instead).
    pack_size_kg: '',
    pack_size_ltr: '',
    shelf_life_days: '',
    qc_responsibility: '',
    qc_template: '',
    uom: 'KG',
    gst_percentage: '',
    conversion_notes: '',
    yield_tracking_required: false,
    active_flag: true,
    company: '',     company_name: '',
    warehouse: '',   warehouse_name: '',
    godown: '',      godown_name: '',
    division: '',    division_name: '',
    // Finished-good-only fields (visible only when goods_sub_type === 'FINISHED_GOOD').
    finished_good_customer: '',
    product_trade_name: '',
    // Per-customer trade names: [{ customer, trade_name }] — the same product
    // sold to different customers under different names, matched by the
    // Customer-PO auto-extractor.
    customer_names: [],
    // MACHINERY only: the machine base (e.g. "BU-001") the auto SKU hangs off
    // (<base>/<part>). Write-only — never stored on the product itself.
    machine_base: '',
    // PACKING_MATERIAL only: the plant series (e.g. "SSB-002") the auto SKU
    // continues (<series>-PACK-###). Write-only.
    pack_base: '',
  });
  const { options: customerOptions } = useLookup(formData.company ? `/api/customers/?company=${formData.company}` : null); // customers scoped to the selected company

  // "Continue from last product" — load the stashed location context on a
  // fresh Create so we can offer to reuse it.
  const [lastCtx, setLastCtx] = useState(null);
  useEffect(() => {
    if (id) return; // edit mode — never offer
    try {
      const raw = localStorage.getItem(LAST_CTX_KEY);
      if (raw) setLastCtx(JSON.parse(raw));
    } catch { /* ignore malformed / disabled storage */ }
  }, [id]);

  const isMachinery = formData.product_type === 'MACHINERY';
  const isService   = formData.product_type === 'SERVICES';
  const isGoods     = formData.product_type === 'GOODS';
  // Services and Machinery share the same Company / Warehouse / Godown
  // / Division layout — collapse them into one flag for the markup.
  const hasMachineryLayout = isMachinery || isService;
  const { options: companyOptions } = useLookup('/api/companies/');
  // Goods uses a flat warehouse picker (no Company cascade) since a
  // packing material can ship out of any warehouse regardless of which
  // company owns it. Machinery and Services keep the cascading
  // company → warehouse flow they need for their Location sections.
  const goodsWarehouseEndpoint = isGoods ? '/api/warehouses/' : null;
  const cascadedWarehouseEndpoint = (!isGoods && formData.company)
    ? `/api/warehouses/?company=${formData.company}` : null;
  const { options: cascadedWarehouseOptions } = useLookup(cascadedWarehouseEndpoint);
  const { options: goodsWarehouseOptionsRaw } = useLookup(goodsWarehouseEndpoint);
  // Dedupe warehouse list by NAME for the Goods picker so the operator
  // sees one "NKP" instead of one row per owning company. Keeps the
  // first occurrence so the FK lookup still resolves cleanly.
  const goodsWarehouseOptions = useMemo(() => {
    const seen = new Set();
    return (goodsWarehouseOptionsRaw || []).filter((o) => {
      const key = (o.label || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
  }, [goodsWarehouseOptionsRaw]);
  const warehouseOptions = isGoods ? goodsWarehouseOptions : cascadedWarehouseOptions;
  const { options: godownOptions } = useLookup(
    formData.warehouse ? `/api/godowns/?warehouse=${formData.warehouse}` : null
  );
  // Division dropdown — pulls from the MachineryDivision master, scoped to the
  // chosen GODOWN (every division is pinned to a godown), so the operator only
  // sees the divisions that belong under the picked godown.
  const { options: divisionOptions } = useLookup(
    hasMachineryLayout && formData.godown ? `/api/machinery-divisions/?godown=${formData.godown}` : null
  );

  // ── Auto SKU generation ───────────────────────────────────────────
  // On a NEW product the SKU code is system-assigned, continuing the
  // running number of its category: goods sub-types with an established
  // prefix (RMNM/PCKNM/FMNM/SMNM), services (SRV), or a machine base
  // (<base>/<part>). The other goods sub-types (traded/capital/spares/
  // consumables) have no scheme, so the code stays hand-entered. Edit
  // mode never regenerates — the saved code is authoritative.
  const GOODS_AUTO_SUBTYPES = ['RAW_MATERIAL', 'PACKING_MATERIAL', 'FINISHED_GOOD', 'SEMI_FINISHED'];
  const isPacking = isGoods && formData.goods_sub_type === 'PACKING_MATERIAL';
  const autoCategory = !isEditMode && (
    isService ||
    isMachinery ||
    (isGoods && GOODS_AUTO_SUBTYPES.includes(formData.goods_sub_type))
  );
  // Machinery needs a base and packing needs a series before a code can be
  // previewed; the flat-prefix categories are ready immediately.
  const skuReady = autoCategory
    && (!isMachinery || !!formData.machine_base)
    && (!isPacking || !!formData.pack_base);

  const [skuPreview, setSkuPreview] = useState('');
  const [machineBases, setMachineBases] = useState([]);
  const [packBases, setPackBases] = useState([]);
  const [newBaseMode, setNewBaseMode] = useState(false);   // machinery: typing a new base
  const [newPackMode, setNewPackMode] = useState(false);   // packing: typing a new series

  const loadMachineBases = () => {
    apiClient.get('/api/products/machine-bases/')
      .then(res => setMachineBases(res.data || []))
      .catch(() => setMachineBases([]));
  };
  const loadPackBases = () => {
    apiClient.get('/api/products/pack-bases/')
      .then(res => setPackBases(res.data || []))
      .catch(() => setPackBases([]));
  };
  useEffect(() => {
    if (isEditMode || !isMachinery) return;
    loadMachineBases();
  }, [isMachinery, isEditMode]);
  useEffect(() => {
    if (isEditMode || !isPacking) return;
    loadPackBases();
  }, [isPacking, isEditMode]);
  useEffect(() => { if (!isMachinery) setNewBaseMode(false); }, [isMachinery]);
  useEffect(() => { if (!isPacking) setNewPackMode(false); }, [isPacking]);

  // Live preview of the code that will be assigned on save.
  useEffect(() => {
    if (!skuReady) { setSkuPreview(''); return; }
    const params = new URLSearchParams({ product_type: formData.product_type });
    if (formData.goods_sub_type) params.set('goods_sub_type', formData.goods_sub_type);
    if (formData.machine_base) params.set('machine_base', formData.machine_base);
    if (formData.pack_base) params.set('pack_base', formData.pack_base);
    let cancelled = false;
    apiClient.get(`/api/products/next-sku/?${params.toString()}`)
      .then(res => { if (!cancelled) setSkuPreview(res.data?.sku || ''); })
      .catch(() => { if (!cancelled) setSkuPreview(''); });
    return () => { cancelled = true; };
  }, [skuReady, formData.product_type, formData.goods_sub_type, formData.machine_base, formData.pack_base]);

  const onMachineBaseChange = (e) => {
    const v = e.target.value;
    if (v === '__new__') { setNewBaseMode(true); setFormData(f => ({ ...f, machine_base: '' })); }
    else { setNewBaseMode(false); setFormData(f => ({ ...f, machine_base: v })); }
  };
  const onPackBaseChange = (e) => {
    const v = e.target.value;
    if (v === '__new__') { setNewPackMode(true); setFormData(f => ({ ...f, pack_base: '' })); }
    else { setNewPackMode(false); setFormData(f => ({ ...f, pack_base: v })); }
  };

  // Load product data in edit mode
  useEffect(() => {
    if (!isEditMode) return;
    setIsLoadingData(true);
    apiClient.get(`/api/products/${id}/`)
      .then(res => {
        const p = res.data;
        setFormData({
          sku_code: p.sku_code || '',
          product_name: p.product_name || '',
          product_type: p.product_type || 'GOODS',
          goods_sub_type: p.goods_sub_type || '',
          service_sub_type: p.service_sub_type || '',
          description: p.description || '',
          batch_tracking_required: p.batch_tracking_required || false,
          sg_applicable: p.sg_applicable || false,
          specific_gravity: p.specific_gravity || '',
          pack_size_kg: p.pack_size_kg || '',
          pack_size_ltr: p.pack_size_ltr || '',
          shelf_life_days: p.shelf_life_days || '',
          qc_responsibility: p.qc_responsibility === 'VENDOR' ? 'SUPPLIER' : (p.qc_responsibility || ''),
          qc_template: p.qc_template || '',
          uom: p.uom || 'KG',
          gst_percentage: p.gst_percentage ?? '',
          conversion_notes: p.conversion_notes || '',
          yield_tracking_required: p.yield_tracking_required || false,
          active_flag: p.active_flag !== undefined ? p.active_flag : (p.is_active !== undefined ? p.is_active : true),
          company:   p.company   || '', company_name:   p.company_name   || '',
          warehouse: p.warehouse || '', warehouse_name: p.warehouse_name || '',
          godown:    p.godown    || '', godown_name:    p.godown_name    || '',
          division:  p.division  || '', division_name:  p.division_name  || '',
          finished_good_customer: p.finished_good_customer || '',
          product_trade_name: p.product_trade_name || '',
          customer_names: (p.customer_names || []).map(cn => ({
            customer: cn.customer || '', trade_name: cn.trade_name || '',
          })),
        });
        // Load preferred vendors
        const vendorIds = (p.preferred_vendors || []).map(v => typeof v === 'object' ? v.id : v);
        setSelectedVendors(vendorIds);
        // Load the full warehouse set (fall back to the single FK for
        // legacy rows that pre-date the multi-select).
        const whIds = (p.warehouses && p.warehouses.length
          ? p.warehouses
          : (p.warehouse ? [p.warehouse] : [])
        ).map(w => typeof w === 'object' ? w.id : w);
        setSelectedWarehouses(whIds);
      })
      .catch(err => {
        toast.error('Failed to load product');
        console.error(err);
      })
      .finally(() => setIsLoadingData(false));
  }, [id, isEditMode]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => {
      const next = { ...prev, [name]: type === 'checkbox' ? checked : value };
      // Cascade clears for the location sub-section.
      if (name === 'company') {
        next.warehouse = '';
        next.godown = '';
        next.division = '';
      } else if (name === 'warehouse') {
        next.godown = '';
        next.division = '';
      } else if (name === 'godown') {
        // Division is scoped to the godown — a division from the previous
        // godown can't belong to the new one.
        next.division = '';
      } else if (name === 'product_type') {
        // Switching product type resets the sub-type + location fields so we
        // don't submit stale data alongside the new type. Machinery is always
        // classified as a spare by default (its Sub Type dropdown offers
        // Machine Spares / Capital Good); Services carry no goods sub-type.
        if (value === 'MACHINERY') {
          next.goods_sub_type = 'MACHINE_SPARES';
          next.finished_good_customer = '';
          next.product_trade_name = '';
        } else if (value !== 'GOODS') {
          next.goods_sub_type = '';
          next.finished_good_customer = '';
          next.product_trade_name = '';
        }
        if (value !== 'SERVICES') next.service_sub_type = '';
        // Company is only meaningful on the cascading-location types
        // (Machinery / Services). Goods uses a flat dedup-by-name
        // warehouse picker with no company gate, so clear company
        // whenever the new type doesn't ask for it.
        if (value !== 'MACHINERY' && value !== 'SERVICES') {
          next.company = '';
        }
        // Godown belongs to Machinery + Services. Goods intentionally
        // has no Godown field, so clear it on Goods too — otherwise a
        // leftover Machinery pick would silently save on a Goods
        // product the operator can't see.
        if (value !== 'MACHINERY' && value !== 'SERVICES') {
          next.godown = '';
        }
        // Division belongs to Machinery + Services. Clear it the
        // moment the type swaps to anything else.
        if (value !== 'MACHINERY' && value !== 'SERVICES') {
          next.division = '';
        }
        // Machine base only applies to Machinery — drop it otherwise so
        // it never rides along on a Goods/Services save.
        if (value !== 'MACHINERY') next.machine_base = '';
        // Packing series only applies to Goods; clear it off any other type.
        if (value !== 'GOODS') next.pack_base = '';
      } else if (name === 'goods_sub_type') {
        // Finished-good-only fields disappear from the form when the
        // sub-type changes to anything else — wipe their values so the
        // server doesn't get stale references on save.
        if (value !== 'FINISHED_GOOD') {
          next.finished_good_customer = '';
          next.product_trade_name = '';
        }
        // Packing series only belongs to Packing Material.
        if (value !== 'PACKING_MATERIAL') next.pack_base = '';
      }
      return next;
    });
  };

  // ── "Continue from last product" helpers ──────────────────────────
  const _nameOf = (opts, val) => (opts || []).find(o => String(o.value) === String(val))?.label || '';

  // Stash the current stocking location after a successful create.
  const rememberContext = () => {
    const ctx = {
      product_type: formData.product_type,
      goods_sub_type: formData.goods_sub_type,
      company:   formData.company,   company_name:   _nameOf(companyOptions, formData.company),
      warehouse: formData.warehouse, warehouse_name: _nameOf(warehouseOptions, formData.warehouse),
      godown:    formData.godown,    godown_name:    _nameOf(godownOptions, formData.godown),
      division:  formData.division,  division_name:  _nameOf(divisionOptions, formData.division),
      // Goods stock in a multi-select warehouse set instead of the cascade.
      goods_warehouses: isGoods ? selectedWarehouses : [],
      goods_warehouse_labels: isGoods
        ? selectedWarehouses.map(w => _nameOf(warehouseOptions, w)).filter(Boolean) : [],
    };
    try { localStorage.setItem(LAST_CTX_KEY, JSON.stringify(ctx)); } catch { /* ignore */ }
  };

  // Apply the offered context to the form (the banner "Use this location").
  const applyLastCtx = () => {
    if (!lastCtx) return;
    setFormData(prev => ({
      ...prev,
      product_type: lastCtx.product_type || prev.product_type,
      goods_sub_type: lastCtx.goods_sub_type ?? prev.goods_sub_type,
      company:   lastCtx.company   || '', company_name:   lastCtx.company_name   || '',
      warehouse: lastCtx.warehouse || '', warehouse_name: lastCtx.warehouse_name || '',
      godown:    lastCtx.godown    || '', godown_name:    lastCtx.godown_name    || '',
      division:  lastCtx.division  || '', division_name:  lastCtx.division_name  || '',
    }));
    if ((lastCtx.goods_warehouses || []).length) setSelectedWarehouses(lastCtx.goods_warehouses);
    setLastCtx(null);
  };

  // After "Save & Add Another": clear the product-specific fields but KEEP
  // the type + stocking location so the operator keeps entering under it.
  const resetForNextProduct = () => {
    setFormData(prev => ({
      ...prev,
      sku_code: '', product_name: '', description: '',
      shelf_life_days: '', gst_percentage: '',
      conversion_notes: '', batch_tracking_required: false, sg_applicable: false, yield_tracking_required: false,
      finished_good_customer: '', product_trade_name: '', customer_names: [],
      // KEPT: product_type, goods_sub_type, uom, company/warehouse/godown/division.
    }));
    setSelectedVendors([]);
    setPendingAttachments([]);
    setAttachKey(k => k + 1);  // remount FileAttachments with an empty staged list
    // selectedWarehouses kept — that's the Goods location we're continuing in.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e, addAnother = false) => {
    e.preventDefault();
    if (autoCategory) {
      if (isMachinery && !formData.machine_base) {
        toast.error('Pick a machine (or add a new one) — the SKU is generated from it.');
        return;
      }
      if (isPacking && !formData.pack_base) {
        toast.error('Pick a packing series (or add a new one) — the SKU is generated from it.');
        return;
      }
    } else if (!formData.sku_code) {
      toast.error('SKU Code is required'); return;
    }
    if (!formData.product_name) { toast.error('Product Name is required'); return; }

    setIsLoading(true);
    try {
      const payload = { ...formData };
      // Fix invalid qc_responsibility value
      if (payload.qc_responsibility === 'VENDOR') payload.qc_responsibility = 'SUPPLIER';
      // System-assigned SKU: send it blank so the server generates the code
      // (race-safe) instead of trusting a stale preview. machine_base /
      // pack_base ride along only for their own category.
      if (autoCategory) delete payload.sku_code;
      if (!isMachinery) delete payload.machine_base;
      if (!isPacking) delete payload.pack_base;
      // Remove empty optional fields
      Object.keys(payload).forEach(k => {
        if (payload[k] === '' || payload[k] === null) delete payload[k];
      });
      // Keep booleans
      payload.batch_tracking_required = formData.batch_tracking_required;
      payload.sg_applicable = formData.sg_applicable;
      payload.yield_tracking_required = formData.yield_tracking_required;
      payload.active_flag = formData.active_flag;

      // Machinery is always classified as a spare (or capital good) — make sure
      // the sub-type rides along even if the delete-empty pass dropped a blank.
      if (isMachinery) payload.goods_sub_type = formData.goods_sub_type || 'MACHINE_SPARES';

      payload.preferred_vendors = selectedVendors;

      // Warehouse set. Goods uses the multi-select; machinery/services keep
      // their single cascade warehouse. The primary `warehouse` FK is the
      // first of the set (kept for stock reports & legacy readers).
      const allWarehouses = isGoods
        ? selectedWarehouses
        : (formData.warehouse ? [formData.warehouse] : []);
      const primaryWarehouse = isGoods ? (selectedWarehouses[0] || '') : (formData.warehouse || '');
      payload.warehouses = allWarehouses;
      if (primaryWarehouse) payload.warehouse = primaryWarehouse;
      else delete payload.warehouse;

      // Per-customer trade names — drop blank rows, coerce empty customer → null.
      payload.customer_names = (formData.customer_names || [])
        .filter(cn => (cn.trade_name || '').trim())
        .map(cn => ({ customer: cn.customer || null, trade_name: cn.trade_name.trim() }));

      if (import.meta.env.DEV) console.log('[Product] payload:', payload);
      if (isEditMode) {
        await apiClient.put(`/api/products/${id}/`, payload);
        // Flush the useLookup module cache — it survives SPA navigation,
        // so purchase/inventory forms opened after this save would still
        // serve the pre-save product catalogue (same fix as the bulk
        // import path in BulkImportModal).
        clearLookupCache();
        toast.success('Product updated successfully!');
        navigate(-1);
      } else {
        const res = await apiClient.post('/api/products/', payload);
        clearLookupCache();
        const newId = res.data?.id;
        // Product exists now — push any reference images the user staged.
        if (newId && pendingAttachments.length > 0) {
          await uploadPendingFiles('PRODUCT', newId, pendingAttachments, PRODUCT_ATTACH_URL);
          setPendingAttachments([]);
        }
        rememberContext();
        if (isMachinery) loadMachineBases();   // a new base is now selectable
        if (isPacking) loadPackBases();        // a new series is now selectable
        if (addAnother) {
          toast.success('Saved — add another in the same location.');
          resetForNextProduct();
        } else {
          toast.success('Product created successfully!');
          navigate(-1);
        }
      }
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateProduct] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass = "w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";

  return (
    <MainLayout>
      {isLoadingData && <div className="text-center py-12 text-slate-500">Loading product data...</div>}
      {!isLoadingData && <>
      <PageHeader
        title={isEditMode ? 'Edit Product' : 'Create Product'}
        subtitle={isEditMode ? 'Update product details' : 'Add a new product or service to your catalog'}
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Products', href: '/masters/products' },
          { label: isEditMode ? 'Edit' : 'Create New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Continue-from-last-product prompt. Shown on a fresh Create when
              a prior product left a stocking location, and only until the
              operator picks a location themselves or dismisses it — so many
              spares can be added under the same Godown/Division in one tap. */}
          {!isEditMode && lastCtx
            && (lastCtx.warehouse || lastCtx.company || (lastCtx.goods_warehouses || []).length)
            && !formData.company && !formData.warehouse && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-primary-50 border border-primary-200 rounded-lg">
              <div className="text-sm text-slate-700 min-w-0">
                <span className="font-semibold">Continue from your last product?</span>{' '}
                <span className="text-slate-600">
                  {[lastCtx.division_name, lastCtx.godown_name, lastCtx.warehouse_name,
                    lastCtx.company_name, ...(lastCtx.goods_warehouse_labels || [])]
                    .filter(Boolean).join(' · ') || 'same stocking location'}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={applyLastCtx}
                  className="px-3 py-1.5 text-xs font-semibold bg-primary-600 text-white rounded hover:bg-primary-700">
                  Use this location
                </button>
                <button type="button" onClick={() => setLastCtx(null)}
                  className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded">
                  Start fresh
                </button>
              </div>
            </div>
          )}
          {/* ── Product Details — top-down and dynamic per type. Machinery &
                Services lead with the identity pickers then the Location
                cascade (Company → Warehouse → Godown → Division) and finally
                the Name; Goods lead with the Sub Type + stocking Warehouses
                then the Name. Fields that don't apply to a type are hidden. */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Product Details</h3>

            {/* Classification row — Type first, then the picker that drives the
                SKU (machine base / goods sub-type / packing series), then the
                assigned SKU / ID. */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Product Type <span className="text-red-500">*</span></label>
                <CustomSelect name="product_type" value={formData.product_type} onChange={handleChange} required className={inputClass}>
                  <option value="GOODS">Goods</option>
                  <option value="SERVICES">Services</option>
                  <option value="MACHINERY">Machinery</option>
                </CustomSelect>
              </div>

              {/* MACHINERY: pick the machine — the auto SKU (<base>/<part>)
                  hangs off it. "New machine…" reveals a text box for a new base. */}
              {isMachinery && !isEditMode && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Machine <span className="text-red-500">*</span></label>
                  <CustomSelect value={newBaseMode ? '__new__' : (formData.machine_base || '')} onChange={onMachineBaseChange} className={inputClass}>
                    <option value="">Select machine...</option>
                    {machineBases.map(b => (
                      <option key={b.base} value={b.base}>
                        {b.base}{b.godown ? ` · ${b.godown}` : ''} ({b.count})
                      </option>
                    ))}
                    <option value="__new__">➕ New machine…</option>
                  </CustomSelect>
                  {newBaseMode && (
                    <input type="text" value={formData.machine_base}
                      onChange={(e) => setFormData(f => ({ ...f, machine_base: e.target.value.toUpperCase().replace(/\s+/g, '') }))}
                      placeholder="New machine base, e.g. BU-002" className={`${inputClass} mt-2`} />
                  )}
                  <p className="text-xs text-slate-400 mt-1">The part number continues this machine's series.</p>
                </div>
              )}

              {/* GOODS: sub type */}
              {isGoods && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Goods Sub Type</label>
                  <CustomSelect name="goods_sub_type" value={formData.goods_sub_type} onChange={handleChange} className={inputClass}>
                    <option value="">Select...</option>
                    <option value="RAW_MATERIAL">Raw Material</option>
                    <option value="PACKING_MATERIAL">Packing Material</option>
                    <option value="FINISHED_GOOD">Finished Good</option>
                    <option value="SEMI_FINISHED">Semi Finished</option>
                    <option value="TRADED_PRODUCTS">Traded Products</option>
                    <option value="CAPITAL_GOOD">Capital Good</option>
                    <option value="MACHINE_SPARES">Machine Spares</option>
                    <option value="CONSUMABLES">Consumables</option>
                  </CustomSelect>
                </div>
              )}

              {/* GOODS: packing series — packing SKUs are plant-scoped
                  (<series>-PACK-###). "New series…" reveals a text box. */}
              {isPacking && !isEditMode && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Packing Series <span className="text-red-500">*</span></label>
                  <CustomSelect value={newPackMode ? '__new__' : (formData.pack_base || '')} onChange={onPackBaseChange} className={inputClass}>
                    <option value="">Select series...</option>
                    {packBases.map(b => (
                      <option key={b.base} value={b.base}>
                        {b.base}{b.company ? ` · ${b.company}` : ''} ({b.count})
                      </option>
                    ))}
                    <option value="__new__">➕ New series…</option>
                  </CustomSelect>
                  {newPackMode && (
                    <input type="text" value={formData.pack_base}
                      onChange={(e) => setFormData(f => ({ ...f, pack_base: e.target.value.toUpperCase().replace(/\s+/g, '') }))}
                      placeholder="New series, e.g. SSB-003" className={`${inputClass} mt-2`} />
                  )}
                  <p className="text-xs text-slate-400 mt-1">The code continues this series' -PACK- number.</p>
                </div>
              )}

              {/* SKU / ID — auto for a scheme category, else hand-entered. */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {isMachinery ? 'Machine ID' : isService ? 'Service Code' : 'SKU Code'} {autoCategory
                    ? <span className="text-xs font-normal text-slate-500">(auto)</span>
                    : <span className="text-red-500">*</span>}
                </label>
                {autoCategory ? (
                  <>
                    <input type="text" readOnly value={
                      skuReady ? (skuPreview || 'Generating…')
                        : (isMachinery ? 'Pick a machine above'
                          : isPacking ? 'Pick a packing series above' : 'Choosing…')}
                      className={`${inputClass} bg-slate-100 text-slate-500 cursor-not-allowed`} />
                    <p className="text-xs text-slate-400 mt-1">
                      Assigned automatically on save, continuing this category's sequence.
                    </p>
                  </>
                ) : (
                  <input type="text" name="sku_code" value={formData.sku_code} onChange={handleChange} className={inputClass} placeholder="e.g., STPL-2MM" />
                )}
              </div>
            </div>

            {/* Location cascade — Machinery & Services: Company → Warehouse →
                Godown → Division, each dependent on the one before it. */}
            {hasMachineryLayout && (
              <div className="mt-5">
                <h4 className="text-sm font-semibold text-slate-600 mb-2">{isMachinery ? 'Machine Location' : 'Service Location'}</h4>
                <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                    <CustomSelect name="company" value={formData.company} onChange={handleChange} required className={inputClass}>
                      <option value="">Select...</option>
                      {formData.company && !companyOptions.find((c) => String(c.value) === String(formData.company)) && (
                        <option value={formData.company}>{formData.company_name || 'Loading…'}</option>
                      )}
                      {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </CustomSelect>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                    <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleChange} required disabled={!formData.company} className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                      <option value="">{formData.company ? 'Select...' : 'Select company first...'}</option>
                      {formData.warehouse && !warehouseOptions.find((w) => String(w.value) === String(formData.warehouse)) && (
                        <option value={formData.warehouse}>{formData.warehouse_name || 'Loading…'}</option>
                      )}
                      {warehouseOptions.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                    </CustomSelect>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Godown</label>
                    <CustomSelect name="godown" value={formData.godown} onChange={handleChange} disabled={!formData.warehouse} className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                      <option value="">{formData.warehouse ? 'Select...' : 'Select warehouse first...'}</option>
                      {formData.godown && !godownOptions.find((g) => String(g.value) === String(formData.godown)) && (
                        <option value={formData.godown}>{formData.godown_name || 'Loading…'}</option>
                      )}
                      {godownOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                    </CustomSelect>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Division</label>
                    <CustomSelect name="division" value={formData.division} onChange={handleChange} disabled={!formData.godown} className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                      <option value="">{formData.godown ? 'Select...' : 'Select godown first...'}</option>
                      {formData.division && !divisionOptions.find((d) => String(d.value) === String(formData.division)) && (
                        <option value={formData.division}>{formData.division_name || 'Loading…'}</option>
                      )}
                      {divisionOptions.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </CustomSelect>
                  </div>
                </div>
              </div>
            )}

            {/* Stocking warehouses — Goods (flat multi-select, no Company gate;
                Godown/Division don't apply to goods). */}
            {isGoods && (
              <div className="mt-5">
                <h4 className="text-sm font-semibold text-slate-600 mb-2">Stocking Warehouses</h4>
                <div className="border border-slate-300 rounded-lg p-2 max-h-44 overflow-y-auto space-y-0.5">
                  {warehouseOptions.length === 0 && (
                    <p className="text-xs text-slate-400 px-1.5 py-1">Loading warehouses…</p>
                  )}
                  {warehouseOptions.map((w) => {
                    const checked = selectedWarehouses.some(id => String(id) === String(w.value));
                    return (
                      <label key={w.value} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelectedWarehouses(prev =>
                            checked ? prev.filter(id => String(id) !== String(w.value)) : [...prev, w.value])}
                          className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                        />
                        <span className="text-sm text-slate-700">{w.label}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {selectedWarehouses.length} selected{selectedWarehouses.length > 0 ? ' — the first is the primary stocking warehouse' : ''}.
                </p>
              </div>
            )}

            {/* Identity — the Name comes AFTER the location so the operator
                drills location → name. Machinery adds its Sub Type here. */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mt-5">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {isMachinery ? 'Machine Name' : isService ? 'Service Name' : 'Product Name'} <span className="text-red-500">*</span>
                </label>
                <input type="text" name="product_name" value={formData.product_name} onChange={handleChange} required className={inputClass} placeholder="Enter name" />
              </div>
              {isMachinery && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Sub Type</label>
                  <CustomSelect name="goods_sub_type" value={formData.goods_sub_type || 'MACHINE_SPARES'} onChange={handleChange} className={inputClass}>
                    <option value="MACHINE_SPARES">Machine Spares</option>
                    <option value="CAPITAL_GOOD">Capital Good</option>
                  </CustomSelect>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">UOM <span className="text-red-500">*</span></label>
                <CustomSelect name="uom" value={formData.uom} onChange={handleChange} required className={inputClass}>
                  {/* Legacy fallback — keep an old saved UOM visible on edit. */}
                  {formData.uom && !UOM_VALUES.includes(formData.uom) && (
                    <option value={formData.uom}>{formData.uom}</option>
                  )}
                  {UOM_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </CustomSelect>
              </div>
              <div className="col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea name="description" value={formData.description} onChange={handleChange} rows={2} className={inputClass} placeholder="Product description" />
              </div>
            </div>

            {/* Finished-good-only fields (Goods → Finished Good). Cleared by
                handleChange when the sub-type moves away, so no stale FK saves. */}
            {formData.product_type === 'GOODS' && formData.goods_sub_type === 'FINISHED_GOOD' && (
              <div className="grid grid-cols-2 md:grid-cols-2 gap-4 p-4 bg-amber-50 border border-amber-200 rounded-lg mt-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Customer Name <span className="text-xs font-normal text-slate-500">(from Customer master)</span>
                  </label>
                  <CustomSelect name="finished_good_customer" value={formData.finished_good_customer} onChange={handleChange} className={inputClass}>
                    <option value="">Select Customer</option>
                    {customerOptions.map(c => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </CustomSelect>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Product Trade Name</label>
                  <input type="text" name="product_trade_name" value={formData.product_trade_name} onChange={handleChange} className={inputClass}
                    placeholder="Trade name the customer markets this product as" />
                </div>
              </div>
            )}

            {/* Per-customer trade names (Goods) — a product sold under many
                brand names; the Customer-PO extractor matches any of these. */}
            {isGoods && (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg mt-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-slate-700">
                    Customer Trade Names
                    <span className="ml-1 text-xs font-normal text-slate-500">(names customers print on their PO — used to auto-match this product on extraction)</span>
                  </label>
                  <button type="button"
                    onClick={() => setFormData(f => ({ ...f, customer_names: [...(f.customer_names || []), { customer: '', trade_name: '' }] }))}
                    className="text-sm text-primary-600 hover:text-primary-800 font-medium">+ Add name</button>
                </div>
                {(formData.customer_names || []).length === 0 && (
                  <p className="text-xs text-slate-400">None yet. Add one so a PO printing a different name still matches this product.</p>
                )}
                {(formData.customer_names || []).map((cn, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2 mb-2 items-center">
                    <CustomSelect value={cn.customer || ''}
                      onChange={(e) => setFormData(f => { const rows = [...f.customer_names]; rows[i] = { ...rows[i], customer: e.target.value }; return { ...f, customer_names: rows }; })}
                      className={inputClass}>
                      <option value="">Any customer</option>
                      {customerOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </CustomSelect>
                    <input type="text" value={cn.trade_name || ''}
                      placeholder="Name on their PO (e.g. SPIC SANGAMAM_40 Kg)"
                      onChange={(e) => setFormData(f => { const rows = [...f.customer_names]; rows[i] = { ...rows[i], trade_name: e.target.value }; return { ...f, customer_names: rows }; })}
                      className={inputClass} />
                    <button type="button" title="Remove"
                      onClick={() => setFormData(f => ({ ...f, customer_names: f.customer_names.filter((_, j) => j !== i) }))}
                      className="px-2 py-1 text-red-500 hover:bg-red-50 rounded">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quality & Tracking */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Quality & Tracking</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">QC Responsibility</label>
                <CustomSelect name="qc_responsibility" value={formData.qc_responsibility} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="SUPPLIER">Supplier</option>
                  <option value="RECEIVER">Receiver</option>
                  <option value="NONE">No QC Required</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">QC Template</label>
                <CustomSelect name="qc_template" value={formData.qc_template} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  {templates.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Shelf Life (Days)</label>
                <input type="number" name="shelf_life_days" value={formData.shelf_life_days} onChange={handleChange} className={inputClass} placeholder="e.g., 365" />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input type="checkbox" name="batch_tracking_required" checked={formData.batch_tracking_required} onChange={handleChange} className="rounded border-slate-300 text-primary-600" />
                <label className="text-sm text-slate-700">Batch Tracking Required</label>
              </div>
            </div>
          </div>

          {/* Units & Conversion */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Units & Conversion</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Specific Gravity applicable</label>
                <div className="flex items-start gap-2 py-2">
                  <input
                    id="sg_applicable_cb"
                    type="checkbox"
                    name="sg_applicable"
                    checked={formData.sg_applicable}
                    onChange={handleChange}
                    className="mt-0.5 rounded border-slate-300 text-primary-600"
                  />
                  <label htmlFor="sg_applicable_cb" className="text-xs text-slate-600 leading-tight">
                    Purchased in kg, consumed in production as litres. The Purchase Receipt line will
                    ask for SG per batch (varies by supplier / lot); litres = kg ÷ SG.
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Specific Gravity <span className="text-slate-400 font-normal">(default)</span>
                </label>
                <input
                  type="number" step="0.0001" min="0"
                  name="specific_gravity" value={formData.specific_gravity} onChange={handleChange}
                  className={inputClass} placeholder="e.g. 1.2000"
                />
                <p className="text-xs text-slate-400 mt-1">
                  Fallback SG used when a receipt doesn't carry a per-batch value.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GST %</label>
                <input type="number" step="0.01" min="0" max="100" name="gst_percentage" value={formData.gst_percentage} onChange={handleChange} className={inputClass} placeholder="e.g., 18" />
                <p className="text-xs text-slate-400 mt-1">When set, quote lines for this product lock to this GST for every vendor.</p>
              </div>
              {/* Pack size — bulk content per pack unit. Only meaningful
                  for packed SKUs (e.g. "10 KG Bag", "500 ML Bottle").
                  Drives the packing entry auto-fill: output_count ×
                  pack_size = expected bulk consumption. Leave blank
                  for bulk products / raw materials / packaging. */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Pack size (KG) <span className="text-slate-400 font-normal">(packed SKUs)</span>
                </label>
                <input
                  type="number" step="0.001" min="0"
                  name="pack_size_kg" value={formData.pack_size_kg} onChange={handleChange}
                  className={inputClass} placeholder="e.g. 10 for a 10 KG Bag"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Pack size (LTR) <span className="text-slate-400 font-normal">(packed SKUs)</span>
                </label>
                <input
                  type="number" step="0.001" min="0"
                  name="pack_size_ltr" value={formData.pack_size_ltr} onChange={handleChange}
                  className={inputClass} placeholder="e.g. 0.5 for a 500 ML Bottle"
                />
              </div>
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Conversion Notes</label>
                <textarea name="conversion_notes" value={formData.conversion_notes} onChange={handleChange} rows={2} className={inputClass} placeholder="e.g., 1 KG = 0.95 LTR at specific gravity 1.05" />
              </div>
            </div>
          </div>

          {/* Yield & Operations */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Yield & Operations</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="flex items-center gap-2 pt-6">
                <input type="checkbox" name="yield_tracking_required" checked={formData.yield_tracking_required} onChange={handleChange} className="rounded border-slate-300 text-primary-600" />
                <label className="text-sm text-slate-700">Yield Tracking Required</label>
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} className="rounded border-slate-300 text-primary-600" />
                <label className="text-sm text-slate-700">Active</label>
              </div>
            </div>
          </div>

          {/* Preferred Vendors - Multi-select Dropdown */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Preferred Vendors</h3>
            <div className="max-w-2xl">
              <label className="block text-sm font-medium text-slate-700 mb-1">Select vendors who supply this product</label>
              <div className="relative">
                {/* Selected tags + input */}
                <div
                  className="min-h-[42px] w-full border border-slate-300 rounded-lg px-2 py-1.5 flex flex-wrap gap-1.5 items-center cursor-text bg-white focus-within:ring-2 focus-within:ring-primary-500 focus-within:border-primary-500"
                  onClick={() => setVendorDropdownOpen(true)}
                >
                  <svg className="w-4 h-4 text-slate-400 shrink-0 ml-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path strokeLinecap="round" d="M21 21l-4.35-4.35" /></svg>
                  {selectedVendors.map(vid => {
                    const v = vendorList.find(x => x.id === vid);
                    if (!v) return null;
                    return (
                      <span key={vid} className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-50 text-primary-700 rounded-md text-xs font-medium border border-primary-200">
                        {v.vendor_name || v.vendor_code}
                        <button type="button" onClick={(e) => { e.stopPropagation(); removeVendor(vid); }} className="text-primary-400 hover:text-primary-700 ml-0.5">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                        </button>
                      </span>
                    );
                  })}
                  <input
                    type="text"
                    value={vendorSearch}
                    onChange={e => { setVendorSearch(e.target.value); setVendorDropdownOpen(true); }}
                    onFocus={() => setVendorDropdownOpen(true)}
                    placeholder={selectedVendors.length === 0 ? 'Search and select vendors...' : ''}
                    className="flex-1 min-w-[120px] outline-none text-sm bg-transparent py-0.5"
                  />
                </div>

                {/* Dropdown */}
                {vendorDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => { setVendorDropdownOpen(false); setVendorSearch(''); }} />
                    <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto">
                      {vendorsLoading ? (
                        <p className="px-3 py-4 text-sm text-slate-400">Loading vendors...</p>
                      ) : filteredVendors.length === 0 ? (
                        <p className="px-3 py-4 text-sm text-slate-400">No vendors found</p>
                      ) : (
                        filteredVendors.map(v => {
                          const isSelected = selectedVendors.includes(v.id);
                          return (
                            <div
                              key={v.id}
                              onClick={() => toggleVendor(v.id)}
                              className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm hover:bg-slate-50 ${isSelected ? 'bg-primary-50' : ''}`}
                            >
                              <input type="checkbox" checked={isSelected} readOnly className="rounded border-slate-300 text-primary-600 pointer-events-none" />
                              <div className="flex-1 min-w-0">
                                <span className="font-medium text-slate-800">{v.vendor_name || v.name || v.vendor_code}</span>
                                {v.vendor_code && <span className="text-slate-400 ml-1">({v.vendor_code})</span>}
                              </div>
                              {v.contact_email && <span className="text-xs text-slate-400 truncate max-w-[150px]">{v.contact_email}</span>}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
              {selectedVendors.length > 0 && (
                <p className="text-xs text-slate-500 mt-1.5">{selectedVendors.length} vendor(s) selected</p>
              )}
            </div>
          </div>

          {/* Product Images & Attachments */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-1 pb-2 border-b">Product Images &amp; Attachments</h3>
            <p className="text-xs text-slate-500 mb-3">Upload reference images or documents for this product. Multiple files allowed.</p>
            {isEditMode ? (
              <FileAttachments module="PRODUCT" recordId={id} baseUrl={PRODUCT_ATTACH_URL} />
            ) : (
              <FileAttachments key={attachKey} module="PRODUCT" baseUrl={PRODUCT_ATTACH_URL} deferUpload onPendingChange={setPendingAttachments} />
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="flex-1 sm:flex-none px-3 sm:px-6 py-2 border border-slate-300 rounded-lg text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            {!isEditMode && (
              <button type="button" disabled={isLoading} onClick={(e) => handleSubmit(e, true)}
                title="Save this product and start another under the same location"
                className="flex-1 sm:flex-none px-3 sm:px-6 py-2 border border-primary-300 text-primary-700 rounded-lg text-xs sm:text-sm font-medium hover:bg-primary-50 disabled:opacity-50">
                {isLoading ? 'Saving…' : 'Save & Add Another'}
              </button>
            )}
            <button type="submit" disabled={isLoading} className="flex-1 sm:flex-none px-3 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-xs sm:text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : (isEditMode ? 'Update Product' : 'Save Product')}</button>
          </div>
          </EditGate>
        </form>
      </div>
      </>}
    </MainLayout>
  );
}
