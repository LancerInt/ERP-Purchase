import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { UOM_OPTIONS, UOM_VALUES } from '../../../constants/uom.js';
import { confirm } from '@/components/common/confirm';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

const REGION_OPTIONS = [
  ['',          'All Regions'],
  ['SOUTH',     'South'],
  ['NORTH',     'North'],
  ['EAST',      'East'],
  ['WEST',      'West'],
  ['NORTHEAST', 'North-East'],
  ['CENTRAL',   'Central'],
  ['PAN_INDIA', 'Pan India'],
];

const emptyPriceLine = { product: '', customer_trade_name: '', uom: 'KG', region: '', state_group: '', packing: '', hsn_code: '', rate: '', discount: '0', gst: '0', sgst_rate: '0', cgst_rate: '0', igst_rate: '0' };

export default function EditPriceList() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const editable = canEdit('Price List');
  // Company has no `name` field (legal_name) and Customer uses customer_name —
  // set the label fields explicitly so the dropdowns show real names.
  const { options: companies } = useLookup('/api/companies/', { labelField: 'legal_name' });
  // Fetch every product (paginated through all pages) so saved price-line
  // products always have a matching option to pre-select. useLookup caps
  // at one page (500 items) which leaves out larger catalogs.
  const { data: allProducts } = useApiData('/api/products/');
  const productOptions = allProducts.map(p => ({
    value: p.id,
    label: p.product_name || p.sku_code || p.id,
  }));
  const { options: stateGroupOptions, raw: stateGroupsRaw } = useLookup('/api/state-groups/');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState({
    price_list_id: '', company: '', company_name: '', customer: '', customer_name: '', delivery_region: '', currency: 'INR',
    effective_from: '', effective_to: '', default_freight_terms: '',
    payment_terms: '', delivery_terms: '', gst_type: '', status: 'ACTIVE', notes: '',
  });
  const { options: customers } = useLookup(formData.company ? `/api/customers/?company=${formData.company}` : null, { labelField: 'customer_name' }); // customers scoped to the selected company
  const [priceLines, setPriceLines] = useState([{ ...emptyPriceLine }]);
  // Auto-detect state-wise mode from the loaded lines so a UAI-style
  // list opens already expanded with the State Group + Packing columns
  // visible. Toggleable in case the user wants to switch a list from
  // single-price to state-wise (or vice-versa) mid-edit.
  const [isStateWisePricing, setIsStateWisePricing] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const res = await apiClient.get(`/api/price-lists/${id}/`);
        const d = res.data;
        setFormData({
          price_list_id: d.price_list_id || '',
          company: d.company || '',
          company_name: d.company_name || '',
          customer: d.customer || '',
          customer_name: d.customer_name || '',
          delivery_region: d.delivery_region || '',
          currency: d.currency || 'INR',
          effective_from: d.effective_from || '',
          effective_to: d.effective_to || '',
          default_freight_terms: d.default_freight_terms || '',
          payment_terms: d.payment_terms || '',
          delivery_terms: d.delivery_terms || '',
          gst_type: d.gst_type || '',
          status: d.status || 'ACTIVE',
          notes: d.notes || '',
        });
        const lines = (d.price_lines || []).map(l => ({
          product: l.product || '',
          // Keep the server-side product_name so we can render a fallback
          // <option> if the product list hasn't finished loading yet.
          product_name: l.product_name || '',
          customer_trade_name: l.customer_trade_name || '',
          uom: l.uom || 'KG',
          // `region` is hydrated below once stateGroupsRaw lands. Starts
          // blank — the State Group dropdown still shows the saved
          // group via its UUID even before the lookup resolves.
          region: '',
          state_group: l.state_group || '',
          state_group_name: l.state_group_name || '',
          packing: l.packing || '',
          hsn_code: l.hsn_code || '',
          rate: l.rate || '',
          discount: l.discount || '0',
          gst: l.gst || '0',
          sgst_rate: l.sgst_rate || '0',
          cgst_rate: l.cgst_rate || '0',
          igst_rate: l.igst_rate || '0',
        }));
        setPriceLines(lines.length > 0 ? lines : [{ ...emptyPriceLine }]);
        // Switch the form into state-wise mode if any loaded line has
        // a state group OR packing — otherwise the columns would be
        // hidden and the values would silently disappear on save.
        if (lines.some(l => l.state_group || l.packing)) {
          setIsStateWisePricing(true);
        }
      } catch {
        toast.error('Failed to load price list');
        navigate(-1);
      } finally { setIsLoading(false); }
    };
    fetchData();
  }, [id]);

  // Deterministic India-state → region map used as a fallback when a
  // StateGroup row has `region=''` in the database (the field is
  // blank-by-default on the model, so older / hand-imported rows
  // often skip it). Without this fallback the Region dropdown silently
  // stays at "All Regions" even when the saved State Group clearly
  // points at one region — e.g. a "TN,KA" group whose region wasn't
  // populated would display blank, confusing the operator.
  const STATE_TO_REGION = {
    'TAMIL NADU': 'SOUTH', 'TAMILNADU': 'SOUTH', 'TN': 'SOUTH',
    'KARNATAKA': 'SOUTH', 'KA': 'SOUTH',
    'KERALA': 'SOUTH', 'KL': 'SOUTH',
    'ANDHRA PRADESH': 'SOUTH', 'AP': 'SOUTH',
    'TELANGANA': 'SOUTH', 'TS': 'SOUTH', 'TG': 'SOUTH',
    'PUDUCHERRY': 'SOUTH', 'PONDICHERRY': 'SOUTH', 'PY': 'SOUTH',
    'PUNJAB': 'NORTH', 'PB': 'NORTH',
    'HARYANA': 'NORTH', 'HR': 'NORTH',
    'UTTAR PRADESH': 'NORTH', 'UTTARPRADESH': 'NORTH', 'UP': 'NORTH',
    'UTTARAKHAND': 'NORTH', 'UK': 'NORTH', 'UT': 'NORTH',
    'HIMACHAL PRADESH': 'NORTH', 'HIMACHALPRADESH': 'NORTH', 'HP': 'NORTH',
    'DELHI': 'NORTH', 'DL': 'NORTH', 'NEW DELHI': 'NORTH',
    'JAMMU AND KASHMIR': 'NORTH', 'JAMMU & KASHMIR': 'NORTH', 'JK': 'NORTH',
    'LADAKH': 'NORTH', 'LA': 'NORTH',
    'CHANDIGARH': 'NORTH', 'CH': 'NORTH',
    'RAJASTHAN': 'NORTH', 'RJ': 'NORTH',
    'MAHARASHTRA': 'WEST', 'MH': 'WEST',
    'GUJARAT': 'WEST', 'GJ': 'WEST',
    'GOA': 'WEST', 'GA': 'WEST',
    'WEST BENGAL': 'EAST', 'WESTBENGAL': 'EAST', 'WB': 'EAST',
    'ODISHA': 'EAST', 'ORISSA': 'EAST', 'OR': 'EAST',
    'BIHAR': 'EAST', 'BR': 'EAST',
    'JHARKHAND': 'EAST', 'JH': 'EAST',
    'ASSAM': 'NORTHEAST', 'AS': 'NORTHEAST',
    'ARUNACHAL PRADESH': 'NORTHEAST', 'AR': 'NORTHEAST',
    'MANIPUR': 'NORTHEAST', 'MN': 'NORTHEAST',
    'MEGHALAYA': 'NORTHEAST', 'ML': 'NORTHEAST',
    'MIZORAM': 'NORTHEAST', 'MZ': 'NORTHEAST',
    'NAGALAND': 'NORTHEAST', 'NL': 'NORTHEAST',
    'SIKKIM': 'NORTHEAST', 'SK': 'NORTHEAST',
    'TRIPURA': 'NORTHEAST', 'TR': 'NORTHEAST',
    'MADHYA PRADESH': 'CENTRAL', 'MADHYAPRADESH': 'CENTRAL', 'MP': 'CENTRAL',
    'CHHATTISGARH': 'CENTRAL', 'CHATTISGARH': 'CENTRAL', 'CG': 'CENTRAL',
  };
  const inferRegionFromStateGroup = (sg) => {
    if (!sg) return '';
    if (sg.region) return sg.region;
    const members = Array.isArray(sg.member_states) ? sg.member_states : [];
    // Tally regions across all member states; the most-popular wins.
    // Avoids picking an outlier (e.g. a stray TN code on a North group).
    const tally = {};
    members.forEach(code => {
      const key = String(code || '').toUpperCase().trim();
      const r = STATE_TO_REGION[key] || STATE_TO_REGION[key.replace(/\s+/g, '')];
      if (r) tally[r] = (tally[r] || 0) + 1;
    });
    let winner = '';
    let winnerCount = 0;
    Object.entries(tally).forEach(([r, n]) => { if (n > winnerCount) { winner = r; winnerCount = n; } });
    return winner;
  };

  // Hydrate each line's UI-only `region` from its saved state_group
  // once both the price list AND the State Group lookup have loaded.
  // Runs whenever either lands, but only patches rows whose region
  // isn't already filled — avoids stomping a user edit mid-session.
  useEffect(() => {
    if (!stateGroupsRaw || stateGroupsRaw.length === 0) return;
    setPriceLines(prev => {
      let changed = false;
      const next = prev.map(line => {
        if (line.region || !line.state_group) return line;
        const sg = stateGroupsRaw.find(g => String(g.id) === String(line.state_group));
        const inferred = inferRegionFromStateGroup(sg);
        if (!inferred) return line;
        changed = true;
        return { ...line, region: inferred };
      });
      return changed ? next : prev;
    });
  }, [stateGroupsRaw]);

  // Lookup the customer-facing trade name registered against the
  // selected (product, customer) pair in the Product master. The
  // edit page uses useApiData for products (which returns the full
  // rows), so we read finished_good_customer + product_trade_name
  // directly off those.
  const resolveTradeName = (productId, customerId) => {
    if (!productId || !customerId) return '';
    const p = (allProducts || []).find(r => String(r.id) === String(productId));
    if (!p) return '';
    const fgCust = p.finished_good_customer || p.finished_good_customer_id || '';
    if (!fgCust || String(fgCust) !== String(customerId)) return '';
    return (p.product_trade_name || '').trim();
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    // Refill every line's Customer Brand Name when the price list's
    // Customer changes — but never overwrite a value the user typed
    // in manually. We treat the row as "manual" if its current text
    // differs from what the OLD customer + product would have resolved
    // to.
    if (name === 'customer') {
      setPriceLines(prev => prev.map(line => {
        const resolvedNew = resolveTradeName(line.product, value);
        const resolvedOld = resolveTradeName(line.product, formData.customer);
        const userTypedManually = line.customer_trade_name && line.customer_trade_name !== resolvedOld;
        if (userTypedManually) return line;
        return { ...line, customer_trade_name: resolvedNew };
      }));
    }
    // Re-split every row's existing GST when the GST Type flips —
    // otherwise switching IGST→CGST_SGST (or back) leaves stale values
    // on the row and the hidden columns silently submit.
    if (name === 'gst_type') {
      setPriceLines(prev => prev.map(line => {
        const gstNum = parseFloat(line.gst);
        if (isNaN(gstNum)) return line;
        if (value === 'IGST') {
          return { ...line, igst_rate: String(gstNum), sgst_rate: '0', cgst_rate: '0' };
        }
        if (value === 'CGST_SGST') {
          const half = gstNum / 2;
          return { ...line, sgst_rate: String(half), cgst_rate: String(half), igst_rate: '0' };
        }
        return line;
      }));
    }
  };

  const isIgst = formData.gst_type === 'IGST';
  const isCgstSgst = formData.gst_type === 'CGST_SGST';

  const handleLineChange = (index, field, value) => {
    setPriceLines(prev => prev.map((line, i) => {
      if (i !== index) return line;
      const next = { ...line, [field]: value };
      // When the product on this line changes, auto-fill the Customer
      // Brand Name from the Product master — only when the price list's
      // Customer is set AND that product is tagged as a finished good
      // for that customer.
      if (field === 'product') {
        next.customer_trade_name = resolveTradeName(value, formData.customer);
      }
      // Auto-split GST into the appropriate component(s) based on the
      // price list's GST Type. IGST = full rate; CGST_SGST = half each.
      if (field === 'gst') {
        const gstNum = parseFloat(value);
        if (!isNaN(gstNum)) {
          if (formData.gst_type === 'IGST') {
            next.igst_rate = String(gstNum);
            next.sgst_rate = '0';
            next.cgst_rate = '0';
          } else if (formData.gst_type === 'CGST_SGST') {
            const half = gstNum / 2;
            next.sgst_rate = String(half);
            next.cgst_rate = String(half);
            next.igst_rate = '0';
          }
        }
      }
      return next;
    }));
  };
  const addLine = () => setPriceLines(prev => [...prev, { ...emptyPriceLine }]);
  const removeLine = (index) => { if (priceLines.length > 1) setPriceLines(prev => prev.filter((_, i) => i !== index)); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // PUT replaces the line set, so a row that's silently dropped here
    // gets HARD-deleted on save. Only drop rows that are completely
    // empty (no product yet); if the user picked a product but left
    // Rate blank, surface a toast instead of swallowing the row.
    const candidateLines = priceLines.filter(l => l.product);
    const missingRate = candidateLines.findIndex(
      l => l.rate === '' || l.rate === null || l.rate === undefined,
    );
    if (missingRate !== -1) {
      toast.error(`Line ${missingRate + 1}: enter a Rate before saving (use 0 if the product is free).`);
      return;
    }
    setIsSaving(true);
    try {
      const payload = {
        price_list_id: formData.price_list_id,
        company: formData.company || null,
        customer: formData.customer || null,
        delivery_region: formData.delivery_region || '',
        currency: formData.currency || 'INR',
        effective_from: formData.effective_from || null,
        effective_to: formData.effective_to || null,
        default_freight_terms: formData.default_freight_terms || '',
        payment_terms: formData.payment_terms || '',
        delivery_terms: formData.delivery_terms || '',
        gst_type: formData.gst_type || '',
        status: formData.status || 'ACTIVE',
        notes: formData.notes || '',
        price_lines: candidateLines.map(l => ({
          product: l.product,
          customer_trade_name: l.customer_trade_name || '',
          uom: l.uom || 'KG',
          state_group: l.state_group || null,
          packing: l.packing || '',
          hsn_code: l.hsn_code || '',
          rate: l.rate,
          discount: l.discount || 0,
          gst: l.gst || 0,
          sgst_rate: l.sgst_rate || 0,
          cgst_rate: l.cgst_rate || 0,
          igst_rate: l.igst_rate || 0,
        })),
      };
      await apiClient.put(`/api/price-lists/${id}/`, payload);
      toast.success('Price list updated!');
      navigate(-1);
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally { setIsSaving(false); }
  };

  if (isLoading) return <MainLayout><div className="space-y-4">{[1, 2].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;

  return (
    <MainLayout>
      <PageHeader
        title={`Edit Price List — ${formData.price_list_id}`}
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Price Lists', href: '/masters/price-list' },
          { label: formData.price_list_id },
          { label: 'Edit' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit} noValidate>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Price List ID <span className="text-red-500">*</span></label>
                <input type="text" name="price_list_id" value={formData.price_list_id} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  {companies.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  {/* Guarantee the saved company shows even if it's not in the
                      loaded option list (stale cache / deleted / older build). */}
                  {formData.company && !companies.some(c => String(c.value) === String(formData.company)) && (
                    <option value={formData.company}>{formData.company_name || formData.company}</option>
                  )}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer</label>
                <CustomSelect name="customer" value={formData.customer} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  {customers.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  {formData.customer && !customers.some(c => String(c.value) === String(formData.customer)) && (
                    <option value={formData.customer}>{formData.customer_name || formData.customer}</option>
                  )}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Delivery Region</label>
                <input type="text" name="delivery_region" value={formData.delivery_region} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Currency</label>
                <CustomSelect name="currency" value={formData.currency} onChange={handleChange} className={inputClass}>
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Validity & Terms */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Validity & Terms</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Effective From</label>
                <CustomDatePicker name="effective_from" value={formData.effective_from} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Effective To</label>
                <CustomDatePicker name="effective_to" value={formData.effective_to} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Default Freight Terms</label>
                <CustomSelect name="default_freight_terms" value={formData.default_freight_terms} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="PAID">Freight Paid</option>
                  <option value="TO_COLLECT">Freight To Collect</option>
                  <option value="MIXED">Mixed</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms</label>
                <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="NET_15">Net 15</option><option value="NET_30">Net 30</option>
                  <option value="NET_45">Net 45</option><option value="NET_60">Net 60</option>
                  <option value="IMMEDIATE">Immediate</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Delivery Terms</label>
                <CustomSelect name="delivery_terms" value={formData.delivery_terms} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="EX_FACTORY">Ex-Factory</option><option value="DOOR_DELIVERY">Door Delivery</option>
                  <option value="CIF">CIF</option><option value="FOB">FOB</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GST Type</label>
                <CustomSelect name="gst_type" value={formData.gst_type} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="CGST_SGST">CGST + SGST (Intra-State)</option>
                  <option value="IGST">IGST (Inter-State)</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
                <CustomSelect name="status" value={formData.status} onChange={handleChange} className={inputClass}>
                  <option value="DRAFT">Draft</option>
                  <option value="ACTIVE">Active</option>
                  <option value="ARCHIVED">Archived</option>
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Product Lines */}
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3 sm:mb-4 pb-2 border-b">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800">Product List ({priceLines.filter(l => l.product).length} items)</h3>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                  <Plus size={16} /> Add Product
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Customer Brand Name</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">State Group</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Packing</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">HSN Code</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Price <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Discount %</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">GST %</th>
                    {isCgstSgst && <th className="text-right px-3 py-2 font-medium text-slate-600">SGST %</th>}
                    {isCgstSgst && <th className="text-right px-3 py-2 font-medium text-slate-600">CGST %</th>}
                    {isIgst && <th className="text-right px-3 py-2 font-medium text-slate-600">IGST %</th>}
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {priceLines.map((line, index) => (
                    <tr key={index} className="border-b">
                      <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                      <td className="px-3 py-2">
                        <CustomSelect value={line.product} onChange={(e) => handleLineChange(index, 'product', e.target.value)} className={inputClass} style={{ minWidth: '180px' }}>
                          <option value="">Select Product</option>
                          {/* Fallback option for saved products not present in productOptions
                              (still loading, or product was soft-deleted). Keeps the row's
                              product visible instead of silently resetting to placeholder. */}
                          {line.product
                            && line.product_name
                            && !productOptions.some(o => o.value === line.product)
                            && <option value={line.product}>{line.product_name}</option>}
                          {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={line.customer_trade_name || ''}
                          onChange={(e) => handleLineChange(index, 'customer_trade_name', e.target.value)}
                          className={inputClass}
                          style={{ minWidth: '180px' }}
                          placeholder="e.g. Nimbecidine 0.03%"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <CustomSelect
                          value={line.state_group || ''}
                          onChange={(e) => handleLineChange(index, 'state_group', e.target.value)}
                          className={inputClass}
                          style={{ minWidth: '150px' }}
                        >
                          <option value="">All States (default)</option>
                          {line.state_group
                            && !stateGroupOptions.some(o => String(o.value) === String(line.state_group))
                            && <option value={line.state_group}>{line.state_group_name || 'Saved group'}</option>}
                          {stateGroupOptions.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={line.packing || ''}
                          onChange={(e) => handleLineChange(index, 'packing', e.target.value)}
                          className={inputClass}
                          style={{ minWidth: '110px' }}
                          placeholder="20 KG"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={line.hsn_code || ''}
                          onChange={(e) => handleLineChange(index, 'hsn_code', e.target.value)}
                          className={inputClass}
                          style={{ minWidth: '100px' }}
                          placeholder="Leave blank if none"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.01" min="0" value={line.rate} onChange={(e) => handleLineChange(index, 'rate', e.target.value)} className={inputClass} style={{ minWidth: '100px' }} placeholder="0.00" />
                      </td>
                      <td className="px-3 py-2">
                        <CustomSelect value={line.uom} onChange={(e) => handleLineChange(index, 'uom', e.target.value)} className={inputClass} style={{ minWidth: '80px' }}>
                          {line.uom && !UOM_VALUES.includes(line.uom) && (
                            <option value={line.uom}>{line.uom}</option>
                          )}
                          {UOM_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.01" min="0" max="100" value={line.discount} onChange={(e) => handleLineChange(index, 'discount', e.target.value)} className={inputClass} style={{ minWidth: '80px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.01" min="0" max="100" value={line.gst} onChange={(e) => handleLineChange(index, 'gst', e.target.value)} className={inputClass} style={{ minWidth: '70px' }} />
                      </td>
                      {isCgstSgst && (
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" value={line.sgst_rate || ''} onChange={(e) => handleLineChange(index, 'sgst_rate', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} placeholder="0" />
                        </td>
                      )}
                      {isCgstSgst && (
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" value={line.cgst_rate || ''} onChange={(e) => handleLineChange(index, 'cgst_rate', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} placeholder="0" />
                        </td>
                      )}
                      {isIgst && (
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" value={line.igst_rate || ''} onChange={(e) => handleLineChange(index, 'igst_rate', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} placeholder="0" />
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => removeLine(index)} disabled={priceLines.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Notes */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional</h3>
            <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} placeholder="Notes..." />
          </div>

          {/* Actions */}
          <div className="flex flex-row items-center justify-between gap-2 pt-4 border-t">
            {isAdmin ? (
              <button
                type="button"
                onClick={async () => {
                  if (!(await confirm({ message: 'Are you sure you want to delete this price list? This action cannot be undone.', isDangerous: true, confirmLabel: 'Delete' }))) return;
                  try {
                    await apiClient.delete(`/api/price-lists/${id}/`);
                    toast.success('Price list deleted');
                    navigate(-1);
                  } catch (err) {
                    toast.error(getApiErrorMessage(err));
                  }
                }}
                className="px-4 sm:px-6 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
              >
                Delete
              </button>
            ) : <div />}
            <div className="flex flex-row gap-2">
              <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
              <button type="submit" disabled={isSaving} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Update Price List'}</button>
            </div>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
