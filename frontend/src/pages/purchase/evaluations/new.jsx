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

  const inputClass = 'w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

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
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Evaluation Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-3 gap-y-2">
              {!isHidden('rfq') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">RFQ <span className="text-red-500">*</span></label>
                <CustomSelect name="rfq" value={formData.rfq} onChange={handleChange} required disabled={isReadOnly('rfq')} className={isReadOnly('rfq') ? lockedInputClass : inputClass}>
                  <option value="">Select RFQ</option>
                  {rfqOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Evaluation Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="evaluation_date" value={formData.evaluation_date} onChange={handleChange} required className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
              {!isHidden('recommended_vendor') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Recommended Vendor</label>
                <CustomSelect name="recommended_vendor" value={formData.recommended_vendor} onChange={handleChange} disabled={isReadOnly('recommended_vendor')} className={isReadOnly('recommended_vendor') ? lockedInputClass : inputClass}>
                  <option value="">Select Vendor</option>
                  {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('approval_status') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Approval Status <span className="text-red-500">*</span></label>
                <CustomSelect name="approval_status" value={formData.approval_status} onChange={handleChange} required disabled={isReadOnly('approval_status')} className={isReadOnly('approval_status') ? lockedInputClass : inputClass}>
                  <option value="">Select Status</option>
                  <option value="Pending">Pending</option>
                  <option value="Approved">Approved</option>
                  <option value="Rejected">Rejected</option>
                </CustomSelect>
              </div>
              )}
            </div>
          </div>
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Additional Information</h3>
            <div className="grid grid-cols-1 gap-3">
              {!isHidden('justification_notes') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Justification Notes</label>
                <textarea name="justification_notes" value={formData.justification_notes} onChange={handleChange} rows={2} disabled={isReadOnly('justification_notes')} className={isReadOnly('justification_notes') ? lockedInputClass : 'w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500'} />
              </div>
              )}
            </div>
          </div>
          <FileAttachments module="EVALUATION" recordId={null} onPendingChange={(files) => { pendingAttachmentsRef.current = files; setPendingAttachments(files); }} />

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            {canCreate('Quote Evaluation') && (
              <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
            )}
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
