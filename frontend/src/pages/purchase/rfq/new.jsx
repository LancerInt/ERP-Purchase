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

  const prOptions = prRaw
    .filter(p => p.approval_status === 'APPROVED' && !p.linked_rfq && !p.allow_rfq_skip)
    .map(p => ({
      value: p.id,
      label: `${p.pr_no} — ${p.warehouse_name || ''} — ${p.requirement_type || ''}`,
    }));

  const [isLoading, setIsLoading] = useState(false);
  const [selectedPRs, setSelectedPRs] = useState([]);
  const [prDetails, setPrDetails] = useState({});

  const [formData, setFormData] = useState({
    rfq_mode: 'EMAIL',
    quote_count_expected: '',
    skip_rfq_flag: false,
    skip_rfq_justification: '',
    notes: '',
  });

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

  // Float design — compact floating-label inputs
  const floatWrap = "relative";
  const floatLabel = "absolute top-[3px] left-[7px] text-[8px] font-semibold text-slate-400 uppercase tracking-[0.04em] pointer-events-none z-10";
  const floatInput = "w-full pt-[14px] pb-[3px] px-[7px] text-[11.5px] border border-slate-300 rounded-[6px] focus:ring-1 focus:ring-primary-500 focus:border-primary-500 bg-white";
  const floatLocked = `${floatInput} bg-slate-100 cursor-not-allowed`;
  const sectionTitle = "text-[11px] font-bold text-slate-500 uppercase tracking-wide";

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
      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="space-y-2">
        {/* RFQ Details + Additional Info — single compact card */}
        <div className="bg-white rounded-[6px] border border-slate-200 px-3 py-2">
          <p className={`${sectionTitle} mb-1.5`}>RFQ Details</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {!isHidden('rfq_mode') && (
            <div className={floatWrap}>
              <label className={floatLabel}>RFQ Mode *</label>
              <CustomSelect name="rfq_mode" value={formData.rfq_mode} onChange={handleChange} required disabled={isReadOnly('rfq_mode')} className={isReadOnly('rfq_mode') ? floatLocked : floatInput}>
                <option value="">Select Mode</option>
                <option value="EMAIL">Email</option>
                <option value="PORTAL">Portal</option>
                <option value="PHONE">Phone</option>
              </CustomSelect>
            </div>
            )}
            <div className={floatWrap}>
              <label className={floatLabel}>Skip RFQ Justification</label>
              <input type="text" name="skip_rfq_justification" value={formData.skip_rfq_justification} onChange={handleChange} className={floatInput} placeholder=" " />
            </div>
            <div className={`${floatWrap} sm:col-span-1 lg:col-span-2`}>
              <label className={floatLabel}>Notes</label>
              <input type="text" name="notes" value={formData.notes} onChange={handleChange} className={floatInput} placeholder=" " />
            </div>
          </div>
        </div>

        {/* Linked Purchase Requests */}
        {!isHidden('linked_prs') && (
        <div className="bg-white rounded-[6px] border border-slate-200 px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <p className={sectionTitle}>Linked Purchase Requests *</p>
          </div>

          <div className="mb-2">
            <CustomSelect
              value=""
              onChange={(e) => handleAddPR(e.target.value)}
              disabled={isReadOnly('linked_prs')}
              className={`${isReadOnly('linked_prs') ? floatLocked : floatInput} max-w-md`}
            >
              <option value="">+ Add Purchase Request...</option>
              {prOptions.filter(o => !selectedPRs.includes(o.value)).map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </CustomSelect>
            {prOptions.filter(o => !selectedPRs.includes(o.value)).length === 0 && selectedPRs.length === 0 && (
              <p className="text-[10px] text-amber-600 mt-0.5">No approved PRs available without an RFQ.</p>
            )}
          </div>

          {selectedPRs.length === 0 ? (
            <div className="text-center py-4 border border-dashed border-slate-200 rounded-[6px]">
              <Package size={22} className="mx-auto text-slate-300 mb-1" />
              <p className="text-[11px] text-slate-400">No Purchase Requests selected.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {selectedPRs.map(prId => {
                const prData = prDetails[prId] || prRaw.find(p => p.id === prId);
                const lines = prData?.lines || prData?.line_items || [];
                return (
                  <div key={prId} className="border border-slate-200 rounded-[6px] overflow-hidden">
                    <div className="flex items-center justify-between px-2.5 py-1.5 bg-slate-50 border-b">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] font-semibold text-primary-700">{prData?.pr_no || prId}</span>
                        <StatusBadge status={prData?.approval_status || 'APPROVED'} />
                        <span className="text-[10px] text-slate-500">{prData?.warehouse_name || ''}</span>
                        <span className="text-[10px] text-slate-500">{prData?.requirement_type || ''}</span>
                        {prData?.priority && <span className="text-[9px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">{prData.priority}</span>}
                      </div>
                      <button type="button" onClick={() => handleRemovePR(prId)} className="p-0.5 text-slate-400 hover:text-red-500 rounded hover:bg-red-50">
                        <X size={14} />
                      </button>
                    </div>
                    {lines.length > 0 && (
                      <div className="px-2.5 py-1">
                        <table className="text-[11px]">
                          <thead>
                            <tr className="text-slate-500">
                              <th className="text-left py-0.5 pr-2" style={{ fontSize: 9 }}>#</th>
                              <th className="text-left py-0.5 pr-2 whitespace-nowrap" style={{ fontSize: 9 }}>PRODUCT</th>
                              <th className="text-right py-0.5 pr-2 whitespace-nowrap" style={{ fontSize: 9 }}>QTY</th>
                              <th className="text-left py-0.5 pr-2 whitespace-nowrap" style={{ fontSize: 9 }}>UOM</th>
                              <th className="text-left py-0.5 whitespace-nowrap" style={{ fontSize: 9 }}>DESCRIPTION</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map((l, idx) => (
                              <tr key={l.id || idx} className="border-t border-slate-100">
                                <td className="py-1 pr-2 text-slate-400">{idx + 1}</td>
                                <td className="py-1 pr-2 font-medium text-slate-800">{l.product_name || l.product_service_name || '-'}</td>
                                <td className="py-1 pr-2 text-right">{l.quantity_requested || '-'}</td>
                                <td className="py-1 pr-2 text-slate-600">{l.uom || '-'}</td>
                                <td className="py-1 text-slate-500">{l.description_override || '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {lines.length === 0 && prData && (
                      <div className="px-2.5 py-1 text-[10px] text-slate-400 italic">Loading line items...</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {selectedPRs.length === 0 && <input type="text" required value="" onChange={() => {}} className="sr-only" tabIndex={-1} />}
        </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={() => navigate(-1)} className="px-4 py-1.5 border border-slate-300 rounded-[6px] text-[11.5px] font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={isLoading} className="px-4 py-1.5 bg-primary-600 text-white rounded-[6px] text-[11.5px] font-medium hover:bg-primary-700 disabled:opacity-50">
            {isLoading ? 'Creating...' : 'Create RFQ'}
          </button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
