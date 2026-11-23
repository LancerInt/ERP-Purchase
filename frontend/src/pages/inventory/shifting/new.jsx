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

export default function CreateShifting() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Shifting');
  const { isHidden, isReadOnly } = useFieldPermissions('Shifting');
  const [selectedCompany, setSelectedCompany] = useState('');
  const { options: companyOptions } = useLookup('/api/companies/');
  const [isLoading, setIsLoading] = useState(false);

  const [formData, setFormData] = useState({
    warehouse: '',
    from_godown: '',
    to_godown: '',
    reason_code: '',
    other_reason: '',
  });
  const [lines, setLines] = useState([{ ...emptyLine }]);

  const { options: warehouses } = useLookup(
    selectedCompany ? `/api/warehouses/?company=${selectedCompany}&scope=true` : null
  );

  // Products come from the shared item catalogue (masters) — the same feed the
  // Movement Request uses. Open to any authenticated user (unlike /api/products/,
  // which is gated by the Product module), returns each item's category (goods
  // sub-type) for the Category filter and a live current_stock; reflects masters.
  const catalogEndpoint = formData.warehouse
    ? (formData.from_godown
        ? `/api/purchase/items/?warehouse=${formData.warehouse}&godown=${formData.from_godown}`
        : `/api/purchase/items/?warehouse=${formData.warehouse}`)
    : '/api/purchase/items/';
  const { raw: catalogItems } = useLookup(catalogEndpoint);
  const norm = (v) => (v || '').toString().trim().toUpperCase().replace(/[\s-]+/g, '_');
  const productItems = (catalogItems || []).filter(it => it.item_type === 'PRODUCT');
  const productOptionsFor = (category) => productItems
    .filter(it => !category || norm(it.category) === norm(category))
    .map(it => ({ value: it.item_id, label: it.label || it.item_name }))
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  const { options: godownOptions } = useLookup(
    formData.warehouse ? `/api/godowns/?warehouse=${formData.warehouse}` : null
  );

  // Approved SHIFTING-type Movement Requests → auto-fill this shifting.
  const { data: approvedRequests } = useApiData('/api/inventory/movement-requests/?status=APPROVED&movement_type=SHIFTING');
  const [selectedRequestId, setSelectedRequestId] = useState('');
  const applyRequest = (reqId) => {
    setSelectedRequestId(reqId);
    if (!reqId) return;
    const r = (approvedRequests || []).find(x => String(x.id) === String(reqId));
    if (!r) return;
    setSelectedCompany(r.company || '');
    setFormData(prev => ({
      ...prev,
      warehouse: r.from_warehouse || '',
      from_godown: r.from_godown || '',
      to_godown: r.to_godown || '',
      // Shifting uses a different reason list, so carry the request's purpose +
      // notes into the free-text reason instead of the coded dropdown.
      reason_code: '',
      other_reason: [r.reason_code ? `Purpose: ${r.reason_code}` : '', r.remarks].filter(Boolean).join(' | '),
    }));
    setLines((r.products && r.products.length)
      ? r.products.map(p => ({ category: p.category || '', product: p.product, batch: p.batch || '', uom: p.uom || '', quantity: String(p.quantity ?? ''), available_stock: '' }))
      : [{ ...emptyLine }]);
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const updateLine = (idx, field, value) => {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };

  // Category → clear product (re-pick within the new category). Normal shifting:
  // picking a product does NOT change the category (it's only a filter);
  // it's pre-set only when loading from a Movement Request (applyRequest).
  const onCategoryChange = (idx, category) => setLines(prev => prev.map((l, i) => i === idx ? { ...l, category, product: '', uom: '', available_stock: '' } : l));

  const onProductChange = (idx, productId) => {
    const it = productItems.find(x => String(x.item_id) === String(productId));
    setLines(prev => prev.map((l, i) => i === idx ? {
      ...l,
      product: productId,
      uom: it?.uom || l.uom || '',
      available_stock: '',
    } : l));
  };

  // Fetch available stock for each line whenever (warehouse, from_godown, product, batch) changes.
  useEffect(() => {
    const wh = formData.warehouse;
    const gd = formData.from_godown;
    if (!wh) return;
    lines.forEach((l, idx) => {
      if (!l.product) return;
      const params = new URLSearchParams({ warehouse: wh, product: l.product });
      if (gd) params.set('godown', gd);
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
    formData.warehouse,
    formData.from_godown,
    lines.map(l => `${l.product}|${l.batch}`).join(','),
  ]);

  const addLine = () => setLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => setLines(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.from_godown && formData.to_godown && formData.from_godown === formData.to_godown) {
      toast.error('From Godown and To Godown cannot be the same.');
      return;
    }
    const payloadProducts = lines
      .filter(l => l.product && l.quantity && parseFloat(l.quantity) > 0)
      .map(l => ({
        product: l.product,
        batch: l.batch || '',
        uom: l.uom || '',
        quantity: l.quantity,
      }));
    if (payloadProducts.length === 0) {
      toast.error('Add at least one line item with a product and quantity.');
      return;
    }

    setIsLoading(true);
    try {
      const payload = {
        ...cleanFormData(formData),
        products: payloadProducts,
      };
      const res = await apiClient.post('/api/inventory/shifting/', payload);
      // If this fulfils an approved Movement Request, mark it Converted.
      if (selectedRequestId) {
        try {
          await apiClient.post(`/api/inventory/movement-requests/${selectedRequestId}/convert/`, { shifting_id: res.data?.id });
        } catch { /* ignore — the shifting itself was created */ }
      }
      toast.success('Shifting created — click Approve from the detail page to move the stock.');
      navigate('/inventory/shifting');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Shifting"
        breadcrumbs={[
          { label: 'Inventory', path: '/inventory' },
          { label: 'Shifting', path: '/inventory/shifting' },
          { label: 'New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          {/* Load an approved Movement Request → auto-fill this shifting */}
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4">
            <label className="block text-sm font-semibold text-slate-800 mb-1">Load from Movement Request</label>
            <CustomSelect value={selectedRequestId} onChange={(e) => applyRequest(e.target.value)} className={inputClass} style={{ maxWidth: '560px' }}>
              <option value="">— Select an approved request —</option>
              {(approvedRequests || []).map(r => (
                <option key={r.id} value={r.id}>
                  {r.request_no} — {r.from_godown_name} → {r.to_godown_name} ({Number(r.total_qty || 0).toLocaleString('en-IN')})
                </option>
              ))}
            </CustomSelect>
            <p className="text-xs text-slate-500 mt-1">
              {(approvedRequests || []).length === 0
                ? 'No approved Shifting requests yet — approve a Shifting-type Movement Request first.'
                : 'Pick an approved request to auto-fill the shifting, then Save.'}
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Shifting Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={selectedCompany}
                  onChange={(e) => { setSelectedCompany(e.target.value); setFormData(prev => ({ ...prev, warehouse: '', from_godown: '', to_godown: '' })); }}
                  required
                  className={inputClass}
                >
                  <option value="">Select Company</option>
                  {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              {!isHidden('warehouse') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect
                  name="warehouse"
                  value={formData.warehouse}
                  onChange={(e) => {
                    // Reset godowns + product picks when the warehouse
                    // changes — stale FK values from a different warehouse
                    // would otherwise break the line-level filters.
                    setFormData(prev => ({ ...prev, warehouse: e.target.value, from_godown: '', to_godown: '' }));
                    setLines(prev => prev.map(l => ({ ...l, product: '', available_stock: '' })));
                  }}
                  required
                  disabled={!selectedCompany || isReadOnly('warehouse')}
                  className={`${isReadOnly('warehouse') ? lockedInputClass : inputClass} ${inputDisabled}`}
                >
                  <option value="">{selectedCompany ? 'Select Warehouse' : 'Select company first...'}</option>
                  {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('from_godown') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">From Godown <span className="text-red-500">*</span></label>
                <CustomSelect name="from_godown" value={formData.from_godown} onChange={handleChange} required disabled={!formData.warehouse || isReadOnly('from_godown')} className={`${isReadOnly('from_godown') ? lockedInputClass : inputClass} ${inputDisabled}`}>
                  <option value="">{formData.warehouse ? 'Select Godown' : 'Select warehouse first...'}</option>
                  {godownOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('to_godown') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">To Godown <span className="text-red-500">*</span></label>
                <CustomSelect name="to_godown" value={formData.to_godown} onChange={handleChange} required disabled={!formData.warehouse || isReadOnly('to_godown')} className={`${isReadOnly('to_godown') ? lockedInputClass : inputClass} ${inputDisabled}`}>
                  <option value="">{formData.warehouse ? 'Select Godown' : 'Select warehouse first...'}</option>
                  {godownOptions.filter(g => g.value !== formData.from_godown).map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('reason_code') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Reason Code</label>
                <CustomSelect name="reason_code" value={formData.reason_code} onChange={handleChange} disabled={isReadOnly('reason_code')} className={isReadOnly('reason_code') ? lockedInputClass : inputClass}>
                  <option value="">Select Reason Code</option>
                  <option value="DAMAGE">Damage</option>
                  <option value="SPACE_OPTIMISATION">Space Optimisation</option>
                  <option value="AUDIT">Audit</option>
                  <option value="PRODUCTION">Production</option>
                  <option value="OTHER">Other</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('other_reason') && (
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Other Reason / Notes</label>
                <textarea name="other_reason" value={formData.other_reason} onChange={handleChange} disabled={isReadOnly('other_reason')} className={isReadOnly('other_reason') ? lockedInputClass : inputClass} />
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
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Batch No</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Available Stock</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Shift Qty <span className="text-red-500">*</span></th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => {
                    const avail = parseFloat(line.available_stock || 0);
                    const qty = parseFloat(line.quantity || 0);
                    const overdraft = qty > avail && line.product && formData.warehouse;
                    return (
                      <tr key={idx} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                        <td className="px-3 py-2">
                          <CustomSelect value={line.category} onChange={(e) => onCategoryChange(idx, e.target.value)} disabled={!formData.warehouse} className={`${inputClass} ${inputDisabled}`} style={{ minWidth: '150px' }}>
                            <option value="">All</option>
                            {CATEGORY_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                          </CustomSelect>
                        </td>
                        <td className="px-3 py-2">
                          <CustomSelect
                            value={line.product}
                            onChange={(e) => onProductChange(idx, e.target.value)}
                            required
                            disabled={!formData.warehouse}
                            className={`${inputClass} ${inputDisabled}`}
                            style={{ minWidth: '200px' }}
                          >
                            <option value="">{formData.warehouse ? 'Select Product' : 'Pick warehouse first…'}</option>
                            {productOptionsFor(line.category).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                          </CustomSelect>
                        </td>
                        <td className="px-3 py-2">
                          <input type="text" value={line.batch} onChange={(e) => updateLine(idx, 'batch', e.target.value)} placeholder="Batch No" className={inputClass} style={{ minWidth: '120px' }} />
                        </td>
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
                        <td className="px-3 py-2">
                          <input type="text" value={line.uom} onChange={(e) => updateLine(idx, 'uom', e.target.value)} placeholder="UOM" className={inputClass} style={{ minWidth: '80px' }} />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            step="0.0001"
                            min="0"
                            value={line.quantity}
                            onChange={(e) => updateLine(idx, 'quantity', e.target.value)}
                            required
                            className={`${inputClass} text-right ${overdraft ? 'border-red-400 bg-red-50' : ''}`}
                            style={{ minWidth: '110px' }}
                          />
                          {overdraft && (
                            <p className="text-xs text-red-600 mt-1">Exceeds available</p>
                          )}
                        </td>
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

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
