import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, X, Package } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

export default function CreateRFQ() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isHidden, isReadOnly } = useFieldPermissions('RFQ');
  const { canCreate } = usePermissions();
  const editable = canCreate('RFQ');
  const { raw: prRaw } = useLookup('/api/purchase/requests/');

  // Only show approved PRs that don't already have an RFQ and aren't set to
  // skip the RFQ process (those go straight to a PO — no RFQ/quote/eval).
  const prOptions = prRaw
    .filter(p => p.approval_status === 'APPROVED' && !p.linked_rfq && !p.allow_rfq_skip)
    .map(p => ({
      value: p.id,
      label: `${p.pr_no} — ${p.warehouse_name || ''} — ${p.requirement_type || ''}`,
    }));

  const [isLoading, setIsLoading] = useState(false);
  const [selectedPRs, setSelectedPRs] = useState([]);
  const [prDetails, setPrDetails] = useState({}); // { prId: { ...prData, lines: [] } }

  const [formData, setFormData] = useState({
    rfq_mode: 'EMAIL',
    quote_count_expected: '',
    skip_rfq_flag: false,
    skip_rfq_justification: '',
    notes: '',
  });

  // Auto-select PR from query param
  useEffect(() => {
    const prId = searchParams.get('pr_id');
    if (prId && prRaw.length > 0 && selectedPRs.length === 0) {
      const pr = prRaw.find(p => String(p.id) === String(prId));
      if (pr?.allow_rfq_skip) {
        toast.error(`${pr.pr_no || 'This request'} is set to skip RFQ — an RFQ can't be created for it.`);
        return;
      }
      if (pr) {
        setSelectedPRs([pr.id]);
        fetchPRDetails(pr.id);
      }
    }
  }, [searchParams, prRaw]);

  // Fetch PR details when a PR is added
  const fetchPRDetails = async (prId) => {
    if (prDetails[prId]) return;
    try {
      const res = await apiClient.get(`/api/purchase/requests/${prId}/`);
      setPrDetails(prev => ({ ...prev, [prId]: res.data }));
    } catch { /* ignore */ }
  };

  const handleAddPR = (prId) => {
    if (!prId || selectedPRs.includes(prId)) return;
    const pr = prRaw.find(p => String(p.id) === String(prId));
    if (pr?.allow_rfq_skip) {
      toast.error(`${pr.pr_no || 'This request'} is set to skip RFQ — an RFQ can't be created for it.`);
      return;
    }
    setSelectedPRs(prev => [...prev, prId]);
    fetchPRDetails(prId);
  };

  const handleRemovePR = (prId) => {
    setSelectedPRs(prev => prev.filter(id => id !== prId));
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  // Collect all line items from selected PRs
  const allLineItems = selectedPRs.flatMap(prId => {
    const pr = prDetails[prId];
    if (!pr) return [];
    return (pr.lines || pr.line_items || []).map(l => ({
      ...l,
      pr_no: pr.pr_no,
    }));
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (selectedPRs.length === 0) {
      toast.error('Please select at least one Purchase Request');
      return;
    }
    setIsLoading(true);
    try {
      const payload = cleanFormData({ ...formData, linked_prs: selectedPRs });
      const res = await apiClient.post('/api/purchase/rfq/', payload);
      const newId = res.data?.id;

      toast.success(`RFQ ${res.data.rfq_no || ''} created successfully!`);
      navigate(newId ? `/purchase/rfq/${newId}` : '/purchase/rfq');
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateRFQ] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;
  const labelClass = 'block text-sm font-medium text-slate-700 mb-1';

  return (
    <MainLayout>
      <PageHeader
        title="Create RFQ"
        breadcrumbs={[
          { label: 'Purchase', path: '/purchase' },
          { label: 'RFQs', path: '/purchase/rfq' },
          { label: 'Create RFQ' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-3 sm:space-y-6">
          {/* Section 1: RFQ Details */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">RFQ Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {!isHidden('rfq_mode') && (
              <div>
                <label className={labelClass}>RFQ Mode <span className="text-red-500">*</span></label>
                <CustomSelect name="rfq_mode" value={formData.rfq_mode} onChange={handleChange} required disabled={isReadOnly('rfq_mode')} className={isReadOnly('rfq_mode') ? lockedInputClass : inputClass}>
                  <option value="">Select Mode</option>
                  <option value="EMAIL">Email</option>
                  <option value="PORTAL">Portal</option>
                  <option value="PHONE">Phone</option>
                </CustomSelect>
              </div>
              )}
            </div>
          </div>

          {/* Section 2: Linked Purchase Requests */}
          {!isHidden('linked_prs') && (
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Linked Purchase Requests <span className="text-red-500">*</span></h3>
            </div>

            {/* PR Selector */}
            <div className="mb-4">
              <CustomSelect
                value=""
                onChange={(e) => handleAddPR(e.target.value)}
                disabled={isReadOnly('linked_prs')}
                className={isReadOnly('linked_prs') ? lockedInputClass : inputClass}
                style={{ maxWidth: '500px' }}
              >
                <option value="">+ Add Purchase Request...</option>
                {prOptions.filter(o => !selectedPRs.includes(o.value)).map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </CustomSelect>
              {prOptions.filter(o => !selectedPRs.includes(o.value)).length === 0 && selectedPRs.length === 0 && (
                <p className="text-xs text-amber-600 mt-1">No approved PRs available without an RFQ.</p>
              )}
            </div>

            {/* Selected PRs with details */}
            {selectedPRs.length === 0 ? (
              <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-lg">
                <Package size={32} className="mx-auto text-slate-300 mb-2" />
                <p className="text-sm text-slate-400">No Purchase Requests selected. Select one from the dropdown above.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {selectedPRs.map(prId => {
                  const prData = prDetails[prId] || prRaw.find(p => p.id === prId);
                  const lines = prData?.lines || prData?.line_items || [];
                  return (
                    <div key={prId} className="border border-slate-200 rounded-lg overflow-hidden">
                      {/* PR Header */}
                      <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-semibold text-primary-700">{prData?.pr_no || prId}</span>
                          <StatusBadge status={prData?.approval_status || 'APPROVED'} />
                          <span className="text-xs text-slate-500">{prData?.warehouse_name || ''}</span>
                          <span className="text-xs text-slate-500">{prData?.requirement_type || ''}</span>
                          {prData?.priority && <span className="text-xs px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">{prData.priority}</span>}
                        </div>
                        <button type="button" onClick={() => handleRemovePR(prId)} className="p-1 text-slate-400 hover:text-red-500 rounded hover:bg-red-50">
                          <X size={16} />
                        </button>
                      </div>
                      {/* PR Line Items */}
                      {lines.length > 0 && (
                        <div className="px-4 py-2">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-slate-500">
                                <th className="text-left py-1 pr-3">#</th>
                                <th className="text-left py-1 pr-3">Product</th>
                                <th className="text-right py-1 pr-3">Qty</th>
                                <th className="text-left py-1 pr-3">UOM</th>
                                <th className="text-left py-1">Description</th>
                              </tr>
                            </thead>
                            <tbody>
                              {lines.map((l, idx) => (
                                <tr key={l.id || idx} className="border-t border-slate-100">
                                  <td className="py-1.5 pr-3 text-slate-400">{idx + 1}</td>
                                  <td className="py-1.5 pr-3 font-medium text-slate-800">{l.product_name || l.product_service_name || '-'}</td>
                                  <td className="py-1.5 pr-3 text-right">{l.quantity_requested || '-'}</td>
                                  <td className="py-1.5 pr-3 text-slate-600">{l.uom || '-'}</td>
                                  <td className="py-1.5 text-slate-500">{l.description_override || '-'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {lines.length === 0 && prData && (
                        <div className="px-4 py-2 text-xs text-slate-400 italic">Loading line items...</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Hidden validation input */}
            {selectedPRs.length === 0 && <input type="text" required value="" onChange={() => {}} className="sr-only" tabIndex={-1} />}
          </div>
          )}

          {/* Section 3: Additional Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional Information</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Skip RFQ Justification</label>
                <textarea name="skip_rfq_justification" value={formData.skip_rfq_justification} onChange={handleChange} rows={3} className={inputClass} placeholder="Reason for skipping RFQ process..." />
              </div>
              <div>
                <label className={labelClass}>Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} placeholder="Additional notes..." />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isLoading ? 'Creating...' : 'Create RFQ'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
