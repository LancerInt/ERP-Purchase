import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useApiData from '../../../hooks/useApiData.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const inputDisabled = 'disabled:bg-slate-100 disabled:cursor-not-allowed';
// Visual lock for a field set READ_ONLY by field permissions.
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

const emptyLine = { category: '', product: '', batch: '', uom: '', quantity: '', available_stock: '' };

// Product categories = goods sub-type (same as the Movement Request). Pick a
// category → the Product dropdown narrows to it.
const CATEGORY_CHOICES = [
  { value: 'RAW_MATERIAL', label: 'Raw Material' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'FINISHED_GOOD', label: 'Finished Good' },
  { value: 'SEMI_FINISHED', label: 'Semi Finished' },
];

export default function CreateTransfer() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Stock Transfer');
  const { isHidden, isReadOnly } = useFieldPermissions('Stock Transfer');
  // Line-item column field permissions (Line Items table is its own module).
  const { isHidden: isLineHidden, isReadOnly: isLineRO } = useFieldPermissions('Stock Transfer Line');
  const todayIso = new Date().toISOString().split('T')[0];
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: transporters } = useLookup('/api/transporters/');
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    company: '',
    transfer_date: todayIso,
    from_warehouse: '',
    from_godown: '',
    to_warehouse: '',
    to_godown: '',
    transporter: '',
    vehicle_no: '',
    remarks: '',
    dispatch_date: '',
    loading_wages: '',
    freight_amount: '',
    freight_terms: '',
  });
  const [lines, setLines] = useState([{ ...emptyLine }]);
  // Batches that hold stock per source+product, keyed
  // `${from_warehouse}|${from_godown}|${product}`. Feeds the Batch picker so
  // operators choose a batch that actually has stock instead of typing one.
  const [lineBatches, setLineBatches] = useState({});

  // Approved Stock Movement Requests (transfer-type, not yet converted) — the
  // operator picks one at the top and the form auto-fills from it.
  const { data: approvedRequests } = useApiData('/api/inventory/movement-requests/?status=APPROVED&movement_type=TRANSFER');
  const [selectedRequestId, setSelectedRequestId] = useState('');

  const applyRequest = (reqId) => {
    setSelectedRequestId(reqId);
    if (!reqId) return;
    const r = (approvedRequests || []).find(x => String(x.id) === String(reqId));
    if (!r) return;
    setFormData(prev => ({
      ...prev,
      company: r.company || prev.company,
      from_warehouse: r.from_warehouse || '',
      from_godown: r.from_godown || '',
      to_warehouse: r.to_warehouse || '',
      to_godown: r.to_godown || '',
      transporter: r.transporter || '',
      vehicle_no: r.vehicle_no || '',
      loading_wages: r.coolie_wage || '',
      freight_amount: r.lorry_rent || '',
      remarks: r.remarks || '',
    }));
    setLines((r.products && r.products.length)
      ? r.products.map(p => ({ category: p.category || '', product: p.product, batch: p.batch || '', uom: p.uom || '', quantity: String(p.quantity ?? ''), available_stock: '' }))
      : [{ ...emptyLine }]);
  };

  const { options: warehouses } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}` : null
  );
  // To Warehouse can be ANY active warehouse, not just one owned by
  // the From-side company — operators routinely transfer stock across
  // companies (e.g. UAI/NKP → SSB/TVP). Filtering by company here
  // used to hide every option whenever the From-side company owned
  // only one warehouse. Label includes the company name so users can
  // tell same-name warehouses apart (TVP exists under both SSB and
  // BTP, for example).
  const { options: allWarehouseOptions } = useLookup('/api/warehouses/', {
    labelField: (w) => `${w.name || w.warehouse_code || ''}${w.company_name ? ` — ${w.company_name}` : ''}`,
  });
  const { options: fromGodownOptions } = useLookup(
    formData.from_warehouse ? `/api/godowns/?warehouse=${formData.from_warehouse}` : null
  );
  const { options: toGodownOptions } = useLookup(
    formData.to_warehouse ? `/api/godowns/?warehouse=${formData.to_warehouse}` : null
  );

  const selectedFromWarehouseName = (warehouses.find(w => w.value === formData.from_warehouse) || {}).label || '';
  // Products come from the shared item catalogue (masters) — the same feed the
  // Movement Request uses. It's open to any authenticated user (unlike
  // /api/products/, which is gated by the Product module), returns each item's
  // category (goods sub-type) for the Category filter and a live current_stock,
  // and always reflects the current Product master.
  const catalogEndpoint = formData.from_warehouse
    ? (formData.from_godown
        ? `/api/purchase/items/?warehouse=${formData.from_warehouse}&godown=${formData.from_godown}`
        : `/api/purchase/items/?warehouse=${formData.from_warehouse}`)
    : '/api/purchase/items/';
  const { raw: catalogItems } = useLookup(catalogEndpoint);
  const norm = (v) => (v || '').toString().trim().toUpperCase().replace(/[\s-]+/g, '_');
  const productItems = (catalogItems || []).filter(it => it.item_type === 'PRODUCT');
  const productOptionsFor = (category) => productItems
    .filter(it => !category || norm(it.category) === norm(category))
    .map(it => ({ value: it.item_id, label: it.label || it.item_name }))
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const updateLine = (idx, field, value) => {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };

  // Category → clear the product (re-pick within the new category).
  const onCategoryChange = (idx, category) => setLines(prev => prev.map((l, i) => i === idx ? { ...l, category, product: '', uom: '', available_stock: '' } : l));

  // Auto-set UOM when a product is picked. The Category is NOT changed here —
  // for a normal transfer it stays whatever the operator picked as the filter;
  // it's only pre-set when loading from a Movement Request (see applyRequest).
  const onProductChange = (idx, productId) => {
    const it = productItems.find(x => String(x.item_id) === String(productId));
    setLines(prev => prev.map((l, i) => i === idx ? {
      ...l,
      product: productId,
      uom: it?.uom || l.uom || '',
      available_stock: '',
    } : l));
  };

  // Fetch available stock for a line whenever (from_warehouse, from_godown,
  // product, batch) changes. Server endpoint: /api/inventory/stock-ledger/stock-balance/.
  useEffect(() => {
    const wh = formData.from_warehouse;
    const gd = formData.from_godown;
    if (!wh) return;
    lines.forEach((l, idx) => {
      if (!l.product) return;
      const params = new URLSearchParams({ warehouse: wh, product: l.product });
      if (gd) params.set('godown', gd);
      // Always send batch (even empty) so the server filters by batch='' for
      // non-batch products instead of summing across all batches.
      params.set('batch', l.batch || '');
      apiClient.get(`/api/inventory/stock-ledger/stock-balance/?${params.toString()}`)
        .then(res => {
          const balance = res.data?.balance ?? '0';
          setLines(prev => prev.map((row, i) => (
            i === idx && row.product === l.product && (row.batch || '') === (l.batch || '')
              ? { ...row, available_stock: balance }
              : row
          )));
        })
        .catch((err) => {
          // Surface the failure so we don't sit on a blank field forever.
          console.error('[stock-balance]', err?.response?.status, err?.response?.data || err.message);
          setLines(prev => prev.map((row, i) => (
            i === idx && row.product === l.product && (row.batch || '') === (l.batch || '')
              ? { ...row, available_stock: 'ERR' }
              : row
          )));
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    formData.from_warehouse,
    formData.from_godown,
    // Re-fetch when any line's product or batch changes; key on a stable string.
    lines.map(l => `${l.product}|${l.batch}`).join(','),
  ]);

  // Source key for a product's batch list: warehouse + godown + product.
  const batchKeyFor = (productId) => `${formData.from_warehouse || ''}|${formData.from_godown || ''}|${productId || ''}`;

  // Fetch the batches that actually hold stock for each line's product at the
  // chosen source, so the Batch field is a picker (not a free-text guess that
  // reads as "available 0"). Auto-picks when a product has exactly one batch
  // with stock — the common single-batch finished-good case.
  useEffect(() => {
    const wh = formData.from_warehouse;
    const gd = formData.from_godown;
    if (!wh) return;
    const wanted = new Set(lines.filter(l => l.product).map(l => batchKeyFor(l.product)));
    wanted.forEach(key => {
      if (lineBatches[key] !== undefined) return; // already fetched for this source+product
      const productId = key.split('|')[2];
      const params = new URLSearchParams({ warehouse: wh, product: productId });
      if (gd) params.set('godown', gd);
      apiClient.get(`/api/inventory/stock-ledger/stock-batches/?${params.toString()}`)
        .then(res => {
          const batches = res.data?.batches || [];
          setLineBatches(prev => ({ ...prev, [key]: batches }));
          if (batches.length === 1) {
            setLines(prev => prev.map(row => (
              batchKeyFor(row.product) === key && !row.batch
                ? { ...row, batch: batches[0].batch }
                : row
            )));
          }
        })
        .catch(() => setLineBatches(prev => ({ ...prev, [key]: [] })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.from_warehouse, formData.from_godown, lines.map(l => l.product).join(',')]);

  const addLine = () => setLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => setLines(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  const sameWarehouse = !!formData.from_warehouse && formData.from_warehouse === formData.to_warehouse;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (sameWarehouse) {
      toast.error('From Warehouse and To Warehouse cannot be the same. Use the Shifting module for godown-to-godown movement.');
      return;
    }
    const payloadLines = lines
      .filter(l => l.product && l.quantity && parseFloat(l.quantity) > 0)
      .map(l => ({
        product: l.product,
        batch: l.batch || '',
        uom: l.uom || '',
        quantity: l.quantity,
      }));
    if (payloadLines.length === 0) {
      toast.error('Add at least one line item with a product and quantity.');
      return;
    }

    setIsLoading(true);
    try {
      const payload = {
        ...cleanFormData(formData),
        lines: payloadLines,
      };
      const res = await apiClient.post('/api/inventory/transfers/', payload);
      // If this transfer fulfils an approved Stock Movement Request, mark that
      // request Converted (non-fatal if it fails).
      if (selectedRequestId) {
        try {
          await apiClient.post(`/api/inventory/movement-requests/${selectedRequestId}/convert/`, { transfer_id: res.data?.id });
        } catch { /* ignore — the transfer itself was created */ }
      }
      toast.success('Transfer created successfully!');
      navigate('/inventory/transfers');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Transfer"
        breadcrumbs={[
          { label: 'Inventory', path: '/inventory' },
          { label: 'Transfers', path: '/inventory/transfers' },
          { label: 'New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          {/* Load an approved Movement Request → auto-fill this transfer */}
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4">
            <label className="block text-sm font-semibold text-slate-800 mb-1">Load from Movement Request</label>
            <CustomSelect value={selectedRequestId} onChange={(e) => applyRequest(e.target.value)} className={inputClass} style={{ maxWidth: '560px' }}>
              <option value="">— Select an approved request —</option>
              {(approvedRequests || []).map(r => (
                <option key={r.id} value={r.id}>
                  {r.request_no} — {r.from_warehouse_name} → {r.to_warehouse_name} ({Number(r.total_qty || 0).toLocaleString('en-IN')})
                </option>
              ))}
            </CustomSelect>
            <p className="text-xs text-slate-500 mt-1">
              {(approvedRequests || []).length === 0
                ? 'No approved Transfer requests yet — raise a Transfer-type Movement Request and approve it first.'
                : 'Pick an approved request to auto-fill the transfer, then Save.'}
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Transfer Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {!isHidden('company') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={formData.company}
                  onChange={(e) => setFormData(prev => ({ ...prev, company: e.target.value, from_warehouse: '', from_godown: '', to_warehouse: '', to_godown: '' }))}
                  required
                  disabled={isReadOnly('company')}
                  className={isReadOnly('company') ? lockedInputClass : inputClass}
                >
                  <option value="">Select Company</option>
                  {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('transfer_date') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Transfer Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="transfer_date" value={formData.transfer_date} onChange={handleChange} required disabled={isReadOnly('transfer_date')} className={isReadOnly('transfer_date') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('from_warehouse') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">From Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect name="from_warehouse" value={formData.from_warehouse} onChange={(e) => setFormData(prev => ({ ...prev, from_warehouse: e.target.value, from_godown: '' }))} required disabled={!formData.company || isReadOnly('from_warehouse')} className={`${isReadOnly('from_warehouse') ? lockedInputClass : inputClass} ${inputDisabled}`}>
                  <option value="">{formData.company ? 'Select Warehouse' : 'Select company first...'}</option>
                  {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('from_godown') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">From Godown <span className="text-red-500">*</span></label>
                <CustomSelect name="from_godown" value={formData.from_godown} onChange={handleChange} required disabled={!formData.from_warehouse || isReadOnly('from_godown')} className={`${isReadOnly('from_godown') ? lockedInputClass : inputClass} ${inputDisabled}`}>
                  <option value="">{formData.from_warehouse ? 'Select Godown' : 'Select warehouse first...'}</option>
                  {fromGodownOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('to_warehouse') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">To Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect
                  name="to_warehouse"
                  value={formData.to_warehouse}
                  onChange={(e) => setFormData(prev => ({ ...prev, to_warehouse: e.target.value, to_godown: '' }))}
                  required
                  disabled={isReadOnly('to_warehouse')}
                  className={`${isReadOnly('to_warehouse') ? lockedInputClass : inputClass} ${sameWarehouse ? 'border-red-400 bg-red-50' : ''}`}
                >
                  <option value="">Select Warehouse</option>
                  {allWarehouseOptions
                    .filter(w => w.value !== formData.from_warehouse)
                    .map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
                {sameWarehouse && (
                  <p className="text-xs text-red-600 mt-1">
                    Cannot match From Warehouse. Use Shifting for godown-to-godown moves within one warehouse.
                  </p>
                )}
              </div>
              )}
              {!isHidden('to_godown') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">To Godown <span className="text-red-500">*</span></label>
                <CustomSelect name="to_godown" value={formData.to_godown} onChange={handleChange} required disabled={!formData.to_warehouse || isReadOnly('to_godown')} className={`${isReadOnly('to_godown') ? lockedInputClass : inputClass} ${inputDisabled}`}>
                  <option value="">{formData.to_warehouse ? 'Select Godown' : 'Select warehouse first...'}</option>
                  {toGodownOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                </CustomSelect>
              </div>
              )}
            </div>
          </div>

          {/* Line Items */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Line Items</h3>
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add Line
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Category</th>
                    {!isLineHidden('product') && <th className="text-left px-3 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>}
                    {!isLineHidden('batch') && <th className="text-left px-3 py-2 font-medium text-slate-600">Batch No</th>}
                    {!isLineHidden('available_stock') && <th className="text-right px-3 py-2 font-medium text-slate-600">Available Stock</th>}
                    {!isLineHidden('uom') && <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>}
                    {!isLineHidden('quantity') && <th className="text-right px-3 py-2 font-medium text-slate-600">Transfer Qty <span className="text-red-500">*</span></th>}
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => {
                    const avail = parseFloat(line.available_stock || 0);
                    const qty = parseFloat(line.quantity || 0);
                    const overdraft = qty > avail && line.product && formData.from_warehouse;
                    return (
                      <tr key={idx} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                        <td className="px-3 py-2">
                          <CustomSelect value={line.category} onChange={(e) => onCategoryChange(idx, e.target.value)} disabled={!formData.from_warehouse} className={`${inputClass} ${inputDisabled}`} style={{ minWidth: '150px' }}>
                            <option value="">All</option>
                            {CATEGORY_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                          </CustomSelect>
                        </td>
                        {!isLineHidden('product') && (
                        <td className="px-3 py-2">
                          <CustomSelect value={line.product} onChange={(e) => onProductChange(idx, e.target.value)} required disabled={isLineRO('product') || !formData.from_warehouse} className={isLineRO('product') ? lockedInputClass : inputClass} style={{ minWidth: '180px' }}>
                            <option value="">{formData.from_warehouse ? 'Select Product' : 'Pick warehouse first…'}</option>
                            {productOptionsFor(line.category).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                          </CustomSelect>
                        </td>
                        )}
                        {!isLineHidden('batch') && (
                        <td className="px-3 py-2">
                          {(() => {
                            const bopts = lineBatches[batchKeyFor(line.product)];
                            // No product chosen yet, or batches still loading → plain input.
                            if (!line.product || bopts === undefined) {
                              return <input type="text" value={line.batch} onChange={(e) => updateLine(idx, 'batch', e.target.value)} placeholder={line.product ? 'Loading…' : 'Select product'} disabled={isLineRO('batch') || !line.product} className={(isLineRO('batch') || !line.product) ? lockedInputClass : inputClass} style={{ minWidth: '120px' }} />;
                            }
                            const hasCurrent = bopts.some(b => (b.batch || '') === (line.batch || ''));
                            return (
                              <CustomSelect value={line.batch} onChange={(e) => updateLine(idx, 'batch', e.target.value)} disabled={isLineRO('batch')} className={isLineRO('batch') ? lockedInputClass : inputClass} style={{ minWidth: '150px' }}>
                                <option value="">{bopts.length ? '-- Select Batch --' : 'No stock in this godown'}</option>
                                {bopts.map(b => <option key={b.batch} value={b.batch}>{(b.batch || '(No batch)') + ` — ${Number(b.balance).toLocaleString('en-IN', { maximumFractionDigits: 4 })}`}</option>)}
                                {line.batch && !hasCurrent ? <option value={line.batch}>{line.batch}</option> : null}
                              </CustomSelect>
                            );
                          })()}
                        </td>
                        )}
                        {!isLineHidden('available_stock') && (
                        <td className="px-3 py-2 text-right">
                          {line.available_stock === 'ERR' ? (
                            <span className="text-red-500 text-xs" title="Failed to fetch — check console">err</span>
                          ) : line.available_stock !== '' ? (
                            <span className="font-medium text-slate-700">
                              {Number(line.available_stock).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        )}
                        {!isLineHidden('uom') && (
                        <td className="px-3 py-2">
                          <input type="text" value={line.uom} onChange={(e) => updateLine(idx, 'uom', e.target.value)} placeholder="UOM" disabled={isLineRO('uom')} className={isLineRO('uom') ? lockedInputClass : inputClass} style={{ minWidth: '80px' }} />
                        </td>
                        )}
                        {!isLineHidden('quantity') && (
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            step="0.0001"
                            min="0"
                            value={line.quantity}
                            onChange={(e) => updateLine(idx, 'quantity', e.target.value)}
                            required
                            disabled={isLineRO('quantity')}
                            className={`${isLineRO('quantity') ? lockedInputClass : inputClass} text-right ${overdraft ? 'border-red-400 bg-red-50' : ''}`}
                            style={{ minWidth: '110px' }}
                          />
                          {overdraft && (
                            <p className="text-xs text-red-600 mt-1">Exceeds available</p>
                          )}
                        </td>
                        )}
                        <td className="px-3 py-2">
                          <button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} aria-label="Remove line" title="Remove line" className="text-red-500 hover:text-red-700 disabled:opacity-30">
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Optional Transport / Costs */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Transport & Costs (optional)</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
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
              {!isHidden('dispatch_date') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Dispatch Date</label>
                <CustomDatePicker name="dispatch_date" value={formData.dispatch_date} onChange={handleChange} disabled={isReadOnly('dispatch_date')} className={isReadOnly('dispatch_date') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('loading_wages') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Loading Wages</label>
                <input type="number" name="loading_wages" value={formData.loading_wages} onChange={handleChange} disabled={isReadOnly('loading_wages')} className={isReadOnly('loading_wages') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('freight_amount') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Amount</label>
                <input type="number" name="freight_amount" value={formData.freight_amount} onChange={handleChange} disabled={isReadOnly('freight_amount')} className={isReadOnly('freight_amount') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('freight_terms') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Terms</label>
                <CustomSelect name="freight_terms" value={formData.freight_terms} onChange={handleChange} disabled={isReadOnly('freight_terms')} className={isReadOnly('freight_terms') ? lockedInputClass : inputClass}>
                  <option value="">Select</option>
                  <option value="TO_PAY">To Pay</option>
                  <option value="PAID">Paid</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('remarks') && (
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} disabled={isReadOnly('remarks')} className={isReadOnly('remarks') ? lockedInputClass : inputClass} />
              </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading || sameWarehouse} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
