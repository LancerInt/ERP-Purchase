import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';

const floatWrap = "relative";
const floatLabel = "absolute top-[3px] left-[7px] text-[8px] font-semibold text-slate-400 uppercase tracking-[0.04em] pointer-events-none z-10";
const floatInput = "w-full pt-[14px] pb-[3px] px-[7px] text-[11.5px] border border-slate-300 rounded-[6px] focus:ring-1 focus:ring-primary-500 focus:border-primary-500 bg-white";
const floatLocked = `${floatInput} bg-slate-100 cursor-not-allowed`;
const sectionTitle = "text-[11px] font-bold text-slate-500 uppercase tracking-wide";

export default function CreateQuoteEvaluation() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const { isHidden, isReadOnly } = useFieldPermissions('Quote Evaluation');
  const { options: rfqOptions } = useLookup('/api/purchase/rfq/');
  const { options: vendorOptions } = useLookup('/api/vendors/');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const pendingAttachmentsRef = useRef([]);
  const [formData, setFormData] = useState({
    rfq: '',
    evaluation_date: '',
    recommended_vendor: '',
    justification_notes: '',
    approval_status: '',
  });

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const payload = cleanFormData(formData);
      if (import.meta.env.DEV) console.log('[CreateQuoteEvaluation] payload:', payload);
      const res = await apiClient.post('/api/purchase/evaluations/', payload);
      const newId = res.data?.id;

      if (pendingAttachments.length > 0 && newId) {
        await uploadPendingFiles('EVALUATION', newId, pendingAttachmentsRef.current);
      }

      toast.success('Quote Evaluation created successfully!');
      navigate('/purchase/evaluations');
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateQuoteEvaluation] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Quote Evaluation"
        breadcrumbs={[
          { label: 'Purchase', path: '/purchase' },
          { label: 'Evaluations', path: '/purchase/evaluations' },
          { label: 'Create Quote Evaluation' },
        ]}
      />
      <form onSubmit={handleSubmit} className="space-y-2">
        <div className="bg-white rounded-[6px] border border-slate-200 px-3 py-2">
          <p className={`${sectionTitle} mb-1.5`}>Evaluation Details</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
            {!isHidden('rfq') && (
            <div className={floatWrap}>
              <label className={floatLabel}>RFQ *</label>
              <CustomSelect name="rfq" value={formData.rfq} onChange={handleChange} required disabled={isReadOnly('rfq')} className={isReadOnly('rfq') ? floatLocked : floatInput}>
                <option value="">Select RFQ</option>
                {rfqOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            )}
            <div className={floatWrap}>
              <label className={floatLabel}>Evaluation Date *</label>
              <CustomDatePicker name="evaluation_date" value={formData.evaluation_date} onChange={handleChange} required className={floatInput} />
            </div>
            {!isHidden('recommended_vendor') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Recommended Vendor</label>
              <CustomSelect name="recommended_vendor" value={formData.recommended_vendor} onChange={handleChange} disabled={isReadOnly('recommended_vendor')} className={isReadOnly('recommended_vendor') ? floatLocked : floatInput}>
                <option value="">Select Vendor</option>
                {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('approval_status') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Approval Status *</label>
              <CustomSelect name="approval_status" value={formData.approval_status} onChange={handleChange} required disabled={isReadOnly('approval_status')} className={isReadOnly('approval_status') ? floatLocked : floatInput}>
                <option value="">Select Status</option>
                <option value="Pending">Pending</option>
                <option value="Approved">Approved</option>
                <option value="Rejected">Rejected</option>
              </CustomSelect>
            </div>
            )}
            {!isHidden('justification_notes') && (
            <div className={floatWrap}>
              <label className={floatLabel}>Justification Notes</label>
              <input type="text" name="justification_notes" value={formData.justification_notes} onChange={handleChange} disabled={isReadOnly('justification_notes')} className={isReadOnly('justification_notes') ? floatLocked : floatInput} placeholder=" " />
            </div>
            )}
          </div>
        </div>

        <FileAttachments module="EVALUATION" recordId={null} onPendingChange={(files) => { pendingAttachmentsRef.current = files; setPendingAttachments(files); }} />

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={() => navigate(-1)} className="px-4 py-1.5 border border-slate-300 rounded-[6px] text-[11.5px] font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          {canCreate('Quote Evaluation') && (
            <button type="submit" disabled={isLoading} className="px-4 py-1.5 bg-primary-600 text-white rounded-[6px] text-[11.5px] font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          )}
        </div>
      </form>
    </MainLayout>
  );
}
