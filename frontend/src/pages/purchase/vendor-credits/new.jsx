import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup, { clearLookupCache } from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import useAllProducts from '../components/useAllProducts.js';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';

export default function CreateVendorCredit() {
  const navigate = useNavigate();
  const { isHidden, isReadOnly } = useFieldPermissions('Vendor Credit');

  // Bills cache must always be fresh on this page so newly created credits are
  // reflected (a bill becomes ineligible the moment a credit is raised against it).
  // Clear the cache before the first useLookup call so it refetches.
  useLayoutEffect(() => {
    clearLookupCache('/api/purchase/bills/');
    clearLookupCache('/api/purchase/vendor-credits/');
  }, []);

  const { options: vendorOptions } = useLookup('/api/vendors/');
  const { raw: billsRaw } = useLookup('/api/purchase/bills/');
  const { raw: productRaw } = useAllProducts();
  // Unified item catalogue — drives the line item dropdown so Vendor
  // Credits can be raised against Machinery and Service lines too
  // (matches the Bill flow). Each row: { item_type, item_id, ... }.
  const { raw: purchaseItems } = useLookup('/api/purchase/items/');

  // Belt-and-braces filter: independently fetch existing credits and exclude their
  // bill IDs, in case the bill API hasn't been refetched yet or `has_credit` is
  // not yet populated by the backend. Recomputes whenever the credit list changes.
  const [creditedBillIds, setCreditedBillIds] = useState(new Set());
  useEffect(() => {
    let cancelled = false;
    apiClient.get('/api/purchase/vendor-credits/', { params: { page_size: 500 } })
      .then(res => {
        if (cancelled) return;
        const list = res.data?.results || res.data || [];
        const ids = new Set(
          list
            .filter(c => c.bill && c.status !== 'CANCELLED')
            .map(c => c.bill)
        );
        setCreditedBillIds(ids);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const billOptions = billsRaw.map(b => ({ value: b.id, label: `${b.bill_no} - ${b.vendor_name || ''}` }));
  const productOptions = productRaw.map(p => ({ value: p.id, label: `${p.sku_code || ''} - ${p.product_name}`, uom: p.uom || '' }));

  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const pendingAttachmentsRef = useRef([]);
  const [formData, setFormData] = useState({
    vendor: '',
    credit_type: 'CREDIT',
    credit_date: new Date().toISOString().split('T')[0],
    bill: '',
    reason: '',
    notes: '',
    status: 'DRAFT',
  });

  const emptyLine = { item_type: 'PRODUCT', product: '', item_name: '', description: '', quantity: '1', max_quantity: null, uom: '', rate: '0', tax_percent: '0', amount: '0' };
  const [lines, setLines] = useState([{ ...emptyLine }]);

  const calcLineAmount = (line) => {
    const qty = parseFloat(line.quantity) || 0;
    const rate = parseFloat(line.rate) || 0;
    const tax = parseFloat(line.tax_percent) || 0;
    const base = qty * rate;
    const withTax = base + (base * tax / 100);
    return Math.round(withTax * 100) / 100;
  };

  const handleLineChange = (idx, field, value) => {
    // Quantity validation against bill line quantity — allow free typing
    if (field === 'quantity' && value !== '') {
      const maxQty = lines[idx]?.max_quantity;
      const numVal = parseFloat(value);
      if (maxQty && !isNaN(numVal) && numVal > maxQty) {
        toast.error(`Quantity cannot exceed ${maxQty} (billed quantity). Quantity cannot be greater than the Purchase Order quantity.`);
        return;
      }
      if (!isNaN(numVal) && numVal < 0) {
        toast.error('Quantity cannot be negative.');
        return;
      }
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

  // Auto-fill credit lines from bill lines when bill is selected
  const handleBillSelect = async (e) => {
    const billId = e.target.value;
    setFormData(prev => ({ ...prev, bill: billId }));

    if (!billId) return;

    const bill = billsRaw.find(b => b.id === billId);
    if (!bill) return;

    // Auto-fill vendor from bill
    if (bill.vendor) {
      setFormData(prev => ({ ...prev, bill: billId, vendor: bill.vendor }));
    }

    // Fetch receipt data to get diff in qty per item. Key the diff
    // map by "<TYPE>:<id>" so Goods / Machinery / Service items don't
    // collide on numeric id alone. Also track whether ANY receipt line
    // for that item was flagged is_debit_note=True and capture the PO
    // unit price + gst so the debit-note auto-fill uses PO rate (not
    // the bill rate) — the price the vendor owes back is the PO price,
    // not whatever the bill happened to charge.
    let receiptInfoMap = {};
    if (bill.receipt_advice) {
      try {
        const rRes = await apiClient.get(`/api/purchase/receipts/${bill.receipt_advice}/`);
        const receiptLines = rRes.data?.receipt_lines || [];
        receiptLines.forEach(rl => {
          const rlType = (rl.item_type || 'PRODUCT').toUpperCase();
          const rlId = rl.product || rl.machinery || rl.service_catalogue || rl.product_service;
          const rcvd = parseFloat(rl.quantity_received) || 0;
          const net = parseFloat(rl.net_quantity);
          if (rlId && !isNaN(net)) {
            const diff = Math.round((rcvd - net) * 100) / 100;
            const key = `${rlType}:${rlId}`;
            const prev = receiptInfoMap[key] || { diff: 0, is_debit_note: false, po_rate: null, po_gst: null };
            prev.diff += diff;
            if (rl.is_debit_note) prev.is_debit_note = true;
            if (prev.po_rate == null && rl.po_unit_price != null) prev.po_rate = parseFloat(rl.po_unit_price);
            if (prev.po_gst == null && rl.po_gst != null) prev.po_gst = parseFloat(rl.po_gst);
            receiptInfoMap[key] = prev;
          }
        });
      } catch { /* ignore */ }
    }

    // If any receipt line was flagged as debit note, switch the credit
    // type to Debit Note so the form reflects what's actually being
    // raised (shortfall against vendor).
    const anyDebitNoted = Object.values(receiptInfoMap).some(v => v.is_debit_note);
    if (anyDebitNoted) {
      setFormData(prev => ({ ...prev, credit_type: 'DEBIT' }));
    }

    // Auto-fill credit lines from bill lines with diff qty. Each bill
    // line carries item_type + the matching FK id — forward both so
    // the credit line saves under the same FK column as the bill.
    // When the receipt line was flagged is_debit_note, use the PO
    // unit_price / gst instead of the bill rate.
    if (bill.bill_lines && bill.bill_lines.length > 0) {
      const newLines = bill.bill_lines.map(bl => {
        const itemType = (bl.item_type || 'PRODUCT').toUpperCase();
        const pid = bl.product || bl.machinery || bl.service_catalogue || '';
        const diffKey = `${itemType}:${pid}`;
        const info = receiptInfoMap[diffKey] || { diff: 0, is_debit_note: false, po_rate: null, po_gst: null };
        const diffQty = Math.round((info.diff || 0) * 100) / 100;
        const qty = diffQty > 0 ? diffQty : parseFloat(bl.quantity) || 1;
        const usePoRate = info.is_debit_note && info.po_rate != null;
        const rate = usePoRate ? info.po_rate : (parseFloat(bl.rate) || 0);
        const taxPct = usePoRate && info.po_gst != null ? info.po_gst : (parseFloat(bl.tax_percent) || 0);
        const lineObj = {
          item_type: itemType,
          product: pid,
          item_name: bl.item_name || bl.product_name || '',
          description: bl.description || '',
          quantity: String(qty),
          max_quantity: parseFloat(bl.quantity) || null,
          uom: bl.uom || '',
          rate: String(rate),
          tax_percent: String(taxPct),
          amount: '0',
        };
        // Use calcLineAmount for consistent rounding
        lineObj.amount = calcLineAmount(lineObj).toString();
        return lineObj;
      });
      setLines(newLines);
    }
  };

  const addLine = () => setLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => setLines(prev => prev.filter((_, i) => i !== idx));

  const subtotal = lines.reduce((sum, l) => sum + (parseFloat(l.quantity) || 0) * (parseFloat(l.rate) || 0), 0);
  const totalTax = lines.reduce((sum, l) => {
    const base = (parseFloat(l.quantity) || 0) * (parseFloat(l.rate) || 0);
    return sum + (base * (parseFloat(l.tax_percent) || 0) / 100);
  }, 0);
  const totalAmount = lines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Validate credit line quantities before submission
    if (formData.credit_type !== 'ADVANCE') {
      for (const line of lines) {
        if (!line.product) continue;
        const qty = parseFloat(line.quantity) || 0;
        if (qty <= 0) {
          toast.error('Quantity must be greater than 0.');
          return;
        }
        if (line.max_quantity && qty > line.max_quantity) {
          toast.error(
            `Quantity for ${line.description || 'item'} cannot exceed ${line.max_quantity} (billed quantity). ` +
            `Quantity cannot be greater than the Purchase Order quantity.`
          );
          return;
        }
      }
    }

    setIsLoading(true);
    try {
      let payload;
      if (formData.credit_type === 'ADVANCE') {
        const advAmt = parseFloat(formData.advance_amount) || 0;
        payload = cleanFormData({
          vendor: formData.vendor,
          credit_type: 'ADVANCE',
          credit_date: formData.credit_date,
          bill: formData.bill || null,
          reason: formData.reason || `Advance payment - ${formData.advance_payment_mode || ''} ${formData.advance_reference || ''}`.trim(),
          notes: formData.notes,
          status: formData.status,
          subtotal: advAmt.toFixed(2),
          tax_amount: '0.00',
          total_amount: advAmt.toFixed(2),
        });
      } else {
        payload = cleanFormData({
          ...formData,
          subtotal: subtotal.toFixed(2),
          tax_amount: totalTax.toFixed(2),
          total_amount: totalAmount.toFixed(2),
          credit_lines: lines.filter(l => l.product).map(l => {
            // Route the picked id to the correct FK column per
            // item_type. Goods (default) keep `product` for back-compat.
            const itemType = (l.item_type || 'PRODUCT').toUpperCase();
            // Machine spares are MACHINERY Products now → save to `product` like
            // goods (the legacy `machinery` FK is retired).
            const fkPair = itemType === 'SERVICE'
              ? { service_catalogue: l.product }
              : { product: l.product };
            return {
              ...fkPair,
              description: l.description,
              quantity: l.quantity,
              uom: l.uom,
              rate: l.rate,
              tax_percent: l.tax_percent,
              amount: l.amount,
            };
          }),
        });
      }
      const res = await apiClient.post('/api/purchase/vendor-credits/', payload);
      const newId = res.data?.id;

      if (pendingAttachments.length > 0 && newId) {
        await uploadPendingFiles('CREDIT', newId, pendingAttachmentsRef.current);
      }

      // Invalidate cached lookups so the bill we just used no longer appears
      // as a candidate the next time this form is opened.
      clearLookupCache('/api/purchase/bills/');
      clearLookupCache('/api/purchase/vendor-credits/');

      toast.success('Vendor Credit created successfully!');
      navigate('/purchase/vendor-credits');
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass = "w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;
  const labelClass = "block text-xs font-semibold text-slate-700 mb-0.5";

  // Product/Item picker for a line — shared by the desktop table and the
  // mobile cards. Bill-autofilled lines are locked to a read-only label;
  // manual lines get the grouped Products / Machinery / Services dropdown.
  const renderProductPicker = (line, idx) => (
    line.max_quantity ? (
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
          if (!v) { handleLineChange(idx, 'product', ''); return; }
          const ci = v.indexOf(':');
          const type = ci >= 0 ? v.slice(0, ci) : 'PRODUCT';
          const id = ci >= 0 ? v.slice(ci + 1) : v;
          setLines(prev => prev.map((row, ri) => ri === idx ? { ...row, item_type: type, product: id } : row));
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
    )
  );

  return (
    <MainLayout>
      <PageHeader
        title="Create Vendor Credit"
        breadcrumbs={[
          { label: 'Purchase', path: '/purchase' },
          { label: 'Vendor Notes & Advances', path: '/purchase/vendor-credits' },
          { label: 'New Credit' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Credit Details */}
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Credit Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
              {!isHidden('vendor') && (
              <div>
                <label className={labelClass}>Vendor <span className="text-red-500">*</span></label>
                <CustomSelect name="vendor" value={formData.vendor} onChange={handleChange} required disabled={isReadOnly('vendor')} className={isReadOnly('vendor') ? lockedInputClass : inputClass}>
                  <option value="">Select Vendor</option>
                  {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('credit_type') && (
              <div>
                <label className={labelClass}>Type <span className="text-red-500">*</span></label>
                <CustomSelect name="credit_type" value={formData.credit_type} onChange={handleChange} disabled={isReadOnly('credit_type')} className={isReadOnly('credit_type') ? lockedInputClass : inputClass}>
                  <option value="CREDIT">Credit Note</option>
                  <option value="DEBIT">Debit Note</option>
                  <option value="ADVANCE">Advance Payment</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('credit_date') && (
              <div>
                <label className={labelClass}>Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="credit_date" value={formData.credit_date} onChange={handleChange} required disabled={isReadOnly('credit_date')} className={isReadOnly('credit_date') ? lockedInputClass : inputClass} />
              </div>
              )}
            </div>
            {/* Bill No - for Credit Note and Debit Note types */}
            {(formData.credit_type === 'CREDIT' || formData.credit_type === 'DEBIT') && !isHidden('bill') && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2 mt-3">
                <div>
                  <label className={labelClass}>Bill No</label>
                  <CustomSelect name="bill" value={formData.bill || ''} onChange={handleBillSelect} disabled={isReadOnly('bill')} className={isReadOnly('bill') ? lockedInputClass : inputClass}>
                    <option value="">Select Bill</option>
                    {billsRaw
                      .filter(b => !formData.vendor || b.vendor === formData.vendor)
                      .filter(b => b.is_debit_eligible)
                      .filter(b => !b.has_credit && !creditedBillIds.has(b.id))
                      .map(b => (
                        <option key={b.id} value={b.id}>
                          {b.bill_no} — ₹{(Number(b.total_amount) || 0).toLocaleString('en-IN')}
                        </option>
                      ))}
                  </CustomSelect>
                  <p className="mt-1 text-xs text-slate-500">
                    Only debit-note-eligible bills with no existing credit note appear here.
                  </p>
                </div>
              </div>
            )}
            {!isHidden('reason') && (
            <div className="mt-3">
              <label className={labelClass}>Reason</label>
              <textarea name="reason" value={formData.reason} onChange={handleChange} rows={2} disabled={isReadOnly('reason')} className={isReadOnly('reason') ? lockedInputClass : inputClass} placeholder="Reason for credit/debit note..." />
            </div>
            )}
          </div>

          {/* Advance Amount (only for ADVANCE type) */}
          {formData.credit_type === 'ADVANCE' && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 sm:p-4">
              <h3 className="text-sm sm:text-base font-semibold text-green-800 mb-2 pb-1.5 border-b border-green-200">Advance Payment Details</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
                <div>
                  <label className={labelClass}>Advance Amount <span className="text-red-500">*</span></label>
                  <input type="number" step="0.01" min="0" name="advance_amount" value={formData.advance_amount || ''} onChange={(e) => {
                    const val = e.target.value;
                    setFormData(prev => ({ ...prev, advance_amount: val }));
                    setLines([]);
                  }} required className={inputClass} placeholder="Enter advance amount" />
                </div>
                <div>
                  <label className={labelClass}>Payment Mode</label>
                  <CustomSelect name="advance_payment_mode" value={formData.advance_payment_mode || ''} onChange={handleChange} className={inputClass}>
                    <option value="">Select Mode</option>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="CASH">Cash</option>
                    <option value="CHEQUE">Cheque</option>
                    <option value="UPI">UPI</option>
                    <option value="NEFT">NEFT</option>
                    <option value="RTGS">RTGS</option>
                  </CustomSelect>
                </div>
                <div>
                  <label className={labelClass}>Reference No</label>
                  <input type="text" name="advance_reference" value={formData.advance_reference || ''} onChange={handleChange} className={inputClass} placeholder="Transaction/cheque reference" />
                </div>
                {!isHidden('bill') && (
                <div>
                  <label className={labelClass}>Link to Bill <span className="text-xs text-slate-400 font-normal">(optional)</span></label>
                  <CustomSelect name="bill" value={formData.bill || ''} onChange={handleChange} disabled={isReadOnly('bill')} className={isReadOnly('bill') ? lockedInputClass : inputClass}>
                    <option value="">Any Bill (General Advance)</option>
                    {billsRaw.filter(b => !formData.vendor || b.vendor === formData.vendor).filter(b => ['DRAFT', 'OPEN', 'PARTIALLY_PAID'].includes(b.status)).map(b => (
                      <option key={b.id} value={b.id}>{b.bill_no} — Balance: ₹{(Number(b.balance_due) || 0).toLocaleString('en-IN')}</option>
                    ))}
                  </CustomSelect>
                </div>
                )}
              </div>
              <p className="text-xs text-green-600 mt-3">{formData.bill ? 'This advance will only be available for the selected bill.' : 'This advance will be stored against the selected vendor and can be applied to any bill.'}</p>
            </div>
          )}

          {/* Line Items (hidden for ADVANCE type) */}
          {formData.credit_type !== 'ADVANCE' && <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Line Items</h3>
            <div className="hidden md:block overflow-x-auto ios-scroll">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-8">#</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 min-w-[180px]">Product</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 min-w-[120px]">Description</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-20">Qty</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-16">UOM</th>
                    <th className="text-left px-2 py-2 font-medium text-slate-600 w-24">Rate</th>
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
                        {renderProductPicker(line, idx)}
                      </td>
                      <td className="px-2 py-1"><input type="text" value={line.description} onChange={e => handleLineChange(idx, 'description', e.target.value)} className={inputClass} /></td>
                      <td className="px-2 py-1"><input type="number" step="0.01" min="0.01" max={line.max_quantity || undefined} value={line.quantity} onChange={e => handleLineChange(idx, 'quantity', e.target.value)} className={inputClass} title={line.max_quantity ? `Max: ${line.max_quantity}` : ''} /></td>
                      <td className="px-2 py-1"><input type="text" value={line.uom} onChange={e => handleLineChange(idx, 'uom', e.target.value)} className={inputClass} /></td>
                      <td className="px-2 py-1"><input type="number" step="0.01" value={line.rate} onChange={e => handleLineChange(idx, 'rate', e.target.value)} className={inputClass} /></td>
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

            {/* mobile: each line as a stacked card */}
            <div className="md:hidden space-y-3">
              {lines.map((line, idx) => (
                <div key={idx} className="rounded-lg border border-slate-200 p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-500">Item {idx + 1}</span>
                    {lines.length > 1 && (
                      <button type="button" onClick={() => removeLine(idx)} className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Product</label>
                    {renderProductPicker(line, idx)}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Description</label>
                    <input type="text" value={line.description} onChange={e => handleLineChange(idx, 'description', e.target.value)} className={inputClass} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Qty</label>
                      <input type="number" step="0.01" min="0.01" max={line.max_quantity || undefined} value={line.quantity} onChange={e => handleLineChange(idx, 'quantity', e.target.value)} className={inputClass} title={line.max_quantity ? `Max: ${line.max_quantity}` : ''} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">UOM</label>
                      <input type="text" value={line.uom} onChange={e => handleLineChange(idx, 'uom', e.target.value)} className={inputClass} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Rate</label>
                      <input type="number" step="0.01" value={line.rate} onChange={e => handleLineChange(idx, 'rate', e.target.value)} className={inputClass} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Tax %</label>
                      <input type="number" step="0.01" value={line.tax_percent} onChange={e => handleLineChange(idx, 'tax_percent', e.target.value)} className={inputClass} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                    <span className="text-xs text-slate-500">Amount</span>
                    <span className="text-sm font-semibold">{'₹'}{(parseFloat(line.amount) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                </div>
              ))}
            </div>

            <button type="button" onClick={addLine} className="mt-3 px-4 py-2 text-sm text-primary-600 border border-primary-300 rounded-lg hover:bg-primary-50">
              + Add Item
            </button>
          </div>}

          {/* Summary */}
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Summary</h3>
            <div className="max-w-md ml-auto space-y-2 text-sm">
              {formData.credit_type === 'ADVANCE' ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Advance Amount:</span>
                    <span className="font-medium">{'\u20B9'}{(parseFloat(formData.advance_amount) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-slate-300 text-base font-bold">
                    <span>Total:</span>
                    <span>{'\u20B9'}{(parseFloat(formData.advance_amount) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Subtotal:</span>
                    <span className="font-medium">{'\u20B9'}{subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Tax:</span>
                    <span>{'\u20B9'}{totalTax.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-slate-300 text-base font-bold">
                    <span>Total:</span>
                    <span>{'\u20B9'}{totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Notes */}
          {!isHidden('notes') && (
          <div>
            <label className={labelClass}>Notes</label>
            <textarea name="notes" value={formData.notes} onChange={handleChange} rows={2} disabled={isReadOnly('notes')} className={isReadOnly('notes') ? lockedInputClass : inputClass} placeholder="Additional notes..." />
          </div>
          )}

          <FileAttachments module="CREDIT" recordId={null} onPendingChange={(files) => { pendingAttachmentsRef.current = files; setPendingAttachments(files); }} />

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isLoading ? 'Saving...' : 'Save Credit Note'}
            </button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
