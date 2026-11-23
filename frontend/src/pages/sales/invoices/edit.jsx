import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import AddressField from '../../../components/common/AddressField';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import { SALES_UOM_OPTIONS } from '../utils/uomOptions';
import { formatCurrency as sharedFormatCurrency } from '@/utils/formatters';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const readOnlyClass = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-100 text-slate-600 cursor-not-allowed';

const PAYMENT_TERMS_OPTIONS = [
  { value: '', label: 'Select Payment Terms' },
  { value: 'IMMEDIATE', label: 'Immediate' },
  { value: 'NET15', label: 'Net 15 Days' },
  { value: 'NET30', label: 'Net 30 Days' },
  { value: 'NET45', label: 'Net 45 Days' },
  { value: 'NET60', label: 'Net 60 Days' },
  { value: 'CUSTOM', label: 'Custom' },
];

const normalizePaymentTerms = (val) => {
  if (!val) return '';
  const normalized = val.replace(/_/g, '').toUpperCase();
  const valid = PAYMENT_TERMS_OPTIONS.map(o => o.value);
  if (valid.includes(normalized)) return normalized;
  if (valid.includes(val)) return val;
  return val;
};

const emptyLine = {
  product: '',
  description: '',
  batch_no: '',
  hsn_sac: '',
  gst_rate: '',
  quantity: '',
  uom: '',
  rate: '',
  discount_percent: '',
};

const numberToWordsINR = (num) => {
  if (num === 0) return 'Zero Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const convert = (n) => {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + convert(n % 100) : '');
    if (n < 100000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + convert(n % 1000) : '');
    if (n < 10000000) return convert(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + convert(n % 100000) : '');
    return convert(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + convert(n % 10000000) : '');
  };
  const rupees = Math.floor(Math.abs(num));
  const paise = Math.round((Math.abs(num) - rupees) * 100);
  let result = 'INR ' + convert(rupees);
  if (paise > 0) result += ' and ' + convert(paise) + ' Paise';
  return result + ' Only';
};

const formatCurrency = (val) => {
  const num = Number(val);
  if (isNaN(num)) return '₹0.00';
  return sharedFormatCurrency(num);
};

const calcLineAmount = (line) => {
  const qty = parseFloat(line.quantity) || 0;
  const rate = parseFloat(line.rate) || 0;
  const disc = parseFloat(line.discount_percent) || 0;
  return qty * rate - (qty * rate * disc / 100);
};

const GSTIN_STATE_CODES = {
  '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand',
  '06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim',
  '12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya',
  '18':'Assam','19':'West Bengal','20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh',
  '24':'Gujarat','26':'Dadra and Nagar Haveli and Daman and Diu','27':'Maharashtra','28':'Andhra Pradesh',
  '29':'Karnataka','30':'Goa','31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu','34':'Puducherry',
  '35':'Andaman and Nicobar Islands','36':'Telangana','37':'Andhra Pradesh (New)',
};

const getStateFromGstin = (gstin) => {
  if (!gstin || gstin.length < 2) return { state: '', stateCode: '' };
  const code = gstin.substring(0, 2);
  return { state: GSTIN_STATE_CODES[code] || '', stateCode: code };
};

// Reverse-lookup map (state name → 2-digit code). Fallback used when
// the buyer/company has no GSTIN — without this the inter-state check
// silently defaults to CGST+SGST, which is wrong for an unregistered
// out-of-state buyer.
const STATE_NAME_TO_CODE = Object.entries(GSTIN_STATE_CODES).reduce((m, [code, name]) => {
  m[name.toLowerCase()] = code;
  return m;
}, {});
const codeFromStateName = (state) => STATE_NAME_TO_CODE[(state || '').trim().toLowerCase()] || '';
const computeInterState = (companyCode, companyState, buyerCode, buyerState) => {
  const cCode = (companyCode || '').trim() || codeFromStateName(companyState);
  const bCode = (buyerCode || '').trim() || codeFromStateName(buyerState);
  if (!cCode || !bCode) return { inter: false, confident: false };
  return { inter: cCode !== bCode, confident: true };
};

export default function EditSalesInvoice() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit } = usePermissions();
  const editable = canEdit('Sales Invoice');
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: dcOptions, raw: rawDCs } = useLookup('/api/sales/dc/', { labelField: 'dc_no' });
  const { options: soOptions } = useLookup('/api/sales/orders/', { labelField: 'so_no' });
  const { options: productOptions, raw: rawProducts } = useLookup('/api/products/');

  const [fetching, setFetching] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [errors, setErrors] = useState({});
  const [selectedDcIds, setSelectedDcIds] = useState([]);
  const [customerAddresses, setCustomerAddresses] = useState([]);

  const [formData, setFormData] = useState({
    invoice_no: '', invoice_date: '', status: '',
    company: '', company_gstin: '', company_pan: '', company_state: '', company_state_code: '',
    consignee_name: '', consignee_address: '', consignee_gstin: '', consignee_state: '', consignee_state_code: '',
    buyer_name: '', buyer_address: '', buyer_gstin: '', buyer_state: '', buyer_state_code: '',
    dc_reference: '', so_reference: '',
    buyers_order_no: '', buyers_order_date: '', delivery_note: '', delivery_note_date: '', other_references: '',
    dispatch_doc_no: '', dispatch_doc_date: '', dispatched_through: '', destination: '', terms_of_delivery: '', payment_terms: '',
    customer: '', amount_in_words: '', remarks: '', declaration: '',
  });
  const { options: customerOptions } = useLookup(formData.company ? `/api/customers/?company=${formData.company}` : null); // customers scoped to the selected company

  const [lines, setLines] = useState([{ ...emptyLine }]);

  // Fetch existing invoice
  useEffect(() => {
    const fetchInvoice = async () => {
      try {
        const res = await apiClient.get(`/api/sales/invoices/${id}/`);
        const d = res.data;
        setFormData({
          invoice_no: d.invoice_no || '', invoice_date: d.invoice_date || '', status: d.status || '',
          company: d.company || '', company_gstin: d.company_gstin || '', company_pan: d.company_pan || '',
          company_state: d.company_state || '', company_state_code: d.company_state_code || '',
          customer: d.customer || '',
          consignee_name: d.consignee_name || '', consignee_address: d.consignee_address || '',
          consignee_gstin: d.consignee_gstin || '', consignee_state: d.consignee_state || '', consignee_state_code: d.consignee_state_code || '',
          buyer_name: d.buyer_name || '', buyer_address: d.buyer_address || '',
          buyer_gstin: d.buyer_gstin || '', buyer_state: d.buyer_state || '', buyer_state_code: d.buyer_state_code || '',
          dc_reference: d.dc_reference || '', so_reference: d.so_reference || '',
          buyers_order_no: d.buyers_order_no || '', buyers_order_date: d.buyers_order_date || '',
          delivery_note: d.delivery_note || '', delivery_note_date: d.delivery_note_date || '',
          other_references: d.other_references || '',
          dispatch_doc_no: d.dispatch_doc_no || '', dispatch_doc_date: d.dispatch_doc_date || '',
          dispatched_through: d.dispatched_through || '', destination: d.destination || '',
          terms_of_delivery: d.terms_of_delivery || '', payment_terms: d.payment_terms || '',
          amount_in_words: d.amount_in_words || '', remarks: d.remarks || '', declaration: d.declaration || '',
        });
        if (d.dc_reference_ids && d.dc_reference_ids.length > 0) {
          setSelectedDcIds(d.dc_reference_ids.map(String));
        } else if (d.dc_reference) {
          setSelectedDcIds([String(d.dc_reference)]);
        }
        if (d.invoice_lines && d.invoice_lines.length > 0) {
          setLines(d.invoice_lines.map((l) => ({
            product: l.product || '', description: l.description || '',
            batch_no: l.batch_no || '',
            hsn_sac: l.hsn_sac || '', gst_rate: l.gst_rate || '',
            quantity: l.quantity || '', uom: l.uom || '',
            rate: l.rate || '', discount_percent: l.discount_percent || '',
          })));
        }
        // Load customer addresses for billing address selection
        if (d.customer) fetchCustomerAddresses(d.customer);
      } catch {
        toast.error('Failed to load invoice data');
        navigate('/sales/invoices');
      } finally {
        setFetching(false);
      }
    };
    fetchInvoice();
  }, [id, navigate]);

  const fetchInvoiceData = async (dcIds) => {
    if (dcIds.length === 0) return;
    try {
      const params = { dc_ids: dcIds.join(',') };
      if (formData.so_reference) params.so_id = formData.so_reference;
      const res = await apiClient.get('/api/sales/invoices/invoice-data/', { params });
      const data = res.data;
      if (data.so_ids && data.so_ids.length > 0) {
        setFormData(prev => ({ ...prev, so_reference: data.so_ids[0] }));
      }
      if (data.so) {
        const so = data.so;
        let custBillingAddr = '';
        let custGstin = '';
        let custBillingState = '';
        let custStateCode = '';
        if (so.customer) {
          const cust = await fetchCustomerAddresses(so.customer);
          if (cust) {
            custGstin = cust.gstin || '';
            const gstinInfo = getStateFromGstin(custGstin);
            custStateCode = gstinInfo.stateCode;
            if (cust.billing_address && Object.keys(cust.billing_address).length > 0) {
              custBillingAddr = JSON.stringify(cust.billing_address);
              custBillingState = cust.billing_address.state || gstinInfo.state || '';
            } else {
              custBillingState = gstinInfo.state || '';
            }
          }
        }
        setFormData(prev => ({
          ...prev,
          so_reference: data.so_ids?.[0] || prev.so_reference,
          customer: so.customer || prev.customer,
          company: so.company || prev.company,
          company_gstin: so.company_gstin || prev.company_gstin,
          company_pan: so.company_pan || prev.company_pan,
          company_state: so.company_state || prev.company_state,
          company_state_code: so.company_state_code || prev.company_state_code,
          consignee_name: so.consignee_name || prev.consignee_name,
          consignee_address: so.consignee_address || prev.consignee_address,
          consignee_gstin: so.consignee_gstin || prev.consignee_gstin,
          consignee_state: so.consignee_state || prev.consignee_state,
          consignee_state_code: so.consignee_state_code || prev.consignee_state_code,
          buyer_name: so.customer_name || prev.buyer_name,
          buyer_address: custBillingAddr || prev.buyer_address,
          buyer_gstin: custGstin || so.billing_gstin || prev.buyer_gstin,
          buyer_state: custBillingState || prev.buyer_state,
          buyer_state_code: custStateCode || prev.buyer_state_code,
          destination: so.destination || prev.destination,
          payment_terms: normalizePaymentTerms(so.payment_terms) || prev.payment_terms,
          terms_of_delivery: so.delivery_terms || prev.terms_of_delivery,
          dispatched_through: so.dispatched_through || prev.dispatched_through,
        }));
      }
      if (data.lines && data.lines.length > 0) {
        // Merge lines with the same product: sum quantities, keep same rate/gst/hsn
        const merged = {};
        data.lines.forEach((l) => {
          const key = l.product || l.product_name;
          if (merged[key]) {
            merged[key].quantity = String(parseFloat(merged[key].quantity || 0) + parseFloat(l.quantity || 0));
          } else {
            merged[key] = {
              product: l.product || '', description: l.product_name || '',
              batch_no: l.batch_no || '',
              hsn_sac: l.hsn_sac || '', quantity: l.quantity || '',
              uom: l.uom || '', rate: l.rate || '',
              discount_percent: l.discount_percent || '0',
              gst_rate: l.gst_rate || '0',
            };
          }
        });
        const mergedLines = Object.values(merged);
        setLines(mergedLines);
        toast.success(`${mergedLines.length} line(s) loaded from ${data.dcs.length} DC(s)`);
      }
    } catch { /* ignore */ }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleCompanyChange = async (e) => {
    const companyId = e.target.value;
    setFormData(prev => ({ ...prev, company: companyId }));
    if (!companyId) return;
    try {
      const res = await apiClient.get(`/api/companies/${companyId}/`);
      const c = res.data;
      const gstinInfo = getStateFromGstin(c.gstin);
      const regAddr = c.registered_address || {};
      setFormData(prev => ({
        ...prev, company: companyId,
        company_gstin: c.gstin || '', company_pan: c.pan || '',
        company_state: regAddr.state || gstinInfo.state || '',
        company_state_code: gstinInfo.stateCode || '',
      }));
    } catch { /* silent */ }
  };

  const fetchCustomerAddresses = async (custId) => {
    if (!custId) { setCustomerAddresses([]); return; }
    try {
      const res = await apiClient.get(`/api/customers/${custId}/`);
      const c = res.data;
      const addrs = [];
      if (c.billing_address && Object.keys(c.billing_address).length > 0) {
        addrs.push({ label: 'Billing Address', address: c.billing_address, gstin: c.gstin || '' });
      }
      if (c.shipping_addresses && c.shipping_addresses.length > 0) {
        c.shipping_addresses.forEach((sa) => {
          addrs.push({ label: sa.address_label || 'Shipping Address', address: sa.address || {}, gstin: c.gstin || '' });
        });
      }
      setCustomerAddresses(addrs);
      return c;
    } catch { setCustomerAddresses([]); return null; }
  };

  const handleBuyerAddressSelect = (idx) => {
    const addr = customerAddresses[idx];
    if (!addr) return;
    const a = typeof addr.address === 'object' ? addr.address : {};
    const raw = a.raw_address || a.street || a.address_line || '';
    const state = a.state || '';
    const district = a.district || a.city || '';
    const pincode = a.pincode || a.postal_code || a.zip || '';
    const country = a.country || 'India';
    const addrJson = JSON.stringify({ raw_address: raw, state, district, pincode, country });
    const gstinInfo = getStateFromGstin(addr.gstin);
    setFormData(prev => ({
      ...prev,
      buyer_address: addrJson,
      buyer_gstin: addr.gstin || prev.buyer_gstin,
      buyer_state: state || gstinInfo.state || prev.buyer_state,
      buyer_state_code: gstinInfo.stateCode || prev.buyer_state_code,
    }));
  };

  const handleCustomerChange = async (e) => {
    const custId = e.target.value;
    setFormData(prev => ({ ...prev, customer: custId }));
    if (!custId) return;
    const c = await fetchCustomerAddresses(custId);
    if (!c) return;
    const billingAddr = c.billing_address && Object.keys(c.billing_address).length > 0
      ? JSON.stringify(c.billing_address) : '';
    const billingState = c.billing_address?.state || '';
    const gstinInfo = getStateFromGstin(c.gstin);
    setFormData(prev => ({
      ...prev,
      customer: custId,
      consignee_name: c.customer_name || '',
      consignee_address: billingAddr,
      consignee_gstin: c.gstin || '',
      consignee_state: billingState || gstinInfo.state || '',
      consignee_state_code: gstinInfo.stateCode || '',
      buyer_name: c.customer_name || '',
      buyer_address: billingAddr,
      buyer_gstin: c.gstin || '',
      buyer_state: billingState || gstinInfo.state || '',
      buyer_state_code: gstinInfo.stateCode || '',
    }));
  };

  const handleLineChange = (idx, field, value) => {
    setLines(prev => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], [field]: value };
      return updated;
    });
  };

  const handleProductSelect = (idx, productId) => {
    const product = rawProducts.find(p => String(p.id) === String(productId));
    setLines(prev => {
      const updated = [...prev];
      updated[idx] = {
        ...updated[idx], product: productId,
        description: product?.description || product?.product_name || '',
        hsn_sac: product?.hsn_sac || product?.hsn_code || '',
        gst_rate: product?.gst_rate || '',
        uom: product?.uom || product?.unit || '',
        rate: product?.selling_price || product?.rate || '',
      };
      return updated;
    });
  };

  const addLine = () => setLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => {
    if (lines.length <= 1) return;
    setLines(prev => prev.filter((_, i) => i !== idx));
  };

  // Tax Calculations — uses the robust state-code OR state-name
  // resolver so an unregistered out-of-state buyer (no GSTIN) doesn't
  // silently get CGST+SGST. `taxConfident=false` drives a banner.
  const { inter: isInterState, confident: taxConfident } = computeInterState(
    formData.company_state_code,
    formData.company_state,
    formData.buyer_state_code,
    formData.buyer_state,
  );
  const subtotal = lines.reduce((sum, l) => sum + calcLineAmount(l), 0);
  const taxDetails = lines.map(line => {
    const amount = calcLineAmount(line);
    const gstRate = parseFloat(line.gst_rate) || 0;
    const taxAmount = amount * gstRate / 100;
    if (isInterState) return { cgst: 0, sgst: 0, igst: taxAmount, cgst_rate: 0, sgst_rate: 0, igst_rate: gstRate };
    return { cgst: taxAmount / 2, sgst: taxAmount / 2, igst: 0, cgst_rate: gstRate / 2, sgst_rate: gstRate / 2, igst_rate: 0 };
  });
  const totalCGST = taxDetails.reduce((s, t) => s + t.cgst, 0);
  const totalSGST = taxDetails.reduce((s, t) => s + t.sgst, 0);
  const totalIGST = taxDetails.reduce((s, t) => s + t.igst, 0);
  const totalBeforeRound = subtotal + totalCGST + totalSGST + totalIGST;
  const grandTotal = Math.round(totalBeforeRound);
  const roundOff = grandTotal - totalBeforeRound;

  useEffect(() => {
    if (grandTotal > 0) {
      setFormData(prev => ({ ...prev, amount_in_words: numberToWordsINR(grandTotal) }));
    }
  }, [grandTotal]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setErrors({});
    const payload = {
      invoice_date: formData.invoice_date,
      company: formData.company || null, customer: formData.customer || null,
      consignee_name: formData.consignee_name, consignee_address: formData.consignee_address,
      consignee_gstin: formData.consignee_gstin, consignee_state: formData.consignee_state, consignee_state_code: formData.consignee_state_code,
      buyer_name: formData.buyer_name, buyer_address: formData.buyer_address,
      buyer_gstin: formData.buyer_gstin, buyer_state: formData.buyer_state, buyer_state_code: formData.buyer_state_code,
      dc_reference: formData.dc_reference || null,
      dc_reference_ids: selectedDcIds.length > 0 ? selectedDcIds : undefined,
      so_reference: formData.so_reference || null,
      buyers_order_no: formData.buyers_order_no, buyers_order_date: formData.buyers_order_date || null,
      delivery_note: formData.delivery_note, delivery_note_date: formData.delivery_note_date || null,
      other_references: formData.other_references,
      dispatch_doc_no: formData.dispatch_doc_no, dispatch_doc_date: formData.dispatch_doc_date || null,
      dispatched_through: formData.dispatched_through, destination: formData.destination,
      terms_of_delivery: formData.terms_of_delivery, payment_terms: formData.payment_terms || null,
      amount_in_words: formData.amount_in_words, remarks: formData.remarks, declaration: formData.declaration,
      invoice_lines: lines.map((line, idx) => ({
        product: line.product || null, description: line.description,
        batch_no: line.batch_no || '', hsn_sac: line.hsn_sac,
        gst_rate: parseFloat(line.gst_rate) || 0, quantity: parseFloat(line.quantity) || 0,
        uom: line.uom, rate: parseFloat(line.rate) || 0, discount_percent: parseFloat(line.discount_percent) || 0,
        cgst_rate: taxDetails[idx]?.cgst_rate || 0, sgst_rate: taxDetails[idx]?.sgst_rate || 0, igst_rate: taxDetails[idx]?.igst_rate || 0,
      })),
    };
    try {
      await apiClient.put(`/api/sales/invoices/${id}/`, payload);
      toast.success('Sales Invoice updated successfully!');
      if (pendingAttachments.length > 0) { await uploadPendingFiles('SALES_INVOICE', id, pendingAttachments); }
      navigate(`/sales/invoices/${id}`);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to update invoice');
      if (err.response?.data) setErrors(err.response.data);
    } finally {
      setIsLoading(false);
    }
  };

  if (fetching) {
    return (
      <MainLayout>
        <PageHeader title="Edit Sales Invoice" breadcrumbs={[{ label: 'Invoices', path: '/sales/invoices' }, { label: 'Edit Invoice' }]} />
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 space-y-4 sm:space-y-6 animate-pulse">
          {[...Array(6)].map((_, i) => (
            <div key={i}>
              <div className="h-5 bg-slate-200 rounded w-48 mb-4" />
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {[...Array(3)].map((_, j) => (<div key={j}><div className="h-4 bg-slate-200 rounded w-24 mb-1" /><div className="h-10 bg-slate-100 rounded" /></div>))}
              </div>
            </div>
          ))}
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title="Edit Sales Invoice"
        breadcrumbs={[
          { label: 'Sales', path: '/sales' },
          { label: 'Invoices', path: '/sales/invoices' },
          { label: 'Edit Invoice' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <form onSubmit={handleSubmit} noValidate>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">

          {/* GST-confidence banner — fires when we can't determine
              whether this is intra-state (CGST+SGST) or inter-state
              (IGST) because either the company or buyer state is
              missing from the form (no GSTIN, no state name). The
              calculation defaults to CGST+SGST in that case, which
              is wrong for an unregistered out-of-state buyer. */}
          {!taxConfident && (
            <div className="px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-xs">
              <strong>Heads up:</strong> Could not determine whether this is an inter-state or intra-state sale —
              {!formData.company_state_code && !formData.company_state && ' the company state is missing,'}
              {!formData.buyer_state_code && !formData.buyer_state && ' the buyer state is missing,'}
              {' '}so the invoice currently shows <strong>CGST + SGST</strong>. Fill in the buyer / company state (or GSTIN) before saving if this is actually an inter-state sale (IGST).
            </div>
          )}

          {/* Invoice Header */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Invoice Header</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Invoice No</label>
                <input type="text" value={formData.invoice_no} readOnly className={readOnlyClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Invoice Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="invoice_date" value={formData.invoice_date} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
                <input type="text" value={formData.status} readOnly className={readOnlyClass} />
              </div>
            </div>
          </div>

          {/* Seller / Company Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Seller / Company Details</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleCompanyChange} className={inputClass}>
                  <option value="">Select Company</option>
                  {companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company GSTIN</label>
                <input type="text" value={formData.company_gstin} readOnly className={readOnlyClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">PAN</label>
                <input type="text" value={formData.company_pan} readOnly className={readOnlyClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State</label>
                <input type="text" value={formData.company_state} readOnly className={readOnlyClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State Code</label>
                <input type="text" value={formData.company_state_code} readOnly className={readOnlyClass} />
              </div>
            </div>
          </div>

          {/* Consignee (Ship to) */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Consignee (Ship to)</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer <span className="text-red-500">*</span></label>
                <CustomSelect name="customer" value={formData.customer} onChange={handleCustomerChange} className={inputClass}>
                  <option value="">Select Customer</option>
                  {customerOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
                <input type="text" name="consignee_name" value={formData.consignee_name} onChange={handleChange} className={inputClass} />
              </div>
              <AddressField label="Address" value={formData.consignee_address} onChange={(v) => setFormData(prev => ({ ...prev, consignee_address: v }))} />
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GSTIN</label>
                <input type="text" name="consignee_gstin" value={formData.consignee_gstin} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State</label>
                <input type="text" name="consignee_state" value={formData.consignee_state} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State Code</label>
                <input type="text" name="consignee_state_code" value={formData.consignee_state_code} onChange={handleChange} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Buyer (Bill to) */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Buyer (Bill to)</h3>
            {customerAddresses.length > 0 && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-700 mb-1">Select Billing Address</label>
                <CustomSelect onChange={(e) => { if (e.target.value !== '') handleBuyerAddressSelect(Number(e.target.value)); }} className={inputClass}>
                  <option value="">-- Choose an address --</option>
                  {customerAddresses.map((a, idx) => {
                    const addr = typeof a.address === 'object' ? a.address : {};
                    const preview = [addr.raw_address || addr.street || '', addr.district || addr.city || '', addr.state || ''].filter(Boolean).join(', ');
                    return <option key={idx} value={idx}>{a.label} — {preview || 'No address'}</option>;
                  })}
                </CustomSelect>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
                <input type="text" name="buyer_name" value={formData.buyer_name} onChange={handleChange} className={inputClass} />
              </div>
              <AddressField label="Address" value={formData.buyer_address} onChange={(v) => setFormData(prev => ({ ...prev, buyer_address: v }))} />
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GSTIN</label>
                <input type="text" name="buyer_gstin" value={formData.buyer_gstin} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State</label>
                <input type="text" name="buyer_state" value={formData.buyer_state} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State Code</label>
                <input type="text" name="buyer_state_code" value={formData.buyer_state_code} onChange={handleChange} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Dispatch Challans */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Dispatch Challans</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Add Dispatch Challans <span className="text-red-500">*</span></label>
                <CustomSelect onChange={(e) => {
                  if (e.target.value && !selectedDcIds.includes(e.target.value)) {
                    const newIds = [...selectedDcIds, e.target.value];
                    setSelectedDcIds(newIds);
                    const dcNos = newIds.map(id => dcOptions.find(o => o.value === id)?.label || '').filter(Boolean).join(', ');
                    if (!formData.dc_reference) setFormData(prev => ({ ...prev, dc_reference: e.target.value, dispatch_doc_no: dcNos }));
                    else setFormData(prev => ({ ...prev, dispatch_doc_no: dcNos }));
                    fetchInvoiceData(newIds);
                  }
                  e.target.value = '';
                }} className={inputClass}>
                  <option value="">-- Select DC to add --</option>
                  {dcOptions.filter(o => !selectedDcIds.includes(o.value)).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                {selectedDcIds.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {selectedDcIds.map(dcId => {
                      const dc = dcOptions.find(o => o.value === dcId);
                      return (
                        <span key={dcId} className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-800 rounded-lg text-xs font-semibold">
                          {dc?.label || dcId}
                          <button type="button" onClick={() => {
                            const newIds = selectedDcIds.filter(id => id !== dcId);
                            setSelectedDcIds(newIds);
                            const dcNos = newIds.map(id => dcOptions.find(o => o.value === id)?.label || '').filter(Boolean).join(', ');
                            setFormData(prev => ({ ...prev, dispatch_doc_no: dcNos }));
                            if (newIds.length > 0) fetchInvoiceData(newIds);
                          }} className="text-primary-500 hover:text-red-600 ml-0.5">&times;</button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <p className="text-xs text-slate-400 mt-1">Select one or more DCs. SO, customer, addresses, and product lines will auto-fill.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">SO Reference</label>
                <CustomSelect name="so_reference" value={formData.so_reference} onChange={handleChange} className={inputClass}>
                  <option value="">Auto-filled from DC</option>
                  {soOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                <p className="text-xs text-slate-400 mt-1">Auto-detected from selected DCs</p>
              </div>
            </div>
          </div>

          {/* Additional References */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Additional References</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Buyer's Order No</label>
                <input type="text" name="buyers_order_no" value={formData.buyers_order_no} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Buyer's Order Date</label>
                <CustomDatePicker name="buyers_order_date" value={formData.buyers_order_date} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Delivery Note</label>
                <input type="text" name="delivery_note" value={formData.delivery_note} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Delivery Note Date</label>
                <CustomDatePicker name="delivery_note_date" value={formData.delivery_note_date} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Other References</label>
                <input type="text" name="other_references" value={formData.other_references} onChange={handleChange} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Dispatch Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Dispatch Details</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Dispatch Doc No</label>
                <input type="text" name="dispatch_doc_no" value={formData.dispatch_doc_no} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Dispatch Doc Date</label>
                <CustomDatePicker name="dispatch_doc_date" value={formData.dispatch_doc_date} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Dispatched Through</label>
                <input type="text" name="dispatched_through" value={formData.dispatched_through} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Destination</label>
                <input type="text" name="destination" value={formData.destination} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Terms of Delivery</label>
                <input type="text" name="terms_of_delivery" value={formData.terms_of_delivery} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms</label>
                <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} className={inputClass}>
                  {PAYMENT_TERMS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Invoice Lines */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Invoice Lines</h3>
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add Line
              </button>
            </div>
            {/* Mobile-only stacked editor for invoice lines. */}
            <div className="sm:hidden space-y-3">
              {lines.map((line, idx) => (
                <div key={idx} className="border border-slate-200 rounded-lg p-3 space-y-2 bg-white">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Line #{idx + 1}</span>
                    <button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} className="inline-flex items-center gap-1 text-red-500 disabled:opacity-30 text-xs">
                      <Trash2 size={14} /> Remove
                    </button>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Product</label>
                    <CustomSelect value={line.product} onChange={(e) => handleProductSelect(idx, e.target.value)} className={`${inputClass} w-full`}>
                      <option value="">Select</option>
                      {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Description</label>
                    <input className={`${inputClass} w-full`} value={line.description} onChange={(e) => handleLineChange(idx, 'description', e.target.value)} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Batch</label>
                      <input className={`${inputClass} w-full`} value={line.batch_no || ''} onChange={(e) => handleLineChange(idx, 'batch_no', e.target.value)} placeholder="Batch / Lot" />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">HSN/SAC</label>
                      <input className={`${inputClass} w-full`} value={line.hsn_sac} onChange={(e) => handleLineChange(idx, 'hsn_sac', e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Qty</label>
                      <input type="number" step="0.001" min="0" className={`${inputClass} w-full text-right`} value={line.quantity} onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">UOM</label>
                      <CustomSelect className={`${inputClass} w-full`} value={line.uom} onChange={(e) => handleLineChange(idx, 'uom', e.target.value)}>
                        {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                      </CustomSelect>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Rate</label>
                      <input type="number" className={`${inputClass} w-full text-right`} value={line.rate} onChange={(e) => handleLineChange(idx, 'rate', e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Disc %</label>
                      <input type="number" className={`${inputClass} w-full text-right`} value={line.discount_percent} onChange={(e) => handleLineChange(idx, 'discount_percent', e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">GST %</label>
                      <input type="number" className={`${inputClass} w-full text-right`} value={line.gst_rate} onChange={(e) => handleLineChange(idx, 'gst_rate', e.target.value)} />
                    </div>
                    <div className="flex flex-col justify-end">
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Amount</label>
                      <div className="px-3 py-2 bg-slate-100 border border-slate-300 rounded text-right text-sm font-bold text-slate-900">{formatCurrency(calcLineAmount(line))}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600" style={{ minWidth: '160px' }}>Product</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600" style={{ minWidth: '140px' }}>Description</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Batch No</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">HSN/SAC</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">GST %</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Qty</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Rate</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Disc%</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Amount</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => (
                    <tr key={idx} className="border-b border-slate-100">
                      <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <CustomSelect value={line.product} onChange={(e) => handleProductSelect(idx, e.target.value)} className={inputClass} style={{ minWidth: '160px' }}>
                          <option value="">Select</option>
                          {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <input className={inputClass} value={line.description} onChange={(e) => handleLineChange(idx, 'description', e.target.value)} style={{ minWidth: '140px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input className={inputClass} value={line.batch_no || ''} onChange={(e) => handleLineChange(idx, 'batch_no', e.target.value)} style={{ minWidth: '100px' }} placeholder="Batch / Lot" />
                      </td>
                      <td className="px-3 py-2">
                        <input className={inputClass} value={line.hsn_sac} onChange={(e) => handleLineChange(idx, 'hsn_sac', e.target.value)} style={{ minWidth: '100px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" className={inputClass + ' text-right'} value={line.gst_rate} onChange={(e) => handleLineChange(idx, 'gst_rate', e.target.value)} style={{ minWidth: '70px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.001" min="0" className={inputClass + ' text-right'} value={line.quantity} onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)} style={{ minWidth: '80px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <CustomSelect className={inputClass} value={line.uom} onChange={(e) => handleLineChange(idx, 'uom', e.target.value)} style={{ minWidth: '70px' }}>
                          {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" className={inputClass + ' text-right'} value={line.rate} onChange={(e) => handleLineChange(idx, 'rate', e.target.value)} style={{ minWidth: '90px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" className={inputClass + ' text-right'} value={line.discount_percent} onChange={(e) => handleLineChange(idx, 'discount_percent', e.target.value)} style={{ minWidth: '70px' }} />
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-slate-700 whitespace-nowrap">
                        {formatCurrency(calcLineAmount(line))}
                      </td>
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} className="text-red-400 hover:text-red-600 disabled:opacity-30" title="Remove">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Tax Summary */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Tax Summary</h3>
            <div className="max-w-md ml-auto space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">Subtotal</span>
                <span className="font-medium">{formatCurrency(subtotal)}</span>
              </div>
              {!isInterState ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-slate-600">CGST</span>
                    <span className="font-medium">{formatCurrency(totalCGST)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">SGST</span>
                    <span className="font-medium">{formatCurrency(totalSGST)}</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between">
                  <span className="text-slate-600">IGST</span>
                  <span className="font-medium">{formatCurrency(totalIGST)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-slate-600">Round Off</span>
                <span className="font-medium">{roundOff >= 0 ? '+' : ''}{roundOff.toFixed(2)}</span>
              </div>
              <div className="flex justify-between border-t border-slate-300 pt-2 text-base font-bold">
                <span>Grand Total</span>
                <span>{formatCurrency(grandTotal)}</span>
              </div>
            </div>
          </div>

          {/* Amount in Words */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Amount in Words</h3>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Amount in Words</label>
              <input type="text" value={formData.amount_in_words} readOnly className={readOnlyClass} />
            </div>
          </div>

          {/* Remarks & Declaration */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Remarks & Declaration</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Declaration</label>
                <textarea name="declaration" value={formData.declaration} onChange={handleChange} rows={3} className={inputClass} />
              </div>
            </div>
          </div>

          <FileAttachments module="SALES_INVOICE" recordId={id} deferUpload onPendingChange={setPendingAttachments} />

          {/* Submit */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button type="button" onClick={() => navigate(`/sales/invoices/${id}`)} className="w-full sm:w-auto px-4 sm:px-6 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">
              Cancel
            </button>
            <button type="submit" disabled={isLoading} className="w-full sm:w-auto px-4 sm:px-6 py-2.5 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50">
              {isLoading ? 'Updating...' : 'Update Invoice'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
