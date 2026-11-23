import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '@/utils/formatters';
import useLookup, { clearLookupCache } from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

// Return Type dropdown options, each gated on a per-role permission
// (Sales Return module). Only the granted types appear in the dropdown.
const RETURN_TYPE_OPTIONS = [
  { value: 'CUSTOMER_RETURN', label: 'Customer Return', perm: 'return_customer' },
  { value: 'SALES_RETURN',    label: 'Sales Return',    perm: 'return_sales' },
  { value: 'DAMAGE_RETURN',   label: 'Damage Return',   perm: 'return_damage' },
  { value: 'QC_RETURN',       label: 'QC Return',       perm: 'return_qc' },
];

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;
const inputDisabled = 'disabled:bg-slate-100 disabled:cursor-not-allowed';

const emptyLine = {
  category: '',
  product: '',
  godown: '',
  batch: '',
  uom: '',
  return_qty: '',
  rate: '',
  amount: '',
  item_remarks: '',
};

// Product goods sub-types (mirrors master.Product.GOODS_SUB_TYPE_CHOICES) —
// used to filter the per-line Product dropdown by category.
const GOODS_CATEGORIES = [
  ['RAW_MATERIAL', 'Raw Material'],
  ['PACKING_MATERIAL', 'Packing Material'],
  ['FINISHED_GOOD', 'Finished Good'],
  ['SEMI_FINISHED', 'Semi Finished'],
  ['TRADED_PRODUCTS', 'Traded Products'],
  ['CAPITAL_GOOD', 'Capital Good'],
  ['MACHINE_SPARES', 'Machine Spares'],
  ['CONSUMABLES', 'Consumables'],
];

export default function CreateReturn() {
  const navigate = useNavigate();
  const { can, canCreate } = usePermissions();
  const editable = canCreate('Sales Return');
  const { isHidden, isReadOnly } = useFieldPermissions('Sales Return');
  // Only the Return Types this role is granted (Sales Return module).
  const allowedReturnTypes = useMemo(
    () => RETURN_TYPE_OPTIONS.filter((o) => can('Sales Return', o.perm)),
    [can],
  );
  const todayIso = new Date().toISOString().split('T')[0];
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: vendorOptions } = useLookup('/api/vendors/', { labelField: 'vendor_name' });
  const { options: transporters } = useLookup('/api/transporters/');
  const { raw: productsRaw } = useLookup('/api/products/');
  const [isLoading, setIsLoading] = useState(false);
  // Preview-only return number — backend returns the next sequence
  // it would use if the form were saved right now. If two operators
  // open the page at once the actual saved number can differ; this
  // is purely a UI affordance, the real number is assigned in the
  // model's save().
  const [nextReturnNo, setNextReturnNo] = useState('');
  useEffect(() => {
    apiClient.get('/api/inventory/returns/next-no/')
      .then(r => setNextReturnNo(r.data?.next_no || ''))
      .catch(() => {});
  }, []);
  const [formData, setFormData] = useState({
    return_date: todayIso,
    return_type: 'CUSTOMER_RETURN',
    company: '',
    customer: '',
    // Vendor return fields. Populated when return_type=CUSTOMER_RETURN
    // (this workflow treats Customer Return as "we are returning goods
    // to the vendor"). Picking a purchase receipt auto-fills vendor /
    // company / warehouse / godown and the line items.
    vendor: '',
    purchase_receipt: '',
    received_warehouse: '',
    source_document: '',
    original_invoice_no: '',
    sales_order_no: '',
    delivery_challan_no: '',
    selected_dc_id: '',
    // UI-only state for the dropdown pickers. The backend fields
    // sales_order_no / original_invoice_no are plain text columns,
    // so the picker keeps the FK id here and writes the readable
    // number into the text field on selection.
    selected_bill_id: '',
    selected_so_id: '',
    reason: '',
    freight_terms: '',
    transporter: '',
    vehicle_no: '',
    qc_requirement: 'REQUIRED',
    qc_status: '',
    approval_status: 'DRAFT',
    remarks: '',
  });
  const { options: customerOptions } = useLookup(formData.company ? `/api/customers/?company=${formData.company}` : null); // customers scoped to the selected company
  // If the role can't use the current Return Type, snap to the first
  // permitted one (so the dropdown never shows a type they're denied).
  useEffect(() => {
    if (allowedReturnTypes.length === 0) return;
    if (!allowedReturnTypes.some((o) => o.value === formData.return_type)) {
      setFormData((prev) => ({ ...prev, return_type: allowedReturnTypes[0].value }));
    }
  }, [allowedReturnTypes, formData.return_type]);
  const [lines, setLines] = useState([{ ...emptyLine }]);
  // Header fields that were autofilled from a picked DC stay locked
  // so the operator can't desync the Return Advice from its source DC.
  // Clearing the DC dropdown (or switching the Return Type) unlocks
  // them via the `selected_dc_id` reset wired in handleChange.
  const dcLocked = formData.return_type === 'SALES_RETURN' && !!formData.selected_dc_id;

  const { options: warehouses } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}&scope=true` : null
  );
  const { options: godownOptions } = useLookup(
    formData.received_warehouse ? `/api/godowns/?warehouse=${formData.received_warehouse}` : null
  );

  // The Product picker lists every product, narrowed by the line's Category
  // (goods sub-type) when one is chosen. Returns aren't tied to a warehouse's
  // current stock — a customer return brings a product back IN even when its
  // balance is zero — so we don't restrict by warehouse or stock here. This
  // also guarantees autofilled products (from a Receipt / DC) always have a
  // matching <option>.
  const productOptionsFor = (category) => (productsRaw || [])
    .filter(p => !category || p.goods_sub_type === category)
    .map(p => ({ value: p.id, label: `${p.sku_code ? p.sku_code + ' — ' : ''}${p.product_name}` }));
  // Category (goods sub-type) for a product id — used to auto-fill the per-line
  // Category when lines come from a Receipt / Bill / SO / DC.
  const categoryOf = (productId) => (productsRaw || [])
    .find(p => String(p.id) === String(productId))?.goods_sub_type || '';
  // Existing returns — used to filter the receipt + DC pickers so a
  // source document that already has a non-cancelled return raised
  // against it can't be picked again (would create a duplicate return).
  // Keyed by:
  //   - usedReceiptIds  → set of purchase_receipt UUIDs (Customer Return)
  //   - usedDcNos       → set of delivery_challan_no strings (Sales Return)
  const { raw: existingReturnsRaw } = useLookup('/api/inventory/returns/');
  const { usedReceiptIds, usedDcNos } = useMemo(() => {
    const receipts = new Set();
    const dcs = new Set();
    (existingReturnsRaw || []).forEach(r => {
      if (r.approval_status === 'CANCELLED') return;
      if (r.purchase_receipt) receipts.add(String(r.purchase_receipt));
      if (r.delivery_challan_no) dcs.add(String(r.delivery_challan_no).trim());
    });
    return { usedReceiptIds: receipts, usedDcNos: dcs };
  }, [existingReturnsRaw]);

  // Dispatch Challan list — fetched only for the Sales Return flow,
  // since that's the only Return Type that pulls header + line data
  // from an existing DC. `raw` gives us the full DC records (with
  // dc_no / linked_so_no / customer_name) for the dropdown labels.
  // DCs already returned against are filtered out.
  const { raw: dcsRaw, options: dcOptionsRaw } = useLookup(
    formData.return_type === 'SALES_RETURN' ? '/api/sales/dc/' : null,
    { labelField: 'dc_no' },
  );
  // Show every Dispatch Challan returned by the API in the dropdown.
  // No status / warehouse / customer / already-returned filtering at
  // the picker level — the operator wants the full list so they can
  // pick any DC. The label includes the customer name and linked SO
  // (when present) to make the row identifiable; soft-deleted DCs
  // (is_active=false) are still dropped to avoid surfacing tombstones.
  const dcOptions = useMemo(() => dcOptionsRaw
    .map(o => {
      const dc = dcsRaw.find(d => String(d.id) === String(o.value));
      return { o, dc };
    })
    .filter(({ dc }) => !dc || dc.is_active !== false)
    .map(({ o, dc }) => {
      const cust = dc?.customer_name || '';
      const so = dc?.linked_so_no || '';
      const suffix = [cust, so && `SO: ${so}`].filter(Boolean).join(' · ');
      return { value: o.value, label: suffix ? `${o.label} — ${suffix}` : o.label };
    }), [dcOptionsRaw, dcsRaw]);

  // Purchase Receipt list — fetched only for the Customer Return flow.
  // That return type traces back to the original receipt so we can
  // autofill vendor + line items and post a stock-OUT entry on save.
  // Receipts already returned against are filtered out.
  const { raw: receiptsRaw, options: receiptOptionsRaw } = useLookup(
    formData.return_type === 'CUSTOMER_RETURN' ? '/api/purchase/receipts/' : null,
    { labelField: 'receipt_advice_no' },
  );
  const receiptOptions = useMemo(() => receiptOptionsRaw
    .filter(o => !usedReceiptIds.has(String(o.value)))
    .map(o => {
      const r = receiptsRaw.find(x => String(x.id) === String(o.value));
      const vendor = r?.vendor_name || '';
      const date = r?.receipt_date ? formatDate(r.receipt_date) : '';
      const suffix = [vendor, date].filter(Boolean).join(' · ');
      return { value: o.value, label: suffix ? `${o.label} — ${suffix}` : o.label };
    }), [receiptOptionsRaw, receiptsRaw, usedReceiptIds]);

  // Vendor Bill list — fetched only for Customer Return. Lets the
  // operator pick the bill behind the receipt; selecting one drops
  // the bill_no, the vendor, and the line items into the form.
  const { raw: billsRaw, options: billOptionsRaw } = useLookup(
    formData.return_type === 'CUSTOMER_RETURN' ? '/api/purchase/bills/' : null,
    { labelField: 'bill_no' },
  );
  const billOptions = useMemo(() => billOptionsRaw.map(o => {
    const b = billsRaw.find(x => String(x.id) === String(o.value));
    const vendor = b?.vendor_name || '';
    const date = b?.bill_date ? formatDate(b.bill_date) : '';
    const suffix = [vendor, date].filter(Boolean).join(' · ');
    return { value: o.value, label: suffix ? `${o.label} — ${suffix}` : o.label };
  }), [billOptionsRaw, billsRaw]);

  // Sales Order list — fetched only for Sales Return. Lets the
  // operator pick the SO that the customer is returning against; the
  // SO No, customer / company / warehouse and line items autofill.
  const { raw: salesOrdersRaw, options: salesOrderOptionsRaw } = useLookup(
    formData.return_type === 'SALES_RETURN' ? '/api/sales/orders/' : null,
    { labelField: 'so_no' },
  );
  const salesOrderOptions = useMemo(() => salesOrderOptionsRaw.map(o => {
    const s = salesOrdersRaw.find(x => String(x.id) === String(o.value));
    const cust = s?.customer_name || '';
    const date = s?.so_date ? formatDate(s.so_date) : '';
    const suffix = [cust, date].filter(Boolean).join(' · ');
    return { value: o.value, label: suffix ? `${o.label} — ${suffix}` : o.label };
  }), [salesOrderOptionsRaw, salesOrdersRaw]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => {
      const next = { ...prev, [name]: type === 'checkbox' ? checked : value };
      // Switching away from Sales Return clears the DC + SO pickers
      // so leftover ids can't leak into the payload (they're only
      // meaningful in the Sales Return flow).
      if (name === 'return_type' && value !== 'SALES_RETURN') {
        next.selected_dc_id = '';
        next.selected_so_id = '';
        next.sales_order_no = '';
      }
      // Switching away from Customer Return clears the purchase
      // receipt + vendor + bill picker. Switching INTO it clears
      // the customer field so the two FK columns don't fight.
      if (name === 'return_type') {
        if (value !== 'CUSTOMER_RETURN') {
          next.purchase_receipt = '';
          next.vendor = '';
          next.selected_bill_id = '';
          next.original_invoice_no = '';
        } else {
          next.customer = '';
        }
      }
      return next;
    });
  };

  // Pull vendor / company / warehouse / godown and the line items off
  // the picked Purchase Receipt. Fires when the user picks a GRN in
  // the Customer Return flow.
  const handleReceiptSelect = async (receiptId) => {
    setFormData(prev => ({ ...prev, purchase_receipt: receiptId }));
    if (!receiptId) {
      setFormData(prev => ({ ...prev, vendor: '', source_document: '', company: '', received_warehouse: '', original_invoice_no: '' }));
      return;
    }
    try {
      const res = await apiClient.get(`/api/purchase/receipts/${receiptId}/`);
      const r = res.data || {};
      // Set company / warehouse / godown together. The Warehouse and
      // Godown <select>s gate their options on the company / warehouse
      // FK respectively, so we stash the intended values in formData
      // even before the dependent useLookup() refetches the option
      // list. The selects accept any string value — they'll render
      // the option as soon as the matching lookup row arrives.
      setFormData(prev => ({
        ...prev,
        purchase_receipt: receiptId,
        vendor: r.vendor || prev.vendor,
        company: r.company || prev.company,
        received_warehouse: r.warehouse || prev.received_warehouse,
        // The receipt carries the vendor's invoice no on its header
        // (captured when the goods were received). That's what we
        // surface as the Bill No on the return form.
        original_invoice_no: r.invoice_no || prev.original_invoice_no,
        source_document: r.receipt_advice_no ? `Receipt ${r.receipt_advice_no}` : prev.source_document,
      }));
      const rcptLines = (r.receipt_lines || []).filter(l => l.product);
      if (rcptLines.length > 0) {
        setLines(rcptLines.map(l => ({
          ...emptyLine,
          product: l.product || '',
          category: categoryOf(l.product),
          // ReceiptLine.godown is stored as `godown_location`
          // (matches the model field). Falls back to the header
          // godown so legacy rows without a per-line godown
          // still inherit the right value.
          godown: l.godown_location || r.godown || '',
          batch: l.batch_no || '',
          uom: l.uom || '',
          // Default the return qty to the net (physically received)
          // quantity — that's the realistic upper bound for a return
          // back to the vendor. Operator can edit down if needed.
          return_qty: l.net_quantity || l.quantity_received || '',
          rate: l.rate || l.po_unit_price || '',
          amount: ((parseFloat(l.net_quantity || l.quantity_received) || 0) * (parseFloat(l.rate || l.po_unit_price) || 0)).toFixed(2) || '',
          item_remarks: '',
        })));
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load receipt details');
    }
  };

  // Pull vendor + line items off the picked Vendor Bill (Customer
  // Return flow). The Bill No also tracks back to a receipt — if one
  // is set we also pull that receipt's godown / warehouse + lines so
  // the stock-OUT entries land in the right godown.
  const handleBillSelect = async (billId) => {
    setFormData(prev => ({ ...prev, selected_bill_id: billId }));
    if (!billId) {
      setFormData(prev => ({ ...prev, selected_bill_id: '', original_invoice_no: '' }));
      return;
    }
    try {
      const res = await apiClient.get(`/api/purchase/bills/${billId}/`);
      const b = res.data || {};
      setFormData(prev => ({
        ...prev,
        selected_bill_id: billId,
        original_invoice_no: b.bill_no || prev.original_invoice_no,
        vendor: b.vendor || prev.vendor,
        // If the bill is linked to a receipt advice, propagate the
        // receipt id so the rest of the form picks it up like the
        // user had selected the receipt themselves.
        purchase_receipt: b.receipt_advice || prev.purchase_receipt,
        source_document: b.bill_no ? `Bill ${b.bill_no}` : prev.source_document,
      }));
      // If a receipt is behind the bill, run the same autofill
      // path as the receipt picker (lines + warehouse + godown).
      if (b.receipt_advice) {
        await handleReceiptSelect(b.receipt_advice);
      } else if ((b.bill_lines || []).length > 0) {
        // Standalone bill — fall back to bill_lines for the items.
        setLines(b.bill_lines.map(l => ({
          ...emptyLine,
          product: l.product || '',
          category: categoryOf(l.product),
          batch: '',
          uom: l.uom || '',
          return_qty: l.quantity || '',
          rate: l.rate || '',
          amount: l.amount || '',
        })));
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load bill details');
    }
  };

  // Pull customer / company / warehouse + line items off the picked
  // Sales Order (Sales Return flow). Mirrors the DC autofill but
  // starts one step further upstream.
  const handleSoSelect = async (soId) => {
    setFormData(prev => ({ ...prev, selected_so_id: soId }));
    if (!soId) {
      setFormData(prev => ({ ...prev, selected_so_id: '', sales_order_no: '' }));
      return;
    }
    try {
      const res = await apiClient.get(`/api/sales/orders/${soId}/`);
      const so = res.data || {};
      setFormData(prev => ({
        ...prev,
        selected_so_id: soId,
        sales_order_no: so.so_no || prev.sales_order_no,
        company: so.company || prev.company,
        customer: so.customer || prev.customer,
        received_warehouse: so.warehouse || prev.received_warehouse,
        source_document: so.so_no ? `SO ${so.so_no}` : prev.source_document,
      }));
      const soLines = so.so_lines || so.lines || [];
      if (soLines.length > 0) {
        setLines(soLines.map(l => ({
          ...emptyLine,
          product: l.product || '',
          category: categoryOf(l.product),
          batch: l.batch || '',
          uom: l.uom || '',
          return_qty: l.quantity || l.ordered_quantity || '',
          rate: l.rate || l.unit_price || '',
          amount: l.amount || '',
        })));
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load sales order details');
    }
  };

  // Pull customer / company / warehouse / godown / SO No / DC No and
  // a starter set of line items off the picked DC. The user can still
  // tweak everything afterwards; this just saves the typing.
  const handleDcSelect = async (dcId) => {
    setFormData(prev => ({ ...prev, selected_dc_id: dcId }));
    if (!dcId) {
      setFormData(prev => ({ ...prev, delivery_challan_no: '' }));
      return;
    }
    try {
      const res = await apiClient.get(`/api/sales/dc/${dcId}/`);
      const dc = res.data || {};
      const firstLine = (dc.dc_lines || [])[0] || {};
      setFormData(prev => ({
        ...prev,
        delivery_challan_no: dc.dc_no || '',
        sales_order_no: dc.linked_so_no || '',
        company: dc.company || prev.company,
        customer: dc.customer || prev.customer,
        received_warehouse: dc.warehouse || prev.received_warehouse,
      }));
      const dcLines = dc.dc_lines || [];
      if (dcLines.length > 0) {
        setLines(dcLines.map(l => ({
          ...emptyLine,
          product: l.product || '',
          category: categoryOf(l.product),
          godown: l.godown || dc.godown || '',
          batch: l.batch || '',
          uom: l.uom || '',
          return_qty: l.quantity_dispatched || '',
        })));
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load DC details');
    }
  };

  const updateLine = (idx, field, value) => {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const next = { ...l, [field]: value };
      // Amount = return_qty * rate. Recomputed inline so the operator
      // always sees the latest figure without a separate "calculate"
      // step. Empty when either input is blank.
      if (field === 'return_qty' || field === 'rate') {
        const qty = parseFloat(field === 'return_qty' ? value : next.return_qty) || 0;
        const rate = parseFloat(field === 'rate' ? value : next.rate) || 0;
        const amt = qty * rate;
        next.amount = amt ? amt.toFixed(2) : '';
      }
      return next;
    }));
  };

  const onProductChange = (idx, productId) => {
    const product = productsRaw.find(p => String(p.id) === String(productId));
    setLines(prev => prev.map((l, i) => i === idx ? {
      ...l,
      product: productId,
      uom: product?.uom || l.uom || '',
    } : l));
  };

  // Changing a line's Category re-filters its Product dropdown; clear the
  // picked product so a now-hidden one can't linger.
  const onCategoryChange = (idx, category) => {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, category, product: '' } : l));
  };

  const addLine = () => setLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => setLines(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  const lineErrors = useMemo(() => lines.map((l) => {
    const ret = parseFloat(l.return_qty || 0);
    if (l.product && ret <= 0) return 'Return Qty must be greater than zero.';
    return null;
  }), [lines]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payloadLines = lines
      .filter(l => l.product && parseFloat(l.return_qty || 0) > 0)
      .map(l => ({
        product: l.product,
        godown: l.godown || null,
        batch: l.batch || '',
        uom: l.uom || '',
        return_qty: l.return_qty || 0,
        quantity_returned: l.return_qty || 0,
        rate: l.rate || 0,
        amount: l.amount || 0,
        item_remarks: l.item_remarks || '',
      }));
    if (payloadLines.length === 0) {
      toast.error('Add at least one line item with a product and Return Qty.');
      return;
    }
    if (lineErrors.some(Boolean)) {
      toast.error('Fix the highlighted line item errors before saving.');
      return;
    }

    setIsLoading(true);
    try {
      // Drop the File object before serializing; multipart upload would need
      // a separate FormData submit path which is out of scope for this UI pass.
      // selected_dc_id / selected_bill_id / selected_so_id are UI-only
      // state for the picker dropdowns — the resolved DC / Bill / SO
      // *number* already lives on the corresponding text field.
      // eslint-disable-next-line no-unused-vars
      const { attachment, selected_dc_id, selected_bill_id, selected_so_id, ...jsonFields } = formData;
      const payload = {
        ...cleanFormData(jsonFields),
        lines: payloadLines,
      };
      const res = await apiClient.post('/api/inventory/returns/', payload);
      // Stock is ALWAYS written on Approve, never on save — regardless
      // of return_type. The draft record is just paperwork until then.
      toast.success('Return created — click Approve to update the stock ledger.');
      // Drop the cached returns list so the next Create form won't
      // show the receipt / DC we just consumed.
      clearLookupCache('/api/inventory/returns/');
      // Drop the user on the detail page so they can review and hit
      // Approve. The detail endpoint returns the freshly assigned id.
      const newId = res.data?.id;
      navigate(newId ? `/inventory/returns/${newId}` : '/inventory/returns');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Return"
        breadcrumbs={[
          { label: 'Inventory', path: '/inventory' },
          { label: 'Returns', path: '/inventory/returns' },
          { label: 'New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          {/* Header */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Return Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Return No</label>
                <input type="text" value={nextReturnNo || 'Auto Generated'} readOnly className={`${inputClass} bg-slate-50 text-slate-500`} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Return Type <span className="text-red-500">*</span></label>
                <CustomSelect name="return_type" value={formData.return_type} onChange={handleChange} required className={inputClass}>
                  {allowedReturnTypes.length === 0 ? (
                    <option value="">No return types permitted</option>
                  ) : (
                    allowedReturnTypes.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))
                  )}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {formData.return_type === 'CUSTOMER_RETURN' ? <>Receipt No <span className="text-red-500">*</span></>
                    : 'Delivery Challan No'}
                </label>
                {formData.return_type === 'CUSTOMER_RETURN' ? (
                  <>
                    <CustomSelect
                      value={formData.purchase_receipt}
                      onChange={(e) => handleReceiptSelect(e.target.value)}
                      required
                      className={inputClass}
                    >
                      <option value="">Select Purchase Receipt</option>
                      {receiptOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                    <p className="text-[10px] text-slate-400 mt-0.5">Picking a receipt autofills Vendor, Company, Warehouse, Godown, and the line items.</p>
                  </>
                ) : formData.return_type === 'SALES_RETURN' ? (
                  <>
                    <CustomSelect
                      value={formData.selected_dc_id}
                      onChange={(e) => handleDcSelect(e.target.value)}
                      className={inputClass}
                    >
                      <option value="">{dcOptions.length === 0 ? 'No Delivery Challans found' : 'Select Delivery Challan'}</option>
                      {dcOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                    <p className="text-[10px] text-slate-400 mt-0.5">Picking a DC autofills Customer, Company, Warehouse, SO No, and the line items.</p>
                  </>
                ) : (
                  <input type="text" name="delivery_challan_no" value={formData.delivery_challan_no} onChange={handleChange} className={inputClass} />
                )}
              </div>
              {!isHidden('return_date') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Return Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="return_date" value={formData.return_date} onChange={handleChange} required disabled={isReadOnly('return_date')} className={isReadOnly('return_date') ? lockedInputClass : inputClass} />
              </div>
              )}
              {formData.return_type === 'CUSTOMER_RETURN' ? (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Vendor <span className="text-red-500">*</span></label>
                  <CustomSelect name="vendor" value={formData.vendor} onChange={handleChange} required className={inputClass}>
                    <option value="">Select Vendor</option>
                    {vendorOptions.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                  </CustomSelect>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Customer <span className="text-red-500">*</span></label>
                  <CustomSelect name="customer" value={formData.customer} onChange={handleChange} required disabled={dcLocked} className={`${inputClass} ${inputDisabled}`}>
                    <option value="">Select Customer</option>
                    {customerOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </CustomSelect>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={formData.company}
                  onChange={(e) => setFormData(prev => ({ ...prev, company: e.target.value, received_warehouse: '' }))}
                  required
                  disabled={dcLocked}
                  className={`${inputClass} ${inputDisabled}`}
                >
                  <option value="">Select Company</option>
                  {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect
                  name="received_warehouse"
                  value={formData.received_warehouse}
                  onChange={handleChange}
                  required
                  disabled={dcLocked || !formData.company}
                  className={`${inputClass} ${inputDisabled}`}
                >
                  <option value="">{formData.company ? 'Select Warehouse' : 'Select company first...'}</option>
                  {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Source Document</label>
                <input type="text" name="source_document" value={formData.source_document} onChange={handleChange} placeholder="e.g. Invoice / SO / DC" className={inputClass} />
              </div>
              {formData.return_type === 'CUSTOMER_RETURN' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Bill No</label>
                  <input
                    type="text"
                    value={formData.original_invoice_no}
                    readOnly
                    placeholder="Auto-filled from selected receipt"
                    className={`${inputClass} bg-slate-50 text-slate-700`}
                  />
                </div>
              )}
              {formData.return_type === 'SALES_RETURN' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Sales Order No</label>
                  <input
                    type="text"
                    value={formData.sales_order_no}
                    readOnly
                    placeholder="Auto-filled from selected DC"
                    className={`${inputClass} bg-slate-50 text-slate-700`}
                  />
                </div>
              )}
              {!isHidden('reason') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Reason <span className="text-red-500">*</span></label>
                <CustomSelect name="reason" value={formData.reason} onChange={handleChange} required disabled={isReadOnly('reason')} className={isReadOnly('reason') ? lockedInputClass : inputClass}>
                  <option value="">Select Reason</option>
                  <option value="DEFECTIVE">Defective</option>
                  <option value="WRONG_ITEM">Wrong Item</option>
                  <option value="EXCESS">Excess</option>
                  <option value="DAMAGE">Damage</option>
                  <option value="EXPIRED">Expired</option>
                  <option value="QC_FAIL">QC Fail</option>
                  <option value="OTHER">Other</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('freight_terms') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Terms</label>
                <CustomSelect name="freight_terms" value={formData.freight_terms} onChange={handleChange} disabled={isReadOnly('freight_terms')} className={isReadOnly('freight_terms') ? lockedInputClass : inputClass}>
                  <option value="">Select Freight Terms</option>
                  <option value="PAID">Paid</option>
                  <option value="TO_PAY">To Pay</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('transporter') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Transporter</label>
                <CustomSelect name="transporter" value={formData.transporter} onChange={handleChange} disabled={isReadOnly('transporter')} className={isReadOnly('transporter') ? lockedInputClass : inputClass}>
                  <option value="">Select Transporter</option>
                  {transporters.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('vehicle_no') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Vehicle No</label>
                <input type="text" name="vehicle_no" value={formData.vehicle_no} onChange={handleChange} disabled={isReadOnly('vehicle_no')} className={isReadOnly('vehicle_no') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('qc_requirement') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">QC Requirement</label>
                <CustomSelect name="qc_requirement" value={formData.qc_requirement} onChange={handleChange} disabled={isReadOnly('qc_requirement')} className={isReadOnly('qc_requirement') ? lockedInputClass : inputClass}>
                  <option value="REQUIRED">Required</option>
                  <option value="OPTIONAL">Optional</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('qc_status') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">QC Status</label>
                <CustomSelect name="qc_status" value={formData.qc_status} onChange={handleChange} disabled={isReadOnly('qc_status')} className={isReadOnly('qc_status') ? lockedInputClass : inputClass}>
                  <option value="">—</option>
                  <option value="PENDING">Pending</option>
                  <option value="PASS">Pass</option>
                  <option value="FAIL">Fail</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('approval_status') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Approval Status</label>
                <CustomSelect name="approval_status" value={formData.approval_status} onChange={handleChange} disabled={isReadOnly('approval_status')} className={isReadOnly('approval_status') ? lockedInputClass : inputClass}>
                  <option value="DRAFT">Draft</option>
                  <option value="PENDING">Pending</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('remarks') && (
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} disabled={isReadOnly('remarks')} rows={2} className={isReadOnly('remarks') ? lockedInputClass : inputClass} />
              </div>
              )}
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Attachment</label>
                <input
                  type="file"
                  name="attachment"
                  onChange={(e) => setFormData(prev => ({ ...prev, attachment: e.target.files?.[0] || null }))}
                  className="block w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
                />
                {formData.attachment && (
                  <p className="text-xs text-slate-500 mt-1">
                    Selected: <span className="font-medium text-slate-700">{formData.attachment.name}</span>
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Line Items</h3>
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add Line
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="text-left px-2 py-2 font-medium text-slate-600">#</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600">Category</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600">Product *</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600">Godown</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600">Batch</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600">UOM</th>
                    <th className="text-right px-2 py-2 font-medium text-slate-600">Return Qty *</th>
                    <th className="text-right px-2 py-2 font-medium text-slate-600">Rate</th>
                    <th className="text-right px-2 py-2 font-medium text-slate-600">Amount</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600">Remarks</th>
                    <th className="px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => (
                    <tr key={idx} className={`border-b ${lineErrors[idx] ? 'bg-red-50' : ''}`}>
                      <td className="px-2 py-2 text-slate-500">{idx + 1}</td>
                      <td className="px-2 py-2">
                        <CustomSelect value={line.category || ''} onChange={(e) => onCategoryChange(idx, e.target.value)} className={inputClass} style={{ minWidth: '140px' }}>
                          <option value="">All Categories</option>
                          {GOODS_CATEGORIES.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-2 py-2">
                        <CustomSelect value={line.product} onChange={(e) => onProductChange(idx, e.target.value)} required className={inputClass} style={{ minWidth: '160px' }}>
                          <option value="">Select Product</option>
                          {productOptionsFor(line.category).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                        </CustomSelect>
                        {line.product && (() => {
                          const p = productsRaw.find(x => String(x.id) === String(line.product));
                          const sku = p?.sku_code || p?.sku || '';
                          return sku ? <p className="text-[10px] text-slate-400 mt-0.5">SKU: {sku}</p> : null;
                        })()}
                      </td>
                      <td className="px-2 py-2">
                        <CustomSelect value={line.godown} onChange={(e) => updateLine(idx, 'godown', e.target.value)} className={inputClass} style={{ minWidth: '120px' }}>
                          <option value="">{formData.received_warehouse ? 'Select Godown' : 'Pick warehouse...'}</option>
                          {godownOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-2 py-2"><input type="text" value={line.batch} onChange={(e) => updateLine(idx, 'batch', e.target.value)} className={inputClass} style={{ minWidth: '100px' }} /></td>
                      <td className="px-2 py-2"><input type="text" value={line.uom} onChange={(e) => updateLine(idx, 'uom', e.target.value)} className={inputClass} style={{ minWidth: '70px' }} /></td>
                      <td className="px-2 py-2"><input type="number" step="0.0001" min="0" value={line.return_qty} onChange={(e) => updateLine(idx, 'return_qty', e.target.value)} required className={`${inputClass} text-right`} style={{ minWidth: '90px' }} /></td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.rate} onChange={(e) => updateLine(idx, 'rate', e.target.value)} className={`${inputClass} text-right`} style={{ minWidth: '90px' }} /></td>
                      <td className="px-2 py-2 text-right text-slate-600 font-medium" style={{ minWidth: '90px' }}>{line.amount || '—'}</td>
                      <td className="px-2 py-2"><input type="text" value={line.item_remarks} onChange={(e) => updateLine(idx, 'item_remarks', e.target.value)} className={inputClass} style={{ minWidth: '120px' }} /></td>
                      <td className="px-2 py-2">
                        <button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} aria-label="Remove line" title="Remove line" className="text-red-500 hover:text-red-700 disabled:opacity-30">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lineErrors.some(Boolean) && (
              <div className="mt-2 text-xs text-red-600 space-y-0.5">
                {lineErrors.map((err, i) => err && <div key={i}>Line {i + 1}: {err}</div>)}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading || lineErrors.some(Boolean)} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
