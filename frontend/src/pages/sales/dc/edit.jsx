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
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import { SALES_UOM_OPTIONS } from '../utils/uomOptions';
import { formatCurrency } from '@/utils/formatters';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const errorInputClass = 'w-full border border-red-400 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500';
const lockedInputClass = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-100 text-slate-600 cursor-not-allowed';

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

const emptyDCLine = {
  product_category: '', product: '', quantity_dispatched: '', uom: 'KG',
  batch: '', warehouse: '', godown: '', noa: '', weight: '', linked_so_line: null, so_qty: '', balance_qty: '',
};

export default function EditDispatchChallan() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit } = usePermissions();
  const editable = canEdit('Dispatch Challan');
  const { options: transporterOptions } = useLookup('/api/transporters/');
  const { options: productOptions, raw: rawProducts } = useLookup('/api/products/');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [errors, setErrors] = useState({});

  const [formData, setFormData] = useState({
    dc_no: '',
    selected_so: '',
    warehouse: '',
    company_name: '',
    customer_name: '',
    freight_terms: 'TO_PAY',
    payment_terms: 'NET_15',
    currency: 'INR',
    transporter: '',
    lorry_no: '',
    driver_contact: '',
    destination: '',
    freight_rate_value: '',
  });
  const [dcLines, setDcLines] = useState([{ ...emptyDCLine }]);
  const [linkedSONo, setLinkedSONo] = useState('');
  const [warehouseName, setWarehouseName] = useState('');

  const hasSO = !!linkedSONo;

  // Warehouse + godown are per-line (a DC can span several warehouses). Fetch
  // all warehouses + godowns once and filter the godown list per line.
  const { options: warehouseOptions } = useLookup('/api/warehouses/');
  const { raw: rawGodowns } = useLookup('/api/godowns/');
  const godownsForWarehouse = (whId) =>
    (rawGodowns || [])
      .filter(g => whId && String(g.warehouse) === String(whId))
      .map(g => ({ value: g.id, label: g.godown_name || g.godown_code || g.id }));

  useEffect(() => {
    const fetchDC = async () => {
      setIsLoading(true);
      try {
        const res = await apiClient.get(`/api/sales/dc/${id}/`);
        const d = res.data;
        setFormData({
          dc_no: d.dc_no || '',
          selected_so: d.linked_so || '',
          warehouse: d.warehouse || '',
          company_name: d.company_name || '',
          customer_name: d.customer_name || '',
          freight_terms: d.freight_terms || 'TO_PAY',
          payment_terms: d.payment_terms || 'NET_15',
          currency: d.currency || 'INR',
          transporter: d.transporter || '',
          lorry_no: d.lorry_no || '',
          driver_contact: d.driver_contact || '',
          destination: d.destination || '',
          freight_rate_value: d.freight_rate_value || '',
        });
        setLinkedSONo(d.linked_so_no || '');
        setWarehouseName(d.warehouse_name || '');

        // Map DC lines with SO info
        const lines = (d.dc_lines || []).map(l => {
          const currentDispatch = parseFloat(l.quantity_dispatched) || 0;
          const pendingFromSO = parseFloat(l.pending_qty) || 0;
          const totalBalance = currentDispatch + pendingFromSO;
          const soQty = parseFloat(l.quantity_ordered) || 0;

          return {
            product_category: l.product_category || '',
            product: l.product || '',
            quantity_dispatched: l.quantity_dispatched || '',
            uom: l.uom || 'KG',
            batch: l.batch || '',
            warehouse: l.warehouse || d.warehouse || '',
            godown: l.godown || '',
            noa: l.noa || '',
            weight: l.weight || '',
            linked_so_line: l.linked_so_line || null,
            so_qty: soQty > 0 ? String(soQty) : '',
            balance_qty: totalBalance > 0 ? String(totalBalance) : '',
            product_name: l.product_name || '',
            product_sku: l.product_sku || '',
          };
        });
        setDcLines(lines.length > 0 ? lines : [{ ...emptyDCLine }]);
      } catch {
        toast.error('Failed to load Dispatch Challan');
        navigate('/sales/dc');
      } finally {
        setIsLoading(false);
      }
    };
    fetchDC();
  }, [id]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    // Block changes to SO-locked fields
    if (hasSO && ['freight_terms', 'payment_terms', 'currency'].includes(name)) return;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: '' }));
  };

  const getFilteredProducts = (category) => {
    if (!category) return productOptions;
    return rawProducts
      .filter(p => p.goods_sub_type === category)
      .map(p => ({ value: p.id, label: p.product_name || p.name || p.sku_code || p.id }));
  };

  const handleLineChange = (index, field, value) => {
    setDcLines(prev => prev.map((line, i) => {
      if (i !== index) return line;
      const isFromSO = !!line.linked_so_line;

      // Block changes to SO-locked fields on SO lines
      if (isFromSO && ['product_category', 'product', 'uom'].includes(field)) return line;

      const newLine = { ...line, [field]: value };

      // Cap quantity to balance for SO lines
      if (isFromSO && field === 'quantity_dispatched' && value) {
        const max = parseFloat(line.balance_qty) || 0;
        if (parseFloat(value) > max) {
          newLine.quantity_dispatched = String(max);
          toast.error(`Quantity capped to balance: ${max}`);
        }
      }

      // Changing a line's warehouse invalidates its godown pick.
      if (field === 'warehouse') {
        newLine.godown = '';
      }
      if (field === 'product_category') {
        newLine.product = ''; newLine.linked_so_line = null;
        newLine.so_qty = ''; newLine.balance_qty = '';
      }
      if (field === 'product' && value && !newLine.product_category) {
        const prod = rawProducts.find(p => p.id === value);
        if (prod?.goods_sub_type) newLine.product_category = prod.goods_sub_type;
      }
      return newLine;
    }));
    if (errors.lines) setErrors(prev => ({ ...prev, lines: '' }));
  };

  const addLine = () => setDcLines(prev => [...prev, { ...emptyDCLine, warehouse: formData.warehouse || '' }]);
  const removeLine = (index) => {
    if (dcLines.length > 1) setDcLines(prev => prev.filter((_, i) => i !== index));
  };

  const totalDispatchQty = dcLines.reduce((s, l) => s + (parseFloat(l.quantity_dispatched) || 0), 0);
  const fmtQty = (v) => {
    const n = Number(v);
    return isNaN(n) || n === 0 ? '' : n.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.warehouse) newErrors.warehouse = 'Warehouse is required';
    const validLines = dcLines.filter(l => l.product && l.quantity_dispatched);
    if (validLines.length === 0) {
      newErrors.lines = 'At least one item with product and dispatch quantity is required';
    } else {
      const lineErrors = {};
      dcLines.forEach((line, i) => {
        const le = {};
        if (line.product && (!line.quantity_dispatched || parseFloat(line.quantity_dispatched) <= 0)) {
          le.qty = 'Dispatch qty must be > 0';
        }
        if (line.product && line.quantity_dispatched && line.balance_qty) {
          if (parseFloat(line.quantity_dispatched) > parseFloat(line.balance_qty)) {
            le.qty = `Cannot exceed SO balance (${fmtQty(line.balance_qty)})`;
          }
        }
        if (!line.product && line.quantity_dispatched) le.product = 'Select a product';
        // Each line needs its own warehouse, then a godown within it — release
        // rejects a DC whose lines are missing a godown.
        if (line.product && !line.warehouse) le.warehouse = 'Warehouse is required';
        if (line.product && !line.godown) le.godown = 'Godown is required';
        if (Object.keys(le).length > 0) lineErrors[i] = le;
      });
      if (Object.keys(lineErrors).length > 0) newErrors.lineErrors = lineErrors;
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) { toast.error('Please fix validation errors.'); return; }
    setIsSaving(true);
    try {
      const validLines = dcLines.filter(l => l.product && l.quantity_dispatched);
      const payload = {
        warehouse: formData.warehouse,
        transporter: formData.transporter || null,
        freight_terms: formData.freight_terms || '',
        payment_terms: formData.payment_terms || '',
        currency: formData.currency || 'INR',
        lorry_no: formData.lorry_no || '',
        driver_contact: formData.driver_contact || '',
        destination: formData.destination || '',
        freight_rate_value: parseFloat(formData.freight_rate_value) || null,
        freight_amount_total: (parseFloat(formData.freight_rate_value) || 0) * totalDispatchQty || null,
        dc_lines: validLines.map(l => ({
          product: l.product,
          quantity_dispatched: l.quantity_dispatched,
          uom: l.uom || 'KG',
          batch: l.batch || '',
          warehouse: l.warehouse || formData.warehouse || null,
          godown: l.godown || null,
          noa: l.noa ? parseInt(l.noa) : null,
          weight: l.weight || null,
          linked_so_line: l.linked_so_line || null,
        })),
      };
      await apiClient.put(`/api/sales/dc/${id}/`, payload);
      toast.success('Dispatch Challan updated!');
      if (pendingAttachments.length > 0) { await uploadPendingFiles('DISPATCH_CHALLAN', id, pendingAttachments); }
      navigate(`/sales/dc/${id}`);
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return <MainLayout><div className="space-y-4">{[1, 2, 3].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;
  }

  return (
    <MainLayout>
      <PageHeader
        title={`Edit DC - ${formData.dc_no}`}
        breadcrumbs={[
          { label: 'Sales', path: '/sales' },
          { label: 'Dispatch Challans', path: '/sales/dc' },
          { label: formData.dc_no, path: `/sales/dc/${id}` },
          { label: 'Edit' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <form onSubmit={handleSubmit} noValidate>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Dispatch Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Dispatch Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Sales Order</label>
                <input type="text" value={linkedSONo || 'No linked SO'} readOnly className={lockedInputClass} />
                {linkedSONo && (
                  <p className="text-xs text-green-600 mt-1">Customer: {formData.customer_name}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
                <input type="text" value={formData.company_name} readOnly className={hasSO ? lockedInputClass : `${inputClass} bg-slate-50`} placeholder="Auto-filled from SO" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer</label>
                <input type="text" value={formData.customer_name} readOnly className={hasSO ? lockedInputClass : `${inputClass} bg-slate-50`} placeholder="Auto-filled from SO" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Default Warehouse <span className="text-red-500">*</span></label>
                {hasSO ? (
                  <input type="text" value={warehouseName} readOnly className={lockedInputClass} />
                ) : (
                  <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleChange} className={`${errors.warehouse ? errorInputClass : inputClass}`}>
                    <option value="">Select Warehouse</option>
                    {warehouseOptions.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </CustomSelect>
                )}
                <p className="text-xs text-slate-400 mt-1">Each item can dispatch from its own warehouse &amp; godown — set per line below.</p>
                {errors.warehouse && <p className="text-xs text-red-500 mt-1">{errors.warehouse}</p>}
              </div>
            </div>
          </div>

          {/* Terms & Currency */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Terms & Currency</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Terms</label>
                {hasSO ? (
                  <input type="text" value={formData.freight_terms === 'TO_PAY' ? 'To Pay' : formData.freight_terms === 'PAID' ? 'Paid' : formData.freight_terms} readOnly className={lockedInputClass} />
                ) : (
                  <CustomSelect name="freight_terms" value={formData.freight_terms} onChange={handleChange} className={inputClass}>
                    <option value="">Select</option><option value="PAID">Paid</option><option value="TO_PAY">To Pay</option>
                  </CustomSelect>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms</label>
                {hasSO ? (
                  <input type="text" value={formData.payment_terms === 'NET_15' ? 'Net 15' : formData.payment_terms === 'NET_30' ? 'Net 30' : formData.payment_terms === 'NET_45' ? 'Net 45' : formData.payment_terms} readOnly className={lockedInputClass} />
                ) : (
                  <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} className={inputClass}>
                    <option value="">Select</option><option value="NET_15">Net 15</option><option value="NET_30">Net 30</option><option value="NET_45">Net 45</option>
                  </CustomSelect>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Currency</label>
                {hasSO ? (
                  <input type="text" value={formData.currency} readOnly className={lockedInputClass} />
                ) : (
                  <CustomSelect name="currency" value={formData.currency} onChange={handleChange} className={inputClass}>
                    <option value="INR">INR</option><option value="USD">USD</option>
                  </CustomSelect>
                )}
              </div>
            </div>
          </div>

          {/* Transport Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Transport Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Transporter</label>
                <CustomSelect name="transporter" value={formData.transporter} onChange={handleChange} className={inputClass}>
                  <option value="">Select Transporter</option>
                  {transporterOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Lorry / Vehicle No</label>
                <input type="text" name="lorry_no" value={formData.lorry_no} onChange={handleChange} className={inputClass} placeholder="e.g. TN 01 AB 1234" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Driver Contact</label>
                <input type="text" name="driver_contact" value={formData.driver_contact} onChange={handleChange} className={inputClass} placeholder="Driver phone number" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Destination</label>
                <input type="text" name="destination" value={formData.destination} readOnly className={hasSO ? lockedInputClass : `${inputClass} bg-slate-50 text-slate-600`} />
                {hasSO && <p className="text-xs text-slate-400 mt-0.5">Locked from Sales Order</p>}
              </div>
            </div>
          </div>

          {/* Freight Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Freight Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Rate (Per Unit)</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-400 text-sm">₹</span>
                  <input type="number" step="0.01" min="0" name="freight_rate_value" value={formData.freight_rate_value}
                    onChange={handleChange} className={inputClass + ' pl-7'} placeholder="0.00" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Total Dispatch Qty</label>
                <input type="text" value={totalDispatchQty.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} readOnly
                  className={`${inputClass} bg-slate-50 text-slate-600`} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Amount</label>
                <input type="text" value={formatCurrency((parseFloat(formData.freight_rate_value) || 0) * totalDispatchQty)} readOnly
                  className={`${inputClass} bg-emerald-50 text-emerald-700 font-semibold`} />
              </div>
            </div>
          </div>

          {/* Dispatch Items */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Dispatch Items</h3>
              {!hasSO && (
                <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                  <Plus size={16} /> Add Item
                </button>
              )}
            </div>
            {errors.lines && (
              <div className="mb-3 p-3 bg-red-50 rounded-lg text-sm text-red-700">{errors.lines}</div>
            )}
            {linkedSONo && (
              <div className="mb-3 p-3 bg-blue-50 rounded-lg text-sm text-blue-800">
                SO {linkedSONo} linked. Product, Category and UOM are locked. Dispatch quantity cannot exceed SO balance.
              </div>
            )}
            {/* Mobile-only stacked editor for DC lines. Same shape as
                DC new; SO-linked lines lock product/category/UOM. */}
            <div className="sm:hidden space-y-3">
              {dcLines.map((line, index) => {
                const le = errors.lineErrors?.[index] || {};
                const isFromSO = !!line.linked_so_line;
                return (
                  <div key={index} className="border border-slate-200 rounded-lg p-3 space-y-2 bg-white">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Line #{index + 1}</span>
                      {!hasSO && (
                        <button type="button" onClick={() => removeLine(index)} disabled={dcLines.length <= 1} className="inline-flex items-center gap-1 text-red-500 disabled:opacity-30 text-xs">
                          <Trash2 size={14} /> Remove
                        </button>
                      )}
                    </div>
                    {isFromSO ? (
                      <div className="bg-slate-100 rounded p-2">
                        <p className="text-[10px] uppercase tracking-wide text-slate-500">Product</p>
                        <p className="font-medium text-slate-800 break-words">{line.product_name}</p>
                        {line.product_sku && <p className="text-[11px] text-slate-500">{line.product_sku}</p>}
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Category</label>
                          <CustomSelect value={line.product_category || ''} onChange={(e) => handleLineChange(index, 'product_category', e.target.value)} className={`${inputClass} w-full`}>
                            {GOODS_SUB_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                        </div>
                        <div>
                          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Product <span className="text-red-500">*</span></label>
                          <CustomSelect value={line.product} onChange={(e) => handleLineChange(index, 'product', e.target.value)} disabled={!line.product_category} className={`${le.product ? errorInputClass : inputClass} disabled:bg-slate-100 w-full`}>
                            <option value="">{line.product_category ? 'Select Product' : 'Select Category first'}</option>
                            {getFilteredProducts(line.product_category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                          {le.product && <p className="text-xs text-red-500 mt-0.5">{le.product}</p>}
                        </div>
                      </>
                    )}
                    {(line.so_qty != null || line.balance_qty != null) && (
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        {line.so_qty != null && (
                          <div>
                            <span className="text-slate-400 uppercase tracking-wide text-[10px]">SO Qty</span>
                            <p className="text-slate-700">{fmtQty(line.so_qty)}</p>
                          </div>
                        )}
                        {line.balance_qty != null && (
                          <div>
                            <span className="text-slate-400 uppercase tracking-wide text-[10px]">Balance</span>
                            <p className="text-orange-600 font-medium">{fmtQty(line.balance_qty)}</p>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-blue-700 mb-0.5">Dispatch <span className="text-red-500">*</span></label>
                        <input type="number" step="0.001" min="0.001" max={line.balance_qty || undefined} value={line.quantity_dispatched} onChange={(e) => handleLineChange(index, 'quantity_dispatched', e.target.value)} className={`${le.qty ? errorInputClass : `${inputClass} border-blue-300`} w-full text-right`} placeholder={line.balance_qty ? `Max ${fmtQty(line.balance_qty)}` : '0'} />
                        {le.qty && <p className="text-xs text-red-500 mt-0.5">{le.qty}</p>}
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">UOM</label>
                        {isFromSO ? (
                          <div className="bg-slate-100 px-3 py-2 rounded text-sm text-slate-700">{line.uom}</div>
                        ) : (
                          <CustomSelect value={line.uom} onChange={(e) => handleLineChange(index, 'uom', e.target.value)} className={`${inputClass} w-full`}>
                            {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                          </CustomSelect>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Warehouse <span className="text-red-500">*</span></label>
                        <CustomSelect value={line.warehouse || ''} onChange={(e) => handleLineChange(index, 'warehouse', e.target.value)} className={`${le.warehouse ? errorInputClass : inputClass} w-full`}>
                          <option value="">Select Warehouse</option>
                          {warehouseOptions.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                        </CustomSelect>
                        {le.warehouse && <p className="text-xs text-red-500 mt-0.5">{le.warehouse}</p>}
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Godown <span className="text-red-500">*</span></label>
                        <CustomSelect value={line.godown || ''} onChange={(e) => handleLineChange(index, 'godown', e.target.value)} disabled={!line.warehouse} className={`${le.godown ? errorInputClass : inputClass} disabled:bg-slate-100 w-full`}>
                          <option value="">{line.warehouse ? 'Select Godown' : 'Pick warehouse first'}</option>
                          {godownsForWarehouse(line.warehouse).map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                        </CustomSelect>
                        {le.godown && <p className="text-xs text-red-500 mt-0.5">{le.godown}</p>}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Batch</label>
                        <input type="text" value={line.batch} onChange={(e) => handleLineChange(index, 'batch', e.target.value)} className={`${inputClass} w-full`} placeholder="Batch" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">NOA</label>
                        <input type="number" step="1" min="0" value={line.noa} onChange={(e) => handleLineChange(index, 'noa', e.target.value)} className={`${inputClass} w-full text-right`} placeholder="0" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Weight</label>
                        <input type="number" step="0.01" min="0" value={line.weight} onChange={(e) => handleLineChange(index, 'weight', e.target.value)} className={`${inputClass} w-full text-right`} placeholder="0" />
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex justify-between text-sm">
                <span className="text-slate-700 font-semibold">Total Dispatch Qty</span>
                <span className="text-base font-bold text-blue-700">{fmtQty(totalDispatchQty) || '0.00'}</span>
              </div>
            </div>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Category</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">SO Qty</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600 text-orange-600">Balance to Dispatch</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600 text-blue-700">Qty to Dispatch <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Warehouse <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Godown <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Batch</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">NOA</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Weight</th>
                    {!hasSO && <th className="px-3 py-2"></th>}
                  </tr>
                </thead>
                <tbody>
                  {dcLines.map((line, index) => {
                    const le = errors.lineErrors?.[index] || {};
                    const isFromSO = !!line.linked_so_line;
                    return (
                      <tr key={index} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                        <td className="px-3 py-2">
                          {isFromSO ? (
                            <span className="text-xs text-slate-600 bg-slate-100 px-2 py-1 rounded">
                              {GOODS_SUB_TYPE_OPTIONS.find(o => o.value === line.product_category)?.label || line.product_category || '-'}
                            </span>
                          ) : (
                            <CustomSelect value={line.product_category || ''} onChange={(e) => handleLineChange(index, 'product_category', e.target.value)} className={inputClass} style={{ minWidth: '130px' }}>
                              {GOODS_SUB_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </CustomSelect>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {isFromSO ? (
                            <div className="bg-slate-100 px-2 py-1 rounded">
                              <p className="font-medium text-slate-800">{line.product_name}</p>
                              <p className="text-xs text-slate-400">{line.product_sku}</p>
                            </div>
                          ) : (
                            <>
                              <CustomSelect value={line.product} onChange={(e) => handleLineChange(index, 'product', e.target.value)} disabled={!line.product_category} className={`${le.product ? errorInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`} style={{ minWidth: '170px' }}>
                                <option value="">{line.product_category ? 'Select Product' : 'Select Category first'}</option>
                                {getFilteredProducts(line.product_category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </CustomSelect>
                              {le.product && <p className="text-xs text-red-500 mt-0.5">{le.product}</p>}
                            </>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-500 font-medium">
                          {line.so_qty ? fmtQty(line.so_qty) : '-'}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-orange-600">
                          {line.balance_qty ? fmtQty(line.balance_qty) : '-'}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number" step="0.001" min="0.001"
                            max={line.balance_qty || undefined}
                            value={line.quantity_dispatched}
                            onChange={(e) => handleLineChange(index, 'quantity_dispatched', e.target.value)}
                            className={le.qty ? errorInputClass : `${inputClass} border-blue-300 focus:ring-blue-500`}
                            style={{ minWidth: '110px' }}
                            placeholder={line.balance_qty ? `Max ${fmtQty(line.balance_qty)}` : '0'}
                          />
                          {isFromSO && line.balance_qty && (
                            <p className="text-xs text-slate-400 mt-0.5">Max: {fmtQty(line.balance_qty)}</p>
                          )}
                          {le.qty && <p className="text-xs text-red-500 mt-0.5">{le.qty}</p>}
                        </td>
                        <td className="px-3 py-2">
                          {isFromSO ? (
                            <span className="text-xs text-slate-600 bg-slate-100 px-2 py-1 rounded">{line.uom}</span>
                          ) : (
                            <CustomSelect value={line.uom} onChange={(e) => handleLineChange(index, 'uom', e.target.value)} className={inputClass} style={{ minWidth: '70px' }}>
                              {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                            </CustomSelect>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <CustomSelect
                            value={line.warehouse || ''}
                            onChange={(e) => handleLineChange(index, 'warehouse', e.target.value)}
                            className={`${le.warehouse ? errorInputClass : inputClass}`}
                            style={{ minWidth: '150px' }}
                          >
                            <option value="">Select Warehouse</option>
                            {warehouseOptions.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                          </CustomSelect>
                          {le.warehouse && <p className="text-xs text-red-500 mt-0.5">{le.warehouse}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <CustomSelect
                            value={line.godown || ''}
                            onChange={(e) => handleLineChange(index, 'godown', e.target.value)}
                            disabled={!line.warehouse}
                            className={`${le.godown ? errorInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}
                            style={{ minWidth: '140px' }}
                          >
                            <option value="">{line.warehouse ? 'Select Godown' : 'Pick warehouse first'}</option>
                            {godownsForWarehouse(line.warehouse).map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                          </CustomSelect>
                          {le.godown && <p className="text-xs text-red-500 mt-0.5">{le.godown}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <input type="text" value={line.batch} onChange={(e) => handleLineChange(index, 'batch', e.target.value)} className={inputClass} style={{ minWidth: '90px' }} placeholder="Batch" />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="1" min="0" value={line.noa} onChange={(e) => handleLineChange(index, 'noa', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} placeholder="0" />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.01" min="0" value={line.weight} onChange={(e) => handleLineChange(index, 'weight', e.target.value)} className={inputClass} style={{ minWidth: '70px' }} placeholder="0" />
                        </td>
                        {!hasSO && (
                          <td className="px-3 py-2">
                            <button type="button" onClick={() => removeLine(index)} disabled={dcLines.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30">
                              <Trash2 size={16} />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-semibold border-t-2 border-slate-300">
                    <td colSpan="5" className="px-3 py-2 text-right text-slate-600">Total Dispatch Qty:</td>
                    <td className="px-3 py-2 text-right text-blue-700">{fmtQty(totalDispatchQty) || '0.00'}</td>
                    <td colSpan={hasSO ? 6 : 7}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <FileAttachments module="DISPATCH_CHALLAN" recordId={id} deferUpload onPendingChange={setPendingAttachments} />

          {/* Actions */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button type="button" onClick={() => navigate(`/sales/dc/${id}`)} className="w-full sm:w-auto px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isSaving} className="w-full sm:w-auto px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Update Dispatch Challan'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
