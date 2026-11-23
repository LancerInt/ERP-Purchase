import CustomSelect from "@/components/ui/CustomSelect";
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, X } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup, { clearLookupCache } from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

export default function CreateAdjustment() {
  const navigate = useNavigate();
  const { isHidden, isReadOnly } = useFieldPermissions('Stock Adjustment');
  const { canCreate } = usePermissions();
  const editable = canCreate('Stock Adjustment');
  const [selectedCompany, setSelectedCompany] = useState('');
  const { options: companyOptions } = useLookup('/api/companies/');
  const { raw: productsRaw } = useLookup('/api/products/');
  const [isLoading, setIsLoading] = useState(false);
  const todayIso = new Date().toISOString().split('T')[0];
  const [formData, setFormData] = useState({
    warehouse: '',
    product: '',
    adjustment_type: '',
    quantity: '',
    batch: '',
    godown: '',
    notes: '',
    reason_code: '',
    other_reason: '',
    uom: '',
    adjustment_date: todayIso,
    value_impact: '0',
  });

  const { options: warehouses } = useLookup(
    selectedCompany ? `/api/warehouses/?company=${selectedCompany}&scope=true` : null
  );
  const godownEndpoint = formData.warehouse ? `/api/godowns/?warehouse=${formData.warehouse}` : null;
  const { options: godownOptions } = useLookup(godownEndpoint);

  // Product picker is filtered strictly by the selected warehouse.
  // Match by UUID or by warehouse name (the master can hold the same
  // name under multiple companies). Products with no warehouse FK on
  // the master row are dropped — only warehouse-scoped products show.
  const selectedWarehouseName = (warehouses.find(w => w.value === formData.warehouse) || {}).label || '';
  const products = (productsRaw || [])
    .filter(p => {
      if (!formData.warehouse) return true;
      if (!p.warehouse) return false;
      if (String(p.warehouse) === String(formData.warehouse)) return true;
      if (selectedWarehouseName && p.warehouse_name === selectedWarehouseName) return true;
      return false;
    })
    .map(p => ({ value: p.id, label: `${p.sku_code ? p.sku_code + ' — ' : ''}${p.product_name}` }));

  // Inline godown create modal — same pattern as the receipts form.
  const [godownModal, setGodownModal] = useState({ open: false, code: '', name: '', saving: false });
  const openGodownModal = () => {
    if (!formData.warehouse) {
      toast.error('Select a warehouse first.');
      return;
    }
    setGodownModal({ open: true, code: '', name: '', saving: false });
  };
  const handleCreateGodown = async () => {
    const code = godownModal.code.trim();
    const name = godownModal.name.trim();
    if (!code) { toast.error('Godown Code is required.'); return; }
    if (!name) { toast.error('Godown Name is required.'); return; }
    setGodownModal(prev => ({ ...prev, saving: true }));
    try {
      const res = await apiClient.post('/api/godowns/', {
        godown_code: code,
        godown_name: name,
        warehouse: formData.warehouse,
      });
      if (godownEndpoint) clearLookupCache(godownEndpoint);
      const newId = res.data?.id;
      if (newId) setFormData(prev => ({ ...prev, godown: newId }));
      toast.success(`Godown ${code} created`);
      setGodownModal({ open: false, code: '', name: '', saving: false });
    } catch (err) {
      toast.error(getApiErrorMessage(err));
      setGodownModal(prev => ({ ...prev, saving: false }));
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await apiClient.post('/api/inventory/adjustments/', cleanFormData(formData));
      toast.success('Adjustment created successfully!');
      navigate('/inventory/adjustments');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Adjustment"
        breadcrumbs={[
          { label: 'Inventory', path: '/inventory' },
          { label: 'Adjustments', path: '/inventory/adjustments' },
          { label: 'New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Adjustment Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect value={selectedCompany} onChange={(e) => { setSelectedCompany(e.target.value); setFormData(prev => ({ ...prev, warehouse: '', godown: '' })); }} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select Company</option>
                  {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              {!isHidden('warehouse') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect name="warehouse" value={formData.warehouse} onChange={(e) => { setFormData(prev => ({ ...prev, warehouse: e.target.value, godown: '' })); }} required disabled={!selectedCompany || isReadOnly('warehouse')} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed">
                  <option value="">{selectedCompany ? 'Select Warehouse' : 'Select company first...'}</option>
                  {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('godown') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Godown</label>
                <div className="flex items-center gap-1">
                  <CustomSelect name="godown" value={formData.godown} onChange={handleChange} disabled={!formData.warehouse || isReadOnly('godown')} className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed">
                    <option value="">{formData.warehouse ? 'Select Godown' : 'Select warehouse first...'}</option>
                    {godownOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                  </CustomSelect>
                  <button
                    type="button"
                    onClick={openGodownModal}
                    disabled={!formData.warehouse || isReadOnly('godown')}
                    aria-label="Create godown"
                    title={formData.warehouse ? 'Create new godown in this warehouse' : 'Select warehouse first'}
                    className="p-1.5 text-primary-600 hover:bg-primary-50 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
              )}
              {!isHidden('product') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Product <span className="text-red-500">*</span></label>
                <CustomSelect name="product" value={formData.product} onChange={handleChange} required disabled={isReadOnly('product')} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select Product</option>
                  {products.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('adjustment_type') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Adjustment Type <span className="text-red-500">*</span></label>
                <CustomSelect name="adjustment_type" value={formData.adjustment_type} onChange={handleChange} required disabled={isReadOnly('adjustment_type')} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select Type</option>
                  <option value="POSITIVE">Increase</option>
                  <option value="NEGATIVE">Decrease</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('quantity') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Quantity <span className="text-red-500">*</span></label>
                <input type="number" name="quantity" value={formData.quantity} onChange={handleChange} required disabled={isReadOnly('quantity')} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
              )}
              {!isHidden('batch') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Batch</label>
                <input type="text" name="batch" value={formData.batch} onChange={handleChange} disabled={isReadOnly('batch')} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
              )}
              {!isHidden('reason_code') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Reason Code <span className="text-red-500">*</span></label>
                <CustomSelect name="reason_code" value={formData.reason_code} onChange={handleChange} required disabled={isReadOnly('reason_code')} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select Reason Code</option>
                  <option value="DAMAGE">Damage</option>
                  <option value="EXPIRY">Expiry</option>
                  <option value="SHORTAGE">Shortage</option>
                  <option value="SURPLUS">Surplus</option>
                  <option value="AUDIT_CORRECTION">Audit Correction</option>
                  <option value="OTHERS">Others</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('uom') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">UOM</label>
                <CustomSelect name="uom" value={formData.uom} onChange={handleChange} disabled={isReadOnly('uom')} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select UOM</option>
                  <option value="Kg">Kg</option>
                  <option value="Litres">Litres</option>
                  <option value="Pcs">Pcs</option>
                  <option value="Tons">Tons</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('other_reason') && (
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Other Reason</label>
                <textarea name="other_reason" value={formData.other_reason} onChange={handleChange} rows={3} disabled={isReadOnly('other_reason')} placeholder='Use when Reason Code is "Others", or to add detail' className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
              )}
              {!isHidden('notes') && (
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} disabled={isReadOnly('notes')} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
          </EditGate>
        </form>
      </div>

      {/* Inline godown create modal */}
      {godownModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md" role="dialog" aria-modal="true" aria-label="Create Godown">
            <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b">
              <h2 className="text-lg font-semibold text-slate-800">Create Godown</h2>
              <button
                type="button"
                onClick={() => setGodownModal({ open: false, code: '', name: '', saving: false })}
                className="p-1 text-slate-400 hover:text-slate-600 rounded"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <div className="px-4 sm:px-5 py-4 space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse</label>
                <input
                  type="text"
                  value={(warehouses.find(w => String(w.value) === String(formData.warehouse))?.label) || formData.warehouse || ''}
                  readOnly
                  disabled
                  className="w-full border border-slate-200 bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-600 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Godown Code <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={godownModal.code}
                  onChange={(e) => setGodownModal(prev => ({ ...prev, code: e.target.value }))}
                  placeholder="e.g., G-01"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Godown Name <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={godownModal.name}
                  onChange={(e) => setGodownModal(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Main Floor Storage"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-4 sm:px-5 py-4 border-t bg-slate-50">
              <button
                type="button"
                onClick={() => setGodownModal({ open: false, code: '', name: '', saving: false })}
                className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateGodown}
                disabled={godownModal.saving}
                className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
              >
                {godownModal.saving ? 'Creating…' : 'Create Godown'}
              </button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
