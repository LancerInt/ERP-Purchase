import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, Paperclip, X } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatCurrency } from '@/utils/formatters';
import { formatAddressDisplay } from '../../../components/common/AddressField';
import { UOM_OPTIONS, UOM_VALUES } from '../../../constants/uom.js';
import { isZeroRatedTreatment, gstTreatmentLabel } from '../../../constants/gstTreatment.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const GOODS_SUB_TYPE_OPTIONS = [
  { value: '', label: 'Select Category' },
  { value: 'RAW_MATERIAL', label: 'Raw Material' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'FINISHED_GOOD', label: 'Finished Good' },
  { value: 'SEMI_FINISHED', label: 'Semi Finished' },
  { value: 'TRADED_PRODUCTS', label: 'Traded Products' },
  { value: 'CAPITAL_GOOD', label: 'Capital Good' },
  { value: 'MACHINE_SPARES', label: 'Machine Spares' },
  { value: 'CONSUMABLES', label: 'Consumables' },
];
// GST options — the label is stored; the effective total rate is the sum of
// its parts (2.5+2.5 → 5%, 9+9 → 18%).
const GST_OPTIONS = ['2.5+2.5', '5', '9+9', '18'];
const gstEffective = (label) => String(label || '').split('+').reduce((s, p) => s + (parseFloat(p) || 0), 0);
// Split a GST label into CGST/SGST (intra-state "a+b") or IGST (single number)
// amounts for a taxable base. "2.5+2.5" → CGST+SGST; "18" → IGST.
const gstBreakdown = (label, taxable) => {
  const parts = String(label || '').split('+').map((p) => parseFloat(p) || 0);
  if (parts.length >= 2) return { cgst: taxable * parts[0] / 100, sgst: taxable * parts[1] / 100, igst: 0 };
  return { cgst: 0, sgst: 0, igst: taxable * (parts[0] || 0) / 100 };
};
const GST_ADD = '__ADD_GST__';
const blankLine = () => ({ product_category: '', hsn_code: '', product: '', description: '', quantity: 1, uom: 'KG', unit_price: '', discount: '0', gst_type: '', gst: '0', remarks: '' });

// Freight / Delivery add-able dropdown. Picks from `options`, or reveals an
// inline input to add a new one (persisted server-side; duplicates rejected).
function TermSelect({ value, onChange, options, onAdd, placeholder }) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState('');
  const save = async () => {
    const ok = await onAdd(val);
    if (ok) { onChange(val.trim()); setVal(''); setAdding(false); }
  };
  if (adding) {
    return (
      <div className="flex gap-1">
        <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} className={inputClass} placeholder="New option"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
        <button type="button" onClick={save} className="px-3 rounded-lg bg-primary-600 text-white text-sm shrink-0">Add</button>
        <button type="button" onClick={() => { setAdding(false); setVal(''); }} className="px-2 rounded-lg border border-slate-300 text-slate-500 shrink-0"><X size={14} /></button>
      </div>
    );
  }
  return (
    <div className="flex gap-1">
      <CustomSelect value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">{placeholder || 'Select'}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </CustomSelect>
      <button type="button" onClick={() => setAdding(true)} title="Add option" className="px-2.5 rounded-lg border border-primary-300 text-primary-600 hover:bg-primary-50 shrink-0"><Plus size={16} /></button>
    </div>
  );
}

export default function SalesQuoteNew() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Sales Quote');
  const [saving, setSaving] = useState(false);

  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: productOptions, raw: rawProducts } = useLookup('/api/products/');

  const todayStr = new Date().toLocaleDateString('en-GB'); // dd/mm/yyyy — the quote's creation date
  const [quoteNo, setQuoteNo] = useState('');
  const [freightOptions, setFreightOptions] = useState([]);
  const [deliveryOptions, setDeliveryOptions] = useState([]);
  const [gstOptions, setGstOptions] = useState([]);
  const [mailAttachments, setMailAttachments] = useState([]); // File[] — emailed
  const [otherAttachments, setOtherAttachments] = useState([]); // File[] — kept only
  const mailFileRef = useRef(null);
  const otherFileRef = useRef(null);

  const [formData, setFormData] = useState({
    customer: '', customer_name: '', customer_email: '', company: '', warehouse: '',
    payment_terms: 'NET_30', currency: 'INR', delivery_terms: '',
    freight_terms: '', destination: '', dispatched_through: '',
    consignee_name: '', consignee_address: '', consignee_gstin: '',
    billing_address: '', billing_gstin: '', special_instructions: '', remarks: '',
  });
  const [lines, setLines] = useState([blankLine()]);

  // Company-scoped customers (Old Customer picker) + warehouses.
  const { options: customerOptions, raw: rawCustomers } = useLookup(formData.company ? `/api/customers/?company=${formData.company}` : null);
  const { options: warehouseOptions } = useLookup(formData.company ? `/api/warehouses/?company=${formData.company}&sales_scope=true` : null);

  // Preview the next quote number + load the Freight/Delivery term options.
  useEffect(() => {
    apiClient.get('/api/sales/quotations/next-number/').then((r) => setQuoteNo(r.data?.quote_no || '')).catch(() => {});
    apiClient.get('/api/sales/quotations/term-options/').then((r) => {
      const rows = r.data || [];
      setFreightOptions(rows.filter((o) => o.kind === 'FREIGHT').map((o) => o.value));
      setDeliveryOptions(rows.filter((o) => o.kind === 'DELIVERY').map((o) => o.value));
      setGstOptions(rows.filter((o) => o.kind === 'GST').map((o) => o.value));
    }).catch(() => {});
  }, []);

  const set = (k, v) => setFormData((p) => ({ ...p, [k]: v }));

  // Zero-rated customer (SEZ / Overseas / Deemed Export) → their supplies are
  // zero-rated, so we default line GST to 0% (still editable for "with payment"
  // cases). Resolved from the selected Old Customer's gst_treatment.
  const selectedCustomer = (rawCustomers || []).find((x) => String(x.id) === String(formData.customer));
  const isZeroRated = isZeroRatedTreatment(selectedCustomer?.gst_treatment);

  // Old Customer chosen → copy its name into the Customer field + auto-fill the
  // billing / consignee addresses from the master.
  const onOldCustomer = (custId) => {
    const c = (rawCustomers || []).find((x) => String(x.id) === String(custId));
    // Zero-rated customer → reset every line's GST to 0 (supply is zero-rated).
    if (c && isZeroRatedTreatment(c.gst_treatment)) {
      setLines((prev) => prev.map((l) => ({ ...l, gst_type: '', gst: '0' })));
    }
    // Addresses are stored as JSON dicts ({raw_address, district, state,
    // pincode, country}); format them to readable text. Ship-to comes from
    // the customer's first shipping address; billing falls back to it.
    const shipAddr = c ? formatAddressDisplay(c.shipping_addresses?.[0]?.address) : '';
    const billAddr = c ? (formatAddressDisplay(c.billing_address) || shipAddr) : '';
    setFormData((p) => ({
      ...p,
      customer: custId,
      customer_name: c ? (c.customer_name || c.name || p.customer_name) : p.customer_name,
      customer_email: c ? (c.contact_email || c.email || p.customer_email) : p.customer_email,
      billing_address: c ? (billAddr || p.billing_address) : p.billing_address,
      billing_gstin: c ? (c.gstin || p.billing_gstin) : p.billing_gstin,
      consignee_name: c ? (c.customer_name || c.name || p.consignee_name) : p.consignee_name,
      consignee_address: c ? (shipAddr || billAddr || p.consignee_address) : p.consignee_address,
      consignee_gstin: c ? (c.gstin || p.consignee_gstin) : p.consignee_gstin,
    }));
  };

  const addTerm = (kind) => async (value) => {
    const v = (value || '').trim();
    if (!v) { toast.error('Enter a value.'); return false; }
    const list = kind === 'FREIGHT' ? freightOptions : deliveryOptions;
    if (list.some((o) => o.toLowerCase() === v.toLowerCase())) { toast.error('That option already exists.'); return false; }
    try {
      await apiClient.post('/api/sales/quotations/term-options/', { kind, value: v });
      if (kind === 'FREIGHT') setFreightOptions((p) => [...p, v]); else setDeliveryOptions((p) => [...p, v]);
      return true;
    } catch (err) { toast.error(getApiErrorMessage(err)); return false; }
  };

  const setLine = (idx, field, value) => setLines((prev) => prev.map((l, i) => {
    if (i !== idx) return l;
    const next = { ...l, [field]: value };
    if (field === 'product_category') next.product = '';
    if (field === 'gst_type') next.gst = String(gstEffective(value));
    if (field === 'product' && value) {
      const prod = (rawProducts || []).find((p) => String(p.id) === String(value));
      if (prod?.goods_sub_type) next.product_category = prod.goods_sub_type;
      if (prod?.uom) next.uom = prod.uom;
      if (prod?.hsn_code && !next.hsn_code) next.hsn_code = prod.hsn_code;
    }
    return next;
  }));
  const addLine = () => setLines((p) => [...p, blankLine()]);
  const removeLine = (idx) => setLines((p) => (p.length <= 1 ? p : p.filter((_, i) => i !== idx)));

  const getFilteredProducts = (category) => {
    if (!category) return productOptions;
    return (rawProducts || []).filter((p) => p.goods_sub_type === category).map((p) => ({ value: p.id, label: p.product_name || p.name || p.sku_code || p.id }));
  };
  const usedProducts = (idx) => new Set(lines.filter((_, i) => i !== idx).map((l) => String(l.product)).filter(Boolean));

  const totals = useMemo(() => {
    let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
    lines.forEach((l) => {
      const base = (Number(l.quantity) || 0) * (Number(l.unit_price) || 0) - (Number(l.discount) || 0);
      subtotal += base;
      const b = gstBreakdown(l.gst_type, base);
      cgst += b.cgst; sgst += b.sgst; igst += b.igst;
    });
    const tax = cgst + sgst + igst;
    return { subtotal, cgst, sgst, igst, tax, grand: subtotal + tax };
  }, [lines]);

  const gstList = gstOptions.length ? gstOptions : GST_OPTIONS;
  // GST per line is add-able: the "+ Add rate…" option prompts for a new rate,
  // persists it (kind=GST, no duplicates), and selects it on this line.
  const onGstChange = async (idx, value) => {
    if (value !== GST_ADD) { setLine(idx, 'gst_type', value); return; }
    const v = (window.prompt('New GST rate — a single number for IGST (e.g. 12), or "a+b" for CGST+SGST (e.g. 6+6):') || '').trim();
    if (!v) return;
    if (!/^\d+(\.\d+)?(\+\d+(\.\d+)?)?$/.test(v)) { toast.error('Enter a number like 12 or 6+6.'); return; }
    if (gstList.some((o) => o === v)) { toast.error('That rate already exists.'); setLine(idx, 'gst_type', v); return; }
    try {
      await apiClient.post('/api/sales/quotations/term-options/', { kind: 'GST', value: v });
      setGstOptions((p) => (p.length ? [...p, v] : [...GST_OPTIONS, v]));
      setLine(idx, 'gst_type', v);
    } catch (err) { toast.error(getApiErrorMessage(err)); }
  };

  const onFiles = (setter, ref) => (e) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length) setter((p) => [...p, ...picked]);
    if (ref.current) ref.current.value = '';
  };
  const removeFile = (setter, i) => setter((p) => p.filter((_, idx) => idx !== i));
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.company) { toast.error('Company is required.'); return; }
    if (!(formData.customer_name || '').trim()) { toast.error('Customer is required.'); return; }
    if ((formData.customer_email || '').trim() && !EMAIL_RE.test(formData.customer_email.trim())) { toast.error('Enter a valid customer email.'); return; }
    if (!formData.warehouse) { toast.error('Warehouse is required (needed to convert the quote into a Sales Order).'); return; }
    const valid = lines.filter((l) => l.product);
    if (valid.length === 0) { toast.error('Add at least one product line.'); return; }
    for (let i = 0; i < valid.length; i++) {
      if (!(Number(valid[i].quantity) > 0)) { toast.error(`Line ${i + 1}: Quantity must be greater than 0.`); return; }
      if (!(Number(valid[i].unit_price) > 0)) { toast.error(`Line ${i + 1}: Unit Price must be greater than 0.`); return; }
    }
    setSaving(true);
    try {
      const payload = {
        ...formData,
        customer: formData.customer || null,
        warehouse: formData.warehouse || null,
        quotation_lines: valid.map((l, i) => ({
          line_no: i + 1, product: l.product, hsn_code: l.hsn_code || '', description: l.description || '',
          quantity: l.quantity, uom: l.uom || 'KG', unit_price: l.unit_price, discount: l.discount || 0,
          gst: gstEffective(l.gst_type), gst_type: l.gst_type || '', remarks: l.remarks || '',
        })),
      };
      const res = await apiClient.post('/api/sales/quotations/', payload);
      const id = res.data?.id;
      // Upload attachments after the quote exists (best-effort per file).
      if (id) {
        const uploadBucket = async (files, category) => {
          for (const f of files) {
            const fd = new FormData();
            fd.append('file', f);
            fd.append('category', category);
            try { await apiClient.post(`/api/sales/quotations/${id}/attachments/`, fd); } catch { /* ignore */ }
          }
        };
        await uploadBucket(mailAttachments, 'MAIL');
        await uploadBucket(otherAttachments, 'OTHER');
      }
      toast.success('Quotation created!');
      navigate(id ? `/sales/quotes/${id}` : '/sales/quotes');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally { setSaving(false); }
  };

  return (
    <MainLayout>
      <PageHeader title="Create Sales Quotation" breadcrumbs={[{ label: 'Sales', href: '/sales/dashboard' }, { label: 'Sales Quote', href: '/sales/quotes' }, { label: 'New' }]} />
      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
        <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
          <h3 className="text-base font-semibold text-slate-800 mb-3 pb-2 border-b">Quote Details</h3>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Quote No</label>
              <input type="text" value={quoteNo} disabled className={`${inputClass} bg-slate-100 text-slate-500`} placeholder="Auto-generated" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Date</label>
              <input type="text" value={todayStr} disabled className={`${inputClass} bg-slate-100 text-slate-500`} />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
              <CustomSelect value={formData.company} onChange={(e) => { set('company', e.target.value); set('customer', ''); set('warehouse', ''); }} className={inputClass}>
                <option value="">Select Company</option>
                {companyOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Old Customer</label>
              <CustomSelect value={formData.customer} onChange={(e) => onOldCustomer(e.target.value)} disabled={!formData.company} className={inputClass}>
                <option value="">{formData.company ? 'Select (optional)' : 'Select Company first'}</option>
                {customerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Customer <span className="text-red-500">*</span></label>
              <input type="text" value={formData.customer_name} onChange={(e) => set('customer_name', e.target.value)} className={inputClass} placeholder="Customer name" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Customer Email</label>
              <input type="email" value={formData.customer_email} onChange={(e) => set('customer_email', e.target.value)}
                className={`${inputClass} ${(formData.customer_email || '').trim() && !EMAIL_RE.test(formData.customer_email.trim()) ? 'border-red-400 focus:ring-red-400' : ''}`}
                placeholder="customer@email.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
              <CustomSelect value={formData.warehouse} onChange={(e) => set('warehouse', e.target.value)} disabled={!formData.company} className={inputClass}>
                <option value="">{formData.company ? 'Select Warehouse' : 'Select Company first'}</option>
                {warehouseOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms</label>
              <CustomSelect value={formData.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} className={inputClass}>
                <option value="">Select</option><option value="NET_15">NET 15</option><option value="NET_30">NET 30</option><option value="NET_45">NET 45</option><option value="NET_60">NET 60</option><option value="ADVANCE">Advance</option>
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Currency</label>
              <CustomSelect value={formData.currency} onChange={(e) => set('currency', e.target.value)} className={`${inputClass} max-w-[130px]`}>
                <option value="INR">INR</option><option value="USD">USD</option><option value="EUR">EUR</option>
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Delivery Terms</label>
              <TermSelect value={formData.delivery_terms} onChange={(v) => setFormData((p) => ({ ...p, delivery_terms: v, freight_terms: (v === 'Ex Factory' && !p.freight_terms) ? 'Paid' : p.freight_terms }))} options={deliveryOptions} onAdd={addTerm('DELIVERY')} placeholder="Select" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Freight Terms</label>
              <TermSelect value={formData.freight_terms} onChange={(v) => set('freight_terms', v)} options={freightOptions} onAdd={addTerm('FREIGHT')} placeholder="Select" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
          <div className="flex items-center justify-between mb-3 pb-2 border-b">
            <h3 className="text-base font-semibold text-slate-800">Line Items</h3>
            <button type="button" onClick={addLine} className="flex items-center gap-1 px-3 py-1.5 text-sm text-primary-600 border border-primary-300 rounded-lg hover:bg-primary-50"><Plus size={16} /> Add Item</button>
          </div>
          {isZeroRated && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
              <strong>{gstTreatmentLabel(selectedCustomer?.gst_treatment)}</strong> customer — this supply is zero-rated, so GST is defaulted to 0%. Set a GST rate on a line only for a "with payment of tax" export.
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b text-left text-slate-600">
                  <th className="px-3 py-2 font-medium w-10">#</th>
                  <th className="px-3 py-2 font-medium w-40">Category</th>
                  <th className="px-3 py-2 font-medium w-28">HSN</th>
                  <th className="px-3 py-2 font-medium">Product <span className="text-red-500">*</span></th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium w-24">Qty <span className="text-red-500">*</span></th>
                  <th className="px-3 py-2 font-medium w-20">UOM</th>
                  <th className="px-3 py-2 font-medium w-28">Unit Price <span className="text-red-500">*</span></th>
                  <th className="px-3 py-2 font-medium w-20">Disc</th>
                  <th className="px-3 py-2 font-medium w-24">GST</th>
                  <th className="px-3 py-2 font-medium text-right w-28">Total</th>
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => {
                  const used = usedProducts(idx);
                  const base = (Number(l.quantity) || 0) * (Number(l.unit_price) || 0) - (Number(l.discount) || 0);
                  const total = base + base * (Number(l.gst) || 0) / 100;
                  return (
                    <tr key={idx} className="border-b border-slate-100">
                      <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <CustomSelect value={l.product_category || ''} onChange={(e) => setLine(idx, 'product_category', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" style={{ minWidth: '140px' }}>
                          {GOODS_SUB_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2"><input type="text" value={l.hsn_code} onChange={(e) => setLine(idx, 'hsn_code', e.target.value)} placeholder="HSN" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" style={{ minWidth: '90px' }} /></td>
                      <td className="px-3 py-2">
                        <CustomSelect value={l.product} onChange={(e) => setLine(idx, 'product', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" style={{ minWidth: '180px' }}>
                          <option value="">Select Product</option>
                          {getFilteredProducts(l.product_category).filter((o) => !used.has(String(o.value))).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2"><input type="text" value={l.description} onChange={(e) => setLine(idx, 'description', e.target.value)} placeholder="Description" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" style={{ minWidth: '160px' }} /></td>
                      <td className="px-3 py-2"><input type="number" min="0.01" step="any" required value={l.quantity} onChange={(e) => setLine(idx, 'quantity', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" /></td>
                      <td className="px-3 py-2">
                        <CustomSelect value={l.uom} onChange={(e) => setLine(idx, 'uom', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm">
                          {l.uom && !UOM_VALUES.includes(l.uom) && <option value={l.uom}>{l.uom}</option>}
                          {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2"><input type="number" min="0" step="any" required value={l.unit_price} onChange={(e) => setLine(idx, 'unit_price', e.target.value)} placeholder="0.00" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm text-right" /></td>
                      <td className="px-3 py-2"><input type="number" min="0" step="any" value={l.discount} onChange={(e) => setLine(idx, 'discount', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm text-right" /></td>
                      <td className="px-3 py-2">
                        <CustomSelect value={l.gst_type} onChange={(e) => onGstChange(idx, e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" style={{ minWidth: '90px' }}>
                          <option value="">GST</option>
                          {gstList.map((o) => <option key={o} value={o}>{o}</option>)}
                          <option value={GST_ADD}>+ Add rate…</option>
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-800">{total > 0 ? formatCurrency(total) : '-'}</td>
                      <td className="px-3 py-2 text-center"><button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} className="p-1 text-red-500 hover:bg-red-50 rounded disabled:opacity-30"><Trash2 size={16} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end mt-4">
            <div className="w-72 bg-slate-50 rounded-lg border border-slate-200 p-4 text-sm space-y-2">
              <div className="flex justify-between"><span className="text-slate-600">Subtotal</span><span className="font-medium tabular-nums">{formatCurrency(totals.subtotal)}</span></div>
              {totals.cgst > 0 && <div className="flex justify-between"><span className="text-slate-600">CGST</span><span className="font-medium tabular-nums">{formatCurrency(totals.cgst)}</span></div>}
              {totals.sgst > 0 && <div className="flex justify-between"><span className="text-slate-600">SGST</span><span className="font-medium tabular-nums">{formatCurrency(totals.sgst)}</span></div>}
              {totals.igst > 0 && <div className="flex justify-between"><span className="text-slate-600">IGST</span><span className="font-medium tabular-nums">{formatCurrency(totals.igst)}</span></div>}
              {totals.tax === 0 && <div className="flex justify-between"><span className="text-slate-600">GST</span><span className="font-medium tabular-nums">{formatCurrency(0)}</span></div>}
              <div className="flex justify-between pt-2 border-t font-semibold"><span>Grand Total</span><span className="tabular-nums">{formatCurrency(totals.grand)}</span></div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Attachment for Mail — emailed to the customer with the quote. */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
            <div className="flex items-center justify-between mb-3 pb-2 border-b">
              <h3 className="text-base font-semibold text-slate-800">Attachment for Mail</h3>
              <button type="button" onClick={() => mailFileRef.current?.click()} className="flex items-center gap-1 px-3 py-1.5 text-sm text-primary-600 border border-primary-300 rounded-lg hover:bg-primary-50"><Paperclip size={15} /> Add file(s)</button>
            </div>
            <input ref={mailFileRef} type="file" multiple className="hidden" onChange={onFiles(setMailAttachments, mailFileRef)} />
            {mailAttachments.length === 0 ? (
              <p className="text-sm text-slate-400">No files. These file(s) are emailed to the customer along with the quote PDF.</p>
            ) : (
              <ul className="space-y-1.5">
                {mailAttachments.map((f, i) => (
                  <li key={i} className="flex items-center justify-between text-sm bg-slate-50 border border-slate-200 rounded px-3 py-1.5">
                    <span className="truncate flex items-center gap-2"><Paperclip size={13} className="text-slate-400 shrink-0" />{f.name}</span>
                    <button type="button" onClick={() => removeFile(setMailAttachments, i)} className="text-red-500 shrink-0"><X size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {/* Attachment — kept on the quote only (not emailed). */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
            <div className="flex items-center justify-between mb-3 pb-2 border-b">
              <h3 className="text-base font-semibold text-slate-800">Attachment</h3>
              <button type="button" onClick={() => otherFileRef.current?.click()} className="flex items-center gap-1 px-3 py-1.5 text-sm text-primary-600 border border-primary-300 rounded-lg hover:bg-primary-50"><Paperclip size={15} /> Add file(s)</button>
            </div>
            <input ref={otherFileRef} type="file" multiple className="hidden" onChange={onFiles(setOtherAttachments, otherFileRef)} />
            {otherAttachments.length === 0 ? (
              <p className="text-sm text-slate-400">No files. Kept on the quote for reference — not emailed.</p>
            ) : (
              <ul className="space-y-1.5">
                {otherAttachments.map((f, i) => (
                  <li key={i} className="flex items-center justify-between text-sm bg-slate-50 border border-slate-200 rounded px-3 py-1.5">
                    <span className="truncate flex items-center gap-2"><Paperclip size={13} className="text-slate-400 shrink-0" />{f.name}</span>
                    <button type="button" onClick={() => removeFile(setOtherAttachments, i)} className="text-red-500 shrink-0"><X size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
          <h3 className="text-base font-semibold text-slate-800 mb-3 pb-2 border-b">Consignee / Billing &amp; Notes (optional)</h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-2">
              <input type="text" value={formData.consignee_name} onChange={(e) => set('consignee_name', e.target.value)} className={inputClass} placeholder="Consignee (Ship to) name" />
              <textarea value={formData.consignee_address} onChange={(e) => set('consignee_address', e.target.value)} rows={2} className={inputClass} placeholder="Consignee address" />
              <input type="text" value={formData.consignee_gstin} onChange={(e) => set('consignee_gstin', e.target.value)} className={inputClass} placeholder="Consignee GSTIN" />
            </div>
            <div className="space-y-2">
              <textarea value={formData.billing_address} onChange={(e) => set('billing_address', e.target.value)} rows={2} className={inputClass} placeholder="Billing address" />
              <input type="text" value={formData.billing_gstin} onChange={(e) => set('billing_gstin', e.target.value)} className={inputClass} placeholder="Billing GSTIN" />
              <textarea value={formData.remarks} onChange={(e) => set('remarks', e.target.value)} rows={2} className={inputClass} placeholder="Remarks / terms shown on the quote" />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => navigate('/sales/quotes')} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{saving ? 'Saving…' : 'Create Quote'}</button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
