import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, Paperclip } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import VoiceDictation from '../../../components/common/VoiceDictation.jsx';
import { UOM_OPTIONS, UOM_VALUES } from '../../../constants/uom.js';

// Roles allowed to enable RFQ Skip (must mirror backend RFQ_SKIP_ALLOWED_ROLES).

// Count-based UOMs render as integers; everything else gets 3 decimals.
// Matches the Stock Ledger pages so a stock figure looks identical
// across the PR form and the ledger.
const INTEGER_UOMS = new Set(['NOS', 'PCS', 'BAG', 'BOX', 'SET']);
const fmtStock = (v, uom) => {
  if (v === '' || v === null || v === undefined) return '—';
  const isInt = INTEGER_UOMS.has((uom || '').trim().toUpperCase());
  return Number(v).toLocaleString('en-IN', {
    minimumFractionDigits: isInt ? 0 : 3,
    maximumFractionDigits: isInt ? 0 : 3,
  });
};

// Category dropdown options per requirement type. Every option resolves
// to a row in the Product master — `source` tells the line-item filter
// which `product_type` bucket to read:
//   - source='PRODUCT'          → Product.product_type == 'GOODS'
//   - source='MACHINERY_PRODUCT'→ Product.product_type == 'MACHINERY'
//   - source='SERVICE_PRODUCT'  → Product.product_type == 'SERVICES'
//
// All three resolve to a single FK (`product_service`) on the PRLine
// model — the form no longer routes to the separate Machinery /
// ServiceCatalogue masters because the Product master is the unified
// catalogue. The legacy core.Machinery / master.ServiceCatalogue rows
// keep working for historical PRs but new PRs only reference Products.
const GOODS_CATEGORY_CHOICES = [
  { value: 'RAW_MATERIAL', label: 'Raw Material', source: 'PRODUCT' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material', source: 'PRODUCT' },
  { value: 'FRUIT', label: 'Fruit', source: 'PRODUCT' },
  { value: 'MAIZE', label: 'Maize', source: 'PRODUCT' },
  { value: 'FINISHED_GOODS', label: 'Finished Goods', source: 'PRODUCT' },
];

// One sentinel option per non-Goods type — Product master groups them
// purely by product_type so an additional category dropdown would just
// be cosmetic. '__ANY__' is the "show every product of this type" key.
const MACHINERY_CATEGORY_CHOICES = [
  { value: '__ANY__', label: 'All Machinery Products', source: 'MACHINERY_PRODUCT' },
];

const SERVICE_CATEGORY_CHOICES = [
  { value: '__ANY__', label: 'All Services', source: 'SERVICE_PRODUCT' },
];

// Encode source into the <CustomSelect> option value so the change handler
// can recover the source without an extra state lookup. Format:
//   "<SOURCE>:<VALUE>"   e.g. "MACHINERY:CAPITAL_GOODS"
const encodeCategoryOption = (opt) => `${opt.source}:${opt.value}`;
const decodeCategoryOption = (encoded) => {
  if (!encoded || typeof encoded !== 'string') return { source: '', value: '' };
  const i = encoded.indexOf(':');
  if (i < 0) return { source: '', value: encoded };
  return { source: encoded.slice(0, i), value: encoded.slice(i + 1) };
};

function categoryChoicesForRequirementType(rt) {
  const t = (rt || 'GOODS').toUpperCase();
  if (t === 'MACHINERY') return MACHINERY_CATEGORY_CHOICES;
  if (t === 'SERVICES')  return SERVICE_CATEGORY_CHOICES;
  return GOODS_CATEGORY_CHOICES;
}

export default function CreatePurchaseRequest() {
  const navigate = useNavigate();
  const { staff, role, canCreate } = usePermissions();
  const editable = canCreate('Purchase Request');
  const { isHidden, isReadOnly } = useFieldPermissions('Purchase Request');
  const { isHidden: isLineHidden, isReadOnly: isLineRO } = useFieldPermissions('Purchase Request Line');
  const [selectedCompany, setSelectedCompany] = useState('');
  const { options: companyOptions } = useLookup('/api/companies/');
  // Sales Orders for the optional justification-reference dropdown.
  const { options: soOptions } = useLookup('/api/sales/orders/', {
    labelField: (so) => `${so.so_no || so.id}${so.customer_name ? ` — ${so.customer_name}` : ''}`,
  });
  const [nextPrNo, setNextPrNo] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const pendingAttachmentsRef = useRef([]);
  const attachInputRef = useRef(null);
  const [formData, setFormData] = useState({
    warehouse: '',
    godown: '',
    godowns: [],
    requestor_role: '',
    requirement_type: 'GOODS',
    priority: 'MEDIUM',
    required_by_date: new Date().toISOString().split('T')[0],
    justification: '',
    notes: '',
    sales_order: '',
  });

  // Unified purchase item catalogue — merged Product + Machinery +
  // Service Catalogue. This is the single source of truth for the line
  // item dropdown across every Purchase form. Each row has the shape:
  //   { item_type, item_id, item_name, item_code, uom, category, label,
  //     current_stock }
  // `current_stock` is only populated when we pass a warehouse query
  // param — endpoint key changes by warehouse so useLookup's cache
  // keeps the per-warehouse stock snapshots separate. See backend
  // purchase.views.PurchaseItemsView for details.
  // The endpoint URL is part of useLookup's cache key, so appending
  // godown when one's picked means each (warehouse, godown) pair gets
  // its own cached stock snapshot — switching the Godown dropdown
  // re-fetches with the correct scope instead of reusing a
  // warehouse-wide total that includes sibling godowns.
  const purchaseItemsEndpoint = formData.warehouse
    ? (formData.godown
        ? `/api/purchase/items/?warehouse=${formData.warehouse}&godown=${formData.godown}`
        : `/api/purchase/items/?warehouse=${formData.warehouse}`)
    : '/api/purchase/items/';
  const { raw: purchaseItems } = useLookup(purchaseItemsEndpoint);

  // Voice dictation (multi-language → English) for the text fields. Each
  // recorded clip is also attached to the PR alongside its transcript.
  const [voiceAudioFiles, setVoiceAudioFiles] = useState([]);
  const appendDictation = (field, text) => {
    const t = (text || '').trim();
    if (!t) return;
    setFormData((prev) => ({ ...prev, [field]: prev[field] ? `${prev[field]} ${t}` : t }));
  };
  const addVoiceAudio = (file) => {
    if (file) setVoiceAudioFiles((prev) => [...prev, file]);
  };

  // Warehouses are normally filtered by the selected company. We also fetch
  // the global list (raw) and surface any warehouse whose name contains
  // "office" no matter which company it's under — so an "Office" location
  // is always available in the dropdown regardless of the chosen company.
  const { options: warehouseOptionsForCompany } = useLookup(
    selectedCompany ? `/api/warehouses/?company=${selectedCompany}&scope=true` : '/api/warehouses/?scope=true'
  );
  const { raw: allWarehousesRaw } = useLookup('/api/warehouses/?scope=true');
  const warehouseOptions = (() => {
    const byId = new Map();
    (warehouseOptionsForCompany || []).forEach(o => byId.set(o.value, o));
    (allWarehousesRaw || []).forEach(w => {
      if ((w.name || '').toLowerCase().includes('office') && !byId.has(w.id)) {
        byId.set(w.id, { value: w.id, label: w.name });
      }
    });
    // Dedupe by label so the same human-readable name (e.g. "Office")
    // doesn't appear twice when multiple companies own a warehouse with
    // an identical label. The company-filtered list takes priority — it
    // was inserted first, so its entries win on the first-write rule.
    const seenLabels = new Set();
    return Array.from(byId.values()).filter(o => {
      const key = (o.label || '').trim().toLowerCase();
      if (!key || seenLabels.has(key)) return false;
      seenLabels.add(key);
      return true;
    });
  })();
  const { options: godownOptions } = useLookup(
    formData.warehouse ? `/api/godowns/?warehouse=${formData.warehouse}` : null
  );

  // `category_source` records which Product.product_type bucket the
  // chosen category points at:
  //   PRODUCT (GOODS) | MACHINERY_PRODUCT | SERVICE_PRODUCT
  // The Product dropdown reads this to filter the unified items feed by
  // product_type, and every line still saves to the same `product_service`
  // FK on the PRLine model.
  const [lineItems, setLineItems] = useState([
    { category: '', category_source: '', product: '', quantity: 1, uom: 'KG', description: '' },
  ]);

  // Auto-fill from logged-in user's staff profile.
  // Diagnostic log so users on production can confirm what their
  // session is returning. Visible in the browser console — toggle by
  // setting `localStorage.AUTOFILL_DEBUG = '1'`.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.localStorage?.getItem('AUTOFILL_DEBUG') === '1') {
      // eslint-disable-next-line no-console
      console.log('[PR autofill] staff =', staff, 'role =', role);
    }
  }, [staff, role]);

  useEffect(() => {
    if (role?.name && !formData.requestor_role) {
      setFormData(prev => ({ ...prev, requestor_role: role.name }));
    }
  }, [role]);

  useEffect(() => {
    if (staff?.company && !selectedCompany) {
      setSelectedCompany(staff.company);
    }
  }, [staff]);

  // Warehouse autofill — previously gated on the warehouse appearing
  // in `warehouseOptions`. That guard failed silently on production
  // when the user's warehouse list arrived AFTER the staff payload
  // (race) or when the warehouse filter dropped the user's primary
  // location for some reason. Setting the value directly is safe —
  // the <CustomSelect> falls back to its placeholder if the value isn't in
  // the options, and once the matching option arrives it auto-picks.
  useEffect(() => {
    if (staff?.primary_location && !formData.warehouse) {
      setFormData(prev => ({ ...prev, warehouse: staff.primary_location }));
    }
  }, [staff]);

  // Godown autofill — fires once the staff payload arrives and the
  // warehouse has been set (godown <CustomSelect> is gated on the warehouse
  // upstream). We DO check warehouse equality between
  // staff.primary_location and formData.warehouse — if the operator
  // already changed the warehouse manually before staff loaded, we
  // skip the godown autofill (its godown belongs to a different
  // warehouse and would mismatch the loaded godownOptions). Same
  // initial-load-only guard: only fill while formData.godown is empty.
  useEffect(() => {
    if (
      staff?.default_godown
      && !formData.godown
      && formData.warehouse
      && (!staff.primary_location || formData.warehouse === staff.primary_location)
    ) {
      setFormData(prev => ({ ...prev, godown: staff.default_godown, godowns: [staff.default_godown] }));
    }
  }, [staff, formData.warehouse]);

  // Fetch next PR number
  useEffect(() => {
    apiClient.get('/api/purchase/requests/', { params: { page_size: 1, ordering: '-pr_no' } })
      .then(res => {
        const data = res.data?.results || res.data || [];
        if (data.length > 0 && data[0].pr_no) {
          const last = data[0].pr_no; // e.g. PR-2026-00002
          const parts = last.split('-');
          const num = parseInt(parts[parts.length - 1]) || 0;
          const year = new Date().getFullYear();
          setNextPrNo(`PR-${year}-${String(num + 1).padStart(5, '0')}`);
        } else {
          const year = new Date().getFullYear();
          setNextPrNo(`PR-${year}-00001`);
        }
      })
      .catch(() => setNextPrNo(''));
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    // When requirement_type changes, clear BOTH category AND product on
    // every line — a Goods product makes no sense under a Machinery
    // category, etc. User must re-pick a fresh, type-consistent value.
    if (name === 'requirement_type') {
      setLineItems(prev => prev.map(item => ({ ...item, category: '', category_source: '', product: '' })));
    }
  };

  const handleLineChange = (idx, field, value) => {
    setLineItems(prev => prev.map((item, i) => {
      if (i !== idx) return item;
      const next = { ...item, [field]: value };
      // When category changes, clear the product (user must re-pick from
      // the newly filtered list) AND decode the encoded "SOURCE:VALUE"
      // option so we remember which master the category came from. The
      // Product dropdown reads category_source to pick its data source.
      if (field === 'category') {
        const decoded = decodeCategoryOption(value);
        next.category = decoded.value;
        next.category_source = decoded.source;
        next.product = '';
      }
      // Auto-fill UOM from the product master when a product is picked.
      if (field === 'product' && value) {
        const sel = (purchaseItems || []).find(it => String(it.item_id) === String(value));
        if (sel?.uom) next.uom = sel.uom;
      }
      return next;
    }));
  };

  // Hard cap on lines per PR — the backend serializer rejects > 15,
  // so bail out here with a clear toast instead of letting the form
  // POST and get a generic 400.
  const MAX_PR_LINES = 15;
  const addLine = () => {
    if (lineItems.length >= MAX_PR_LINES) {
      toast.error(`A Purchase Request can hold at most ${MAX_PR_LINES} lines. Split the extras into a new PR.`);
      return;
    }
    setLineItems(prev => [...prev, { category: '', category_source: '', product: '', quantity: 1, uom: 'KG', description: '' }]);
  };

  const removeLine = (idx) => {
    if (lineItems.length <= 1) return;
    setLineItems(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.warehouse) { toast.error('Warehouse is required'); return; }

    setIsSubmitting(true);
    try {
      const payload = {
        company: selectedCompany || null,
        warehouse: formData.warehouse,
        godown: formData.godowns[0] || formData.godown || null,
        godown_ids: formData.godowns,
        requestor_role: formData.requestor_role || '',
        requirement_type: formData.requirement_type || 'GOODS',
        priority: formData.priority || 'MEDIUM',
        required_by_date: formData.required_by_date || null,
        justification: formData.justification || '',
        notes: formData.notes || '',
        sales_order: formData.sales_order || null,
      };

      Object.keys(payload).forEach(k => {
        if (payload[k] === null || payload[k] === '') delete payload[k];
      });

      // 1. Create PR
      const res = await apiClient.post('/api/purchase/requests/', payload);
      const prId = res.data.id;
      const prNo = res.data.pr_no || '';

      // 2. Add line items to PR
      const validLines = lineItems.filter(l => l.product && l.product.trim() !== '');
      if (validLines.length === 0) {
        toast.error('No products selected in line items. Please select at least one product.');
      }
      // Validate category on every line before sending
      const isGoods = (formData.requirement_type || 'GOODS').toUpperCase() === 'GOODS';
      for (let i = 0; i < validLines.length; i++) {
        const line = validLines[i];
        const cat = (line.category || '').trim();
        if (!cat) {
          toast.error(`Line ${i + 1}: Category is required.`);
          setIsSubmitting(false);
          return;
        }
        if (isGoods && !['RAW_MATERIAL', 'PACKING_MATERIAL', 'FINISHED_GOODS'].includes(cat)) {
          toast.error(`Line ${i + 1}: For Goods, Category must be Raw Material, Packing Material, or Finished Goods.`);
          setIsSubmitting(false);
          return;
        }
        // Quantity is mandatory on every line.
        if (!(parseFloat(line.quantity) > 0)) {
          toast.error(`Line ${i + 1}: Quantity is required and must be greater than 0.`);
          setIsSubmitting(false);
          return;
        }
        // Cross-check the picked product's sub-category against the line
        // category. Prevents saving a Finished-Goods product under a
        // Raw-Material category line. Goods only — the other product
        // types use a single '__ANY__' category so there's nothing to
        // cross-check.
        const norm = (v) => (v || '').toString().trim().toUpperCase().replace(/[\s-]+/g, '_');
        const pickedItem = (purchaseItems || []).find(
          it => String(it.item_id) === String(line.product) && it.item_type === 'PRODUCT'
        );
        if (pickedItem && isGoods) {
          const expected = cat === 'FINISHED_GOODS' ? 'FINISHED_GOOD' : cat;
          const productSubType = norm(pickedItem.category);
          if (productSubType && productSubType !== expected) {
            const prettyCat = cat.replace(/_/g, ' ');
            const prettyProductCat = (pickedItem.category || 'unknown').replace(/_/g, ' ');
            toast.error(
              `Line ${i + 1}: Category "${prettyCat}" does not match product "${pickedItem.item_name}" (category: ${prettyProductCat}). Pick a matching product or change the category.`
            );
            setIsSubmitting(false);
            return;
          }
        }
      }
      // Every selectable item now resolves to a Product master row, so
      // every line lands on `product_service` on the backend's PRLine
      // model. The legacy `machinery` / `service_catalogue` FKs stay on
      // the model for historical PR data but new PRs only use product.
      let linesAdded = 0;
      for (const line of validLines) {
        try {
          // Backend accepts the listed GOODS_SUB_TYPE_CHOICES values
          // for `category`. For non-Goods requirement types the picked
          // category is '__ANY__' which isn't a valid backend value —
          // fall back to a known-good token derived from the picked
          // product's own goods_sub_type, defaulting to MACHINE_SPARES
          // (the dominant sub-type across non-Goods products in the
          // master).
          let categoryToSend = (line.category || '').trim();
          if (categoryToSend === '__ANY__') {
            const pickedItem = (purchaseItems || []).find(
              it => String(it.item_id) === String(line.product) && it.item_type === 'PRODUCT'
            );
            categoryToSend = (pickedItem?.category || 'MACHINE_SPARES').trim();
          }
          const linePayload = {
            category: categoryToSend,
            product_service: line.product,
            quantity_requested: Number(line.quantity) || 1,
            uom: line.uom || 'KG',
            description_override: line.description || '',
          };
          await apiClient.post(`/api/purchase/requests/${prId}/add-line/`, linePayload);
          linesAdded++;
        } catch (lineErr) {
          const errDetail = lineErr.response?.data;
          const errMsg = typeof errDetail === 'object' ? (errDetail.error || JSON.stringify(errDetail)) : String(errDetail);
          console.error('Failed to add line item:', errDetail);
          toast.error(`Line item failed: ${errMsg}`);
        }
      }

      if (pendingAttachments.length > 0) {
        await uploadPendingFiles('PR', prId, pendingAttachmentsRef.current);
      }

      toast.success(`Purchase Request ${prNo} created with ${validLines.length} line items!`);
      navigate(`/purchase/requests/${prId}`);
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreatePR] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Float design — compact floating-label inputs
  const floatWrap = "relative";
  const floatLabel = "absolute top-[3px] left-[7px] text-[8px] font-semibold text-slate-400 uppercase tracking-[0.04em] pointer-events-none z-10";
  const floatInput = "w-full pt-[14px] pb-[3px] px-[7px] text-[11.5px] border border-slate-300 rounded-[6px] focus:ring-1 focus:ring-primary-500 focus:border-primary-500 bg-white";
  const floatLocked = `${floatInput} bg-slate-100 cursor-not-allowed`;

  return (
    <MainLayout>
      <PageHeader
        title="Create Purchase Request"
        subtitle="Fill in details and add line items"
        breadcrumbs={[
          { label: 'Purchase', href: '/purchase/requests' },
          { label: 'Requests', href: '/purchase/requests' },
          { label: 'New' },
        ]}
        hideCompanyFilter
      />

      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="space-y-3">
        {/* Auto-info strip — read-only auto-generated fields */}
        <div className="bg-white rounded-[6px] border border-slate-200 px-3 py-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          {!isHidden('pr_no') && (
            <span className="text-slate-400"><span className="font-semibold uppercase tracking-wide text-[8px] mr-1">PR#</span><span className="text-slate-600 font-medium">{nextPrNo || 'Auto'}</span></span>
          )}
          {!isHidden('requestor_role') && formData.requestor_role && (
            <span className="text-slate-400"><span className="font-semibold uppercase tracking-wide text-[8px] mr-1">ROLE</span><span className="text-slate-600 font-medium">{formData.requestor_role}</span></span>
          )}
        </div>

        {/* Request Details — Float Design */}
        <div className="bg-white rounded-[6px] border border-slate-200 p-2 sm:p-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1">
            {/* Row 1: Company, Warehouse, Godown, Type (chips), Priority (chips) */}
            {!isHidden('company') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Company *</label>
              <CustomSelect value={selectedCompany} onChange={(e) => { setSelectedCompany(e.target.value); setFormData(prev => ({ ...prev, warehouse: '', godown: '', godowns: [] })); }} required disabled={isReadOnly('company')} className={isReadOnly('company') ? floatLocked : floatInput}>
                <option value="">Select...</option>
                {companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('warehouse') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Warehouse *</label>
              <CustomSelect name="warehouse" value={formData.warehouse} onChange={(e) => { setFormData(prev => ({ ...prev, warehouse: e.target.value, godown: '', godowns: [] })); }} required disabled={isReadOnly('warehouse') || !selectedCompany} className={isReadOnly('warehouse') ? floatLocked : `${floatInput} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                <option value="">{selectedCompany ? 'Select...' : 'Company first...'}</option>
                {warehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('godown') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Godown(s)</label>
              {!formData.warehouse ? (
                <div className={`${floatInput} bg-slate-100 text-slate-400 text-[10px]`}>Select warehouse...</div>
              ) : godownOptions.length === 0 ? (
                <div className={`${floatInput} bg-slate-100 text-slate-400 text-[10px]`}>No godowns</div>
              ) : (
                <div className="border border-slate-300 rounded-[6px] pt-[14px] pb-[2px] px-[5px] max-h-[70px] overflow-y-auto bg-white">
                  {godownOptions.map(o => {
                    const checked = formData.godowns.includes(o.value);
                    return (
                      <label key={o.value} className="flex items-center gap-1.5 text-[10px] px-0.5 py-[1px] rounded hover:bg-slate-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={isReadOnly('godown')}
                          onChange={() => setFormData(prev => {
                            const next = prev.godowns.includes(o.value)
                              ? prev.godowns.filter(g => g !== o.value)
                              : [...prev.godowns, o.value];
                            return { ...prev, godowns: next, godown: next[0] || '' };
                          })}
                          className="rounded border-slate-300 w-3 h-3"
                        />
                        {o.label}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            )}
            {!isHidden('requirement_type') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Type *</label>
              <div className={`flex gap-[2px] pt-[14px] pb-[3px] px-[6px] border border-slate-300 rounded-[6px] bg-white ${isReadOnly('requirement_type') ? 'opacity-60 pointer-events-none' : ''}`}>
                {[{ value: 'GOODS', label: 'Goods' }, { value: 'MACHINERY', label: 'Machinery' }].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => !isReadOnly('requirement_type') && handleChange({ target: { name: 'requirement_type', value: opt.value } })}
                    className={`px-[4px] py-[2px] text-[9px] font-bold rounded-[4px] uppercase tracking-wide transition-colors ${
                      formData.requirement_type === opt.value
                        ? 'bg-primary-600 text-white'
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            )}
            {!isHidden('priority') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Priority</label>
              <div className={`flex gap-[2px] pt-[14px] pb-[3px] px-[6px] border border-slate-300 rounded-[6px] bg-white ${isReadOnly('priority') ? 'opacity-60 pointer-events-none' : ''}`}>
                {[
                  { value: 'LOW', label: 'Low', active: 'bg-emerald-500 text-white', idle: 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' },
                  { value: 'MEDIUM', label: 'Med', active: 'bg-amber-500 text-white', idle: 'bg-amber-50 text-amber-600 hover:bg-amber-100' },
                  { value: 'HIGH', label: 'High', active: 'bg-red-500 text-white', idle: 'bg-red-50 text-red-600 hover:bg-red-100' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => !isReadOnly('priority') && handleChange({ target: { name: 'priority', value: opt.value } })}
                    className={`px-[4px] py-[2px] text-[9px] font-bold rounded-[4px] uppercase tracking-wide transition-colors ${
                      formData.priority === opt.value ? opt.active : opt.idle
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            )}

            {/* Row 2: Required By, SO Ref, Justification (span 2 + mic), Upload Files */}
            {!isHidden('required_by_date') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Required By</label>
              <CustomDatePicker name="required_by_date" value={formData.required_by_date} onChange={handleChange} disabled={isReadOnly('required_by_date')} className={isReadOnly('required_by_date') ? floatLocked : floatInput} />
            </div>
            )}
            <div className={floatWrap}>
              <label className={floatLabel}>SO Ref</label>
              <CustomSelect name="sales_order" value={formData.sales_order} onChange={handleChange} className={floatInput}>
                <option value="">None</option>
                {soOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            {!isHidden('justification') && (
            <div className={floatWrap}>
              <div className="flex items-center justify-between mb-[2px]">
                <label className="text-[9px] font-semibold text-slate-500 uppercase tracking-wide">Justification</label>
                <div className="flex items-center gap-1">
                  {!isReadOnly('justification') && (
                    <VoiceDictation compact onText={(t) => appendDictation('justification', t)} onAudio={addVoiceAudio} />
                  )}
                  <button type="button" onClick={() => attachInputRef.current?.click()} className="flex items-center gap-0.5 px-1.5 py-[3px] text-[9px] font-semibold text-primary-600 border border-primary-300 rounded-[4px] hover:bg-primary-50 uppercase tracking-wide whitespace-nowrap shrink-0">
                    <Paperclip size={9} />
                    {pendingAttachments.length > 0 ? `${pendingAttachments.length}` : 'Attach'}
                  </button>
                </div>
              </div>
              <input type="text" name="justification" value={formData.justification} onChange={handleChange} disabled={isReadOnly('justification')} placeholder="Reason..." className="w-full border border-slate-300 rounded-[6px] px-[7px] py-[6px] text-[11.5px] focus:ring-1 focus:ring-primary-500 focus:border-primary-500 bg-white" />
            </div>
            )}
          </div>
        </div>

        {/* Line Items */}
        <div className="bg-white rounded-[6px] border border-slate-200 p-2 sm:p-3">
          <div className="flex items-center justify-between mb-2 pb-1 border-b border-slate-100">
            <h3 className="text-[11.5px] font-semibold text-slate-700 uppercase tracking-wide">Line Items</h3>
            <button
              type="button"
              onClick={addLine}
              disabled={lineItems.length >= MAX_PR_LINES}
              title={lineItems.length >= MAX_PR_LINES ? `Maximum ${MAX_PR_LINES} lines per PR` : ''}
              className="flex items-center gap-0.5 px-2 py-1 text-[10px] font-semibold text-primary-600 border border-primary-300 rounded-[4px] hover:bg-primary-50 disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-wide"
            >
              <Plus size={12} /> Add {lineItems.length >= MAX_PR_LINES && `(${MAX_PR_LINES} max)`}
            </button>
          </div>

          {/* Mobile-stacked card layout. Each line becomes its own
              card with stacked inputs — no horizontal scroll on
              phones. Reuses the same handlers as the desktop table
              so create / edit behavior is identical. */}
          <div className="sm:hidden space-y-1.5">
            {lineItems.map((item, idx) => {
              const rtKey = (formData.requirement_type || 'GOODS').toUpperCase();
              const categoryOptions = categoryChoicesForRequirementType(rtKey);
              const encodedCurrent = item.category && item.category_source
                ? `${item.category_source}:${item.category}` : '';
              const validEncoded = new Set(categoryOptions.map(encodeCategoryOption));
              const safeCategoryEncoded = validEncoded.has(encodedCurrent) ? encodedCurrent : '';
              const norm = (v) => (v || '').toString().trim().toUpperCase().replace(/[\s-]+/g, '_');
              const src = (item.category_source || '').toUpperCase();
              const wantedType =
                src === 'MACHINERY_PRODUCT' ? 'MACHINERY' :
                src === 'SERVICE_PRODUCT'   ? 'SERVICES'  :
                                              'GOODS';
              const usedElsewhere = new Set(
                lineItems.filter((_, i) => i !== idx).map(l => String(l.product)).filter(Boolean)
              );
              let prodOptions = (purchaseItems || [])
                .filter(it => it.item_type === 'PRODUCT'
                  && (it.product_type || 'GOODS').toUpperCase() === wantedType)
                .filter(it => !usedElsewhere.has(String(it.item_id)))
                .filter(it => {
                  if (!item.category || item.category === '__ANY__') return true;
                  if (wantedType !== 'GOODS') return true;
                  const cat = norm(item.category);
                  const expected = cat === 'FINISHED_GOODS' ? 'FINISHED_GOOD' : cat;
                  return norm(it.category) === expected;
                })
                .map(it => ({ id: it.item_id, label: it.label || it.item_name }))
                .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
              const validIds = new Set(prodOptions.map(o => String(o.id)));
              const safeProduct = validIds.has(String(item.product)) ? item.product : '';
              const noun = wantedType === 'MACHINERY' ? 'Machinery' :
                           wantedType === 'SERVICES'  ? 'Service'   :
                                                        'Product';
              return (
                <div key={`m-${idx}`} className="border border-slate-200 rounded-[6px] bg-white overflow-hidden">
                  <div className="flex items-center justify-between px-2 py-1 bg-slate-50 border-b border-slate-100">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">#{idx + 1}</span>
                    <button type="button" onClick={() => removeLine(idx)} disabled={lineItems.length <= 1} className="p-0.5 text-red-400 hover:bg-red-50 rounded disabled:opacity-30">
                      <Trash2 size={11} />
                    </button>
                  </div>
                  <div className="px-2 py-1.5 grid grid-cols-2 gap-1">
                    {!isLineHidden('category') && (
                    <div className={floatWrap}>
                      <label className={floatLabel}>Category *</label>
                      <CustomSelect key={`mcat-${idx}-${rtKey}`} value={safeCategoryEncoded} onChange={(e) => handleLineChange(idx, 'category', e.target.value)} disabled={isLineRO('category')} className={floatInput}>
                        <option value="">Select...</option>
                        {categoryOptions.map(c => <option key={encodeCategoryOption(c)} value={encodeCategoryOption(c)}>{c.label}</option>)}
                      </CustomSelect>
                    </div>
                    )}
                    {!isLineHidden('product_service') && (
                    <div className={floatWrap}>
                      <label className={floatLabel}>Product</label>
                      <CustomSelect key={`mp-${idx}-${rtKey}-${src}`} value={safeProduct} onChange={(e) => handleLineChange(idx, 'product', e.target.value)} disabled={isLineRO('product_service') || (!!item.category && prodOptions.length === 0)} className={`${floatInput} disabled:bg-slate-50 disabled:text-slate-400`}>
                        <option value="">{!item.category ? 'Category first…' : (prodOptions.length === 0 ? 'None found' : `Select ${noun}`)}</option>
                        {prodOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </CustomSelect>
                    </div>
                    )}
                    <div className={floatWrap}>
                      <label className={floatLabel}>Stock</label>
                      <div className={`${floatInput} bg-slate-50 text-right tabular-nums`}>
                      {(() => {
                        const picked = (purchaseItems || []).find(
                          it => String(it.item_id) === String(item.product) && it.item_type === 'PRODUCT'
                        );
                        if (!formData.warehouse) return <span className="text-slate-400 text-[10px]">—</span>;
                        if (!picked) return <span className="text-slate-300 text-[10px]">—</span>;
                        const n = Number(picked.current_stock);
                        return <span className={n < 0 ? 'text-red-600' : 'text-sky-700'}>{fmtStock(picked.current_stock, picked.uom)}</span>;
                      })()}
                      </div>
                    </div>
                    {!isLineHidden('quantity_requested') && (
                    <div className={floatWrap}>
                      <label className={floatLabel}>Qty *</label>
                      <input type="number" min="0.01" step="any" required value={item.quantity} onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)} disabled={isLineRO('quantity_requested')} className={floatInput} />
                    </div>
                    )}
                    {!isLineHidden('uom') && (
                    <div className={floatWrap}>
                      <label className={floatLabel}>UOM</label>
                      <CustomSelect value={item.uom} onChange={(e) => handleLineChange(idx, 'uom', e.target.value)} disabled={isLineRO('uom')} className={floatInput}>
                        {item.uom && !UOM_VALUES.includes(item.uom) && (
                          <option value={item.uom}>{item.uom}</option>
                        )}
                        {UOM_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </CustomSelect>
                    </div>
                    )}
                    {!isLineHidden('description_override') && (
                    <div className={`${floatWrap} col-span-2`}>
                      <label className={floatLabel}>Description</label>
                      <input type="text" value={item.description} onChange={(e) => handleLineChange(idx, 'description', e.target.value)} disabled={isLineRO('description_override')} placeholder="Optional" className={floatInput} />
                    </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                  <th className="text-left px-3 py-2 font-medium text-slate-600 w-10">#</th>
                  {!isLineHidden('category') && <th className="text-left px-3 py-2 font-medium text-slate-600 w-44">Category <span className="text-red-500">*</span></th>}
                  {!isLineHidden('product_service') && <th className="text-left px-3 py-2 font-medium text-slate-600">Product</th>}
                  <th className="text-right px-3 py-2 font-medium text-slate-600 w-32">Available Stock</th>
                  {!isLineHidden('quantity_requested') && <th className="text-left px-3 py-2 font-medium text-slate-600 w-28">Quantity</th>}
                  {!isLineHidden('uom') && <th className="text-left px-3 py-2 font-medium text-slate-600 w-24">UOM</th>}
                  {!isLineHidden('description_override') && <th className="text-left px-3 py-2 font-medium text-slate-600">Description</th>}
                  <th className="text-center px-3 py-2 font-medium text-slate-600 w-16">Del</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item, idx) => {
                  // Choose the category list based on requirement_type.
                  // All three types now use a select so the user can't
                  // free-type a value that the master doesn't recognise.
                  const rtKey = (formData.requirement_type || 'GOODS').toUpperCase();
                  const categoryOptions = categoryChoicesForRequirementType(rtKey);
                  // The <CustomSelect> uses encoded "SOURCE:VALUE" values so the
                  // change handler can identify which master the chosen
                  // category came from. Safety check uses the encoded
                  // identity (source + value) — same human label across
                  // masters would otherwise collide.
                  const encodedCurrent = item.category && item.category_source
                    ? `${item.category_source}:${item.category}`
                    : '';
                  const validEncoded = new Set(categoryOptions.map(encodeCategoryOption));
                  const safeCategoryEncoded = validEncoded.has(encodedCurrent) ? encodedCurrent : '';
                  return (
                  <tr key={idx} className="border-b border-slate-100">
                    <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                    {!isLineHidden('category') && (
                    <td className="px-3 py-2">
                      <CustomSelect
                        // key forces React to remount the <CustomSelect> when
                        // requirement_type changes, blowing away any
                        // browser-cached option DOM nodes from the
                        // previous master.
                        key={`category-${idx}-${rtKey}`}
                        value={safeCategoryEncoded}
                        onChange={(e) => handleLineChange(idx, 'category', e.target.value)}
                        disabled={isLineRO('category')}
                        className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-primary-500"
                      >
                        <option value="">Select Category...</option>
                        {categoryOptions.map(c => (
                          <option key={encodeCategoryOption(c)} value={encodeCategoryOption(c)}>{c.label}</option>
                        ))}
                      </CustomSelect>
                    </td>
                    )}
                    {!isLineHidden('product_service') && (
                    <td className="px-3 py-2">
                      {(() => {
                        const norm = (v) => (v || '').toString().trim().toUpperCase().replace(/[\s-]+/g, '_');
                        const rt = (formData.requirement_type || 'GOODS').toUpperCase();
                        // Every selectable line item now comes from the
                        // Product master. `src` decodes which product_type
                        // bucket to filter on (Goods / Machinery / Services
                        // — see CATEGORY_CHOICES at the top of the file).
                        // The line-level source mirrors the chosen
                        // category's source tag — see handleLineChange.
                        const src = (item.category_source || '').toUpperCase();
                        const wantedType =
                          src === 'MACHINERY_PRODUCT' ? 'MACHINERY' :
                          src === 'SERVICE_PRODUCT'   ? 'SERVICES'  :
                                                        'GOODS';
                        // A product picked on another line can't be picked
                        // again here (no duplicate products across lines).
                        const usedElsewhere = new Set(
                          lineItems.filter((_, i) => i !== idx).map(l => String(l.product)).filter(Boolean)
                        );
                        let options = (purchaseItems || [])
                          .filter(it => it.item_type === 'PRODUCT'
                            && (it.product_type || 'GOODS').toUpperCase() === wantedType)
                          .filter(it => !usedElsewhere.has(String(it.item_id)))
                          .filter(it => {
                            // Only the Goods flow narrows further by
                            // goods_sub_type. The other product_types use
                            // a single '__ANY__' category sentinel.
                            if (!item.category || item.category === '__ANY__') return true;
                            if (wantedType !== 'GOODS') return true;
                            const cat = norm(item.category);
                            // Product master stores 'FINISHED_GOOD'
                            // (singular); PR form uses 'FINISHED_GOODS'.
                            const expected = cat === 'FINISHED_GOODS' ? 'FINISHED_GOOD' : cat;
                            return norm(it.category) === expected;
                          })
                          .map(it => ({
                            id: it.item_id,
                            label: it.label || it.item_name,
                          }));
                        options = options.slice().sort((a, b) => (a.label || '').localeCompare(b.label || ''));

                        const noun =
                          wantedType === 'MACHINERY' ? 'Machinery' :
                          wantedType === 'SERVICES'  ? 'Service'   :
                                                       'Product';
                        const placeholder = !item.category
                          ? 'Select Category first...'
                          : (options.length === 0 ? `No ${noun.toLowerCase()} found for selected category` : `Select ${noun}`);

                        // Defensive: if line.product isn't in the active
                        // options list (cross-master leak after type
                        // change), drop back to '' so we never render a
                        // selected value that belongs to a different
                        // master's records.
                        const validIds = new Set(options.map(o => String(o.id)));
                        const safeProduct = validIds.has(String(item.product)) ? item.product : '';
                        return (
                          <CustomSelect
                            // Remount on requirement_type OR category_source
                            // change so the browser doesn't retain stale
                            // option DOM from the previous master.
                            key={`product-${idx}-${rt}-${src}`}
                            value={safeProduct}
                            onChange={(e) => handleLineChange(idx, 'product', e.target.value)}
                            disabled={isLineRO('product_service') || (!!item.category && options.length === 0)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-primary-500 disabled:bg-slate-50 disabled:text-slate-400"
                          >
                            <option value="">{placeholder}</option>
                            {options.map(o => (
                              <option key={o.id} value={o.id}>{o.label}</option>
                            ))}
                          </CustomSelect>
                        );
                      })()}
                    </td>
                    )}
                    <td className="px-3 py-2">
                      {(() => {
                        // Available Stock for THIS line's picked product
                        // at the PR's warehouse. Empty when no warehouse
                        // has been chosen yet (backend then returns '')
                        // or no product is selected.
                        const picked = (purchaseItems || []).find(
                          it => String(it.item_id) === String(item.product) && it.item_type === 'PRODUCT'
                        );
                        if (!formData.warehouse) {
                          return <span className="block text-right text-xs text-slate-400 italic">Select warehouse</span>;
                        }
                        if (!picked) {
                          return <span className="block text-right text-xs text-slate-300">—</span>;
                        }
                        const n = Number(picked.current_stock);
                        const tone = Number.isFinite(n) && n < 0
                          ? 'bg-red-50 border-red-200 text-red-800'
                          : 'bg-sky-50 border-sky-200 text-sky-900';
                        return (
                          <div className={`px-2 py-1 text-sm text-right tabular-nums rounded border ${tone}`}>
                            {fmtStock(picked.current_stock, picked.uom)}
                            {picked.uom && <span className="text-[10px] text-slate-400 ml-1">{picked.uom}</span>}
                          </div>
                        );
                      })()}
                    </td>
                    {!isLineHidden('quantity_requested') && (
                    <td className="px-3 py-2">
                      <input type="number" min="0.01" step="any" required value={item.quantity} onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)} disabled={isLineRO('quantity_requested')} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed" />
                    </td>
                    )}
                    {!isLineHidden('uom') && (
                    <td className="px-3 py-2">
                      <CustomSelect value={item.uom} onChange={(e) => handleLineChange(idx, 'uom', e.target.value)} disabled={isLineRO('uom')} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed">
                        {item.uom && !UOM_VALUES.includes(item.uom) && (
                          <option value={item.uom}>{item.uom}</option>
                        )}
                        {UOM_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </CustomSelect>
                    </td>
                    )}
                    {!isLineHidden('description_override') && (
                    <td className="px-3 py-2">
                      <input type="text" value={item.description} onChange={(e) => handleLineChange(idx, 'description', e.target.value)} disabled={isLineRO('description_override')} placeholder="Optional description" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed" />
                    </td>
                    )}
                    <td className="px-3 py-2 text-center">
                      <button type="button" onClick={() => removeLine(idx)} disabled={lineItems.length <= 1} className="p-1 text-red-500 hover:bg-red-50 rounded disabled:opacity-30 disabled:cursor-not-allowed">
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {lineItems.length === 0 && (
            <div className="text-center py-4 sm:py-6 text-slate-400">No line items. Click "Add Item" to begin.</div>
          )}
        </div>

        {/* Hidden file input for inline Attach button */}
        <input ref={attachInputRef} type="file" multiple className="hidden" onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length === 0) return;
          const updated = [...pendingAttachmentsRef.current, ...files];
          pendingAttachmentsRef.current = updated;
          setPendingAttachments(updated);
          e.target.value = '';
        }} />

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => navigate(-1)} className="px-3 sm:px-5 py-1.5 border border-slate-300 rounded-[6px] text-[11.5px] font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="px-3 sm:px-5 py-1.5 text-white rounded-[6px] text-[11.5px] font-medium disabled:opacity-50 bg-primary-600 hover:bg-primary-700">
            {isSubmitting ? 'Creating...' : 'Create Purchase Request'}
          </button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
