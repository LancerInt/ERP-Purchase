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
import AddressField, { formatAddressDisplay, getDistrictState, stringifyAddress } from '../../../components/common/AddressField';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import { SALES_UOM_OPTIONS } from '../utils/uomOptions';
import { formatCurrency } from '@/utils/formatters';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

// Round to a DB column's precision before sending — DRF DecimalFields reject a
// value with more decimal places than the column allows (price/GST = 2 dp,
// qty = 4 dp). Returns null for blank so the caller can apply its default.
const dec = (v, places) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(places)) : null;
};

const GOODS_SUB_TYPE_OPTIONS = [
  { value: '', label: 'Select Category' },
  { value: 'RAW_MATERIAL', label: 'Raw Material' }, { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'FINISHED_GOOD', label: 'Finished Good' }, { value: 'SEMI_FINISHED', label: 'Semi Finished' },
  { value: 'TRADED_PRODUCTS', label: 'Traded Products' }, { value: 'CAPITAL_GOOD', label: 'Capital Good' },
  { value: 'MACHINE_SPARES', label: 'Machine Spares' }, { value: 'CONSUMABLES', label: 'Consumables' },
];

const emptyLine = {
  product_category: 'FINISHED_GOOD', parsed_sku: '', product_description: '', item_code: '', hsn_code: '',
  quantity: '', uom: 'KG', price: '', discount: '0', gst: '0',
  sgst_percent: '0', cgst_percent: '0', igst_percent: '0',
  line_remarks: '',
};

export default function EditCustomerPO() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: productOptions, raw: rawProducts } = useLookup('/api/products/');
  const { options: stateGroupOptions, raw: stateGroupsRaw } = useLookup('/api/state-groups/');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [selectedCompany, setSelectedCompany] = useState('');
  const [filteredCustomers, setFilteredCustomers] = useState([]);
  const [filteredPriceLists, setFilteredPriceLists] = useState([]);
  const [priceLines, setPriceLines] = useState([]);

  const [formData, setFormData] = useState({
    upload_id: '', company: '', customer: '',
    po_number: '', po_date: '',
    price_list: '', state_group: '',
    freight_terms: '', payment_terms: 'NET_15',
    currency: 'INR', required_ship_date: '',
    delivery_type: 'EX_FACTORY',
    delivery_due_date: '',
    dispatched_through: 'BY_ROAD', consignee_name: '', consignee_address: '', consignee_gstin: '',
    billing_name: '', billing_address: '', billing_gstin: '',
    special_instructions: '',
    destination: '', remarks: '',
  });
  const [poLines, setPoLines] = useState([{ ...emptyLine }]);
  // Customer master addresses (from shipping_addresses)
  const [customerAddresses, setCustomerAddresses] = useState([]);
  const [selectedShipIdx, setSelectedShipIdx] = useState(0);

  useEffect(() => {
    apiClient.get(`/api/sales/customer-po/${id}/`).then(r => {
      const p = r.data;
      setFormData({
        upload_id: p.upload_id || '',
        company: p.company || '', customer: p.customer || '',
        po_number: p.po_number || '', po_date: p.po_date || '',
        price_list: p.price_list || '', state_group: p.state_group || '',
        freight_terms: p.freight_terms || '',
        payment_terms: p.payment_terms || 'NET_15',
        currency: p.currency || 'INR',
        required_ship_date: p.required_ship_date || '', delivery_type: p.delivery_type || 'EX_FACTORY',
        delivery_due_date: p.delivery_due_date || '',
        dispatched_through: p.dispatched_through || 'BY_ROAD',
        consignee_name: p.consignee_name || '', consignee_address: p.consignee_address || '',
        consignee_gstin: p.consignee_gstin || '',
        billing_name: p.billing_name || '', billing_address: p.billing_address || '',
        billing_gstin: p.billing_gstin || '', special_instructions: p.special_instructions || '',
        destination: p.destination || '', remarks: p.remarks || '',
      });
      setSelectedCompany(p.company || '');
      if (p.company) {
        apiClient.get(`/api/customers/?company=${p.company}`)
          .then(r2 => {
            const list = (r2.data?.results || r2.data || []).map(c => ({ value: c.id, label: c.customer_name || c.name || c.id, raw: c }));
            // Merge, preserving an already-injected saved customer not in this
            // company's list (order-independent with the customer-detail fetch).
            setFilteredCustomers(prev => {
              const extra = prev.filter(o => !list.some(l => String(l.value) === String(o.value)));
              return [...extra, ...list];
            });
          })
          .catch(() => {});
      }
      if (p.customer) {
        apiClient.get(`/api/price-lists/for_customer/?customer_id=${p.customer}`)
          .then(r2 => {
            const list = (r2.data?.results || r2.data || []).map(pl => ({ value: pl.id, label: pl.price_list_id }));
            setFilteredPriceLists(prev => {
              const extra = prev.filter(o => !list.some(l => String(l.value) === String(o.value)));
              return [...extra, ...list];
            });
          })
          .catch(() => {});
        // Fetch customer shipping addresses from master
        apiClient.get(`/api/customers/${p.customer}/`).then(r2 => {
          const cust = r2.data;
          // Guarantee the PO's own customer is always a selectable option,
          // even if it isn't in this company's customer list (it may have
          // been resolved cross-company during extraction) — otherwise the
          // dropdown falls back to the placeholder and looks "reset".
          setFilteredCustomers(prev => (
            prev.some(o => String(o.value) === String(p.customer))
              ? prev
              : [{ value: p.customer, label: cust.customer_name || cust.name || 'Current customer', raw: cust }, ...prev]
          ));
          const addrs = (cust.shipping_addresses || []).map((sa, i) => ({
            label: sa.address_label || `Shipping Address ${i + 1}`,
            address: sa.address ? (typeof sa.address === 'object' ? JSON.stringify(sa.address) : sa.address) : '',
            contact: sa.contact_person || '',
            phone: sa.contact_phone || '',
            type: 'shipping',
          }));
          setCustomerAddresses(addrs);
        }).catch(() => {});
      }
      if (p.price_list) {
        apiClient.get(`/api/price-lists/${p.price_list}/lines/`)
          .then(r2 => setPriceLines(r2.data?.results || r2.data || []))
          .catch(() => {});
        // Guarantee the PO's own price list is a selectable option, even if
        // /for_customer/ didn't return it (a state-specific or sibling list),
        // so the dropdown shows what the PO was saved with.
        apiClient.get(`/api/price-lists/${p.price_list}/`).then(r2 => {
          const pl = r2.data;
          setFilteredPriceLists(prev => (
            prev.some(o => String(o.value) === String(p.price_list))
              ? prev
              : [{ value: p.price_list, label: pl.price_list_id || pl.name || 'Current price list' }, ...prev]
          ));
        }).catch(() => {});
      }
      const lines = (p.parsed_lines || []).map(l => ({
        product_category: l.product_category || '', parsed_sku: l.parsed_sku || '',
        product_description: l.product_description || '', item_code: l.item_code || '',
        hsn_code: l.hsn_code || '', quantity: l.quantity || '', uom: l.uom || 'KG',
        price: l.price || '', discount: l.discount || '0', gst: l.gst || '0',
        sgst_percent: l.sgst_percent || '0', cgst_percent: l.cgst_percent || '0',
        igst_percent: l.igst_percent || '0',
        line_remarks: l.line_remarks || '',
      }));
      setPoLines(lines.length > 0 ? lines : [{ ...emptyLine }]);
    }).catch(() => { toast.error('Failed to load'); navigate('/sales/customer-po'); })
    .finally(() => setIsLoading(false));
  }, [id]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (name === 'company') {
      setSelectedCompany(value);
      setFormData(prev => ({ ...prev, company: value, customer: '', price_list: '',
        consignee_name: '', consignee_address: '', consignee_gstin: '',
        billing_name: '', billing_address: '', billing_gstin: '',
      }));
      setFilteredCustomers([]); setFilteredPriceLists([]); setPriceLines([]);
      if (value) {
        // Fetch customers for this company
        apiClient.get(`/api/customers/?company=${value}`)
          .then(r => {
            const list = r.data?.results || r.data || [];
            setFilteredCustomers(list.map(c => ({
              value: c.id,
              label: c.customer_name || c.name || c.id,
              raw: c,
            })));
          }).catch(() => {});
        // Auto-fill billing address from company
        apiClient.get(`/api/companies/${value}/`)
          .then(r => {
            const co = r.data;
            const addr = co.billing_address || co.registered_address;
            let addrStr = '';
            if (addr) {
              if (typeof addr === 'object' && !Array.isArray(addr)) addrStr = stringifyAddress(addr);
              else if (typeof addr === 'string') addrStr = addr;
            }
            setFormData(prev => ({
              ...prev,
              billing_name: co.legal_name || co.trade_name || '',
              billing_address: addrStr || co.legal_name || '',
              billing_gstin: co.gstin || '',
            }));
          }).catch(() => {});
      }
    }
    if (name === 'customer') {
      const selectedCust = filteredCustomers.find(c => c.value === value);
      const custData = selectedCust?.raw || {};

      setFormData(prev => ({
        ...prev,
        customer: value,
        price_list: '',
        consignee_name: custData.customer_name || custData.name || '',
        consignee_gstin: custData.gstin || '',
        // Default the payment terms from the customer master's Credit Terms
        // (see new.jsx). A price list picked later overrides with its own.
        payment_terms: custData.credit_terms || prev.payment_terms,
      }));
      setSelectedShipIdx(0);
      setCustomerAddresses([]);

      // Fetch customer detail with shipping addresses from master
      if (value) {
        apiClient.get(`/api/customers/${value}/`).then(r => {
          const cust = r.data;
          const addrs = (cust.shipping_addresses || []).map((sa, i) => ({
            label: sa.address_label || `Shipping Address ${i + 1}`,
            address: sa.address ? (typeof sa.address === 'object' ? JSON.stringify(sa.address) : sa.address) : '',
            contact: sa.contact_person || '',
            phone: sa.contact_phone || '',
            type: 'shipping',
          }));
          setCustomerAddresses(addrs);
          // Auto-select first address
          if (addrs.length > 0) {
            setFormData(prev => ({
              ...prev,
              consignee_address: addrs[0].address,
              destination: getDistrictState(addrs[0].address),
            }));
          }
        }).catch(() => {});
      }
      setFilteredPriceLists([]); setPriceLines([]);
      if (value) {
        apiClient.get(`/api/price-lists/for_customer/?customer_id=${value}`)
          .then(r => setFilteredPriceLists((r.data?.results || r.data || []).map(pl => ({ value: pl.id, label: pl.price_list_id }))))
          .catch(() => setFilteredPriceLists([]));
      }
    }
    if (name === 'price_list' && value) {
      apiClient.get(`/api/price-lists/${value}/lines/`)
        .then(r => setPriceLines(r.data?.results || r.data || []))
        .catch(() => setPriceLines([]));
      // Auto-fill terms from price list
      apiClient.get(`/api/price-lists/${value}/`).then(r => {
        const pl = r.data;
        const gstType = pl.gst_type || '';
        setFormData(prev => ({
          ...prev,
          payment_terms: pl.payment_terms || prev.payment_terms,
          delivery_type: pl.delivery_terms || prev.delivery_type,
          currency: pl.currency || prev.currency,
          freight_terms: pl.default_freight_terms || prev.freight_terms,
        }));
        // Auto-fill UOM + GST split on product lines based on price list GST type
        setPoLines(prev => prev.map(line => {
          const updated = { ...line };
          if (line.parsed_sku) {
            const plLine = (pl.price_lines || []).find(p => p.product === line.parsed_sku);
            if (plLine?.uom) updated.uom = plLine.uom;
          }
          if (gstType === 'IGST') {
            const gst = parseFloat(updated.gst) || 0;
            updated.igst_percent = String(gst);
            updated.sgst_percent = '0';
            updated.cgst_percent = '0';
          } else if (gstType === 'CGST_SGST') {
            const gst = parseFloat(updated.gst) || 0;
            updated.sgst_percent = String(gst / 2);
            updated.cgst_percent = String(gst / 2);
            updated.igst_percent = '0';
          }
          return updated;
        }));
        if (gstType) toast.success(`GST Type set to ${gstType === 'IGST' ? 'IGST (Inter-State)' : 'CGST + SGST (Intra-State)'}`);
      }).catch(() => {});
    }
  };

  const getFilteredProducts = (cat) => {
    let products = rawProducts;
    // If price list is loaded, only show products from the price list
    if (priceLines.length > 0) {
      const plProductIds = new Set(priceLines.map(pl => pl.product));
      products = products.filter(p => plProductIds.has(p.id));
    }
    if (cat) {
      products = products.filter(p => p.goods_sub_type === cat);
    }
    return products.map(p => ({ value: p.id, label: p.product_name || p.sku_code || p.id }));
  };

  const findPriceForProduct = (productId, uom) => {
    if (!productId || priceLines.length === 0) return null;
    // Match on (product, uom) when a uom is supplied — the same
    // product can sit in one price list multiple times under
    // different UOMs (unique_together is product+uom). Without the
    // UOM filter we'd grab the first-sorted row and end up with the
    // wrong rate when the line's UOM differs.
    if (uom) {
      const u = String(uom).trim().toLowerCase();
      const exact = priceLines.find(
        pl => pl.product === productId
          && String(pl.uom || '').trim().toLowerCase() === u,
      );
      if (exact) return exact;
    }
    return priceLines.find(pl => pl.product === productId);
  };

  const handleLineChange = (idx, field, value) => {
    setPoLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const nl = { ...l, [field]: value };
      if (field === 'product_category') { nl.parsed_sku = ''; nl.price = ''; nl.discount = '0'; nl.gst = '0'; nl.sgst_percent = '0'; nl.cgst_percent = '0'; }
      if (field === 'parsed_sku' && value) {
        const prod = rawProducts.find(p => p.id === value);
        if (prod) {
          nl.product_description = prod.product_name || '';
          nl.uom = prod.uom || nl.uom;
          // HSN is NOT a Product field — it lives on the PriceLine (filled
          // below). The old `prod.sku_code` dumped the SKU into the HSN column.
          if (!nl.product_category && prod.goods_sub_type) nl.product_category = prod.goods_sub_type;
        }
        const pl = findPriceForProduct(value, nl.uom);
        if (pl) {
          nl.price = pl.rate || ''; nl.discount = pl.discount || '0'; nl.uom = pl.uom || nl.uom;
          if (pl.hsn_code) nl.hsn_code = pl.hsn_code;
        }
      }
      // Auto-split GST into SGST/CGST (equal split)
      if (field === 'gst') {
        const totalGst = parseFloat(value) || 0;
        nl.sgst_percent = String(totalGst / 2);
        nl.cgst_percent = String(totalGst / 2);
      }
      return nl;
    }));
  };

  const addLine = () => setPoLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => { if (poLines.length > 1) setPoLines(prev => prev.filter((_, i) => i !== idx)); };

  const calcLineTotal = (l) => {
    const qty = parseFloat(l.quantity) || 0;
    const price = parseFloat(l.price) || 0;
    const disc = parseFloat(l.discount) || 0;
    const gst = parseFloat(l.gst) || 0;
    const sub = qty * price - disc;
    return sub + sub * gst / 100;
  };

  const calcLineSGST = (l) => {
    const qty = parseFloat(l.quantity) || 0;
    const price = parseFloat(l.price) || 0;
    const disc = parseFloat(l.discount) || 0;
    const sgst = parseFloat(l.sgst_percent) || 0;
    return (qty * price - disc) * sgst / 100;
  };

  const calcLineCGST = (l) => {
    const qty = parseFloat(l.quantity) || 0;
    const price = parseFloat(l.price) || 0;
    const disc = parseFloat(l.discount) || 0;
    const cgst = parseFloat(l.cgst_percent) || 0;
    return (qty * price - disc) * cgst / 100;
  };

  const totalQty = poLines.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);
  const totalAmount = poLines.reduce((s, l) => s + ((parseFloat(l.quantity) || 0) * (parseFloat(l.price) || 0)), 0);
  const totalDiscount = poLines.reduce((s, l) => s + (parseFloat(l.discount) || 0), 0);
  const totalSGST = poLines.reduce((s, l) => s + calcLineSGST(l), 0);
  const totalCGST = poLines.reduce((s, l) => s + calcLineCGST(l), 0);
  const grandTotal = poLines.reduce((s, l) => s + calcLineTotal(l), 0);
  const fmt = (v) => formatCurrency(v);
  const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.customer) { toast.error('Customer is required'); return; }
    const validLines = poLines.filter(l => l.parsed_sku && l.quantity);
    if (validLines.length === 0) { toast.error('At least one product line is required'); return; }

    setIsSaving(true);
    try {
      const payload = {
        ...formData,
        company: formData.company || null,
        price_list: formData.price_list || null,
        state_group: formData.state_group || null,
        required_ship_date: formData.required_ship_date || null,
        delivery_due_date: formData.delivery_due_date || null,
        po_lines: validLines.map(l => ({
          parsed_sku: l.parsed_sku || null, product_description: l.product_description || '',
          item_code: l.item_code || '', hsn_code: l.hsn_code || '', quantity: dec(l.quantity, 4),
          uom: l.uom || '', price: dec(l.price, 2), discount: dec(l.discount, 2) ?? 0, gst: dec(l.gst, 2) ?? 0,
          sgst_percent: dec(l.sgst_percent, 2) ?? 0, cgst_percent: dec(l.cgst_percent, 2) ?? 0,
          igst_percent: dec(l.igst_percent, 2) ?? 0,
          line_remarks: l.line_remarks || '',
        })),
      };
      await apiClient.put(`/api/sales/customer-po/${id}/`, payload);
      toast.success('Updated!');
      if (pendingAttachments.length > 0) { await uploadPendingFiles('CUSTOMER_PO', id, pendingAttachments); }
      navigate(`/sales/customer-po/${id}`);
    } catch (error) { toast.error(getApiErrorMessage(error)); } finally { setIsSaving(false); }
  };

  if (isLoading) return <MainLayout><div className="space-y-4">{[1,2].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;

  return (
    <MainLayout>
      <PageHeader title={`Edit - ${formData.upload_id}`} breadcrumbs={[
        { label: 'Sales', path: '/sales' }, { label: 'Customer PO', path: '/sales/customer-po' },
        { label: formData.upload_id, path: `/sales/customer-po/${id}` }, { label: 'Edit' },
      ]} />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-6" noValidate>
          {/* Order Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Order Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">PO No</label>
                <input type="text" value={formData.upload_id} readOnly className={`${inputClass} bg-slate-50 text-slate-600 font-medium`} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">PO Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="po_date" value={formData.po_date} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} className={inputClass}>
                  <option value="">Select Company</option>{companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Customer <span className="text-red-500">*</span></label>
                <CustomSelect name="customer" value={formData.customer} onChange={handleChange} disabled={!selectedCompany} className={`${inputClass} disabled:bg-slate-100`}>
                  <option value="">{selectedCompany ? 'Select Customer' : 'Select Company first'}</option>{filteredCustomers.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Price List</label>
                <CustomSelect name="price_list" value={formData.price_list} onChange={handleChange} disabled={!formData.customer} className={`${inputClass} disabled:bg-slate-100`}>
                  <option value="">{formData.customer ? 'Select Price List' : 'Select Customer first'}</option>{filteredPriceLists.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                {formData.price_list && priceLines.length > 0 && <p className="text-xs text-green-600 mt-1">{priceLines.length} product(s) in price list</p>}
              </div>
              {/* State Group — shown only when the price list has
                  state-wise rows OR the CPO already has a state group
                  saved (so legacy / edited POs can still display + edit
                  the value). Hidden for the common single-price flow. */}
              {(priceLines.some(pl => pl.state_group) || formData.state_group) && (
                <div><label className="block text-sm font-medium text-slate-700 mb-1">State Group</label>
                  <CustomSelect
                    name="state_group"
                    value={formData.state_group || ''}
                    onChange={handleChange}
                    className={inputClass}
                    title="Blank = use the customer-wide default rate."
                  >
                    <option value="">— Default —</option>
                    {stateGroupOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                  {formData.state_group && (() => {
                    const sg = stateGroupsRaw.find(g => String(g.id) === String(formData.state_group));
                    return sg && Array.isArray(sg.member_states) && sg.member_states.length > 0
                      ? <p className="text-xs text-slate-500 mt-1">States: {sg.member_states.join(', ')}</p>
                      : null;
                  })()}
                </div>
              )}
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Customer PO Number</label>
                <input type="text" name="po_number" value={formData.po_number} onChange={handleChange} className={inputClass} placeholder="e.g. PO-1010125-05881" /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Delivery Terms</label>
                <CustomSelect name="delivery_type" value={formData.delivery_type} onChange={handleChange} className={inputClass}>
                  <option value="">Select</option><option value="EX_FACTORY">Ex-Factory</option><option value="DOOR_DELIVERY">Door Delivery</option><option value="CIF">CIF</option><option value="FOB">FOB</option>
                </CustomSelect></div>
            </div>
          </div>

          {/* Terms & Currency */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Terms & Currency</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Freight Terms — mirrors customer-po/new.jsx so edit
                  parity matches the list page. Disabled when delivery
                  is EX_FACTORY because the customer arranges freight. */}
              <div><label className="block text-sm font-medium text-slate-700 mb-1">
                  Freight Terms
                </label>
                <CustomSelect
                  name="freight_terms"
                  value={formData.freight_terms || ''}
                  onChange={handleChange}
                  disabled={formData.delivery_type === 'EX_FACTORY'}
                  className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}
                >
                  <option value="">
                    {formData.delivery_type === 'EX_FACTORY'
                      ? 'Not applicable — customer arranges'
                      : 'Select Freight Terms'}
                  </option>
                  <option value="PAID">Paid</option>
                  <option value="TO_PAY">To Pay</option>
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms</label>
                <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} className={inputClass}>
                  <option value="">Select</option>
                  <option value="IMMEDIATE">Immediate</option>
                  {/* CASH / CUSTOM mirror the Customer master's Credit Terms
                      vocabulary (see new.jsx). */}
                  <option value="CASH">Cash</option>
                  <option value="NET_15">Net 15</option>
                  <option value="NET_30">Net 30</option>
                  <option value="NET_45">Net 45</option>
                  <option value="NET_60">Net 60</option>
                  <option value="CUSTOM">Custom Days</option>
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Currency</label>
                <CustomSelect name="currency" value={formData.currency} onChange={handleChange} className={inputClass}>
                  <option value="INR">INR</option><option value="USD">USD</option>
                </CustomSelect></div>
            </div>
          </div>

          {/* Consignee (Ship To) — Select from Customer Master Addresses */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Consignee (Ship To)</h3>
            {!formData.customer ? (
              <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">Select a Customer to see available shipping addresses.</div>
            ) : customerAddresses.length === 0 ? (
              <div className="p-4 bg-slate-50 rounded-lg border text-sm text-slate-500">No addresses found for this customer. Add addresses in Customer Master.</div>
            ) : (
              <div className="mb-4">
                <label className="block text-xs font-medium text-blue-700 mb-1">Shipping Address ({customerAddresses.length} available)</label>
                <CustomSelect value={selectedShipIdx} onChange={(e) => {
                  const idx = parseInt(e.target.value);
                  setSelectedShipIdx(idx);
                  const addr = customerAddresses[idx];
                  if (addr) {
                    setFormData(prev => ({
                      ...prev,
                      consignee_address: addr.address,
                      destination: getDistrictState(addr.address),
                    }));
                  }
                }} className={inputClass}>
                  {customerAddresses.map((addr, idx) => (
                    <option key={idx} value={idx}>{addr.label} — {formatAddressDisplay(addr.address) || 'No address'}</option>
                  ))}
                </CustomSelect>
              </div>
            )}
            {/* Editable fields */}
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-2 gap-3">
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                    <input type="text" name="consignee_name" value={formData.consignee_name} onChange={handleChange} className={inputClass} /></div>
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">GST No</label>
                    <input type="text" name="consignee_gstin" value={formData.consignee_gstin} onChange={handleChange} className={inputClass} placeholder="GSTIN" /></div>
                </div>
                <AddressField label="Selected Address" value={formData.consignee_address} onChange={(v) => setFormData(prev => ({ ...prev, consignee_address: v, destination: getDistrictState(v) }))} />
              </div>
            </div>
          </div>

          {/* Billing Address — Auto-fill from Company */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Billing Address</h3>
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-2 gap-3">
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                    <input type="text" name="billing_name" value={formData.billing_name} onChange={handleChange} className={inputClass} /></div>
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">GST No</label>
                    <input type="text" name="billing_gstin" value={formData.billing_gstin} onChange={handleChange} className={inputClass} placeholder="GSTIN" /></div>
                </div>
                <AddressField label="Selected Address" value={formData.billing_address} onChange={(v) => setFormData(prev => ({ ...prev, billing_address: v }))} />
              </div>
            </div>
          </div>

          {/* Product Lines */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Product Lines</h3>
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100"><Plus size={16} /> Add Product</button>
            </div>
            {formData.price_list && priceLines.length > 0 && (
              <div className="mb-3 p-3 bg-blue-50 rounded-lg text-sm text-blue-800">
                Price list loaded with {priceLines.length} product(s). Only customer products are shown. Selecting a product will auto-fill price, discount & GST.
              </div>
            )}
            {/* Mobile-only stacked editor for product lines.
                The wide 14-column table below is unusable on a phone:
                each cell ends up ~40px wide and inputs clip / numbers
                get hidden behind horizontal scroll. The card layout
                here shows each line as a vertically-stacked form with
                clear labels — same state, same handlers, same auto-
                fill, just rendered as a card on mobile.
                Desktop / tablet (sm+) still renders the original
                table below verbatim. */}
            <div className="sm:hidden space-y-3">
              {poLines.map((line, idx) => {
                const amt = (parseFloat(line.quantity) || 0) * (parseFloat(line.price) || 0);
                const netAmt = calcLineTotal(line);
                return (
                  <div key={idx} className="border border-slate-200 rounded-lg p-3 space-y-2 bg-white">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Line #{idx + 1}</span>
                      <button
                        type="button"
                        onClick={() => removeLine(idx)}
                        disabled={poLines.length <= 1}
                        className="inline-flex items-center gap-1 text-red-500 disabled:opacity-30 text-xs"
                      >
                        <Trash2 size={14} /> Remove
                      </button>
                    </div>

                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Category</label>
                      <CustomSelect value={line.product_category || ''} onChange={(e) => handleLineChange(idx, 'product_category', e.target.value)} className={`${inputClass} w-full`}>
                        {GOODS_SUB_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                    </div>

                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Product <span className="text-red-500">*</span></label>
                      <CustomSelect value={line.parsed_sku} onChange={(e) => handleLineChange(idx, 'parsed_sku', e.target.value)} disabled={!line.product_category} className={`${inputClass} disabled:bg-slate-100 w-full`}>
                        <option value="">{line.product_category ? 'Select' : 'Category first'}</option>
                        {getFilteredProducts(line.product_category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">HSN</label>
                        <input type="text" value={line.hsn_code} onChange={(e) => handleLineChange(idx, 'hsn_code', e.target.value)} className={`${inputClass} w-full`} placeholder="HSN" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">UOM</label>
                        <CustomSelect value={line.uom} onChange={(e) => handleLineChange(idx, 'uom', e.target.value)} className={`${inputClass} w-full`}>
                          {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                        </CustomSelect>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Qty <span className="text-red-500">*</span></label>
                        <input type="number" step="0.001" min="0.001" value={line.quantity} onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)} className={`${inputClass} w-full text-right`} />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Rate</label>
                        <input type="number" step="0.01" min="0" value={line.price} onChange={(e) => handleLineChange(idx, 'price', e.target.value)} className={`${inputClass} w-full text-right`} placeholder="0.00" />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Amount</label>
                        <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded text-right text-sm text-slate-600">
                          {amt > 0 ? fmt(amt) : '-'}
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Discount</label>
                        <input type="number" step="0.01" min="0" value={line.discount} onChange={(e) => handleLineChange(idx, 'discount', e.target.value)} className={`${inputClass} w-full text-right`} />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">SGST %</label>
                        <input
                          type="number" step="0.01" min="0" value={line.sgst_percent}
                          onChange={(e) => {
                            const val = e.target.value;
                            setPoLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, sgst_percent: val, gst: String((parseFloat(val) || 0) + (parseFloat(l.cgst_percent) || 0)) }));
                          }}
                          className={`${inputClass} w-full text-right`}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">CGST %</label>
                        <input
                          type="number" step="0.01" min="0" value={line.cgst_percent}
                          onChange={(e) => {
                            const val = e.target.value;
                            setPoLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, cgst_percent: val, gst: String((parseFloat(l.sgst_percent) || 0) + (parseFloat(val) || 0)) }));
                          }}
                          className={`${inputClass} w-full text-right`}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">IGST %</label>
                        <input type="number" step="0.01" min="0" value={line.igst_percent} onChange={(e) => handleLineChange(idx, 'igst_percent', e.target.value)} className={`${inputClass} w-full text-right`} />
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-xs uppercase tracking-wide text-slate-500">Net Amount</span>
                      <span className="text-base font-bold text-slate-900">{netAmt > 0 ? fmt(netAmt) : '-'}</span>
                    </div>
                  </div>
                );
              })}

              {/* Mobile totals — vertically stacked summary so each
                  number gets enough horizontal room to read. */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">Total Qty</span><span className="font-medium text-slate-800">{fmtQty(totalQty)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Total Amount</span><span className="font-medium text-slate-800">{fmt(totalAmount)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Total Discount</span><span className="font-medium text-red-600">{fmt(totalDiscount)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Total SGST</span><span className="font-medium text-slate-700">{fmt(totalSGST)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Total CGST</span><span className="font-medium text-slate-700">{fmt(totalCGST)}</span></div>
                <div className="flex justify-between pt-2 mt-1 border-t border-slate-300">
                  <span className="text-slate-700 font-semibold">Grand Total</span>
                  <span className="text-base font-bold text-slate-900">{fmt(grandTotal)}</span>
                </div>
              </div>
            </div>

            {/* Desktop / tablet table — original markup, hidden on
                mobile. Behaviour and auto-fill remain identical. */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                  <th className="text-left px-2 py-2 font-medium text-slate-600">#</th>
                  <th className="text-left px-2 py-2 font-medium text-slate-600">Category</th>
                  <th className="text-left px-2 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                  <th className="text-left px-2 py-2 font-medium text-slate-600">HSN</th>
                  <th className="text-left px-2 py-2 font-medium text-slate-600">UOM</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">Qty <span className="text-red-500">*</span></th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">Rate</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">Amount</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">Disc.</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">SGST %</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">CGST %</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">IGST %</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">Net Amt</th>
                  <th className="px-2 py-2"></th>
                </tr></thead>
                <tbody>{poLines.map((line, idx) => {
                  const amt = (parseFloat(line.quantity) || 0) * (parseFloat(line.price) || 0);
                  const netAmt = calcLineTotal(line);
                  return (
                    <tr key={idx} className="border-b">
                      <td className="px-2 py-2 text-slate-500">{idx + 1}</td>
                      <td className="px-2 py-2"><CustomSelect value={line.product_category || ''} onChange={(e) => handleLineChange(idx, 'product_category', e.target.value)} className={inputClass} style={{ minWidth: '110px' }}>
                        {GOODS_SUB_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</CustomSelect></td>
                      <td className="px-2 py-2"><CustomSelect value={line.parsed_sku} onChange={(e) => handleLineChange(idx, 'parsed_sku', e.target.value)} disabled={!line.product_category} className={`${inputClass} disabled:bg-slate-100`} style={{ minWidth: '140px' }}>
                        <option value="">{line.product_category ? 'Select' : 'Category first'}</option>{getFilteredProducts(line.product_category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</CustomSelect></td>
                      <td className="px-2 py-2"><input type="text" value={line.hsn_code} onChange={(e) => handleLineChange(idx, 'hsn_code', e.target.value)} className={inputClass} style={{ minWidth: '80px' }} placeholder="HSN" /></td>
                      <td className="px-2 py-2"><CustomSelect value={line.uom} onChange={(e) => handleLineChange(idx, 'uom', e.target.value)} className={inputClass} style={{ minWidth: '65px' }}>
                        {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                      </CustomSelect></td>
                      <td className="px-2 py-2"><input type="number" step="0.001" min="0.001" value={line.quantity} onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)} className={inputClass} style={{ minWidth: '70px' }} /></td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.price} onChange={(e) => handleLineChange(idx, 'price', e.target.value)} className={inputClass} style={{ minWidth: '80px' }} placeholder="0.00" /></td>
                      <td className="px-2 py-2 text-right font-medium whitespace-nowrap text-slate-600">{amt > 0 ? fmt(amt) : '-'}</td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.discount} onChange={(e) => handleLineChange(idx, 'discount', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} /></td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.sgst_percent}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPoLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, sgst_percent: val, gst: String((parseFloat(val) || 0) + (parseFloat(l.cgst_percent) || 0)) }));
                        }} className={inputClass} style={{ minWidth: '55px' }} /></td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.cgst_percent}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPoLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, cgst_percent: val, gst: String((parseFloat(l.sgst_percent) || 0) + (parseFloat(val) || 0)) }));
                        }} className={inputClass} style={{ minWidth: '55px' }} /></td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.igst_percent} onChange={(e) => handleLineChange(idx, 'igst_percent', e.target.value)} className={inputClass} style={{ minWidth: '55px' }} /></td>
                      <td className="px-2 py-2 text-right font-semibold whitespace-nowrap">{netAmt > 0 ? fmt(netAmt) : '-'}</td>
                      <td className="px-2 py-2"><button type="button" onClick={() => removeLine(idx)} disabled={poLines.length <= 1} className="text-red-500 disabled:opacity-30"><Trash2 size={16} /></button></td>
                    </tr>
                  );
                })}</tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-semibold border-t-2 border-slate-300">
                    <td colSpan="5" className="px-2 py-2 text-right text-slate-600">Totals:</td>
                    <td className="px-2 py-2 text-right">{fmtQty(totalQty)}</td>
                    <td></td>
                    <td className="px-2 py-2 text-right">{fmt(totalAmount)}</td>
                    <td className="px-2 py-2 text-right text-red-600">{fmt(totalDiscount)}</td>
                    <td className="px-2 py-2 text-right text-xs">{fmt(totalSGST)}</td>
                    <td className="px-2 py-2 text-right text-xs">{fmt(totalCGST)}</td>
                    <td></td>
                    <td className="px-2 py-2 text-right text-base">{fmt(grandTotal)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Special Instructions & Remarks */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Additional Information</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Special Instructions</label>
                <textarea name="special_instructions" value={formData.special_instructions} onChange={handleChange} rows={3} className={inputClass} placeholder="e.g. GOODS WILL BE ACCEPTED ONLY AFTER SATISFACTORY COMPLETION OF QUALITY PARAMETERS" /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} className={inputClass} /></div>
            </div>
          </div>

          <FileAttachments module="CUSTOMER_PO" recordId={id} deferUpload onPendingChange={setPendingAttachments} />

          {/* Action row. On mobile we stack the buttons full-width
              with the primary (Update) on top via flex-col-reverse so
              it's reachable with a thumb without scrolling. On sm+
              we keep the original right-aligned inline pair. */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button type="button" onClick={() => navigate(`/sales/customer-po/${id}`)} className="w-full sm:w-auto px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isSaving} className="w-full sm:w-auto px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Update Customer PO'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
