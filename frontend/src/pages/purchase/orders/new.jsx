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

// Float design — compact floating-label inputs
const floatWrap = "relative";
const floatLabel = "absolute top-[3px] left-[7px] text-[8px] font-semibold text-slate-400 uppercase tracking-[0.04em] pointer-events-none z-10";
const floatInput = "w-full pt-[14px] pb-[3px] px-[7px] text-[11.5px] border border-slate-300 rounded-[6px] focus:ring-1 focus:ring-primary-500 focus:border-primary-500 bg-white";
const floatLocked = `${floatInput} bg-slate-100 cursor-not-allowed`;
const sectionTitle = "text-[11px] font-bold text-slate-500 uppercase tracking-wide";

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
  const { raw: brokerList } = useLookup('/api/brokers/');
  const { raw: purchaseItems } = useLookup('/api/purchase/items/');
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
          category: line.category || '',
        })));
      }
    } catch (e) {
      console.error('Failed to load skip-RFQ data:', e);
    }
  }, [isSkipRfq]);

  useEffect(() => {
    if (!skipRfqData?.warehouse || !warehouseOptions.length) return;
    if (warehouseOptions.find(o => o.value === skipRfqData.warehouse)) {
      setFormData(prev => ({ ...prev, warehouse: skipRfqData.warehouse }));
    }
  }, [warehouseOptions, skipRfqData]);

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
      if (isSkipRfq) {
        delete payload.linked_rfq;
      }
      if (import.meta.env.DEV) console.log('[CreatePurchaseOrder] payload:', payload);
      const res = await apiClient.post('/api/purchase/orders/', payload);
      const poId = res.data?.id;

      if (lineItems.length > 0 && poId) {
        const linePromises = lineItems
          .filter(l => l.product && l.quantity)
          .map((line, i) => {
            const itemType = (line.item_type || 'PRODUCT').toUpperCase();
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
        <div className="mb-2 bg-amber-50 border border-amber-200 rounded-[6px] px-3 py-2 flex items-center gap-2">
          <div className="w-7 h-7 rounded-[6px] bg-amber-500 flex items-center justify-center shrink-0">
            <SkipForward size={14} className="text-white" />
          </div>
          <div>
            <p className="text-[11px] font-semibold text-amber-800">RFQ Skipped — Direct PO Creation</p>
            <p className="text-[10px] text-amber-600">
              Creating PO from PR {skipRfqData?.pr_no || ''}. Select a Vendor and fill remaining fields.
            </p>
          </div>
        </div>
      )}

      {(() => {
        const message = paymentTermMessage(formData?.payment_terms);
        if (!message) return null;
        return (
          <div className="mb-2">
            <p className="inline-block bg-amber-100 border border-amber-300 text-amber-800 text-[11px] font-semibold px-3 py-1.5 rounded-[6px]">
              {message}
            </p>
          </div>
        );
      })()}

      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="space-y-2">
        {/* Order Details + Terms — single compact card */}
        <div className="bg-white rounded-[6px] border border-slate-200 px-3 py-2">
          <p className={`${sectionTitle} mb-1.5`}>Order Details</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
            {!isHidden('vendor') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Vendor *</label>
              <CustomSelect name="vendor" value={formData.vendor} onChange={handleChange} required disabled={isReadOnly('vendor')} className={isReadOnly('vendor') ? floatLocked : floatInput}>
                <option value="">Select Vendor</option>
                {filteredVendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('company') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Company *</label>
              <CustomSelect name="company" value={formData.company} onChange={handleChange} required disabled={isReadOnly('company')} className={isReadOnly('company') ? floatLocked : floatInput}>
                <option value="">Select Company</option>
                {companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('warehouse') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Warehouse *</label>
              <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleChange} required disabled={isReadOnly('warehouse') || !formData.company} className={isReadOnly('warehouse') ? floatLocked : `${floatInput} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                <option value="">{formData.company ? 'Select Warehouse' : 'Select company first...'}</option>
                {warehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('linked_prs') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Linked PR</label>
              {isSkipRfq ? (
                <input type="text" name="linked_prs" value={skipRfqData?.pr_no || formData.linked_prs} readOnly className={floatLocked} />
              ) : (
                <CustomSelect name="linked_prs" value={formData.linked_prs} onChange={handleChange} disabled={isReadOnly('linked_prs')} className={isReadOnly('linked_prs') ? floatLocked : floatInput}>
                  <option value="">Select Purchase Request</option>
                  {prOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              )}
            </div>
            )}
            {!isHidden('linked_rfq') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Linked RFQ</label>
              {isSkipRfq ? (
                <div className={`${floatInput} border-amber-300 bg-amber-50 text-amber-700 font-semibold`}>
                  <span className="invisible text-[8px]">x</span>SKIP RFQ
                </div>
              ) : (
                <CustomSelect name="linked_rfq" value={formData.linked_rfq} onChange={handleChange} disabled={isReadOnly('linked_rfq')} className={isReadOnly('linked_rfq') ? floatLocked : floatInput}>
                  <option value="">Select RFQ</option>
                  {rfqOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              )}
            </div>
            )}
            {!isHidden('po_date') && (
            <div className={floatWrap}>
              <label className={floatLabel}>PO Date *</label>
              <CustomDatePicker name="po_date" value={formData.po_date} onChange={handleChange} required disabled={isReadOnly('po_date')} className={isReadOnly('po_date') ? floatLocked : floatInput} />
            </div>
            )}
            {!isHidden('expected_delivery_start') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Delivery Start</label>
              <CustomDatePicker name="expected_delivery_start" value={formData.expected_delivery_start} onChange={handleChange} disabled={isReadOnly('expected_delivery_start')} className={isReadOnly('expected_delivery_start') ? floatLocked : floatInput} />
            </div>
            )}
            {!isHidden('expected_delivery_end') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Delivery End</label>
              <CustomDatePicker name="expected_delivery_end" value={formData.expected_delivery_end} onChange={handleChange} disabled={isReadOnly('expected_delivery_end')} className={isReadOnly('expected_delivery_end') ? floatLocked : floatInput} />
            </div>
            )}
            {!isHidden('freight_terms') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Freight Terms *</label>
              <CustomSelect name="freight_terms" value={formData.freight_terms} onChange={handleChange} required disabled={isReadOnly('freight_terms')} className={isReadOnly('freight_terms') ? floatLocked : floatInput}>
                <option value="">Select Freight Terms</option>
                {withCurrent(FREIGHT_TERM_OPTIONS, formData.freight_terms).map(o => <option key={o} value={o}>{o}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('payment_terms') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Payment Terms</label>
              <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} disabled={isReadOnly('payment_terms')} className={isReadOnly('payment_terms') ? floatLocked : floatInput}>
                <option value="">Select Payment Terms</option>
                {withCurrent(PAYMENT_TERM_OPTIONS, formData.payment_terms).map(o => <option key={o} value={o}>{o}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('currency') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Currency *</label>
              <CustomSelect name="currency" value={formData.currency} onChange={handleChange} required disabled={isReadOnly('currency')} className={isReadOnly('currency') ? floatLocked : floatInput}>
                <option value="">Select Currency</option>
                <option value="INR">INR</option>
                <option value="USD">USD</option>
              </CustomSelect>
            </div>
            )}
            {!isHidden('broker_name') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Broker Name</label>
              <CustomSelect name="broker_name" value={formData.broker_name} onChange={handleChange} disabled={isReadOnly('broker_name')} className={isReadOnly('broker_name') ? floatLocked : floatInput}>
                <option value="">Select broker (optional)</option>
                {(brokerList || []).map((b) => (
                  <option key={b.id} value={b.broker_name}>
                    {b.broker_name}{b.broker_code ? ` (${b.broker_code})` : ''}
                  </option>
                ))}
              </CustomSelect>
            </div>
            )}
            {!isHidden('terms_and_conditions') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Terms & Conditions</label>
              <input type="text" name="terms_and_conditions" value={formData.terms_and_conditions} onChange={handleChange} disabled={isReadOnly('terms_and_conditions')} className={isReadOnly('terms_and_conditions') ? floatLocked : floatInput} placeholder=" " />
            </div>
            )}
            <div className={floatWrap}>
              <label className={floatLabel}>Notes</label>
              <input type="text" name="notes" value={formData.notes} onChange={handleChange} className={floatInput} placeholder=" " />
            </div>
          </div>
        </div>

        {/* Line Items */}
        <div className="bg-white rounded-[6px] border border-slate-200 px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <p className={sectionTitle}>Line Items</p>
            <button type="button" onClick={addLineItem} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-primary-700 bg-primary-50 rounded-[6px] hover:bg-primary-100 transition">
              <Plus size={12} /> Add Item
            </button>
          </div>
          {lineItems.length === 0 ? (
            <p className="text-[11px] text-slate-400 text-center py-3">No line items added. Click "Add Item" to add products.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-[11px]">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-2 py-1 whitespace-nowrap" style={{ fontSize: 9 }}>#</th>
                    {!isLineHidden('product_service') && <th className="text-left px-2 py-1 whitespace-nowrap" style={{ fontSize: 9 }}>ITEM *</th>}
                    <th className="text-left px-2 py-1 whitespace-nowrap" style={{ fontSize: 9 }}>CATEGORY</th>
                    {!isLineHidden('quantity_ordered') && <th className="text-left px-2 py-1 whitespace-nowrap" style={{ fontSize: 9 }}>QTY *</th>}
                    {!isLineHidden('uom') && <th className="text-left px-2 py-1 whitespace-nowrap" style={{ fontSize: 9 }}>UOM</th>}
                    {!isLineHidden('unit_price') && <th className="text-left px-2 py-1 whitespace-nowrap" style={{ fontSize: 9 }}>UNIT PRICE</th>}
                    {!isLineHidden('gst') && <th className="text-left px-2 py-1 whitespace-nowrap" style={{ fontSize: 9 }}>GST %</th>}
                    <th className="text-center px-2 py-1 whitespace-nowrap" style={{ fontSize: 9 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((item, index) => (
                    <tr key={index} className="border-b border-slate-100">
                      <td className="px-2 py-1 text-slate-500">{index + 1}</td>
                      {!isLineHidden('product_service') && (
                      <td className="px-2 py-1">
                        <CustomSelect
                          value={item.product ? `${item.item_type || 'PRODUCT'}:${item.product}` : ''}
                          onChange={e => {
                            const v = e.target.value;
                            if (!v) { handleLineChange(index, 'product', ''); return; }
                            const i = v.indexOf(':');
                            const type = i >= 0 ? v.slice(0, i) : 'PRODUCT';
                            const id = i >= 0 ? v.slice(i + 1) : v;
                            const prod = (productRaw || []).find(pr => String(pr.id) === String(id));
                            const masterGst = (prod && prod.gst_percentage != null && prod.gst_percentage !== '')
                              ? String(prod.gst_percentage) : '';
                            setLineItems(prev => prev.map((row, ri) => ri === index ? {
                              ...row, item_type: type, product: id,
                              ...(masterGst !== '' ? { gst: masterGst } : {}),
                            } : row));
                            applyLastTerms(index, id, type);
                          }}
                          required
                          disabled={isLineRO('product_service')}
                          className="w-full px-1.5 py-1 border border-slate-300 rounded-[4px] text-[11px]"
                          style={{ minWidth: 160 }}
                        >
                          <option value="">Select Item</option>
                          {['PRODUCT', 'MACHINERY', 'SERVICE'].map(type => {
                            const items = (purchaseItems || []).filter(it => it.item_type === type);
                            if (items.length === 0) return null;
                            const groupLabel = type === 'PRODUCT' ? 'Products' : type === 'MACHINERY' ? 'Machinery' : 'Services';
                            return (
                              <optgroup key={type} label={groupLabel}>
                                {items.slice().sort((a, b) => (a.item_name || '').localeCompare(b.item_name || '')).map(it => (
                                  <option key={`${it.item_type}:${it.item_id}`} value={`${it.item_type}:${it.item_id}`}>
                                    {it.label || it.item_name}
                                  </option>
                                ))}
                              </optgroup>
                            );
                          })}
                        </CustomSelect>
                      </td>
                      )}
                      <td className="px-2 py-1">
                        <CustomSelect value={item.category || ''} onChange={e => handleLineChange(index, 'category', e.target.value)} className="w-full px-1.5 py-1 border border-slate-300 rounded-[4px] text-[11px]">
                          <option value="">-</option>
                          <option value="RAW_MATERIAL">Raw Material</option>
                          <option value="PACKING_MATERIAL">Packing Material</option>
                          <option value="FINISHED_GOODS">Finished Goods</option>
                          {item.category && !['RAW_MATERIAL', 'PACKING_MATERIAL', 'FINISHED_GOODS'].includes(item.category) && <option value={item.category}>{item.category}</option>}
                        </CustomSelect>
                      </td>
                      {!isLineHidden('quantity_ordered') && (
                      <td className="px-2 py-1">
                        <input type="number" step="0.01" min="0.01" value={item.quantity} onChange={e => handleLineChange(index, 'quantity', e.target.value)} required disabled={isLineRO('quantity_ordered')} className="w-20 px-1.5 py-1 border border-slate-300 rounded-[4px] text-[11px]" />
                      </td>
                      )}
                      {!isLineHidden('uom') && (
                      <td className="px-2 py-1">
                        <input type="text" value={item.uom} onChange={e => handleLineChange(index, 'uom', e.target.value)} disabled={isLineRO('uom')} className="w-16 px-1.5 py-1 border border-slate-300 rounded-[4px] text-[11px]" />
                      </td>
                      )}
                      {!isLineHidden('unit_price') && (
                      <td className="px-2 py-1">
                        <input type="number" step="0.01" min="0" value={item.unit_price} onChange={e => handleLineChange(index, 'unit_price', e.target.value)} disabled={isLineRO('unit_price')} className="w-24 px-1.5 py-1 border border-slate-300 rounded-[4px] text-[11px]" />
                      </td>
                      )}
                      {!isLineHidden('gst') && (
                      <td className="px-2 py-1">
                        <input type="number" step="0.01" min="0" max="100" value={item.gst} onChange={e => handleLineChange(index, 'gst', e.target.value)} disabled={isLineRO('gst')} className="w-16 px-1.5 py-1 border border-slate-300 rounded-[4px] text-[11px]" />
                      </td>
                      )}
                      <td className="px-2 py-1 text-center">
                        <button type="button" onClick={() => removeLineItem(index)} className="p-0.5 text-red-500 hover:bg-red-50 rounded transition" title="Remove line">
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <FileAttachments module="PO" recordId={null} onPendingChange={(files) => { pendingAttachmentsRef.current = files; setPendingAttachments(files); }} />

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={() => navigate(-1)} className="px-4 py-1.5 border border-slate-300 rounded-[6px] text-[11.5px] font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={isLoading} className="px-4 py-1.5 bg-primary-600 text-white rounded-[6px] text-[11.5px] font-medium hover:bg-primary-700 disabled:opacity-50">
            {isLoading ? 'Saving...' : isSkipRfq ? 'Create PO (Skip RFQ)' : 'Save'}
          </button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
