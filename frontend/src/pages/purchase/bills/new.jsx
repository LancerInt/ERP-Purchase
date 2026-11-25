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
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import AdditionalCharges, { sumAddToTotal, chargesHaveValue } from '../../../components/common/AdditionalCharges';
import { Paperclip, FileText } from 'lucide-react';

// Map a Packing Material row to a bill-line shape. Packing materials
// use different field names (packaging_sku vs product, `quantity` vs
// `quantity_received`) but they should appear on the bill alongside
// goods receipt lines so the vendor can bill the operator for them.
// Without this, packing-only receipts produced an empty Line Items
// table on the bill form even though the Approval allowed them.
function packingLineToBillLine(pm) {
  const itemId = pm.packaging_sku || pm.packaging_sku_id || '';
  const qty = parseFloat(pm.quantity) || 1;
  const netQty = parseFloat(pm.net_quantity);
  const diffQty = !isNaN(netQty) ? Math.round((qty - netQty) * 100) / 100 : null;
  return {
    item_type: 'PRODUCT',
    product: itemId,
    item_name: pm.packaging_sku_name || '',
    po_line_id: pm.po_line || '',
    description: pm.packaging_sku_name || '',
    quantity: String(qty),
    max_quantity: qty,
    net_quantity: !isNaN(netQty) ? netQty : null,
    diff_quantity: diffQty,
    uom: pm.uom || '',
    rate: '0',
    po_rate: null,
    discount_percent: '0',
    tax_percent: '0',
    amount: '0',
    // Tag so the operator can spot packing-material lines visually
    // if we ever choose to render a badge; not persisted on save.
    _source: 'packing',
  };
}

export default function CreateVendorBill() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isHidden, isReadOnly } = useFieldPermissions('Vendor Bill');
  const { canCreate } = usePermissions();
  const editable = canCreate('Vendor Bill');
  const { options: vendorOptions } = useLookup('/api/vendors/');
  const { raw: poRaw } = useLookup('/api/purchase/orders/');
  const { raw: receiptRaw } = useLookup('/api/purchase/receipts/');
  const { raw: productRaw } = useAllProducts();
  // Unified item catalogue — drives the line item dropdown so the
  // Bill can carry Machinery and Service rows (mirroring Receipt /
  // PO). Each row: { item_type, item_id, item_name, item_code, ... }.
  const { raw: purchaseItems } = useLookup('/api/purchase/items/');

  // Fetch billed receipt IDs fresh (no cache) to exclude already-billed receipts
  const [billedReceiptIds, setBilledReceiptIds] = useState(new Set());
  useEffect(() => {
    apiClient.get('/api/purchase/bills/', { params: { page_size: 500 } }).then(res => {
      const bills = res.data?.results || res.data || [];
      setBilledReceiptIds(new Set(bills.filter(b => b.receipt_advice).map(b => b.receipt_advice)));
    }).catch(() => {});
  }, []);

  const poOptions = poRaw.map(p => ({ value: p.id, label: p.po_no }));
  const receiptOptions = receiptRaw
    .filter(r => !billedReceiptIds.has(r.id))
    .map(r => ({ value: r.id, label: r.receipt_advice_no }));
  const productOptions = productRaw.map(p => ({ value: p.id, label: `${p.sku_code || ''} - ${p.product_name}`, uom: p.uom || '' }));

  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const pendingAttachmentsRef = useRef([]);
  // Receipt attachments inherited from selected receipt (read-only display)
  const [receiptAttachments, setReceiptAttachments] = useState([]);
  const addDays = (dateStr, days) => {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };
  // Net days encoded in a PO's payment terms (NET_30 / "Net 45" → 30 / 45;
  // Immediate / COD / Advance → 0). Used to derive the bill's due date.
  const netDaysFromTerms = (terms) => {
    const t = String(terms || '').toUpperCase();
    if (!t || t.includes('IMMEDIATE') || t.includes('COD') || t.includes('ADVANCE')) return 0;
    const m = t.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };
  // Due date for a bill = bill date + the linked PO's net days. Falls back to
  // the legacy 15-day default when there's no PO / no terms to read.
  const dueFromPo = (billDate, poId) => {
    if (!billDate) return '';
    const po = (poRaw || []).find(p => String(p.id) === String(poId));
    return addDays(billDate, po?.payment_terms ? netDaysFromTerms(po.payment_terms) : 15);
  };

  const todayStr = new Date().toISOString().split('T')[0];
  const [formData, setFormData] = useState({
    vendor: '',
    vendor_invoice_no: '',
    bill_date: todayStr,
    due_date: addDays(todayStr, 15),
    purchase_order: '',
    receipt_advice: '',
    notes: '',
    terms_and_conditions: '',
    status: 'DRAFT',
    // Pre-flag as an expense when launched from Expenses › New Expense
    // (/purchase/bills/new?is_expense=true) so the booked bill lands in the
    // Expense Register and is excluded from the purchase totals.
    is_expense: searchParams.get('is_expense') === 'true',
  });

  const emptyLine = { item_type: 'PRODUCT', product: '', item_name: '', description: '', quantity: '1', max_quantity: null, uom: '', rate: '0', po_rate: null, discount_percent: '0', tax_percent: '0', amount: '0' };
  const [lines, setLines] = useState([{ ...emptyLine }]);
  const [additionalCharges, setAdditionalCharges] = useState([]);
  const [chargesRemarks, setChargesRemarks] = useState('');

  const calcLineAmount = (line) => {
    const qty = parseFloat(line.quantity) || 0;
    const rate = parseFloat(line.rate) || 0;
    const disc = parseFloat(line.discount_percent) || 0;
    const tax = parseFloat(line.tax_percent) || 0;
    const base = qty * rate;
    const discounted = base - (base * disc / 100);
    const withTax = discounted + (discounted * tax / 100);
    return Math.round(withTax * 100) / 100;
  };

  const handleLineChange = (idx, field, value) => {
    // Block quantity changes when linked to a receipt — quantity must match receipt
    if (field === 'quantity' && lines[idx]?.max_quantity) {
      toast.error('Quantity cannot be changed. Bill quantity must match the linked Receipt quantity.');
      return;
    }
    // Block rate changes when linked to a PO — rate must match PO unit price
    if (field === 'rate' && lines[idx]?.po_rate !== null && lines[idx]?.po_rate !== undefined) {
      toast.error('Unit price cannot be changed. It must match the linked Purchase Order price.');
      return;
    }
    setLines(prev => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], [field]: value };
      if (field === 'product') {
        const prod = productOptions.find(p => p.value === value);
        if (prod) updated[idx].uom = prod.uom;
      }
      updated[idx].amount = calcLineAmount(updated[idx]).toString();
      return updated;
    });
  };

  const addLine = () => setLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => setLines(prev => prev.filter((_, i) => i !== idx));

  // Summaries — use Math.round to avoid floating point precision issues
  const subtotal = lines.reduce((sum, l) => {
    const qty = parseFloat(l.quantity) || 0;
    const rate = parseFloat(l.rate) || 0;
    return sum + Math.round(qty * rate * 100) / 100;
  }, 0);
  const totalDiscount = lines.reduce((sum, l) => {
    const qty = parseFloat(l.quantity) || 0;
    const rate = parseFloat(l.rate) || 0;
    const disc = parseFloat(l.discount_percent) || 0;
    return sum + Math.round(qty * rate * disc) / 100;
  }, 0);
  const totalTax = lines.reduce((sum, l) => {
    const qty = parseFloat(l.quantity) || 0;
    const rate = parseFloat(l.rate) || 0;
    const disc = parseFloat(l.discount_percent) || 0;
    const tax = parseFloat(l.tax_percent) || 0;
    const base = Math.round((qty * rate - (qty * rate * disc / 100)) * 100) / 100;
    return sum + Math.round(base * tax) / 100;
  }, 0);
  const linesTotal = lines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
  const chargesTotal = sumAddToTotal(additionalCharges);
  const totalAmount = linesTotal + chargesTotal;

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === 'bill_date' && value) {
      setFormData(prev => ({ ...prev, [name]: value, due_date: dueFromPo(value, prev.purchase_order) }));
    } else if (name === 'purchase_order') {
      // Re-derive the due date from the newly-linked PO's payment terms.
      setFormData(prev => ({ ...prev, [name]: value, due_date: prev.bill_date ? dueFromPo(prev.bill_date, value) : prev.due_date }));
    } else {
      setFormData(prev => ({ ...prev, [name]: value }));
    }
  };

  // Auto-fill everything from Receipt Advice
  const handleReceiptChange = (e) => {
    const receiptId = e.target.value;
    setFormData(prev => ({ ...prev, receipt_advice: receiptId }));
    setReceiptAttachments([]);

    if (!receiptId) return;

    // Fetch receipt attachments for the inherited section
    apiClient.get(`/api/purchase/attachments/?module=RECEIPT&record_id=${receiptId}`)
      .then(aRes => setReceiptAttachments(aRes.data?.results || aRes.data || []))
      .catch(() => setReceiptAttachments([]));

    apiClient.get(`/api/purchase/receipts/${receiptId}/`).then(res => {
      const r = res.data;
      // Auto-fill vendor and PO
      const poNos = r.linked_po_numbers || [];
      const poId = (r.linked_pos || [])[0] || '';

      setFormData(prev => ({
        ...prev,
        receipt_advice: receiptId,
        vendor: r.vendor || prev.vendor,
        purchase_order: poId,
        // Pull the vendor invoice number / date captured on the
        // receipt forward into the bill so the operator doesn't have
        // to retype what the OCR (or the manual entry) already
        // produced upstream. Keep an already-typed value untouched
        // so we don't clobber operator edits on form re-renders.
        vendor_invoice_no: prev.vendor_invoice_no || r.invoice_no || '',
        bill_date: prev.bill_date || r.invoice_date || prev.bill_date,
      }));

      // Auto-fill line items from BOTH receipt lines AND packing
      // materials. A receipt that only has packing-material rows
      // (allowed since the approval rules were relaxed) must still
      // produce a Bill with the packing items so the vendor can be
      // invoiced for them.
      const receiptLines = r.receipt_lines || [];
      const packingLines = r.packing_materials || [];
      const goodsLines = receiptLines.map(rl => {
        // Receipt lines carry one of three FKs — read whichever is
        // set, and carry item_type forward so the bill line save
        // routes to the matching FK column.
        const itemType = (rl.item_type || 'PRODUCT').toUpperCase();
        const itemId = rl.product || rl.machinery || rl.service_catalogue || rl.product_service || '';
        const prod = productOptions.find(p => p.value === itemId);
        const qty = parseFloat(rl.quantity_received) || 1;
        const netQty = parseFloat(rl.net_quantity);
        const diffQty = !isNaN(netQty) ? Math.round((qty - netQty) * 100) / 100 : null;
        return {
          item_type: itemType,
          product: itemId,
          item_name: rl.item_name || rl.product_name || '',
          po_line_id: rl.po_line || '',
          description: rl.item_name || rl.product_name || (prod ? prod.label : ''),
          quantity: String(qty),
          max_quantity: qty,
          net_quantity: !isNaN(netQty) ? netQty : null,
          diff_quantity: diffQty,
          uom: rl.uom || (prod ? prod.uom : ''),
          rate: '0',
          po_rate: null,
          discount_percent: '0',
          tax_percent: '0',
          amount: '0',
        };
      });
      const newLines = [...goodsLines, ...packingLines.map(packingLineToBillLine)];
      if (newLines.length > 0) {
        setLines(newLines);
      }

      // If PO exists, fetch PO lines for rates — match by po_line ID for accuracy
      if (poId) {
        const selectedPO = poRaw.find(po => po.id === poId);
        if (selectedPO && selectedPO.po_lines) {
          setLines(prev => prev.map(line => {
            // Match by po_line ID first, fall back to product match
            const poLine = line.po_line_id
              ? selectedPO.po_lines.find(pl => pl.id === line.po_line_id)
              : selectedPO.po_lines.find(pl => pl.product_service === line.product);
            if (poLine) {
              const rate = parseFloat(poLine.unit_price) || 0;
              const gst = parseFloat(poLine.gst) || 0;
              const qty = parseFloat(line.quantity) || 0;
              const base = qty * rate;
              const withTax = base + (base * gst / 100);
              return {
                ...line,
                rate: String(rate),
                po_rate: rate,
                tax_percent: String(gst),
                amount: withTax.toFixed(2),
              };
            }
            return line;
          }));
        }
      }
    }).catch(() => {});
  };

  // Auto-fill from receipt_id query param when redirected from Receipt page
  const [prefillReceiptData, setPrefillReceiptData] = useState(null);

  // Auto-fill from receipt_id query param — fetch receipt + PO data directly
  useEffect(() => {
    const receiptId = searchParams.get('receipt_id');
    if (!receiptId || prefillReceiptData) return;

    // Fetch receipt attachments for the inherited section
    apiClient.get(`/api/purchase/attachments/?module=RECEIPT&record_id=${receiptId}`)
      .then(aRes => setReceiptAttachments(aRes.data?.results || aRes.data || []))
      .catch(() => {});

    apiClient.get(`/api/purchase/receipts/${receiptId}/`).then(async (res) => {
      setPrefillReceiptData(res.data);
      const r = res.data;
      const poId = (r.linked_pos || [])[0] || '';

      setFormData(prev => ({
        ...prev,
        receipt_advice: receiptId,
        vendor: r.vendor || prev.vendor,
        purchase_order: poId,
        // Carry the vendor invoice number forward from the receipt
        // (set there by OCR or by the operator when the receipt was
        // created). Without this, the operator has to re-type the
        // same number on the bill. Don't clobber a value the operator
        // already typed.
        vendor_invoice_no: prev.vendor_invoice_no || r.invoice_no || '',
        bill_date: prev.bill_date || r.invoice_date || prev.bill_date,
      }));

      // Build line items from BOTH receipt lines AND packing materials —
      // a packing-only receipt (allowed by the updated approval rules)
      // would otherwise produce an empty Line Items table here.
      const receiptLines = r.receipt_lines || [];
      const packingLines = r.packing_materials || [];
      const goodsLines = receiptLines.map(rl => {
        const itemType = (rl.item_type || 'PRODUCT').toUpperCase();
        const itemId = rl.product || rl.machinery || rl.service_catalogue || rl.product_service || '';
        const qty = parseFloat(rl.quantity_received) || 1;
        const netQty = parseFloat(rl.net_quantity);
        const diffQty = !isNaN(netQty) ? Math.round((qty - netQty) * 100) / 100 : null;
        const rlRate = parseFloat(rl.rate) || 0;
        const rlGst = parseFloat(rl.gst_percent || rl.gst) || 0;
        const rlBase = qty * rlRate;
        const rlAmount = rlBase + (rlBase * rlGst / 100);
        return {
          item_type: itemType,
          product: itemId,
          item_name: rl.item_name || rl.product_name || '',
          po_line_id: rl.po_line || '',
          description: rl.item_name || rl.product_name || '',
          quantity: String(qty),
          max_quantity: qty,
          net_quantity: !isNaN(netQty) ? netQty : null,
          diff_quantity: diffQty,
          uom: rl.uom || '',
          rate: String(rlRate),
          po_rate: null,
          discount_percent: '0',
          tax_percent: String(rlGst),
          amount: rlAmount.toFixed(2),
        };
      });
      let newLines = [...goodsLines, ...packingLines.map(packingLineToBillLine)];

      // Fetch PO directly to get rates & GST — match by po_line ID
      if (poId) {
        try {
          const poRes = await apiClient.get(`/api/purchase/orders/${poId}/`);
          const poData = poRes.data;
          if (poData?.po_lines) {
            newLines = newLines.map(line => {
              const poLine = line.po_line_id
                ? poData.po_lines.find(pl => pl.id === line.po_line_id)
                : poData.po_lines.find(pl => pl.product_service === line.product);
              if (poLine) {
                const rate = parseFloat(poLine.unit_price) || 0;
                const gst = parseFloat(poLine.gst) || 0;
                const qty = parseFloat(line.quantity) || 0;
                const base = qty * rate;
                const withTax = base + (base * gst / 100);
                return {
                  ...line,
                  rate: String(rate),
                  po_rate: rate,
                  tax_percent: String(gst),
                  amount: withTax.toFixed(2),
                };
              }
              return line;
            });
          }
        } catch {}
      }

      // Fallback for Direct Receipts: if lines still have rate=0 and
      // the receipt header carries an invoice_amount, distribute it
      // evenly across all lines so the bill total isn't zero.
      const invoiceAmt = parseFloat(r.invoice_amount) || 0;
      const allZero = invoiceAmt > 0 && newLines.every(l => parseFloat(l.rate) === 0);
      if (allZero && newLines.length > 0) {
        const perLine = Math.round((invoiceAmt / newLines.length) * 100) / 100;
        newLines = newLines.map(l => {
          const qty = parseFloat(l.quantity) || 1;
          const rate = Math.round((perLine / qty) * 100) / 100;
          const base = qty * rate;
          const gst = parseFloat(l.tax_percent) || 0;
          const amount = base + (base * gst / 100);
          return { ...l, rate: String(rate), amount: amount.toFixed(2) };
        });
      }

      setLines(newLines);
    }).catch(() => {});
  }, [searchParams]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Validate quantities and rates before submit
    for (const line of lines) {
      if (!line.product) continue;
      const qty = parseFloat(line.quantity) || 0;
      if (qty <= 0) { toast.error('Quantity must be greater than 0.'); return; }
      if (line.max_quantity && Math.abs(qty - line.max_quantity) > 0.001) {
        toast.error('Quantity cannot be changed. Bill quantity must match the linked Receipt quantity.');
        return;
      }
      // Rate must match PO price
      if (line.po_rate !== null && line.po_rate !== undefined) {
        const rate = parseFloat(line.rate) || 0;
        if (Math.abs(rate - line.po_rate) > 0.001) {
          toast.error('Unit price cannot be changed. It must match the linked Purchase Order price.');
          return;
        }
      }
    }
    if (chargesHaveValue(additionalCharges) && !chargesRemarks.trim()) {
      toast.error('Remarks are required when additional charges are added.');
      return;
    }
    setIsLoading(true);
    try {
      const payload = cleanFormData({
        ...formData,
        subtotal: subtotal.toFixed(2),
        discount_amount: totalDiscount.toFixed(2),
        tax_amount: totalTax.toFixed(2),
        total_amount: totalAmount.toFixed(2),
        additional_charges: additionalCharges.filter(c => parseFloat(c.amount) > 0),
        additional_charges_remarks: chargesRemarks.trim(),
        bill_lines: lines.filter(l => l.product).map(l => {
          // Route the picked id to the matching FK column based on
          // item_type. Goods (default) keep `product` for back-compat.
          const itemType = (l.item_type || 'PRODUCT').toUpperCase();
          // Machine spares are MACHINERY Products now → save to `product`.
          const fkPair = itemType === 'SERVICE'
            ? { service_catalogue: l.product }
            : { product: l.product };
          return {
            ...fkPair,
            description: l.description,
            quantity: l.quantity,
            uom: l.uom,
            rate: l.rate,
            discount_percent: l.discount_percent,
            tax_percent: l.tax_percent,
            amount: l.amount,
          };
        }),
      });
      const res = await apiClient.post('/api/purchase/bills/', payload);
      const newId = res.data?.id;

      // Use ref for latest pending files (avoids stale closure)
      const filesToUpload = pendingAttachmentsRef.current;
      if (filesToUpload.length > 0 && newId) {
        await uploadPendingFiles('BILL', newId, filesToUpload);
      }

      toast.success('Vendor Bill created successfully!');
      navigate('/purchase/bills');
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass = "w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;
  const labelClass = "block text-xs font-semibold text-slate-700 mb-0.5";

  return (
    <MainLayout>
      <PageHeader
        title={formData.is_expense ? 'New Expense' : 'Create Vendor Bill'}
        subtitle={formData.is_expense ? 'Booked to the Expense Register (excluded from purchase totals)' : undefined}
        breadcrumbs={formData.is_expense ? [
          { label: 'Purchase', path: '/purchase' },
          { label: 'Expenses', path: '/purchase/expenses' },
          { label: 'New Expense' },
        ] : [
          { label: 'Purchase', path: '/purchase' },
          { label: 'Bills', path: '/purchase/bills' },
          { label: 'New Bill' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-3">
          {/* Bill Details */}
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Bill Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-3 gap-y-2">
              {!isHidden('receipt_advice') && (
              <div>
                <label className={labelClass}>Receipt Advice <span className="text-red-500">*</span></label>
                {searchParams.get('receipt_id') && formData.receipt_advice ? (
                  <input type="text" readOnly value={prefillReceiptData?.receipt_advice_no || formData.receipt_advice} className={`${inputClass} bg-slate-50 cursor-not-allowed`} />
                ) : (
                  <CustomSelect name="receipt_advice" value={formData.receipt_advice} onChange={handleReceiptChange} required disabled={isReadOnly('receipt_advice')} className={isReadOnly('receipt_advice') ? lockedInputClass : inputClass}>
                    <option value="">Select Receipt Advice</option>
                    {receiptOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                )}
              </div>
              )}
              {!isHidden('vendor') && (
              <div>
                <label className={labelClass}>Vendor <span className="text-red-500">*</span></label>
                <CustomSelect name="vendor" value={formData.vendor} onChange={handleChange} required disabled={isReadOnly('vendor')} className={isReadOnly('vendor') ? lockedInputClass : inputClass}>
                  <option value="">Select Vendor</option>
                  {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('purchase_order') && (
              <div>
                <label className={labelClass}>Purchase Order</label>
                {searchParams.get('receipt_id') && formData.purchase_order ? (
                  <input type="text" readOnly value={prefillReceiptData?.linked_po_numbers?.[0] || poOptions.find(o => o.value === formData.purchase_order)?.label || formData.purchase_order} className={`${inputClass} bg-slate-50 cursor-not-allowed`} />
                ) : (
                  <CustomSelect name="purchase_order" value={formData.purchase_order} onChange={handleChange} disabled={isReadOnly('purchase_order')} className={isReadOnly('purchase_order') ? lockedInputClass : inputClass}>
                    <option value="">Select PO (optional)</option>
                    {poOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                )}
              </div>
              )}
              {!isHidden('vendor_invoice_no') && (
              <div>
                <label className={labelClass}>Vendor Invoice No</label>
                <input type="text" name="vendor_invoice_no" value={formData.vendor_invoice_no} onChange={handleChange} disabled={isReadOnly('vendor_invoice_no')} className={isReadOnly('vendor_invoice_no') ? lockedInputClass : inputClass} placeholder="Vendor's invoice number" />
              </div>
              )}
              {!isHidden('bill_date') && (
              <div>
                <label className={labelClass}>Bill Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="bill_date" value={formData.bill_date} onChange={handleChange} required disabled={isReadOnly('bill_date')} className={isReadOnly('bill_date') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('due_date') && (
              <div>
                <label className={labelClass}>Due Date</label>
                <CustomDatePicker name="due_date" value={formData.due_date} onChange={handleChange} disabled={isReadOnly('due_date')} className={isReadOnly('due_date') ? lockedInputClass : inputClass} />
              </div>
              )}
            </div>
          </div>

          {/* Payment Terms Note — derived from the linked PO's
              payment_terms so the day count matches what the operator
              actually agreed on. Previously hardcoded to "15 days"
              regardless of the PO's NET_15 / NET_30 / NET_45 setting. */}
          {(() => {
            const linkedPo = (poRaw || []).find(po => String(po.id) === String(formData?.purchase_order));
            const terms = linkedPo?.payment_terms || '';
            let message = '';
            const m = String(terms).match(/^NET_?(\d+)$/i);
            if (m) {
              message = `Payment should be made within ${m[1]} days from the billing date.`;
            } else if (terms === 'ADVANCE') {
              message = 'Payment is required in advance.';
            } else if (terms === 'COD') {
              message = 'Payment is due on delivery (Cash on Delivery).';
            }
            if (!message) return null;
            return (
              <div className="bg-amber-50 border-l-4 border-amber-400 p-3 rounded-r-lg">
                <p className="text-sm font-semibold text-amber-800">{message}</p>
              </div>
            );
          })()}

          {/* Line Items */}
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Line Items</h3>
            <div className="overflow-x-auto ios-scroll">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-8">#</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 min-w-[180px]">Product</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 min-w-[120px]">Description</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-20">Qty</th>
                    <th className="text-right px-2 py-2 font-medium text-slate-600 w-20">Diff in Qty</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-16">UOM</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-24">Rate</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-20">Disc %</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-20">Tax %</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-28">Amount</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="px-2 py-2 text-slate-500">{idx + 1}</td>
                      <td className="px-2 py-1">
                        {/* Lines auto-filled from a Receipt are
                            read-only (locked to the receipt's item) so
                            the user can't accidentally swap a Machinery
                            line back to a Product. Manually-added lines
                            (no max_quantity) get the unified dropdown
                            with Products / Machinery / Services
                            grouped by type. */}
                        {line.max_quantity ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm text-slate-800">{line.item_name || line.description || '-'}</span>
                            {line.item_type && line.item_type !== 'PRODUCT' && (
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                line.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'
                              }`}>
                                {line.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                              </span>
                            )}
                          </div>
                        ) : (
                          <CustomSelect
                            value={line.product ? `${(line.item_type || 'PRODUCT').toUpperCase()}:${line.product}` : ''}
                            onChange={e => {
                              const v = e.target.value;
                              if (!v) {
                                handleLineChange(idx, 'product', '');
                                return;
                              }
                              const ci = v.indexOf(':');
                              const type = ci >= 0 ? v.slice(0, ci) : 'PRODUCT';
                              const id = ci >= 0 ? v.slice(ci + 1) : v;
                              setLines(prev => prev.map((row, ri) => ri === idx ? {
                                ...row,
                                item_type: type,
                                product: id,
                              } : row));
                            }}
                            className={inputClass}
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
                        )}
                      </td>
                      <td className="px-2 py-1"><input type="text" value={line.description} onChange={e => handleLineChange(idx, 'description', e.target.value)} className={inputClass} /></td>
                      <td className="px-2 py-1"><input type="number" step="0.01" min="0.01" value={line.quantity} readOnly={!!line.max_quantity} onChange={e => handleLineChange(idx, 'quantity', e.target.value)} className={line.max_quantity ? `${inputClass} bg-slate-50 cursor-not-allowed` : inputClass} title={line.max_quantity ? `Locked to receipt quantity: ${line.max_quantity}` : ''} /></td>
                      <td className="px-2 py-1 text-right">
                        {line.diff_quantity != null ? (
                          <span className={`font-medium ${line.diff_quantity > 0 ? 'text-red-600' : line.diff_quantity < 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                            {Number(line.diff_quantity).toFixed(2)}
                          </span>
                        ) : <span className="text-slate-400">-</span>}
                      </td>
                      <td className="px-2 py-1"><input type="text" value={line.uom} onChange={e => handleLineChange(idx, 'uom', e.target.value)} className={inputClass} /></td>
                      <td className="px-2 py-1"><input type="number" step="0.01" value={line.rate} readOnly={line.po_rate !== null && line.po_rate !== undefined} onChange={e => handleLineChange(idx, 'rate', e.target.value)} className={line.po_rate !== null && line.po_rate !== undefined ? `${inputClass} bg-slate-50 cursor-not-allowed` : inputClass} title={line.po_rate !== null && line.po_rate !== undefined ? `Locked to PO price: ${line.po_rate}` : ''} /></td>
                      <td className="px-2 py-1"><input type="number" step="0.01" value={line.discount_percent} onChange={e => handleLineChange(idx, 'discount_percent', e.target.value)} className={inputClass} /></td>
                      <td className="px-2 py-1"><input type="number" step="0.01" value={line.tax_percent} onChange={e => handleLineChange(idx, 'tax_percent', e.target.value)} className={inputClass} /></td>
                      <td className="px-2 py-2 font-medium">{'\u20B9'}{(parseFloat(line.amount) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                      <td className="px-2 py-1">
                        {lines.length > 1 && (
                          <button type="button" onClick={() => removeLine(idx)} className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" onClick={addLine} className="mt-3 px-4 py-2 text-sm text-primary-600 border border-primary-300 rounded-lg hover:bg-primary-50">
              + Add Item
            </button>
          </div>

          {/* Additional charges (shipping / courier / custom) */}
          <AdditionalCharges
            charges={additionalCharges}
            remarks={chargesRemarks}
            onChange={({ charges, remarks }) => { setAdditionalCharges(charges); setChargesRemarks(remarks); }}
          />

          {/* Summary */}
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Summary</h3>
            <div className="max-w-md ml-auto space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">Subtotal:</span>
                <span className="font-medium">{'\u20B9'}{subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between text-red-600">
                <span>Discount:</span>
                <span>-{'\u20B9'}{totalDiscount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Tax:</span>
                <span>{'\u20B9'}{totalTax.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
              {chargesTotal > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Additional Charges:</span>
                  <span>{'\u20B9'}{chargesTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t border-slate-300 text-base font-bold">
                <span>Total:</span>
                <span>{'\u20B9'}{totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Notes</h3>
            <div className="grid grid-cols-2 gap-3">
              {!isHidden('terms_and_conditions') && (
              <div>
                <label className={labelClass}>Terms & Conditions</label>
                <textarea name="terms_and_conditions" value={formData.terms_and_conditions} onChange={handleChange} rows={2} disabled={isReadOnly('terms_and_conditions')} className={isReadOnly('terms_and_conditions') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('notes') && (
              <div>
                <label className={labelClass}>Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={2} disabled={isReadOnly('notes')} className={isReadOnly('notes') ? lockedInputClass : inputClass} />
              </div>
              )}
            </div>
          </div>

          {/* Receipt Attachments — inherited from selected Receipt Advice (read-only) */}
          {receiptAttachments.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
              <div className="flex items-center gap-2 mb-3">
                <Paperclip size={16} className="text-blue-700" />
                <h3 className="text-sm font-semibold text-blue-900">
                  Receipt Advice Attachments ({receiptAttachments.length})
                </h3>
                <span className="text-xs text-blue-600">— inherited from linked GRN</span>
              </div>
              <div className="space-y-2">
                {receiptAttachments.map(f => {
                  const sizeKB = f.file_size ? (Number(f.file_size) / 1024).toFixed(1) : null;
                  return (
                    <div key={f.id} className="flex items-center gap-3 p-2.5 bg-white border border-blue-200 rounded">
                      <div className="w-8 h-8 rounded bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <FileText size={14} className="text-blue-700" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate" title={f.file_name}>{f.file_name}</p>
                        <p className="text-xs text-slate-500">
                          Receipt{f.file_type ? ` • ${f.file_type}` : ''}{sizeKB ? ` • ${sizeKB} KB` : ''}
                        </p>
                      </div>
                      <a
                        href={f.file}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1.5 bg-primary-600 text-white text-xs font-medium rounded hover:bg-primary-700"
                      >
                        View
                      </a>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Bill Attachments — for new files uploaded specifically to the bill */}
          <FileAttachments module="BILL" recordId={null} onPendingChange={(files) => { pendingAttachmentsRef.current = files; setPendingAttachments(files); }} />

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isLoading ? 'Saving...' : 'Save Bill'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
