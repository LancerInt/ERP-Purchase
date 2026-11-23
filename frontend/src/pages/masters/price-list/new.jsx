import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { UOM_OPTIONS, UOM_VALUES } from '../../../constants/uom.js';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

// Cosmetic region buckets that match the StateGroup.region choices on
// the backend. Drives the per-line Region dropdown that narrows down
// the State Group options to just one region's clusters — matches the
// UAI PDF layout (separate South / North sections).
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

const emptyPriceLine = {
  product: '',
  customer_trade_name: '',
  uom: 'KG',
  // `region` is UI-only — it narrows the State Group dropdown to a
  // single region's groups so a user adding South-section lines
  // doesn't scroll through North-only clusters. Not sent to the API
  // (the chosen state_group already carries its region).
  region: '',
  // State-wise pricing: leave blank for the customer-wide default rate.
  // CPO→SO resolver prefers a state-specific line and falls back to
  // the blank-state line when no group matches the buyer.
  state_group: '',
  // Free-text packing label so composites like "20 KG & 40 KG" survive
  // round-trips. Same product can appear N times with different packings.
  packing: '',
  // HSN/SAC code — blank when the product has none recorded.
  hsn_code: '',
  rate: '',
  discount: '0',
  gst: '0',
  sgst_rate: '0',
  cgst_rate: '0',
  igst_rate: '0',
};

export default function CreatePriceList() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Price List');
  // Company uses legal_name (no `name` field) and Customer uses customer_name.
  const { options: companies } = useLookup('/api/companies/', { labelField: 'legal_name' });
  // `raw` gives us the full product rows (incl. product_trade_name +
  // finished_good_customer). We use them below to auto-fill the line's
  // Customer Brand Name when the picked product is registered as a
  // finished good for the price list's selected customer.
  const { options: productOptions, raw: productRaw } = useLookup('/api/products/');
  const { options: stateGroupOptions, raw: stateGroupsRaw } = useLookup('/api/state-groups/');
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    price_list_id: '',
    company: '',
    customer: '',
    delivery_region: '',
    currency: '',
    effective_from: '',
    effective_to: '',
    default_freight_terms: '',
    payment_terms: '',
    delivery_terms: '',
    gst_type: '',
    status: '',
    notes: '',
  });
  const { options: customers } = useLookup(formData.company ? `/api/customers/?company=${formData.company}` : null, { labelField: 'customer_name' }); // customers scoped to the selected company
  const [priceLines, setPriceLines] = useState([{ ...emptyPriceLine }]);
  // Some customers (UAI) have state-wise rates; most don't. Hide the
  // State Group + Packing columns by default and let the user opt in
  // with a checkbox. When OFF, the lines save with state_group=NULL /
  // packing='' and the backend resolver treats every row as the
  // default — same behavior as before state-aware pricing landed.
  const [isStateWisePricing, setIsStateWisePricing] = useState(false);

  // Resolve a product's customer-specific brand/trade name from the
  // Product master. Returns '' when the product isn't a finished good
  // for this customer (or the master row carries no trade name). The
  // same helper drives both flows below:
  //   • picking a product   → fill the row's brand name
  //   • picking a customer  → refill every existing row's brand name
  // so the result is consistent regardless of the order the user edits.
  const resolveTradeName = (productId, customerId) => {
    if (!productId || !customerId) return '';
    const p = (productRaw || []).find(r => String(r.id) === String(productId));
    if (!p) return '';
    const fgCust = p.finished_good_customer || p.finished_good_customer_id || '';
    if (!fgCust || String(fgCust) !== String(customerId)) return '';
    return (p.product_trade_name || '').trim();
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    // When the price list's Customer changes, re-derive every line's
    // Customer Brand Name from the new customer. We only OVERWRITE
    // rows whose current brand-name field is blank OR matches what
    // the previous customer's trade name resolved to — never clobber
    // a manual override the user typed in.
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
    // otherwise switching from IGST→CGST_SGST leaves stale IGST values
    // on the rows and the hidden columns silently submit.
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

  // Price line handlers
  const handleLineChange = (index, field, value) => {
    setPriceLines(prev => prev.map((line, i) => {
      if (i !== index) return line;
      const next = { ...line, [field]: value };
      // When the product on this line changes, auto-fill the
      // Customer Brand Name from the Product master's trade name —
      // only when the price-list customer is set AND the product is
      // tagged as that customer's finished good. Existing manual
      // entries on OTHER rows are untouched; this only fires for
      // the row the user just edited.
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
  const removeLine = (index) => {
    if (priceLines.length > 1) setPriceLines(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Only drop rows that are *completely* empty (no product picked
    // yet). Previously this filter also required a non-zero `rate`,
    // which silently lost rows whose price was 0 or hadn't been typed
    // — the user thought they had three products in the list but only
    // one survived the round-trip. Now we surface a validation error
    // instead so missing rates can be fixed up.
    const candidateLines = priceLines.filter(l => l.product);
    const missingRate = candidateLines.findIndex(
      l => l.rate === '' || l.rate === null || l.rate === undefined,
    );
    if (missingRate !== -1) {
      toast.error(`Line ${missingRate + 1}: enter a Rate before saving (use 0 if the product is free).`);
      return;
    }
    setIsLoading(true);
    try {
      const payload = cleanFormData(formData);
      payload.price_lines = candidateLines.map(l => cleanFormData(l));
      if (import.meta.env.DEV) console.log('[CreatePriceList] payload:', payload);
      await apiClient.post('/api/price-lists/', payload);
      toast.success('Price list created successfully!');
      navigate(-1);
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreatePriceList] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Price List"
        subtitle="Add a new price list record"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Price List', href: '/masters/price-list' },
          { label: 'Create New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Price List ID <span className="text-red-500">*</span></label>
                <input type="text" name="price_list_id" value={formData.price_list_id} onChange={handleChange} required className={inputClass} placeholder="Enter price list ID" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  {companies.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer</label>
                <CustomSelect name="customer" value={formData.customer} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  {customers.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Delivery Region</label>
                <input type="text" name="delivery_region" value={formData.delivery_region} onChange={handleChange} className={inputClass} placeholder="Enter delivery region" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Currency <span className="text-red-500">*</span></label>
                <CustomSelect name="currency" value={formData.currency} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Section: Validity & Terms */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Validity & Terms</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Effective From <span className="text-red-500">*</span></label>
                <CustomDatePicker name="effective_from" value={formData.effective_from} onChange={handleChange} required className={inputClass} />
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
                  <option value="NET_15">Net 15</option>
                  <option value="NET_30">Net 30</option>
                  <option value="NET_45">Net 45</option>
                  <option value="NET_60">Net 60</option>
                  <option value="IMMEDIATE">Immediate</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Delivery Terms</label>
                <CustomSelect name="delivery_terms" value={formData.delivery_terms} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="EX_FACTORY">Ex-Factory</option>
                  <option value="DOOR_DELIVERY">Door Delivery</option>
                  <option value="CIF">CIF</option>
                  <option value="FOB">FOB</option>
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
                <label className="block text-sm font-medium text-slate-700 mb-1">Status <span className="text-red-500">*</span></label>
                <CustomSelect name="status" value={formData.status} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  <option value="DRAFT">Draft</option>
                  <option value="ACTIVE">Active</option>
                  <option value="ARCHIVED">Archived</option>
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Section: Product Lines */}
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3 sm:mb-4 pb-2 border-b">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800">Product List</h3>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                {/* Opt-in toggle for state-wise pricing — most customers
                    have a single rate per (product, uom); only a few
                    (e.g. UAI) publish rate sheets that vary by region
                    + packing. Hidden columns keep the form lean for
                    the common case. */}
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
                          {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={line.customer_trade_name}
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
                          <input type="number" step="0.01" min="0" max="100" value={line.sgst_rate || ''} onChange={(e) => handleLineChange(index, 'sgst_rate', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} placeholder="0" />
                        </td>
                      )}
                      {isCgstSgst && (
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" max="100" value={line.cgst_rate || ''} onChange={(e) => handleLineChange(index, 'cgst_rate', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} placeholder="0" />
                        </td>
                      )}
                      {isIgst && (
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" max="100" value={line.igst_rate || ''} onChange={(e) => handleLineChange(index, 'igst_rate', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} placeholder="0" />
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

          {/* Section: Additional */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
