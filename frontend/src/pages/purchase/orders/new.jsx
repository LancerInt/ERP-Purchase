import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import useAllProducts from '../components/useAllProducts.js';
import { Plus, Trash2, SkipForward } from 'lucide-react';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import { PAYMENT_TERM_OPTIONS, FREIGHT_TERM_OPTIONS, withCurrent, paymentTermMessage } from '@/constants/purchaseTerms';

// Base input classes pulled from this form's inline styling so the
// field-permission lock state can reuse them.
const inputClass = "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;
const lineInputClass = "w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm";
const lockedLineInputClass = `${lineInputClass} bg-slate-100 cursor-not-allowed`;

export default function CreatePurchaseOrder() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isSkipRfq = searchParams.get('skip_rfq') === 'true';

  const { isHidden, isReadOnly } = useFieldPermissions('Purchase Order');
  const { canCreate } = usePermissions();
  const editable = canCreate('Purchase Order');
  const { isHidden: isLineHidden, isReadOnly: isLineRO } = useFieldPermissions('Purchase Order Line');

  const { options: vendorOptions } = useLookup('/api/vendors/');
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: rfqOptions } = useLookup('/api/purchase/rfq/');
  // Broker master — drives the Broker Name dropdown so users pick a
  // pre-registered broker instead of free-typing a name.
  const { raw: brokerList } = useLookup('/api/brokers/');
  // Unified item catalogue (Product + Machinery + Service Catalogue).
  // Source of truth for the line item dropdown. See backend
  // PurchaseItemsView. Each row: { item_type, item_id, item_name,
  // item_code, uom, category, label }.
  const { raw: purchaseItems } = useLookup('/api/purchase/items/');
  // Product master is still fetched separately for the skip-RFQ vendor
  // narrowing (which reads `preferred_vendors` off each Product —
  // metadata not exposed by the unified items endpoint).
  const { raw: productRaw } = useAllProducts();
  const { raw: prRaw } = useLookup('/api/purchase/requests/', { labelField: 'pr_no' });
  const { raw: allWarehousesRaw } = useLookup('/api/warehouses/');
  const prOptions = (prRaw || [])
    .filter(p => p.approval_status === 'APPROVED' || p.approval_status === 'PARTIALLY_APPROVED')
    .map(p => ({ value: p.id, label: p.pr_no }));
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const pendingAttachmentsRef = useRef([]);
  const [skipRfqData, setSkipRfqData] = useState(null);

  const today = new Date().toISOString().split('T')[0];

  const [formData, setFormData] = useState({
    vendor: '',
    company: '',
    warehouse: '',
    linked_prs: '',
    linked_rfq: '',
    po_date: today,
    expected_delivery_start: '',
    expected_delivery_end: '',
    freight_terms: '',
    payment_terms: '',
    currency: 'INR',
    broker_name: '',
    terms_and_conditions: '',
    notes: '',
  });

  const [lineItems, setLineItems] = useState([]);

  const { options: warehouseOptions } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}&scope=true` : null
  );

  // Skip-RFQ: narrow vendor dropdown to vendors that are 'preferred' on any of
  // the line-item products. If no line products have preferred vendors set,
  // fall back to all vendors so the user isn't blocked.
  const allowedVendorIds = (() => {
    if (!isSkipRfq) return null;
    const productIds = lineItems.map(l => String(l.product)).filter(Boolean);
    if (productIds.length === 0 || (productRaw || []).length === 0) return null;
    const ids = new Set();
    productIds.forEach(pid => {
      const p = productRaw.find(pr => String(pr.id) === pid);
      (p?.preferred_vendors || []).forEach(vid => ids.add(String(vid)));
    });
    return ids.size > 0 ? ids : null;
  })();
  const filteredVendorOptions = allowedVendorIds
    ? vendorOptions.filter(o => allowedVendorIds.has(String(o.value)))
    : vendorOptions;

  // Load skip-RFQ data from sessionStorage
  useEffect(() => {
    if (!isSkipRfq) return;
    try {
      const raw = sessionStorage.getItem('skipRfqPoData');
      if (!raw) return;
      const data = JSON.parse(raw);
      setSkipRfqData(data);
      sessionStorage.removeItem('skipRfqPoData');

      setFormData(prev => ({
        ...prev,
        company: data.company || '',
        warehouse: data.warehouse || '',
        linked_prs: data.pr_id || [],
        linked_rfq: '',
        po_date: today,
        currency: data.currency || 'INR',
        notes: data.notes || '',
        expected_delivery_end: data.required_by_date || '',
      }));

      // Build line items from PR lines. Each PR line may be a Product,
      // Machinery, or Service — preserve `item_type` so we route to the
      // right FK on save. Older sessionStorage payloads that don't
      // include item_type default to PRODUCT.
      if (data.lines?.length > 0) {
        setLineItems(data.lines.map((line, i) => ({
          item_type: (line.item_type || 'PRODUCT').toUpperCase(),
          product: line.product || line.item_id || '',
          product_name: line.product_name || line.item_name || '',
          description: line.description || '',
          quantity: line.quantity || '1',
          uom: line.uom || 'KG',
          unit_price: '',
          gst: '',
          delivery_schedule: line.required_date || '',
          pr_line_id: line.pr_line_id || '',
          // Mirror PR category onto the PO line so the operator can
          // see / edit it on the PO form. The backend persists this
          // on POLine.category and the Receipt routing reads it first
          // (see POLineSerializer.get_pr_line_category resolver).
          category: line.category || '',
        })));
      }
    } catch (e) {
      console.error('Failed to load skip-RFQ data:', e);
    }
  }, [isSkipRfq]);

  // When warehouse options load and skip-RFQ has a warehouse, re-set it
  useEffect(() => {
    if (!skipRfqData?.warehouse || !warehouseOptions.length) return;
    if (warehouseOptions.find(o => o.value === skipRfqData.warehouse)) {
      setFormData(prev => ({ ...prev, warehouse: skipRfqData.warehouse }));
    }
  }, [warehouseOptions, skipRfqData]);

  // Clear the selected vendor if it's no longer allowed by the product filter
  // (e.g., user picked a vendor, then changed a line product and the previous
  // vendor isn't preferred for the new product).
  useEffect(() => {
    if (!isSkipRfq || !allowedVendorIds || !formData.vendor) return;
    if (!allowedVendorIds.has(String(formData.vendor))) {
      setFormData(prev => ({ ...prev, vendor: '' }));
    }
  }, [isSkipRfq, allowedVendorIds, formData.vendor]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    if (name === 'company') {
      setFormData(prev => ({ ...prev, company: value, warehouse: '' }));
      return;
    }
    if (name === 'linked_prs') {
      const pr = (prRaw || []).find(p => String(p.id) === String(value));
      // Prefer PR's persisted company; fall back to deriving from warehouse for legacy data.
      let companyId = pr?.company || '';
      if (!companyId && pr) {
        const wh = (allWarehousesRaw || []).find(w => String(w.id) === String(pr.warehouse));
        companyId = wh?.company || '';
      }
      setFormData(prev => ({
        ...prev,
        linked_prs: value,
        company: companyId || prev.company,
        warehouse: pr?.warehouse || prev.warehouse,
      }));
      return;
    }
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleLineChange = (index, field, value) => {
    setLineItems(prev => prev.map((item, i) => i === index ? { ...item, [field]: value } : item));
  };

  // When a product is picked, pull the GST% / freight / payment used on the most
  // recent PO for that same product and prefill them — but only fields the
  // operator hasn't already set (never overwrite a typed value). Best-effort:
  // any failure is silently ignored so it never blocks PO creation.
  const applyLastTerms = async (index, productId, itemType) => {
    if (!productId) return;
    try {
      const res = await apiClient.get('/api/purchase/orders/product-last-terms/', {
        params: { product: productId, item_type: itemType || 'PRODUCT' },
      });
      const d = res.data || {};
      if (!d.found) return;
      setLineItems(prev => prev.map((row, ri) => {
        if (ri !== index) return row;
        const gstEmpty = row.gst === '' || row.gst == null;
        return (gstEmpty && d.gst != null && d.gst !== '') ? { ...row, gst: String(d.gst) } : row;
      }));
      setFormData(prev => ({
        ...prev,
        freight_terms: prev.freight_terms || d.freight_terms || '',
        payment_terms: prev.payment_terms || d.payment_terms || '',
      }));
    } catch { /* best-effort autofill */ }
  };

  const addLineItem = () => {
    setLineItems(prev => [...prev, { item_type: 'PRODUCT', product: '', description: '', quantity: '1', uom: 'KG', unit_price: '', gst: '', delivery_schedule: '', pr_line_id: '', category: '' }]);
  };

  const removeLineItem = (index) => {
    setLineItems(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSkipRfq && !formData.vendor) {
      toast.error('Vendor is required. Please select a vendor before creating the PO.');
      return;
    }
    setIsLoading(true);
    try {
      const payload = cleanFormData({ ...formData });
      // For skip-RFQ, ensure linked_rfq is empty
      if (isSkipRfq) {
        delete payload.linked_rfq;
      }
      if (import.meta.env.DEV) console.log('[CreatePurchaseOrder] payload:', payload);
      const res = await apiClient.post('/api/purchase/orders/', payload);
      const poId = res.data?.id;

      // If we have line items, create them. Each line carries an
      // item_type that decides which FK on POLine receives the id
      // (product_service / machinery / service_catalogue). The backend
      // `add-line` endpoint accepts whichever key is set.
      if (lineItems.length > 0 && poId) {
        const linePromises = lineItems
          .filter(l => l.product && l.quantity)
          .map((line, i) => {
            const itemType = (line.item_type || 'PRODUCT').toUpperCase();
            // Machine spares are MACHINERY Products now, so they save to
            // product_service like goods (the legacy `machinery` FK is retired).
            const fkField =
              itemType === 'SERVICE' ? 'service_catalogue' : 'product_service';
            const linePayload = {
              line_no: i + 1,
              [fkField]: line.product,
              description: line.description || '',
              quantity_ordered: line.quantity,
              uom: line.uom || 'KG',
              unit_price: line.unit_price || '0',
              gst: line.gst || '0',
              delivery_schedule: line.delivery_schedule || null,
              // Category drives downstream Receipt routing. Blank when
              // the operator left it as '-' — backend resolver then
              // falls back to PR linkage.
              category: line.category || '',
            };
            if (line.pr_line_id) {
              linePayload.linked_pr_line = line.pr_line_id;
            }
            return apiClient.post(`/api/purchase/orders/${poId}/add-line/`, linePayload);
          });
        await Promise.all(linePromises);
      }

      if (pendingAttachments.length > 0 && poId) {
        await uploadPendingFiles('PO', poId, pendingAttachmentsRef.current);
      }

      toast.success(isSkipRfq ? 'Purchase Order created (RFQ Skipped)!' : 'Purchase Order created successfully!');
      navigate('/purchase/orders');
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreatePurchaseOrder] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title={isSkipRfq ? 'Create Purchase Order (RFQ Skipped)' : 'Create Purchase Order'}
        breadcrumbs={[
          { label: 'Purchase', path: '/purchase' },
          { label: 'Orders', path: '/purchase/orders' },
          { label: isSkipRfq ? 'Skip RFQ → Create PO' : 'Create Purchase Order' },
        ]}
      />

      {/* Skip RFQ Banner */}
      {isSkipRfq && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500 flex items-center justify-center flex-shrink-0">
            <SkipForward size={20} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-amber-800">RFQ Skipped — Direct PO Creation</p>
            <p className="text-xs text-amber-600">
              Creating PO directly from PR {skipRfqData?.pr_no || ''}. Linked RFQ = <span className="font-bold">SKIP RFQ</span>. Fields auto-filled from PR — please select a Vendor and fill remaining required fields.
            </p>
          </div>
        </div>
      )}

      {(() => {
        // Reflects the currently-picked Payment Terms in real time so
        // the operator's deadline matches what they're about to save.
        const message = paymentTermMessage(formData?.payment_terms);
        if (!message) return null;
        return (
          <div className="mb-4">
            <p className="inline-block bg-amber-100 border border-amber-300 text-amber-800 text-sm font-semibold px-4 py-2 rounded-lg">
              {message}
            </p>
          </div>
        );
      })()}

      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-3 sm:space-y-6">
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Order Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {!isHidden('vendor') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Vendor <span className="text-red-500">*</span></label>
                <CustomSelect name="vendor" value={formData.vendor} onChange={handleChange} required disabled={isReadOnly('vendor')} className={isReadOnly('vendor') ? lockedInputClass : inputClass}>
                  <option value="">Select Vendor</option>
                  {filteredVendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                {isSkipRfq && allowedVendorIds && (
                  <p className="text-xs text-slate-500 mt-1">
                    Showing {filteredVendorOptions.length} preferred vendor(s) for the selected product(s).
                  </p>
                )}
                {isSkipRfq && !allowedVendorIds && lineItems.some(l => l.product) && (
                  <p className="text-xs text-amber-600 mt-1">
                    No preferred vendors set on the selected product(s). Showing all vendors.
                  </p>
                )}
              </div>
              )}
              {!isHidden('company') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} required disabled={isReadOnly('company')} className={isReadOnly('company') ? lockedInputClass : inputClass}>
                  <option value="">Select Company</option>
                  {companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('warehouse') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleChange} required disabled={isReadOnly('warehouse') || !formData.company} className={isReadOnly('warehouse') ? lockedInputClass : "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed"}>
                  <option value="">{formData.company ? 'Select Warehouse' : 'Select company first...'}</option>
                  {warehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('linked_prs') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Linked PR</label>
                {isSkipRfq ? (
                  <input type="text" name="linked_prs" value={skipRfqData?.pr_no || formData.linked_prs} readOnly className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-slate-50 text-slate-600" />
                ) : (
                  <CustomSelect name="linked_prs" value={formData.linked_prs} onChange={handleChange} disabled={isReadOnly('linked_prs')} className={isReadOnly('linked_prs') ? lockedInputClass : inputClass}>
                    <option value="">Select Purchase Request</option>
                    {prOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                )}
              </div>
              )}
              {!isHidden('linked_rfq') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Linked RFQ</label>
                {isSkipRfq ? (
                  <div className="w-full border border-amber-300 bg-amber-50 rounded-lg px-3 py-2 text-sm font-semibold text-amber-700">
                    SKIP RFQ
                  </div>
                ) : (
                  <CustomSelect name="linked_rfq" value={formData.linked_rfq} onChange={handleChange} disabled={isReadOnly('linked_rfq')} className={isReadOnly('linked_rfq') ? lockedInputClass : inputClass}>
                    <option value="">Select RFQ</option>
                    {rfqOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                )}
              </div>
              )}
              {!isHidden('po_date') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">PO Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="po_date" value={formData.po_date} onChange={handleChange} required disabled={isReadOnly('po_date')} className={isReadOnly('po_date') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('expected_delivery_start') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Expected Delivery Start</label>
                <CustomDatePicker name="expected_delivery_start" value={formData.expected_delivery_start} onChange={handleChange} disabled={isReadOnly('expected_delivery_start')} className={isReadOnly('expected_delivery_start') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('expected_delivery_end') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Expected Delivery End</label>
                <CustomDatePicker name="expected_delivery_end" value={formData.expected_delivery_end} onChange={handleChange} disabled={isReadOnly('expected_delivery_end')} className={isReadOnly('expected_delivery_end') ? lockedInputClass : inputClass} />
              </div>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Terms & Currency</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {!isHidden('freight_terms') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Terms <span className="text-red-500">*</span></label>
                <CustomSelect name="freight_terms" value={formData.freight_terms} onChange={handleChange} required disabled={isReadOnly('freight_terms')} className={isReadOnly('freight_terms') ? lockedInputClass : inputClass}>
                  <option value="">Select Freight Terms</option>
                  {withCurrent(FREIGHT_TERM_OPTIONS, formData.freight_terms).map(o => <option key={o} value={o}>{o}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('payment_terms') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms</label>
                <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} disabled={isReadOnly('payment_terms')} className={isReadOnly('payment_terms') ? lockedInputClass : inputClass}>
                  <option value="">Select Payment Terms</option>
                  {withCurrent(PAYMENT_TERM_OPTIONS, formData.payment_terms).map(o => <option key={o} value={o}>{o}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('currency') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Currency <span className="text-red-500">*</span></label>
                <CustomSelect name="currency" value={formData.currency} onChange={handleChange} required disabled={isReadOnly('currency')} className={isReadOnly('currency') ? lockedInputClass : inputClass}>
                  <option value="">Select Currency</option>
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('broker_name') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Broker Name</label>
                {/* Sourced from /api/brokers/ (Broker master). PO stores
                    broker_name as a string for backward compat; the
                    dropdown just constrains input to the master list. */}
                <CustomSelect
                  name="broker_name"
                  value={formData.broker_name}
                  onChange={handleChange}
                  disabled={isReadOnly('broker_name')}
                  className={isReadOnly('broker_name') ? lockedInputClass : inputClass}
                >
                  <option value="">Select broker (optional)</option>
                  {(brokerList || []).map((b) => (
                    <option key={b.id} value={b.broker_name}>
                      {b.broker_name}{b.broker_code ? ` (${b.broker_code})` : ''}
                    </option>
                  ))}
                </CustomSelect>
              </div>
              )}
            </div>
          </div>

          {/* Line Items Section */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Line Items</h3>
              <button type="button" onClick={addLineItem} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 transition">
                <Plus size={14} /> Add Item
              </button>
            </div>
            {lineItems.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-4">No line items added. Click "Add Item" to add products.</p>
            ) : (
              <div className="space-y-3">
                {lineItems.map((item, index) => (
                  <div key={index} className="grid grid-cols-1 md:grid-cols-8 gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200 items-end">
                    {!isLineHidden('product_service') && (
                    <div className="col-span-2 md:col-span-2">
                      <label className="block text-xs font-medium text-slate-600 mb-1">Item <span className="text-red-500">*</span></label>
                      {/* Encoded "<TYPE>:<ID>" so the change handler can
                          recover the item_type without an extra lookup.
                          Items are grouped by type so users can scan
                          Products / Machinery / Services separately. */}
                      <CustomSelect
                        value={item.product ? `${item.item_type || 'PRODUCT'}:${item.product}` : ''}
                        onChange={e => {
                          const v = e.target.value;
                          if (!v) {
                            handleLineChange(index, 'product', '');
                            return;
                          }
                          const i = v.indexOf(':');
                          const type = i >= 0 ? v.slice(0, i) : 'PRODUCT';
                          const id = i >= 0 ? v.slice(i + 1) : v;
                          // GST% comes straight from the product master
                          // (Product.gst_percentage) — autofilled on pick,
                          // still editable.
                          const prod = (productRaw || []).find(pr => String(pr.id) === String(id));
                          const masterGst = (prod && prod.gst_percentage != null && prod.gst_percentage !== '')
                            ? String(prod.gst_percentage) : '';
                          setLineItems(prev => prev.map((row, ri) => ri === index ? {
                            ...row,
                            item_type: type,
                            product: id,
                            ...(masterGst !== '' ? { gst: masterGst } : {}),
                          } : row));
                          // Freight / payment (and GST as a fallback when the
                          // product master has none) from the last PO for this
                          // product — fills blanks only.
                          applyLastTerms(index, id, type);
                        }}
                        required
                        disabled={isLineRO('product_service')}
                        className={isLineRO('product_service') ? lockedLineInputClass : lineInputClass}
                      >
                        <option value="">Select Item</option>
                        {['PRODUCT', 'MACHINERY', 'SERVICE'].map(type => {
                          const items = (purchaseItems || []).filter(it => it.item_type === type);
                          if (items.length === 0) return null;
                          const groupLabel = type === 'PRODUCT' ? 'Products' : type === 'MACHINERY' ? 'Machinery' : 'Services';
                          return (
                            <optgroup key={type} label={groupLabel}>
                              {items
                                .slice()
                                .sort((a, b) => (a.item_name || '').localeCompare(b.item_name || ''))
                                .map(it => (
                                  <option key={`${it.item_type}:${it.item_id}`} value={`${it.item_type}:${it.item_id}`}>
                                    {it.label || it.item_name}
                                  </option>
                                ))}
                            </optgroup>
                          );
                        })}
                      </CustomSelect>
                    </div>
                    )}
                    <div>
                      {/* Category dropdown — drives Receipt routing.
                          PACKING_MATERIAL lines flow into the receipt
                          Packing Materials subform; others go to
                          Receipt Line Items. Pre-fills from the PR
                          line on PR→PO; editable on the PO so the
                          operator can override per order. */}
                      <label className="block text-xs font-medium text-slate-600 mb-1">Category</label>
                      <CustomSelect
                        value={item.category || ''}
                        onChange={e => handleLineChange(index, 'category', e.target.value)}
                        className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
                      >
                        <option value="">-</option>
                        <option value="RAW_MATERIAL">Raw Material</option>
                        <option value="PACKING_MATERIAL">Packing Material</option>
                        <option value="FINISHED_GOODS">Finished Goods</option>
                        {/* Preserve any free-form category text the
                            PR line carried (Machinery / Services PRs
                            store free-form values, not the goods enum). */}
                        {item.category
                          && !['RAW_MATERIAL', 'PACKING_MATERIAL', 'FINISHED_GOODS'].includes(item.category)
                          && <option value={item.category}>{item.category}</option>}
                      </CustomSelect>
                    </div>
                    {!isLineHidden('quantity_ordered') && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Qty <span className="text-red-500">*</span></label>
                      <input type="number" step="0.01" min="0.01" value={item.quantity} onChange={e => handleLineChange(index, 'quantity', e.target.value)} required disabled={isLineRO('quantity_ordered')} className={isLineRO('quantity_ordered') ? lockedLineInputClass : lineInputClass} />
                    </div>
                    )}
                    {!isLineHidden('uom') && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">UOM</label>
                      <input type="text" value={item.uom} onChange={e => handleLineChange(index, 'uom', e.target.value)} disabled={isLineRO('uom')} className={isLineRO('uom') ? lockedLineInputClass : lineInputClass} />
                    </div>
                    )}
                    {!isLineHidden('unit_price') && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Unit Price</label>
                      <input type="number" step="0.01" min="0" value={item.unit_price} onChange={e => handleLineChange(index, 'unit_price', e.target.value)} disabled={isLineRO('unit_price')} className={isLineRO('unit_price') ? lockedLineInputClass : lineInputClass} />
                    </div>
                    )}
                    {!isLineHidden('gst') && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">GST %</label>
                      <input type="number" step="0.01" min="0" max="100" value={item.gst} onChange={e => handleLineChange(index, 'gst', e.target.value)} disabled={isLineRO('gst')} className={isLineRO('gst') ? lockedLineInputClass : lineInputClass} />
                    </div>
                    )}
                    <div className="flex items-end">
                      <button type="button" onClick={() => removeLineItem(index)} className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition" title="Remove line">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional Information</h3>
            <div className="grid grid-cols-1 gap-4">
              {!isHidden('terms_and_conditions') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Terms and Conditions</label>
                <textarea name="terms_and_conditions" value={formData.terms_and_conditions} onChange={handleChange} rows={3} disabled={isReadOnly('terms_and_conditions')} className={isReadOnly('terms_and_conditions') ? lockedInputClass : inputClass} />
              </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
            </div>
          </div>

          <FileAttachments module="PO" recordId={null} onPendingChange={(files) => { pendingAttachmentsRef.current = files; setPendingAttachments(files); }} />

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isLoading ? 'Saving...' : isSkipRfq ? 'Create PO (Skip RFQ)' : 'Save'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
