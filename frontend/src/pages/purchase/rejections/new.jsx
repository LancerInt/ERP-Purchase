import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useAllProducts from '../components/useAllProducts.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import { formatCurrency } from '@/utils/formatters';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const readOnlyClass = `${inputClass} bg-slate-50 cursor-not-allowed`;
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;
const labelClass = 'block text-sm font-medium text-slate-700 mb-1';

const REASON_CHOICES = [
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'WRONG_ITEM', label: 'Wrong Item' },
  { value: 'QUALITY_ISSUE', label: 'Quality Issue' },
  { value: 'SHORT_QUANTITY', label: 'Short Quantity' },
  { value: 'OTHER', label: 'Other' },
];

const RETURN_TYPE_CHOICES = [
  { value: 'REPLACE', label: 'Replace' },
  { value: 'REFUND', label: 'Refund' },
  { value: 'SCRAP', label: 'Scrap' },
];

export default function CreateMaterialRejection() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { staff } = usePermissions();
  const { isHidden, isReadOnly } = useFieldPermissions('Material Rejection');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const pendingAttachmentsRef = useRef([]);

  const { raw: receiptRaw } = useLookup('/api/purchase/receipts/');
  const receiptOptions = receiptRaw.map(r => ({ value: r.id, label: r.receipt_advice_no }));
  const { options: productOptions, raw: productRaw } = useAllProducts();

  const [formData, setFormData] = useState({
    receipt_advice: '',
    purchase_order: '',
    vendor: '',
    warehouse: '',
    rejection_date: new Date().toISOString().split('T')[0],
    return_to_vendor: false,
    return_type: '',
    return_date: '',
    replacement_expected_date: '',
    debit_note_required: false,
    description: '',
    remarks: '',
  });
  const [receiptInfo, setReceiptInfo] = useState(null);
  const [lines, setLines] = useState([]);

  // Auto-fill from receipt_id query param
  useEffect(() => {
    const receiptId = searchParams.get('receipt_id');
    if (receiptId) {
      setFormData(prev => ({ ...prev, receipt_advice: receiptId }));
      loadReceiptData(receiptId);
    }
  }, [searchParams]);

  const loadReceiptData = async (receiptId) => {
    try {
      const res = await apiClient.get(`/api/purchase/receipts/${receiptId}/`);
      const r = res.data;
      setReceiptInfo(r);
      const poId = (r.linked_pos || [])[0] || '';

      setFormData(prev => ({
        ...prev,
        receipt_advice: receiptId,
        vendor: r.vendor || '',
        warehouse: r.warehouse || '',
        purchase_order: poId,
      }));

      // Auto-fill rejection lines from receipt — Rejected qty stays blank for the user to enter.
      const receiptLines = r.receipt_lines || [];
      if (receiptLines.length > 0) {
        let poLineMap = {};
        if (poId) {
          try {
            const poRes = await apiClient.get(`/api/purchase/orders/${poId}/`);
            (poRes.data?.po_lines || []).forEach(pl => {
              poLineMap[pl.product_service] = pl;
            });
          } catch { /* ignore */ }
        }

        setLines(receiptLines.map((rl, i) => {
          const poLine = rl.po_line ? poLineMap[rl.product] || {} : {};
          const rcvd = parseFloat(rl.quantity_received) || 0;
          // Carry the source-master from the receipt line so the
          // rejection persists against the matching FK (product /
          // machinery / service_catalogue). Auto-fill picks whichever
          // FK was set on the receipt line.
          const itemType = (rl.item_type || 'PRODUCT').toUpperCase();
          const itemId = rl.product || rl.machinery || rl.service_catalogue || '';
          return {
            line_no: i + 1,
            item_type: itemType,
            product: itemId,
            product_name: rl.item_name || rl.product_name || '',
            receipt_line: rl.id || '',
            received_quantity: String(rcvd),
            accepted_quantity: String(rcvd),
            rejected_quantity: '',
            uom: rl.uom || 'KG',
            batch_no: rl.batch_no || '',
            unit_price: String(parseFloat(poLine.unit_price || 0)),
            rejection_reason: 'QUALITY_ISSUE',
            remarks: '',
          };
        }));
      }
    } catch {
      setReceiptInfo(null);
    }
  };

  const handleReceiptChange = (e) => {
    const val = e.target.value;
    setFormData(prev => ({ ...prev, receipt_advice: val }));
    if (val) loadReceiptData(val);
    else { setReceiptInfo(null); setLines([]); }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleLineChange = (idx, field, value) => {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const updated = { ...l, [field]: value };
      // When picking a product manually, copy name + UOM from product master
      if (field === 'product') {
        const p = (productRaw || []).find(pr => String(pr.id) === String(value));
        if (p) {
          updated.product_name = p.product_name || updated.product_name;
          if (!updated.uom) updated.uom = p.uom || 'KG';
        }
      }
      // Re-derive accepted whenever received or rejected changes
      if (field === 'rejected_quantity' || field === 'received_quantity') {
        const rcvd = parseFloat(updated.received_quantity) || 0;
        const rejected = parseFloat(updated.rejected_quantity) || 0;
        if (rejected > rcvd) {
          toast.error(`Rejected qty (${rejected}) cannot exceed received qty (${rcvd})`);
          return l;
        }
        updated.accepted_quantity = String(Math.round((rcvd - rejected) * 100) / 100);
      }
      return updated;
    }));
  };

  const addLine = () => setLines(prev => [...prev, {
    line_no: prev.length + 1, item_type: 'PRODUCT', product: '', product_name: '', receipt_line: '',
    received_quantity: '', accepted_quantity: '', rejected_quantity: '',
    uom: 'KG', batch_no: '', unit_price: '0', rejection_reason: 'QUALITY_ISSUE', remarks: '',
  }]);
  const removeLine = (idx) => { if (lines.length > 1) setLines(prev => prev.filter((_, i) => i !== idx)); };

  // Totals
  const totalRejectedValue = lines.reduce((s, l) => {
    return s + Math.round((parseFloat(l.rejected_quantity) || 0) * (parseFloat(l.unit_price) || 0) * 100) / 100;
  }, 0);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.receipt_advice) { toast.error('Please select a Receipt Advice.'); return; }
    // Validate lines
    for (const line of lines) {
      const rejected = parseFloat(line.rejected_quantity) || 0;
      const received = parseFloat(line.received_quantity) || 0;
      if (rejected <= 0) continue; // skip lines with no rejection
      if (rejected > received) {
        toast.error(`Rejected qty cannot exceed received qty for ${line.product_name || 'item'}`);
        return;
      }
    }
    const validLines = lines.filter(l => parseFloat(l.rejected_quantity) > 0);
    if (validLines.length === 0) { toast.error('At least one item must have a rejected quantity.'); return; }

    setIsLoading(true);
    try {
      const payload = cleanFormData({
        ...formData,
        rejection_lines: validLines.map((l, i) => {
          // Route the picked id to the matching FK so Machinery /
          // Service rejection lines land on the correct column. Goods
          // (default) keep `product` to preserve back-compat.
          const itemType = (l.item_type || 'PRODUCT').toUpperCase();
          // Machine spares are MACHINERY Products now → save to `product` like
          // goods (the legacy `machinery` FK is retired).
          const fkPair = itemType === 'SERVICE'
            ? { service_catalogue: l.product }
            : { product: l.product };
          return ({
          line_no: i + 1,
          ...fkPair,
          receipt_line: l.receipt_line || null,
          received_quantity: l.received_quantity,
          accepted_quantity: l.accepted_quantity,
          rejected_quantity: l.rejected_quantity,
          uom: l.uom,
          batch_no: l.batch_no || '',
          unit_price: l.unit_price || '0',
          rejection_reason: l.rejection_reason,
          remarks: l.remarks || '',
        });
        }),
      });
      const res = await apiClient.post('/api/purchase/rejections/', payload);
      const newId = res.data?.id;

      const filesToUpload = pendingAttachmentsRef.current;
      if (filesToUpload.length > 0 && newId) {
        await uploadPendingFiles('REJECTION', newId, filesToUpload);
      }

      toast.success('Material Rejection created!');
      navigate(newId ? `/purchase/rejections/${newId}` : '/purchase/rejections');
    } catch (error) {
      console.error('[Rejection] submit error:', error.response?.status, error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Material Rejection"
        breadcrumbs={[{ label: 'Purchase', path: '/purchase' }, { label: 'Rejections', path: '/purchase/rejections' }, { label: 'New' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-6" noValidate>

          {/* Header */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Rejection Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {!isHidden('receipt_advice') && (
              <div>
                <label className={labelClass}>Receipt / GRN <span className="text-red-500">*</span></label>
                {searchParams.get('receipt_id') && formData.receipt_advice ? (
                  <input type="text" readOnly value={receiptInfo?.receipt_advice_no || ''} className={readOnlyClass} />
                ) : (
                  <CustomSelect name="receipt_advice" value={formData.receipt_advice} onChange={handleReceiptChange} required disabled={isReadOnly('receipt_advice')} className={isReadOnly('receipt_advice') ? lockedInputClass : inputClass}>
                    <option value="">Select Receipt</option>
                    {receiptOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                )}
              </div>
              )}
              {!isHidden('purchase_order') && (
              <div>
                <label className={labelClass}>PO Number</label>
                <input type="text" readOnly value={receiptInfo?.linked_po_numbers?.join(', ') || '-'} className={readOnlyClass} />
              </div>
              )}
              {!isHidden('vendor') && (
              <div>
                <label className={labelClass}>Vendor</label>
                <input type="text" readOnly value={receiptInfo?.vendor_name || '-'} className={readOnlyClass} />
              </div>
              )}
              {!isHidden('warehouse') && (
              <div>
                <label className={labelClass}>Warehouse</label>
                <input type="text" readOnly value={receiptInfo?.warehouse_name || '-'} className={readOnlyClass} />
              </div>
              )}
              {!isHidden('rejection_date') && (
              <div>
                <label className={labelClass}>Rejection Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="rejection_date" value={formData.rejection_date} onChange={handleChange} required disabled={isReadOnly('rejection_date')} className={isReadOnly('rejection_date') ? lockedInputClass : inputClass} />
              </div>
              )}
            </div>
          </div>

          {/* Rejection Line Items */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Rejection Items ({lines.length})</h3>
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add Item
              </button>
            </div>
            {lines.length === 0 ? (
              <p className="text-sm text-slate-400 italic">Click "Add Item" to enter rejection lines manually, or select a Receipt to auto-populate.</p>
            ) : (
              <div className="overflow-x-auto ios-scroll">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-3 py-2 font-medium text-slate-600 w-8">#</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Item</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Received</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Accepted</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Rejected <span className="text-red-500">*</span></th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Batch</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Rate</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Value</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Reason</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                      <th className="px-3 py-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => {
                      const rejQty = parseFloat(line.rejected_quantity) || 0;
                      const price = parseFloat(line.unit_price) || 0;
                      const value = Math.round(rejQty * price * 100) / 100;
                      // Manually-added rows (no receipt_line link) are fully editable.
                      const isManual = !line.receipt_line;
                      return (
                        <tr key={idx} className="border-b">
                          <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                          <td className="px-3 py-2">
                            {isManual ? (
                              <CustomSelect value={line.product} onChange={e => handleLineChange(idx, 'product', e.target.value)} className={inputClass} style={{ minWidth: '160px' }} required>
                                <option value="">Select Product</option>
                                {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </CustomSelect>
                            ) : (
                              <span className="font-medium text-slate-800">
                                {line.product_name || '-'}
                                {line.item_type && line.item_type !== 'PRODUCT' && (
                                  <span className={`ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium align-middle ${
                                    line.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'
                                  }`}>
                                    {line.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                                  </span>
                                )}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {isManual ? (
                              <input type="number" step="0.01" min="0" value={line.received_quantity}
                                onChange={e => handleLineChange(idx, 'received_quantity', e.target.value)}
                                className={`${inputClass} text-right`} style={{ minWidth: '80px' }} placeholder="0"
                              />
                            ) : (
                              <span className="block text-right">{line.received_quantity}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-emerald-600">{line.accepted_quantity}</td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" min="0" max={line.received_quantity || undefined}
                              value={line.rejected_quantity}
                              onChange={e => handleLineChange(idx, 'rejected_quantity', e.target.value)}
                              className={`${inputClass} text-red-600 font-medium`} style={{ minWidth: '80px' }}
                            />
                          </td>
                          <td className="px-3 py-2">
                            {isManual ? (
                              <input type="text" value={line.uom} onChange={e => handleLineChange(idx, 'uom', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} placeholder="KG" />
                            ) : (
                              <span>{line.uom}</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <input type="text" value={line.batch_no} onChange={e => handleLineChange(idx, 'batch_no', e.target.value)} className={inputClass} style={{ minWidth: '80px' }} />
                          </td>
                          <td className="px-3 py-2">
                            {isManual ? (
                              <input type="number" step="0.01" min="0" value={line.unit_price}
                                onChange={e => handleLineChange(idx, 'unit_price', e.target.value)}
                                className={`${inputClass} text-right`} style={{ minWidth: '90px' }} placeholder="0.00"
                              />
                            ) : (
                              <span className="block text-right">{price > 0 ? formatCurrency(price) : '-'}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-red-600">{value > 0 ? formatCurrency(value) : '-'}</td>
                          <td className="px-3 py-2">
                            <CustomSelect value={line.rejection_reason} onChange={e => handleLineChange(idx, 'rejection_reason', e.target.value)} className={inputClass} style={{ minWidth: '120px' }}>
                              {REASON_CHOICES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </CustomSelect>
                          </td>
                          <td className="px-3 py-2">
                            <input type="text" value={line.remarks} onChange={e => handleLineChange(idx, 'remarks', e.target.value)} className={inputClass} style={{ minWidth: '100px' }} placeholder="Notes..." />
                          </td>
                          <td className="px-3 py-2">
                            <button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30"><Trash2 size={16} /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 font-semibold border-t-2">
                      <td colSpan="8" className="px-3 py-2 text-right">Total Rejected Value:</td>
                      <td className="px-3 py-2 text-right text-red-700">₹{totalRejectedValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                      <td colSpan="3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* Return Details */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Return & Action</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {!isHidden('return_to_vendor') && (
              <div className="flex items-center gap-3 pt-5">
                <input type="checkbox" name="return_to_vendor" checked={formData.return_to_vendor} onChange={handleChange} disabled={isReadOnly('return_to_vendor')} className="rounded border-slate-300 text-primary-600" />
                <label className="text-sm font-medium text-slate-700">Return to Vendor</label>
              </div>
              )}
              {formData.return_to_vendor && (
                <>
                  {!isHidden('return_type') && (
                  <div>
                    <label className={labelClass}>Return Type</label>
                    <CustomSelect name="return_type" value={formData.return_type} onChange={handleChange} disabled={isReadOnly('return_type')} className={isReadOnly('return_type') ? lockedInputClass : inputClass}>
                      <option value="">Select</option>
                      {RETURN_TYPE_CHOICES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </CustomSelect>
                  </div>
                  )}
                  {!isHidden('return_date') && (
                  <div>
                    <label className={labelClass}>Return Date</label>
                    <CustomDatePicker name="return_date" value={formData.return_date} onChange={handleChange} disabled={isReadOnly('return_date')} className={isReadOnly('return_date') ? lockedInputClass : inputClass} />
                  </div>
                  )}
                  {!isHidden('replacement_expected_date') && (
                  <div>
                    <label className={labelClass}>Replacement Expected Date</label>
                    <CustomDatePicker name="replacement_expected_date" value={formData.replacement_expected_date} onChange={handleChange} disabled={isReadOnly('replacement_expected_date')} className={isReadOnly('replacement_expected_date') ? lockedInputClass : inputClass} />
                  </div>
                  )}
                </>
              )}
              {!isHidden('debit_note_required') && (
              <div className="flex items-center gap-3 pt-5">
                <input type="checkbox" name="debit_note_required" checked={formData.debit_note_required} onChange={handleChange} disabled={isReadOnly('debit_note_required')} className="rounded border-slate-300 text-primary-600" />
                <label className="text-sm font-medium text-slate-700">Debit Note Required</label>
              </div>
              )}
            </div>
          </div>

          {/* Description & Remarks */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional Information</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              {!isHidden('description') && (
              <div>
                <label className={labelClass}>Description</label>
                <textarea name="description" value={formData.description} onChange={handleChange} rows={3} disabled={isReadOnly('description')} className={isReadOnly('description') ? lockedInputClass : inputClass} placeholder="Reason for rejection..." />
              </div>
              )}
              {!isHidden('remarks') && (
              <div>
                <label className={labelClass}>Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} disabled={isReadOnly('remarks')} className={isReadOnly('remarks') ? lockedInputClass : inputClass} placeholder="Additional notes..." />
              </div>
              )}
            </div>
          </div>

          <FileAttachments module="REJECTION" recordId={null} onPendingChange={(files) => { pendingAttachmentsRef.current = files; setPendingAttachments(files); }} />

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
              {isLoading ? 'Saving...' : 'Create Rejection'}
            </button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
