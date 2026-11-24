import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Trash2, Edit3, ArrowLeft } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FileAttachments from '../components/FileAttachments';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';

export default function QuoteEvaluationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete, canApprove } = usePermissions();
  const { isHidden, isReadOnly } = useFieldPermissions('Quote Evaluation');
  const { options: rfqOptions } = useLookup('/api/purchase/rfq/');
  const { options: vendorOptions } = useLookup('/api/vendors/');
  const [evaluation, setEvaluation] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({});
  const [isSaving, setIsSaving] = useState(false);

  const fetchEvaluation = () => {
    setIsLoading(true);
    apiClient.get(`/api/purchase/evaluations/${id}/`)
      .then(res => {
        setEvaluation(res.data);
        setEditData({
          rfq: res.data.rfq || '',
          recommended_vendor: res.data.recommended_vendor || '',
          justification_notes: res.data.justification_notes || '',
          approval_status: res.data.approval_status || 'PENDING',
        });
      })
      .catch((err) => { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); })
      .finally(() => setIsLoading(false));
  };

  useEffect(() => { fetchEvaluation(); }, [id]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await apiClient.patch(`/api/purchase/evaluations/${id}/`, editData);
      setEvaluation(res.data);
      setIsEditing(false);
      toast.success('Evaluation updated');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: 'Are you sure you want to delete this evaluation?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/evaluations/${id}/`);
      toast.success('Evaluation deleted');
      navigate('/purchase/evaluations');
    } catch {
      toast.error('Failed to delete');
    }
  };

  const fmtDate = (d) => d ? formatDate(d) : '-';
  const fmtCurrency = (v) => v ? `\u20B9${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '\u20B90.00';
  const inputClass = "w-full border border-slate-300 rounded px-2 py-1 text-sm";
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" /></div></MainLayout>;
  if (!evaluation) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">Evaluation not found.</p>
        <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/evaluations'))} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Back to Evaluations
        </button>
      </div>
    </MainLayout>
  );

  const comparisons = evaluation.comparison_entries || [];

  return (
    <MainLayout>
      <PageHeader
        title={evaluation.evaluation_id || 'Evaluation'}
        subtitle={`Evaluated on ${fmtDate(evaluation.evaluation_date)}`}
        breadcrumbs={[
          { label: 'Evaluations', href: '/purchase/evaluations' },
          { label: evaluation.evaluation_id },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-3">
          {/* Evaluation Details */}
          <div className="bg-white rounded-lg border p-3 sm:p-4">
            <div className="flex items-center justify-between mb-2 pb-1.5 border-b">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800">Evaluation Details</h3>
              {canEdit('Quote Evaluation') && !isEditing && (
                <button onClick={() => setIsEditing(true)} className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700">
                  <Edit3 size={14} /> Edit
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
              {!isHidden('evaluation_id') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Evaluation ID</p>
                <p className="font-medium">{evaluation.evaluation_id}</p>
              </div>
              )}
              {!isHidden('rfq') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">RFQ</p>
                {isEditing ? (
                  <CustomSelect value={editData.rfq} onChange={(e) => setEditData(prev => ({ ...prev, rfq: e.target.value }))} disabled={isReadOnly('rfq')} className={isReadOnly('rfq') ? lockedInputClass : inputClass}>
                    <option value="">Select RFQ</option>
                    {rfqOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                ) : (
                  <p className="font-medium text-primary-600">{evaluation.rfq_no || evaluation.rfq || '-'}</p>
                )}
              </div>
              )}
              <div>
                <p className="text-xs font-semibold text-slate-700">Evaluation Date</p>
                <p className="font-medium">{fmtDate(evaluation.evaluation_date)}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-700">Evaluated By</p>
                <p className="font-medium">{evaluation.evaluated_by_name || '-'}</p>
              </div>
              {!isHidden('recommended_vendor') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Recommended Vendor</p>
                {isEditing ? (
                  <CustomSelect value={editData.recommended_vendor} onChange={(e) => setEditData(prev => ({ ...prev, recommended_vendor: e.target.value }))} disabled={isReadOnly('recommended_vendor')} className={isReadOnly('recommended_vendor') ? lockedInputClass : inputClass}>
                    <option value="">Select Vendor</option>
                    {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                ) : (
                  <p className="font-medium">{evaluation.recommended_vendor_name || '-'}</p>
                )}
              </div>
              )}
              {!isHidden('approval_status') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Status</p>
                {isEditing ? (
                  <CustomSelect value={editData.approval_status} onChange={(e) => setEditData(prev => ({ ...prev, approval_status: e.target.value }))} disabled={isReadOnly('approval_status')} className={isReadOnly('approval_status') ? lockedInputClass : inputClass}>
                    <option value="PENDING">Pending</option>
                    <option value="APPROVED">Approved</option>
                    <option value="REJECTED">Rejected</option>
                  </CustomSelect>
                ) : (
                  <StatusBadge status={evaluation.approval_status_display || evaluation.approval_status} />
                )}
              </div>
              )}
              {!isHidden('best_quote_flag') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Best Quote</p>
                <p className="font-medium">{evaluation.best_quote_flag ? 'Yes' : 'No'}</p>
              </div>
              )}
            </div>

            {/* Justification */}
            {!isHidden('justification_notes') && (
            <div className="mt-4 pt-4 border-t">
              <p className="text-xs font-semibold text-slate-700 mb-1">Justification Notes</p>
              {isEditing ? (
                <textarea value={editData.justification_notes} onChange={(e) => setEditData(prev => ({ ...prev, justification_notes: e.target.value }))} rows={2} disabled={isReadOnly('justification_notes')} className={isReadOnly('justification_notes') ? `w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm bg-slate-100 cursor-not-allowed` : `w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm`} />
              ) : (
                <p className="text-sm text-slate-700">{evaluation.justification_notes || 'No notes provided'}</p>
              )}
            </div>
            )}

            {/* Edit buttons */}
            {isEditing && (
              <div className="mt-4 flex gap-2 justify-end">
                <button onClick={() => setIsEditing(false)} className="px-4 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
                {canEdit('Quote Evaluation') && (
                  <button onClick={handleSave} disabled={isSaving} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
                    {isSaving ? 'Saving...' : 'Save Changes'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Attachments */}
          <FileAttachments module="EVALUATION" recordId={id} />

          {/* Vendor Comparison */}
          {comparisons.length > 0 && (
            <div className="bg-white rounded-lg border p-3 sm:p-4">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Vendor Comparison</h3>
              <div className="overflow-x-auto ios-scroll">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-4 py-2 font-medium text-slate-600">Vendor</th>
                      <th className="text-right px-4 py-2 font-medium text-slate-600">Total Cost</th>
                      <th className="text-right px-4 py-2 font-medium text-slate-600">Lead Time</th>
                      <th className="text-left px-4 py-2 font-medium text-slate-600">Payment Terms</th>
                      <th className="text-left px-4 py-2 font-medium text-slate-600">Freight Terms</th>
                      <th className="text-right px-4 py-2 font-medium text-slate-600">Score</th>
                      <th className="text-left px-4 py-2 font-medium text-slate-600">Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisons.map((c, i) => {
                      const isRecommended = (c.vendor_name || '') === (evaluation.recommended_vendor_name || '');
                      return (
                        <tr key={c.id || i} className={`border-b ${isRecommended ? 'bg-emerald-50' : ''}`}>
                          <td className="px-4 py-2 font-medium">
                            {c.vendor_name || '-'}
                            {isRecommended && <span className="ml-1 text-xs text-emerald-600 font-semibold">(Recommended)</span>}
                          </td>
                          <td className="px-4 py-2 text-right">{fmtCurrency(c.total_cost)}</td>
                          <td className="px-4 py-2 text-right">{c.lead_time ? `${c.lead_time} days` : '-'}</td>
                          <td className="px-4 py-2">{(c.payment_terms || '').replace(/_/g, ' ') || '-'}</td>
                          <td className="px-4 py-2">{(c.freight_terms || '').replace(/_/g, ' ') || '-'}</td>
                          <td className="px-4 py-2 text-right font-semibold">{c.score || '-'}</td>
                          <td className="px-4 py-2 text-slate-500">{c.remarks || '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-3">
          {/* Summary */}
          <div className="bg-white rounded-lg border p-3 sm:p-4">
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2">Summary</h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-sm text-slate-500">Status</span>
                <StatusBadge status={evaluation.approval_status_display || evaluation.approval_status} />
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-slate-500">Vendor</span>
                <span className="text-sm font-medium">{evaluation.recommended_vendor_name || '-'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-slate-500">Vendors Compared</span>
                <span className="text-sm font-medium">{comparisons.length}</span>
              </div>
              {comparisons.length > 0 && (
                <div className="flex justify-between">
                  <span className="text-sm text-slate-500">Lowest Cost</span>
                  <span className="text-sm font-bold">{fmtCurrency(Math.min(...comparisons.map(c => parseFloat(c.total_cost) || Infinity)))}</span>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="bg-white rounded-lg border p-3 sm:p-4">
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2">Actions</h3>
            <div className="space-y-2">
              {canEdit('Quote Evaluation') && !isEditing && (
                <button onClick={() => setIsEditing(true)} className="w-full px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 flex items-center justify-center gap-1">
                  <Edit3 size={14} /> Edit Evaluation
                </button>
              )}
              {canDelete('Quote Evaluation') && (
                <button onClick={handleDelete} className="w-full px-4 py-2 text-sm bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 flex items-center justify-center gap-1">
                  <Trash2 size={14} /> Delete
                </button>
              )}
              <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/evaluations'))} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
                &larr; Back to List
              </button>
            </div>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
