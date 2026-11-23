import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, FileText } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import AddressField, { parseAddress, getDistrictState, formatAddressDisplay } from '../../../components/common/AddressField';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import { SALES_UOM_OPTIONS } from '../utils/uomOptions';
import { formatCurrency } from '@/utils/formatters';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const DISPATCHED_THROUGH_OPTIONS = [
  { value: '', label: 'Select' },
  { value: 'BY_ROAD', label: 'By Road' }, { value: 'BY_RAIL', label: 'By Rail' },
  { value: 'BY_AIR', label: 'By Air' }, { value: 'BY_SEA', label: 'By Sea' },
  { value: 'BY_COURIER', label: 'By Courier' }, { value: 'HAND_DELIVERY', label: 'Hand Delivery' },
  { value: 'SELF_PICKUP', label: 'Self Pickup' }, { value: 'TRANSPORTER', label: 'Transporter' },
  { value: 'OTHER', label: 'Other' },
];

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const errorInputClass = 'w-full border border-red-400 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500';
const lockedInputClass = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-100 text-slate-600 cursor-not-allowed';

const GOODS_SUB_TYPE_OPTIONS = [
  { value: '', label: 'Select Category' },
  { value: 'RAW_MATERIAL', label: 'Raw Material' }, { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'FINISHED_GOOD', label: 'Finished Good' }, { value: 'SEMI_FINISHED', label: 'Semi Finished' },
  { value: 'TRADED_PRODUCTS', label: 'Traded Products' }, { value: 'CAPITAL_GOOD', label: 'Capital Good' },
  { value: 'MACHINE_SPARES', label: 'Machine Spares' }, { value: 'CONSUMABLES', label: 'Consumables' },
];

const emptySOLine = {
  product_category: 'FINISHED_GOOD',
  product: '',
  quantity_ordered: '',
  uom: 'KG',
  unit_price: '',
  discount: '0',
  gst: '0',
  remarks: '',
};

export default function EditSalesOrder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit } = usePermissions();
  const editable = canEdit('Sales Order');
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: productOptions, raw: rawProducts } = useLookup('/api/products/');
  // Field permissions — same pattern as new.jsx. HIDDEN inputs are
  // removed from the form, READ_ONLY ones render disabled.
  const { isHidden: isHeaderHidden, isReadOnly: isHeaderReadOnly } = useFieldPermissions('Sales Order');
  const { isHidden: isLineHidden, isReadOnly: isLineReadOnly } = useFieldPermissions('Sales Order Line');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [filteredCustomers, setFilteredCustomers] = useState([]);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [errors, setErrors] = useState({});

  // Customer PO states
  const [allAvailablePOs, setAllAvailablePOs] = useState([]);
  const [selectedPOIds, setSelectedPOIds] = useState([]);
  const [linkedPOs, setLinkedPOs] = useState([]);   // POs this SO was clubbed from (read-only)
  const [cpoShippingAddresses, setCpoShippingAddresses] = useState([]);
  const [cpoAllBillingAddresses, setCpoAllBillingAddresses] = useState([]);

  const [formData, setFormData] = useState({
    so_no: '', customer: '', company: '', warehouse: '', so_date: '',
    price_list: '',
    freight_terms: 'TO_PAY', payment_terms: 'NET_15', currency: 'INR',
    required_ship_date: '', destination: '',
    delivery_terms: '', payment_due_date: '',
    dispatched_through: '',
    consignee_name: '', consignee_address: '', consignee_gstin: '',
    billing_name: '', billing_address: '', billing_gstin: '',
    special_instructions: '', remarks: '',
  });
  const [soLines, setSoLines] = useState([]);
  const [cpoLineLimits, setCpoLineLimits] = useState([]);

  // Force warehouse dropdown label to be just `name` — matches the
  // Create Sales Order page so editing reads identically.
  // `sales_scope=true` restricts the picker to the user's allowed
  // warehouses — see sales.mixins._user_allowed_warehouse_ids.
  const { options: warehouseOptions } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}&sales_scope=true` : null,
    { labelField: 'name' },
  );

  useEffect(() => {
    const fetchSO = async () => {
      setIsLoading(true);
      try {
        const res = await apiClient.get(`/api/sales/orders/${id}/`);
        const so = res.data;
        setFormData({
          so_no: so.so_no || '', customer: so.customer || '', company: so.company || '',
          warehouse: so.warehouse || '', so_date: so.so_date || '',
          price_list: so.price_list || '',
          freight_terms: so.freight_terms || 'TO_PAY', payment_terms: so.payment_terms || 'NET_15',
          currency: so.currency || 'INR', required_ship_date: so.required_ship_date || '',
          destination: so.destination || '',
          delivery_terms: so.delivery_terms || '',
          payment_due_date: so.payment_due_date || '',
          dispatched_through: so.dispatched_through || '',
          consignee_name: so.consignee_name || '', consignee_address: so.consignee_address || '',
          consignee_gstin: so.consignee_gstin || '',
          billing_name: so.billing_name || '',
          billing_address: so.billing_address || '', billing_gstin: so.billing_gstin || '',
          special_instructions: so.special_instructions || '', remarks: so.remarks || '',
        });
        if (so.company) {
          apiClient.get(`/api/customers/?company=${so.company}`)
            .then(r => setFilteredCustomers((r.data?.results || r.data || []).map(c => ({ value: c.id, label: c.customer_name || c.name || c.id }))))
            .catch(() => {});
        }
        // Linked POs — a clubbed (multi-PO) SO carries several; a normal SO 0–1.
        const linked = so.customer_po_numbers || [];
        setLinkedPOs(linked);
        if (linked.length > 0) {
          setSelectedPOIds(linked.map((p) => p.id));
        } else if (so.customer_po_ids && so.customer_po_ids.length > 0) {
          setSelectedPOIds(so.customer_po_ids);
        } else if (so.customer_po) {
          setSelectedPOIds([so.customer_po]);
        }
        const lines = (so.so_lines || []).map(l => ({
          product_category: l.product_category || 'FINISHED_GOOD', product: l.product || '', quantity_ordered: l.quantity_ordered || '',
          uom: l.uom || 'KG', unit_price: l.unit_price || '', discount: l.discount || '0', gst: l.gst || '0',
          remarks: l.remarks || '', line_no: l.line_no,
        }));
        setSoLines(lines.length > 0 ? lines : [{ ...emptySOLine }]);
        // Delivery-date pull from the first line was removed along with
        // the form's delivery_date input — delivery scheduling lives on
        // the DC, not the SO.
        // Load CPO limits from linked POs
        const linkedPoIds = so.customer_po_ids || (so.customer_po ? [so.customer_po] : []);
        if (linkedPoIds.length > 0) {
          try {
            const poRes = await apiClient.get(`/api/sales/customer-po/${linkedPoIds[0]}/`);
            const poLines = poRes.data?.parsed_lines || [];
            if (poLines.length > 0) {
              // Build limits by product ID so we can match against SO lines
              const limitsByProduct = {};
              poLines.forEach(pl => {
                if (pl.parsed_sku) limitsByProduct[pl.parsed_sku] = {
                  product: pl.parsed_sku, quantity: parseFloat(pl.quantity) || 0,
                  unit_price: parseFloat(pl.price) || 0, discount: parseFloat(pl.discount) || 0,
                  gst: parseFloat(pl.gst) || 0, uom: pl.uom || 'KG',
                };
              });
              const lineLimits = lines.map(l => limitsByProduct[l.product] || null);
              setCpoLineLimits(lineLimits);
            }
          } catch {}
        }
      } catch {
        toast.error('Failed to load Sales Order');
        navigate('/sales/orders');
      } finally { setIsLoading(false); }
    };
    fetchSO();
  }, [id]);

  // Fetch ALL available Customer POs on mount (confirmed, unlinked)
  useEffect(() => {
    const fetchAllPOs = async () => {
      try {
        const res = await apiClient.get('/api/sales/customer-po/?page_size=500');
        const list = res.data?.results || res.data || [];
        setAllAvailablePOs(list.filter(p =>
          p.status === 'CONFIRMED' &&
          (!p.linked_sos || p.linked_sos.length === 0) &&
          !p.linked_so_number
        ).map(p => ({
          value: p.id,
          label: `${p.upload_id}${p.po_number ? ` (${p.po_number})` : ''} — ${p.customer_name || ''}`,
          raw: p,
        })));
      } catch {
        setAllAvailablePOs([]);
      }
    };
    fetchAllPOs();
  }, []);

  // Company changed → fetch customers for dropdown
  useEffect(() => {
    if (!formData.company) {
      setFilteredCustomers([]);
      return;
    }
    apiClient.get(`/api/customers/?company=${formData.company}`)
      .then(res => {
        const list = res.data?.results || res.data || [];
        setFilteredCustomers(list.map(c => ({ value: c.id, label: c.customer_name || c.name || c.customer_code || c.id })));
      })
      .catch(() => setFilteredCustomers([]));
  }, [formData.company]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => {
      const next = { ...prev, [name]: value };
      // Same Ex-Factory ↔ freight_terms guard as the Create page:
      // when the user switches delivery_terms to EX_FACTORY while
      // TO_PAY is currently set, auto-flip to PAID so the saved
      // record can never carry the illegal combination.
      if (name === 'delivery_terms' && value === 'EX_FACTORY' && prev.freight_terms === 'TO_PAY') {
        next.freight_terms = 'PAID';
      }
      return next;
    });
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: '' }));
  };

  // Handle PO selection → auto-fill ALL SO fields from PO
  const handlePOSelect = async (poId) => {
    if (!poId) return;
    if (selectedPOIds.includes(poId)) return;
    try {
      const res = await apiClient.get(`/api/sales/customer-po/${poId}/`);
      const po = res.data;

      setSelectedPOIds([poId]);

      // Fetch customers for dropdown so the customer field displays correctly
      if (po.company) {
        try {
          const custRes = await apiClient.get(`/api/customers/?company=${po.company}`);
          const custList = custRes.data?.results || custRes.data || [];
          setFilteredCustomers(custList.map(c => ({ value: c.id, label: c.customer_name || c.name || c.id })));
        } catch {}
      }

      // Auto-fill ALL header fields from PO
      {
        const shipNames = (po.consignee_name || '').split(' | ').filter(Boolean);
        const shipAddrs = (po.consignee_address || '').split(' | ').filter(Boolean);
        const shipGstins = (po.consignee_gstin || '').split(' | ').filter(Boolean);
        const maxShip = Math.max(shipNames.length, shipAddrs.length, shipGstins.length, 1);
        const allShip = Array.from({ length: maxShip }, (_, i) => ({
          name: shipNames[i] || '', address: shipAddrs[i] || '', gstin: shipGstins[i] || '',
        }));
        setCpoShippingAddresses(allShip);

        // Carry the billing NAME across too (see new.jsx) — the extractor
        // captures it and the SO stores it as billing_name.
        const billNames = (po.billing_name || '').split(' | ').filter(Boolean);
        const billAddrs = (po.billing_address || '').split(' | ').filter(Boolean);
        const billGstins = (po.billing_gstin || '').split(' | ').filter(Boolean);
        const maxBill = Math.max(billNames.length, billAddrs.length, billGstins.length, 1);
        const allBill = Array.from({ length: maxBill }, (_, i) => ({
          name: billNames[i] || '', address: billAddrs[i] || '', gstin: billGstins[i] || '',
        }));
        setCpoAllBillingAddresses(allBill);

        const firstShip = allShip[0] || {};
        const firstBill = allBill[0] || {};
        setFormData(prev => ({
          ...prev,
          company: po.company || prev.company,
          customer: po.customer || prev.customer,
          warehouse: po.warehouse || prev.warehouse,
          price_list: po.price_list || prev.price_list,
          freight_terms: po.freight_terms || prev.freight_terms,
          payment_terms: po.payment_terms || prev.payment_terms,
          currency: po.currency || prev.currency,
          required_ship_date: po.required_ship_date || prev.required_ship_date,
          delivery_terms: po.delivery_type || prev.delivery_terms,
          payment_due_date: po.payment_due_date || prev.payment_due_date,
          dispatched_through: po.dispatched_through || prev.dispatched_through,
          consignee_name: firstShip.name || prev.consignee_name,
          consignee_address: firstShip.address || prev.consignee_address,
          consignee_gstin: firstShip.gstin || prev.consignee_gstin,
          billing_name: firstBill.name || prev.billing_name,
          billing_address: firstBill.address || prev.billing_address,
          billing_gstin: firstBill.gstin || prev.billing_gstin,
          special_instructions: po.special_instructions || prev.special_instructions,
          destination: getDistrictState(firstShip.address) || po.destination || prev.destination,
        }));
      }

      // Set PO lines as SO lines (replace, not merge) and store CPO limits
      const poLines = po.parsed_lines || [];
      if (poLines.length > 0) {
        const newSOLines = poLines.map(l => ({
          product_category: l.product_category || '',
          product: l.parsed_sku || '',
          quantity_ordered: l.quantity || '',
          uom: l.uom || 'KG',
          unit_price: l.price || '',
          discount: l.discount || '0',
          gst: l.gst || '0',
          remarks: l.line_remarks || '',
        }));
        setSoLines(newSOLines);
        setCpoLineLimits(poLines.map(l => ({
          product: l.parsed_sku || '',
          quantity: parseFloat(l.quantity) || 0,
          unit_price: parseFloat(l.price) || 0,
          discount: parseFloat(l.discount) || 0,
          gst: parseFloat(l.gst) || 0,
          uom: l.uom || 'KG',
        })));
        toast.success(`${poLines.length} item(s) loaded from ${po.upload_id}`);
      }
    } catch {
      toast.error('Failed to load PO details');
    }
  };

  const getFilteredProducts = (category) => {
    if (!category) return productOptions;
    return rawProducts
      .filter(p => p.goods_sub_type === category)
      .map(p => ({
        value: p.id,
        label: p.product_name || p.name || p.sku_code || p.id,
      }));
  };

  const calcLineTotal = (line) => {
    const qty = parseFloat(line.quantity_ordered) || 0;
    const price = parseFloat(line.unit_price) || 0;
    const disc = parseFloat(line.discount) || 0;
    const gst = parseFloat(line.gst) || 0;
    const afterDisc = qty * price - disc;
    return afterDisc + (afterDisc * gst / 100);
  };

  const hasCpoLimits = cpoLineLimits.some(l => l !== null);

  const handleLineChange = (index, field, value) => {
    const limit = cpoLineLimits[index];

    // When CPO is linked, block changes to locked fields
    if (limit && ['product', 'product_category', 'unit_price', 'discount', 'gst', 'uom'].includes(field)) {
      return;
    }
    // Cap quantity to CPO max
    if (limit && field === 'quantity_ordered') {
      const num = parseFloat(value);
      if (num > limit.quantity) {
        toast.error(`Quantity cannot exceed CPO limit: ${limit.quantity}`);
        return;
      }
    }

    setSoLines(prev => prev.map((line, i) => {
      if (i !== index) return line;
      const newLine = { ...line, [field]: value };

      if (field === 'product_category') {
        newLine.product = '';
        newLine.unit_price = '';
        newLine.discount = '0';
        newLine.gst = '0';
      }

      if (field === 'product' && value) {
        const prod = rawProducts.find(p => p.id === value);
        if (prod) {
          if (!newLine.product_category && prod.goods_sub_type) {
            newLine.product_category = prod.goods_sub_type;
          }
          newLine.uom = prod.uom || newLine.uom;
        }
      }

      return newLine;
    }));
    if (errors.lines) setErrors(prev => ({ ...prev, lines: '' }));
  };

  const addLine = () => setSoLines(prev => [...prev, { ...emptySOLine }]);
  const removeLine = (index) => {
    if (soLines.length > 1) setSoLines(prev => prev.filter((_, i) => i !== index));
  };

  // Totals
  const grandTotal = soLines.reduce((sum, line) => sum + calcLineTotal(line), 0);
  const totalQty = soLines.reduce((sum, line) => sum + (parseFloat(line.quantity_ordered) || 0), 0);

  // Validation
  const validate = () => {
    const newErrors = {};

    if (!formData.company) newErrors.company = 'Company is required';
    if (!formData.customer) newErrors.customer = 'Customer is required';
    if (!formData.warehouse) newErrors.warehouse = 'Warehouse is required';
    if (!formData.so_date) newErrors.so_date = 'SO Date is required';
    if (!formData.freight_terms) newErrors.freight_terms = 'Freight Terms is required';
    if (!formData.payment_terms) newErrors.payment_terms = 'Payment Terms is required';
    if (!formData.currency) newErrors.currency = 'Currency is required';

    // Required Ship Date must be today or future
    if (formData.required_ship_date) {
      const today = new Date().toISOString().split('T')[0];
      if (formData.required_ship_date < today) {
        newErrors.required_ship_date = 'Ship date cannot be in the past';
      }
    }

    // Product lines validation
    const validLines = soLines.filter(l => l.product || l.quantity_ordered);
    if (validLines.length === 0) {
      newErrors.lines = 'At least one product line is required';
    } else {
      const lineErrors = [];
      soLines.forEach((line, i) => {
        const le = {};
        if (!line.product && (line.quantity_ordered || line.unit_price)) {
          le.product = 'Product is required';
        }
        if (line.product && (!line.quantity_ordered || parseFloat(line.quantity_ordered) <= 0)) {
          le.quantity = 'Qty must be greater than 0';
        }
        if (line.product && (!line.unit_price || parseFloat(line.unit_price) < 0)) {
          le.price = 'Unit price must be 0 or more';
        }
        if (line.product && line.discount && parseFloat(line.discount) < 0) {
          le.discount = 'Discount cannot be negative';
        }
        if (line.product && line.gst && (parseFloat(line.gst) < 0 || parseFloat(line.gst) > 100)) {
          le.gst = 'GST must be 0-100%';
        }
        // Discount should not exceed subtotal
        if (line.product && line.quantity_ordered && line.unit_price) {
          const subtotal = parseFloat(line.quantity_ordered) * parseFloat(line.unit_price);
          if (parseFloat(line.discount) > subtotal) {
            le.discount = 'Discount exceeds subtotal';
          }
        }
        // CPO limit checks
        const limit = cpoLineLimits[i];
        if (limit && line.product) {
          if (parseFloat(line.quantity_ordered) > limit.quantity) {
            le.quantity = `Cannot exceed CPO qty: ${limit.quantity}`;
          }
          if (parseFloat(line.unit_price) > limit.unit_price) {
            le.price = `Cannot exceed CPO price: ${limit.unit_price}`;
          }
          if (parseFloat(line.gst) > limit.gst) {
            le.gst = `Cannot exceed CPO GST: ${limit.gst}%`;
          }
        }
        if (Object.keys(le).length > 0) lineErrors[i] = le;
      });
      if (lineErrors.length > 0 || Object.keys(lineErrors).length > 0) {
        newErrors.lineErrors = lineErrors;
      }
    }

    // Check for duplicate products
    const productIds = soLines.filter(l => l.product).map(l => l.product);
    const duplicates = productIds.filter((id, idx) => productIds.indexOf(id) !== idx);
    if (duplicates.length > 0) {
      newErrors.lines = (newErrors.lines || '') + ' Duplicate products found.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) {
      toast.error('Please fix the validation errors before saving.');
      return;
    }
    setIsSaving(true);
    try {
      const payload = {
        customer: formData.customer,
        company: formData.company,
        warehouse: formData.warehouse,
        price_list: formData.price_list || null,
        freight_terms: formData.freight_terms || '',
        payment_terms: formData.payment_terms || '',
        currency: formData.currency || 'INR',
        delivery_terms: formData.delivery_terms || '',
        required_ship_date: formData.required_ship_date || undefined,
        destination: formData.destination || '',
        payment_due_date: formData.payment_due_date || null,
        dispatched_through: formData.dispatched_through || '',
        consignee_name: formData.consignee_name || '',
        consignee_address: formData.consignee_address || '',
        consignee_gstin: formData.consignee_gstin || '',
        billing_name: formData.billing_name || '',
        billing_address: formData.billing_address || '',
        billing_gstin: formData.billing_gstin || '',
        special_instructions: formData.special_instructions || '',
        customer_po_ids: selectedPOIds.length > 0 ? selectedPOIds : undefined,
        remarks: formData.remarks || '',
        so_lines: soLines
          .filter(l => l.product && l.quantity_ordered)
          .map((l, i) => {
            const { product_category, ...lineData } = l;
            return {
              ...cleanFormData(lineData),
              line_no: i + 1,
            };
          }),
      };
      if (import.meta.env.DEV) console.log('[EditSalesOrder] payload:', payload);
      await apiClient.put(`/api/sales/orders/${id}/`, payload);
      toast.success('Sales Order updated!');
      if (pendingAttachments.length > 0) { await uploadPendingFiles('SALES_ORDER', id, pendingAttachments); }
      navigate(`/sales/orders/${id}`);
    } catch (error) {
      if (import.meta.env.DEV) console.error('[EditSalesOrder] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally { setIsSaving(false); }
  };

  const fmt = (v) => formatCurrency(v);
  const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  const FieldError = ({ msg }) => msg ? <p className="text-xs text-red-500 mt-1">{msg}</p> : null;

  if (isLoading) return <MainLayout><div className="space-y-4">{[1, 2, 3].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;

  return (
    <MainLayout>
      <PageHeader title={`Edit Sales Order — ${formData.so_no}`} breadcrumbs={[
        { label: 'Sales', path: '/sales' }, { label: 'Orders', path: '/sales/orders' },
        { label: formData.so_no, path: `/sales/orders/${id}` }, { label: 'Edit' },
      ]} />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <form onSubmit={handleSubmit} noValidate>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Customer PO — read-only chips for clubbed (multi-PO) SOs, else the auto-fill dropdown */}
          <div>
            {linkedPOs.length > 0 ? (
              <>
                <h3 className="text-lg font-semibold text-slate-800 mb-3 pb-2 border-b">Linked Customer POs <span className="text-xs font-normal text-slate-500">(this SO was built from these — read only)</span></h3>
                <div className="flex flex-wrap gap-2">
                  {linkedPOs.map((po) => (
                    <span key={po.id} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-700">
                      <FileText size={14} className="text-slate-400" />
                      {po.po_number || po.upload_id}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-slate-400 mt-2">
                  Clubbed from {linkedPOs.length} Customer PO{linkedPOs.length > 1 ? 's' : ''}. To change what’s included, use the Multi-PO Sales Order page.
                </p>
              </>
            ) : (
              <>
                <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Customer PO <span className="text-red-500">*</span> <span className="text-xs font-normal text-slate-500">(select to auto-fill all fields below)</span></h3>
                <div>
                  <CustomSelect value={selectedPOIds[0] || ''} onChange={(e) => {
                    const val = e.target.value;
                    if (val) {
                      handlePOSelect(val);
                    } else {
                      setSelectedPOIds([]);
                      setSoLines([{ ...emptySOLine }]);
                    }
                  }} className={`${errors.customer_po ? errorInputClass : inputClass} border-blue-300 bg-blue-50 text-base py-3`}>
                    <option value="">-- Select Customer PO --</option>
                    {allAvailablePOs.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </CustomSelect>
                  <FieldError msg={errors.customer_po} />
                  {allAvailablePOs.length === 0 && (
                    <p className="text-xs text-slate-400 mt-1">No confirmed, unlinked Customer POs available.</p>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Order Details — auto-filled from CPO */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Order Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">SO No</label>
                <input type="text" name="so_no" value={formData.so_no} readOnly className={`${inputClass} bg-slate-50 text-slate-600`} placeholder="Auto-generating..." />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} className={errors.company ? errorInputClass : inputClass}>
                  <option value="">Select Company</option>
                  {companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                <FieldError msg={errors.company} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer <span className="text-red-500">*</span></label>
                <CustomSelect name="customer" value={formData.customer} onChange={handleChange} className={errors.customer ? errorInputClass : inputClass} disabled={!formData.company}>
                  <option value="">{formData.company ? 'Select Customer' : 'Select Company first'}</option>
                  {filteredCustomers.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                <FieldError msg={errors.customer} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleChange} disabled={!formData.company} className={`${errors.warehouse ? errorInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                  <option value="">{formData.company ? 'Select Warehouse' : 'Select company first...'}</option>
                  {warehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                <FieldError msg={errors.warehouse} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">SO Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="so_date" value={formData.so_date} onChange={handleChange} className={errors.so_date ? errorInputClass : inputClass} />
                <FieldError msg={errors.so_date} />
              </div>
            </div>
          </div>

          {/* Terms & Currency */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Terms & Currency</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Terms <span className="text-red-500">*</span></label>
                <CustomSelect name="freight_terms" value={formData.freight_terms} onChange={handleChange} className={errors.freight_terms ? errorInputClass : inputClass}>
                  <option value="">Select Freight Terms</option>
                  <option value="PAID">Paid</option>
                  {/* "To Pay" hidden when delivery is Ex-Factory —
                      customer arranges and pays freight themselves. */}
                  {formData.delivery_terms !== 'EX_FACTORY' && (
                    <option value="TO_PAY">To Pay</option>
                  )}
                </CustomSelect>
                {formData.delivery_terms === 'EX_FACTORY' && (
                  <p className="text-xs text-slate-500 mt-1">
                    Ex-Factory — customer arranges freight, "To Pay" doesn't apply.
                  </p>
                )}
                <FieldError msg={errors.freight_terms} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms <span className="text-red-500">*</span></label>
                <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} className={errors.payment_terms ? errorInputClass : inputClass}>
                  <option value="">Select Payment Terms</option>
                  <option value="NET_15">Net 15</option>
                  <option value="NET_30">Net 30</option>
                  <option value="NET_45">Net 45</option>
                </CustomSelect>
                <FieldError msg={errors.payment_terms} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Currency <span className="text-red-500">*</span></label>
                <CustomSelect name="currency" value={formData.currency} onChange={handleChange} className={errors.currency ? errorInputClass : inputClass}>
                  <option value="">Select Currency</option>
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                </CustomSelect>
                <FieldError msg={errors.currency} />
              </div>
            </div>
          </div>

          {/* Shipping & Reference */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Shipping & Reference</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Delivery Terms</label>
                <CustomSelect name="delivery_terms" value={formData.delivery_terms} onChange={handleChange} className={inputClass}>
                  <option value="">Select</option><option value="EX_FACTORY">Ex-Factory</option><option value="DOOR_DELIVERY">Door Delivery</option><option value="CIF">CIF</option><option value="FOB">FOB</option>
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Required Ship Date</label>
                <CustomDatePicker name="required_ship_date" value={formData.required_ship_date} onChange={handleChange} min={new Date().toISOString().split('T')[0]} className={errors.required_ship_date ? errorInputClass : inputClass} />
                <FieldError msg={errors.required_ship_date} /></div>
              {/* Payment Due Date — propagates to the receivable when
                  an invoice is generated against this SO. The earlier
                  `Delivery Due Date` and `Delivery Date` fields were
                  removed; delivery scheduling lives on the DC. */}
              {!isHeaderHidden('payment_due_date') && (
                <div><label className="block text-sm font-medium text-slate-700 mb-1">Payment Due Date</label>
                  <CustomDatePicker
                    name="payment_due_date"
                    value={formData.payment_due_date}
                    onChange={handleChange}
                    disabled={isHeaderReadOnly('payment_due_date')}
                    className={isHeaderReadOnly('payment_due_date') ? lockedInputClass : inputClass}
                  />
                  <p className="text-xs text-slate-400 mt-0.5">Flows to the receivable when the invoice is generated.</p>
                </div>
              )}
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Destination</label>
                <input type="text" name="destination" value={formData.destination} readOnly className={`${inputClass} bg-slate-50 text-slate-600`} />
                <p className="text-xs text-slate-400 mt-0.5">Auto-filled from shipping address (District, State)</p></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Dispatched Through</label>
                <CustomSelect name="dispatched_through" value={formData.dispatched_through} onChange={handleChange} className={inputClass}>
                  {DISPATCHED_THROUGH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
            </div>
          </div>

          {/* Consignee & Billing */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Consignee & Billing</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4 sm:gap-6">
              {/* Shipping Address Selection */}
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                <h4 className="text-sm font-semibold text-blue-800 mb-3">Consignee (Ship To)</h4>

                {/* Show all CPO shipping addresses as selectable options */}
                {cpoShippingAddresses.length > 1 && (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-blue-700 mb-2">Select shipping address from Customer PO:</p>
                    <div className="space-y-2">
                      {cpoShippingAddresses.map((sa, idx) => {
                        const isSelected = formData.consignee_name === sa.name && formData.consignee_address === sa.address;
                        return (
                          <label key={idx} className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition ${isSelected ? 'bg-blue-100 border-blue-400 ring-1 ring-blue-400' : 'bg-white border-slate-200 hover:border-blue-300'}`}>
                            <input type="radio" name="ship_addr_select" checked={isSelected}
                              onChange={() => setFormData(prev => ({
                                ...prev, consignee_name: sa.name, consignee_address: sa.address,
                                consignee_gstin: sa.gstin, destination: getDistrictState(sa.address),
                              }))}
                              className="mt-0.5 w-3.5 h-3.5 text-blue-600 border-slate-300 focus:ring-blue-500" />
                            <div className="text-xs">
                              <p className="font-semibold text-slate-800">{sa.name || `Address #${idx + 1}`}</p>
                              <p className="text-slate-600 mt-0.5">{formatAddressDisplay(sa.address) || 'No address'}</p>
                              {sa.gstin && <p className="text-slate-500 mt-0.5">GSTIN: {sa.gstin}</p>}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Editable selected address */}
                <div className="space-y-3">
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                    <input type="text" name="consignee_name" value={formData.consignee_name} onChange={handleChange} className={inputClass} /></div>
                  <AddressField label="Address" value={formData.consignee_address} onChange={(v) => {
                    setFormData(prev => ({ ...prev, consignee_address: v, destination: getDistrictState(v) }));
                  }} />
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">GST No</label>
                    <input type="text" name="consignee_gstin" value={formData.consignee_gstin} onChange={handleChange} className={inputClass} /></div>
                </div>
              </div>

              {/* Billing Address Selection */}
              <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                <h4 className="text-sm font-semibold text-green-800 mb-3">Billing Address</h4>

                {/* Show all CPO billing addresses as selectable options */}
                {cpoAllBillingAddresses.length > 1 && (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-green-700 mb-2">Select billing address from Customer PO:</p>
                    <div className="space-y-2">
                      {cpoAllBillingAddresses.map((ba, idx) => {
                        const isSelected = formData.billing_address === ba.address;
                        return (
                          <label key={idx} className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition ${isSelected ? 'bg-green-100 border-green-400 ring-1 ring-green-400' : 'bg-white border-slate-200 hover:border-green-300'}`}>
                            <input type="radio" name="bill_addr_select" checked={isSelected}
                              onChange={() => setFormData(prev => ({
                                ...prev, billing_name: ba.name || prev.billing_name,
                                billing_address: ba.address, billing_gstin: ba.gstin,
                              }))}
                              className="mt-0.5 w-3.5 h-3.5 text-green-600 border-slate-300 focus:ring-green-500" />
                            <div className="text-xs">
                              <p className="font-semibold text-slate-800">Billing #{idx + 1}</p>
                              <p className="text-slate-600 mt-0.5">{formatAddressDisplay(ba.address) || 'No address'}</p>
                              {ba.gstin && <p className="text-slate-500 mt-0.5">GSTIN: {ba.gstin}</p>}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Editable selected address */}
                <div className="space-y-3">
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                    <input type="text" name="billing_name" value={formData.billing_name} onChange={handleChange} className={inputClass} /></div>
                  <AddressField label="Address" value={formData.billing_address} onChange={(v) => setFormData(prev => ({ ...prev, billing_address: v }))} />
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">GST No</label>
                    <input type="text" name="billing_gstin" value={formData.billing_gstin} onChange={handleChange} className={inputClass} /></div>
                </div>
              </div>
            </div>
          </div>

          {/* Product Lines */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Product Lines</h3>
              {!hasCpoLimits && (
                <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                  <Plus size={16} /> Add Product
                </button>
              )}
            </div>
            {errors.lines && (
              <div className="mb-3 p-3 bg-red-50 rounded-lg text-sm text-red-700">{errors.lines}</div>
            )}

            {/* Mobile-only stacked editor. */}
            <div className="sm:hidden space-y-3">
              {soLines.map((line, index) => {
                const lineTotal = calcLineTotal(line);
                const le = errors.lineErrors?.[index] || {};
                const limit = cpoLineLimits[index];
                const locked = !!limit;
                return (
                  <div key={index} className="border border-slate-200 rounded-lg p-3 space-y-2 bg-white">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Line #{index + 1}</span>
                      {!locked && (
                        <button type="button" onClick={() => removeLine(index)} disabled={soLines.length <= 1} className="inline-flex items-center gap-1 text-red-500 disabled:opacity-30 text-xs">
                          <Trash2 size={14} /> Remove
                        </button>
                      )}
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Product Category</label>
                      <CustomSelect value={line.product_category || ''} onChange={(e) => handleLineChange(index, 'product_category', e.target.value)} disabled={locked} className={`${locked ? lockedInputClass : inputClass} w-full`}>
                        {GOODS_SUB_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Product <span className="text-red-500">*</span></label>
                      <CustomSelect value={line.product} onChange={(e) => handleLineChange(index, 'product', e.target.value)} disabled={locked || !line.product_category} className={`${locked ? lockedInputClass : le.product ? errorInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed w-full`}>
                        <option value="">{line.product_category ? 'Select Product' : 'Select Category first'}</option>
                        {getFilteredProducts(line.product_category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                      {le.product && <p className="text-xs text-red-500 mt-0.5">{le.product}</p>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Qty <span className="text-red-500">*</span></label>
                        <input type="number" step="0.001" min="0.001" max={limit ? limit.quantity : undefined} value={line.quantity_ordered} onChange={(e) => handleLineChange(index, 'quantity_ordered', e.target.value)} className={`${le.quantity ? errorInputClass : inputClass} w-full text-right`} placeholder="0" />
                        {limit && <p className="text-[10px] text-blue-500 mt-0.5">Max: {limit.quantity}</p>}
                        {le.quantity && <p className="text-xs text-red-500 mt-0.5">{le.quantity}</p>}
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">UOM</label>
                        <CustomSelect value={line.uom} onChange={(e) => handleLineChange(index, 'uom', e.target.value)} disabled={locked} className={`${locked ? lockedInputClass : inputClass} w-full`}>
                          {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                        </CustomSelect>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Unit Price</label>
                        <input type="number" step="0.01" min="0" value={line.unit_price} onChange={(e) => handleLineChange(index, 'unit_price', e.target.value)} readOnly={locked} className={`${locked ? lockedInputClass : le.price ? errorInputClass : inputClass} w-full text-right`} placeholder="0.00" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Discount</label>
                        <input type="number" step="0.01" min="0" value={line.discount} onChange={(e) => handleLineChange(index, 'discount', e.target.value)} readOnly={locked} className={`${locked ? lockedInputClass : le.discount ? errorInputClass : inputClass} w-full text-right`} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">GST %</label>
                        <input type="number" step="0.01" min="0" max="100" value={line.gst} onChange={(e) => handleLineChange(index, 'gst', e.target.value)} readOnly={locked} className={`${locked ? lockedInputClass : le.gst ? errorInputClass : inputClass} w-full text-right`} />
                      </div>
                      <div className="flex flex-col justify-end">
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Total</label>
                        <div className="px-3 py-2 bg-slate-100 border border-slate-300 rounded text-right text-sm font-bold text-slate-900">{lineTotal > 0 ? fmt(lineTotal) : '-'}</div>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Remarks</label>
                      <input type="text" value={line.remarks || ''} onChange={(e) => handleLineChange(index, 'remarks', e.target.value)} className={`${inputClass} w-full`} />
                    </div>
                  </div>
                );
              })}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">Total Qty</span><span className="font-medium text-slate-800">{fmtQty(totalQty)}</span></div>
                <div className="flex justify-between pt-2 mt-1 border-t border-slate-300">
                  <span className="text-slate-700 font-semibold">Grand Total</span>
                  <span className="text-base font-bold text-slate-900">{fmt(grandTotal)}</span>
                </div>
              </div>
            </div>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Product Category</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Qty <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Unit Price</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Discount</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">GST %</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Total</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Need to Dispatch</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {soLines.map((line, index) => {
                    const lineTotal = calcLineTotal(line);
                    const qty = parseFloat(line.quantity_ordered) || 0;
                    const le = errors.lineErrors?.[index] || {};
                    const limit = cpoLineLimits[index];
                    const locked = !!limit;
                    return (
                      <tr key={index} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                        <td className="px-3 py-2">
                          <CustomSelect value={line.product_category || ''} onChange={(e) => handleLineChange(index, 'product_category', e.target.value)} disabled={locked} className={locked ? lockedInputClass : inputClass} style={{ minWidth: '150px' }}>
                            {GOODS_SUB_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                        </td>
                        <td className="px-3 py-2">
                          <CustomSelect value={line.product} onChange={(e) => handleLineChange(index, 'product', e.target.value)} disabled={locked || !line.product_category} className={`${locked ? lockedInputClass : le.product ? errorInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`} style={{ minWidth: '180px' }}>
                            <option value="">{line.product_category ? 'Select Product' : 'Select Category first'}</option>
                            {getFilteredProducts(line.product_category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                          {le.product && <p className="text-xs text-red-500 mt-0.5">{le.product}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.001" min="0.001" max={limit ? limit.quantity : undefined} value={line.quantity_ordered} onChange={(e) => handleLineChange(index, 'quantity_ordered', e.target.value)} className={le.quantity ? errorInputClass : inputClass} style={{ minWidth: '90px' }} placeholder="0" />
                          {limit && <p className="text-xs text-blue-500 mt-0.5">Max: {limit.quantity}</p>}
                          {le.quantity && <p className="text-xs text-red-500 mt-0.5">{le.quantity}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <CustomSelect value={line.uom} onChange={(e) => handleLineChange(index, 'uom', e.target.value)} disabled={locked} className={locked ? lockedInputClass : inputClass} style={{ minWidth: '80px' }}>
                            {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                          </CustomSelect>
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" value={line.unit_price} onChange={(e) => handleLineChange(index, 'unit_price', e.target.value)} readOnly={locked} className={locked ? lockedInputClass : le.price ? errorInputClass : inputClass} style={{ minWidth: '100px' }} placeholder="0.00" />
                          {le.price && <p className="text-xs text-red-500 mt-0.5">{le.price}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" value={line.discount} onChange={(e) => handleLineChange(index, 'discount', e.target.value)} readOnly={locked} className={locked ? lockedInputClass : le.discount ? errorInputClass : inputClass} style={{ minWidth: '80px' }} />
                          {le.discount && <p className="text-xs text-red-500 mt-0.5">{le.discount}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" max="100" value={line.gst} onChange={(e) => handleLineChange(index, 'gst', e.target.value)} readOnly={locked} className={locked ? lockedInputClass : le.gst ? errorInputClass : inputClass} style={{ minWidth: '70px' }} />
                          {le.gst && <p className="text-xs text-red-500 mt-0.5">{le.gst}</p>}
                        </td>
                        <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                          {lineTotal > 0 ? fmt(lineTotal) : '-'}
                        </td>
                        <td className="px-3 py-2 text-right font-medium whitespace-nowrap text-orange-600">
                          {qty > 0 ? fmtQty(qty) : '-'}
                        </td>
                        <td className="px-3 py-2">
                          <input type="text" value={line.remarks || ''} onChange={(e) => handleLineChange(index, 'remarks', e.target.value)} className={inputClass} style={{ minWidth: '120px' }} />
                        </td>
                        <td className="px-3 py-2">
                          {!locked && (
                            <button type="button" onClick={() => removeLine(index)} disabled={soLines.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30">
                              <Trash2 size={16} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-semibold border-t-2 border-slate-300">
                    <td colSpan="3" className="px-3 py-2 text-right text-slate-600">Totals:</td>
                    <td className="px-3 py-2 text-right text-slate-800">{fmtQty(totalQty)}</td>
                    <td colSpan="4"></td>
                    <td className="px-3 py-2 text-right text-base text-slate-800">{fmt(grandTotal)}</td>
                    <td className="px-3 py-2 text-right font-semibold text-orange-600">{fmtQty(totalQty)}</td>
                    <td colSpan="2"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Additional Information */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Additional Information</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Special Instructions</label>
                <textarea name="special_instructions" value={formData.special_instructions} onChange={handleChange} rows={3} className={inputClass} placeholder="e.g. GOODS WILL BE ACCEPTED ONLY AFTER SATISFACTORY COMPLETION OF QUALITY PARAMETERS" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} className={inputClass} />
              </div>
            </div>
          </div>

          <FileAttachments module="SALES_ORDER" recordId={id} deferUpload onPendingChange={setPendingAttachments} />

          {/* Actions */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="w-full sm:w-auto px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isSaving} className="w-full sm:w-auto px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Save'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
