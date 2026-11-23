import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, ArrowRightLeft, Mic, X } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import VoiceDictation from '../../../components/common/VoiceDictation';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const inputDisabled = 'disabled:bg-slate-100 disabled:cursor-not-allowed';
const lockedInput = `${inputClass} bg-slate-100 cursor-not-allowed`;

const emptyLine = { category: '', product: '', uom: '', quantity: '', available_stock: '' };

// Product categories = the goods sub-type. Pick a category → the Product
// dropdown narrows to that category (same behaviour as the Purchase Request).
const CATEGORY_CHOICES = [
  { value: 'RAW_MATERIAL', label: 'Raw Material' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'FINISHED_GOOD', label: 'Finished Good' },
  { value: 'SEMI_FINISHED', label: 'Semi Finished' },
  // Machinery products carry goods_sub_type MACHINE_SPARES in the catalogue
  // (item_type PRODUCT), so this choice narrows the product dropdown to them
  // for both Shifting and Transfer movements.
  { value: 'MACHINE_SPARES', label: 'Machinery' },
];

/**
 * Stock Movement Request — a reference request to move stock. Pick a Movement
 * Type (Shifting = godown→godown same warehouse, Transfer = warehouse→warehouse),
 * fill the header + line items, optionally dictate a voice note.
 *
 * This page NEVER moves stock — it only raises a request. Stock is added/reduced
 * later when the resulting Transfer/Shifting is approved.
 */
export default function StockMovementRequest() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Stock Movement Request');
  const [movementType, setMovementType] = useState('SHIFTING');
  const isTransfer = movementType === 'TRANSFER';

  const { options: companyOptions } = useLookup('/api/companies/');
  const [isLoading, setIsLoading] = useState(false);
  const [audioFile, setAudioFile] = useState(null);

  const [formData, setFormData] = useState({
    company: '',
    to_company: '',
    from_warehouse: '',
    to_warehouse: '',
    from_godown: '',
    to_godown: '',
    reason_code: '',
    remarks: '',
  });
  const [lines, setLines] = useState([{ ...emptyLine }]);

  const { options: warehouses } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}` : null
  );
  // Transfer destination is scoped to its own "To Company" so the To
  // Warehouse dropdown lists only that company's warehouses.
  const { options: toWarehouses } = useLookup(
    formData.to_company ? `/api/warehouses/?company=${formData.to_company}` : null
  );
  const { options: fromGodownOptions } = useLookup(
    formData.from_warehouse ? `/api/godowns/?warehouse=${formData.from_warehouse}` : null
  );
  const { options: toGodownOptions } = useLookup(
    formData.to_warehouse ? `/api/godowns/?warehouse=${formData.to_warehouse}` : null
  );

  // Product source = the shared item catalogue (same feed the Purchase Request
  // uses). It's open to any authenticated user — unlike /api/products/, which is
  // gated by the Product module, so a Warehouse Coordinator saw no products. It
  // returns each item's category (goods sub-type) for the Category filter and a
  // live current_stock scoped to the picked warehouse/godown, and always
  // reflects the current Product master.
  const catalogEndpoint = formData.from_warehouse
    ? (formData.from_godown
        ? `/api/purchase/items/?warehouse=${formData.from_warehouse}&godown=${formData.from_godown}`
        : `/api/purchase/items/?warehouse=${formData.from_warehouse}`)
    : '/api/purchase/items/';
  const { raw: catalogItems } = useLookup(catalogEndpoint);

  const selectedFromWarehouseName = (warehouses.find(w => w.value === formData.from_warehouse) || {}).label || '';
  const norm = (v) => (v || '').toString().trim().toUpperCase().replace(/[\s-]+/g, '_');
  const productItems = (catalogItems || []).filter(it => it.item_type === 'PRODUCT');
  // Narrow the product dropdown to the picked category (goods sub-type).
  const productOptionsFor = (category) => productItems
    .filter(it => !category || norm(it.category) === norm(category))
    .map(it => ({ value: it.item_id, label: it.label || it.item_name }))
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  const stockFor = (productId) => {
    const it = productItems.find(x => String(x.item_id) === String(productId));
    return it ? it.current_stock : '';
  };

  const handleChange = (e) => setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  const updateLine = (idx, patch) => setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));

  // Change category → clear the product (must re-pick within the new category).
  const onCategoryChange = (idx, category) => updateLine(idx, { category, product: '', uom: '' });

  const onProductChange = (idx, productId) => {
    const it = productItems.find(x => String(x.item_id) === String(productId));
    updateLine(idx, {
      product: productId,
      uom: it?.uom || '',
      // Keep the category in sync with the product's own sub-type.
      category: it?.category || '',
    });
  };

  // Shifting keeps the destination warehouse = source (godown → godown).
  useEffect(() => {
    if (!isTransfer) {
      setFormData(prev => (
        prev.to_warehouse === prev.from_warehouse ? prev : { ...prev, to_warehouse: prev.from_warehouse, to_godown: '' }
      ));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTransfer, formData.from_warehouse]);

  const addLine = () => setLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => setLines(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  const appendDictation = (text) => {
    if (!text) return;
    setFormData(prev => ({ ...prev, remarks: prev.remarks ? `${prev.remarks} ${text}` : text }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isTransfer && formData.from_godown && formData.to_godown && formData.from_godown === formData.to_godown) {
      toast.error('From Godown and To Godown cannot be the same.');
      return;
    }
    if (isTransfer && formData.from_warehouse && formData.from_warehouse === formData.to_warehouse) {
      toast.error('Transfer needs two different warehouses (or switch to Shifting).');
      return;
    }
    const payloadLines = lines
      .filter(l => l.product && l.quantity && parseFloat(l.quantity) > 0)
      .map(l => ({ product: l.product, category: l.category || '', uom: l.uom || '', quantity: l.quantity }));
    if (payloadLines.length === 0) {
      toast.error('Add at least one line item with a product and quantity.');
      return;
    }

    setIsLoading(true);
    try {
      const payload = {
        movement_type: movementType,
        company: formData.company || null,
        from_warehouse: formData.from_warehouse,
        from_godown: formData.from_godown,
        to_warehouse: isTransfer ? formData.to_warehouse : formData.from_warehouse,
        to_godown: formData.to_godown,
        reason_code: formData.reason_code || '',
        remarks: formData.remarks || '',
        products: payloadLines,
      };
      const res = await apiClient.post('/api/inventory/movement-requests/', payload);
      // Attach the voice note (if recorded) to the freshly-created request.
      if (audioFile && res.data?.id) {
        const fd = new FormData();
        fd.append('audio', audioFile);
        try {
          await apiClient.post(`/api/inventory/movement-requests/${res.data.id}/upload-audio/`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
        } catch { /* non-fatal — the request itself was raised */ }
      }
      toast.success('Stock Movement Request raised — it now needs approval.');
      navigate('/inventory/stock-movement');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  const sameWarehouse = !!formData.from_warehouse && formData.from_warehouse === formData.to_warehouse;

  return (
    <MainLayout>
      <PageHeader
        title="Movement Request"
        subtitle="Reference request only — raise a Shifting (godown → godown) or a Transfer (warehouse → warehouse). It does not move stock."
        breadcrumbs={[{ label: 'Inventory', path: '/inventory' }, { label: 'Movement Request' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          {/* Movement type */}
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-4">
            <label className="block text-sm font-semibold text-slate-800 mb-1">
              <ArrowRightLeft size={15} className="inline mr-1 text-primary-600" /> Movement Type <span className="text-red-500">*</span>
            </label>
            <CustomSelect value={movementType} onChange={(e) => { setMovementType(e.target.value); setFormData(prev => ({ ...prev, to_company: '', to_warehouse: '', to_godown: '' })); }} required className={inputClass} style={{ maxWidth: '340px' }}>
              <option value="SHIFTING">Shifting — godown → godown (same warehouse)</option>
              <option value="TRANSFER">Transfer — warehouse → warehouse</option>
            </CustomSelect>
            <p className="text-xs text-slate-500 mt-1">
              {isTransfer ? 'Stock moves between two different warehouses.' : 'Stock relocates between godowns inside the same warehouse.'}
            </p>
          </div>

          {/* Request details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Request Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {/* ── FROM: company → warehouse → godown ── */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{isTransfer ? 'From Company' : 'Company'} <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={formData.company}
                  onChange={(e) => setFormData(prev => ({ ...prev, company: e.target.value, from_warehouse: '', from_godown: '', ...(isTransfer ? {} : { to_warehouse: '', to_godown: '' }) }))}
                  required className={inputClass}
                >
                  <option value="">Select Company</option>
                  {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">From Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect
                  name="from_warehouse" value={formData.from_warehouse}
                  onChange={(e) => setFormData(prev => ({ ...prev, from_warehouse: e.target.value, from_godown: '', ...(isTransfer ? {} : { to_warehouse: e.target.value, to_godown: '' }) }))}
                  required disabled={!formData.company} className={`${inputClass} ${inputDisabled}`}
                >
                  <option value="">{formData.company ? 'Select Warehouse' : 'Select company first...'}</option>
                  {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">From Godown <span className="text-red-500">*</span></label>
                <CustomSelect name="from_godown" value={formData.from_godown} onChange={handleChange} required disabled={!formData.from_warehouse} className={`${inputClass} ${inputDisabled}`}>
                  <option value="">{formData.from_warehouse ? 'Select Godown' : 'Select warehouse first...'}</option>
                  {fromGodownOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                </CustomSelect>
              </div>

              {/* ── TO: company → warehouse → godown (Transfer shows a To Company; Shifting stays inside the From warehouse) ── */}
              {isTransfer && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">To Company <span className="text-red-500">*</span></label>
                  <CustomSelect
                    value={formData.to_company}
                    onChange={(e) => setFormData(prev => ({ ...prev, to_company: e.target.value, to_warehouse: '', to_godown: '' }))}
                    required className={inputClass}
                  >
                    <option value="">Select Company</option>
                    {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </CustomSelect>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">To Warehouse <span className="text-red-500">*</span></label>
                {isTransfer ? (
                  <CustomSelect
                    name="to_warehouse" value={formData.to_warehouse}
                    onChange={(e) => setFormData(prev => ({ ...prev, to_warehouse: e.target.value, to_godown: '' }))}
                    required disabled={!formData.to_company} className={`${inputClass} ${inputDisabled} ${sameWarehouse ? 'border-red-400 bg-red-50' : ''}`}
                  >
                    <option value="">{formData.to_company ? 'Select Warehouse' : 'Select To company first...'}</option>
                    {toWarehouses.filter(w => w.value !== formData.from_warehouse).map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </CustomSelect>
                ) : (
                  <input type="text" readOnly value={selectedFromWarehouseName || 'Same as From (shifting)'} className={lockedInput} />
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">To Godown <span className="text-red-500">*</span></label>
                <CustomSelect name="to_godown" value={formData.to_godown} onChange={handleChange} required disabled={!formData.to_warehouse} className={`${inputClass} ${inputDisabled}`}>
                  <option value="">{formData.to_warehouse ? 'Select Godown' : (isTransfer ? 'Select To warehouse first...' : 'Select From warehouse first...')}</option>
                  {toGodownOptions.filter(g => isTransfer || g.value !== formData.from_godown).map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                </CustomSelect>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Purpose / Reason</label>
                <CustomSelect name="reason_code" value={formData.reason_code} onChange={handleChange} className={inputClass}>
                  <option value="">Select Purpose</option>
                  <option value="PARTY_SAMPLE">Party Sample</option>
                  <option value="LAB_USE">Lab Use</option>
                  <option value="EXTRA_BAG">Extra Bag</option>
                  <option value="OTHER">Others</option>
                </CustomSelect>
              </div>

              <div className="col-span-2 lg:col-span-3">
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-slate-700">Notes</label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 hidden sm:inline">Speak to add notes →</span>
                    <VoiceDictation onText={appendDictation} onAudio={setAudioFile} />
                  </div>
                </div>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} className={inputClass} rows={2} placeholder="Type or dictate a note…" />
                {audioFile && (
                  <div className="mt-2 inline-flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1">
                    <Mic size={13} /> Voice note recorded
                    <button type="button" onClick={() => setAudioFile(null)} className="text-slate-400 hover:text-red-600" aria-label="Remove voice note"><X size={13} /></button>
                  </div>
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
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Category</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Quantity <span className="text-red-500">*</span></th>
                    {!isTransfer && <th className="text-right px-3 py-2 font-medium text-slate-600">Available Stock</th>}
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <CustomSelect value={line.category} onChange={(e) => onCategoryChange(idx, e.target.value)} disabled={!formData.from_warehouse} className={`${inputClass} ${inputDisabled}`} style={{ minWidth: '150px' }}>
                          <option value="">All</option>
                          {CATEGORY_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <CustomSelect value={line.product} onChange={(e) => onProductChange(idx, e.target.value)} required disabled={!formData.from_warehouse} className={`${inputClass} ${inputDisabled}`} style={{ minWidth: '200px' }}>
                          <option value="">{formData.from_warehouse ? 'Select Product' : 'Pick warehouse first…'}</option>
                          {productOptionsFor(line.category).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" value={line.uom} onChange={(e) => updateLine(idx, { uom: e.target.value })} placeholder="UOM" className={inputClass} style={{ minWidth: '80px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.0001" min="0" value={line.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} required className={`${inputClass} text-right`} style={{ minWidth: '110px' }} />
                      </td>
                      {!isTransfer && (
                        <td className="px-3 py-2 text-right">
                          {(() => {
                            const s = stockFor(line.product);
                            return (s === '' || s === null || s === undefined)
                              ? <span className="text-slate-400">—</span>
                              : <span className="font-medium text-slate-700">{Number(s).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>;
                          })()}
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} aria-label="Remove line" title="Remove line" className="text-red-500 hover:text-red-700 disabled:opacity-30">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isLoading ? 'Saving...' : 'Raise Request'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
