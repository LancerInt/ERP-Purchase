import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Trash2, Edit3, ArrowLeft, Save, X } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
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
  const fmtCurrency = (v) => v ? `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '₹0.00';
  const inputClass = "w-full border border-slate-300 rounded px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500";
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
  const lowestCost = comparisons.length > 0 ? Math.min(...comparisons.map(c => parseFloat(c.total_cost) || Infinity)) : null;

  const breadcrumbs = [
    { label: 'Evaluations', href: '/purchase/evaluations' },
    { label: evaluation.evaluation_id },
  ];

  return (
    <MainLayout breadcrumbs={breadcrumbs}>
      <div className="max-w-6xl space-y-2">

        {/* ── Header row: Back + Eval ID + badge + chips + actions ── */}
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/evaluations'))}
              className="p-1 text-slate-400 hover:text-slate-700 transition shrink-0"
              title="Back to list"
            >
              <ArrowLeft size={18} />
            </button>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 truncate">{evaluation.evaluation_id || 'Evaluation'}</h1>
            <StatusBadge status={evaluation.approval_status_display || evaluation.approval_status} />
            <div className="hidden sm:flex items-center gap-1.5 ml-1">
              {evaluation.recommended_vendor_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{evaluation.recommended_vendor_name}</span>}
              {comparisons.length > 0 && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{comparisons.length} vendor{comparisons.length !== 1 ? 's' : ''} compared</span>}
              {evaluation.best_quote_flag && <span className="px-2 py-0.5 rounded bg-emerald-50 text-[10px] font-semibold text-emerald-700">Best Quote</span>}
              {lowestCost !== null && lowestCost !== Infinity && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">Low {fmtCurrency(lowestCost)}</span>}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap ml-6 sm:ml-0">
            {!isEditing && canEdit('Quote Evaluation') && (
              <button onClick={() => setIsEditing(true)} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition text-xs font-medium">
                <Edit3 size={13} /> Edit
              </button>
            )}
            {!isEditing && canDelete('Quote Evaluation') && (
              <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 border border-red-200 rounded-md text-red-600 hover:bg-red-50 transition text-xs font-medium">
                <Trash2 size={13} /> Delete
              </button>
            )}
            {isEditing && (
              <>
                <button onClick={handleSave} disabled={isSaving} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 transition disabled:opacity-50">
                  <Save size={13} /> {isSaving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setIsEditing(false)} disabled={isSaving} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition text-xs font-medium">
                  <X size={13} /> Cancel
                </button>
              </>
            )}
          </div>
        </div>

        {/* Mobile chips row */}
        <div className="flex sm:hidden items-center gap-1.5 flex-wrap ml-7">
          {evaluation.recommended_vendor_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{evaluation.recommended_vendor_name}</span>}
          {comparisons.length > 0 && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{comparisons.length} vendors</span>}
          {evaluation.best_quote_flag && <span className="px-2 py-0.5 rounded bg-emerald-50 text-[10px] font-semibold text-emerald-700">Best Quote</span>}
        </div>

        {/* ── Single-row field strip ── */}
        <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
          {!isEditing ? (
            <div className="flex items-start gap-4 overflow-x-auto" style={{ fontSize: 0 }}>
              {!isHidden('evaluation_id') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Eval ID</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{evaluation.evaluation_id}</p></div>
              )}
              {!isHidden('rfq') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">RFQ</p>
                  {evaluation.rfq ? (
                    <Link to={`/purchase/rfq/${evaluation.rfq}`} style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-blue-600 hover:underline whitespace-nowrap">{evaluation.rfq_no || 'View RFQ'}</Link>
                  ) : (<p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800">-</p>)}
                </div>
              )}
              <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Eval Date</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{fmtDate(evaluation.evaluation_date)}</p></div>
              <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Evaluated By</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{evaluation.evaluated_by_name || '-'}</p></div>
              {!isHidden('recommended_vendor') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Rec. Vendor</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{evaluation.recommended_vendor_name || '-'}</p></div>
              )}
              {!isHidden('best_quote_flag') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Best Quote</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{evaluation.best_quote_flag ? 'Yes' : 'No'}</p></div>
              )}
              {!isHidden('justification_notes') && evaluation.justification_notes && (
                <div className="min-w-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Justification</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-700 truncate max-w-[260px]" title={evaluation.justification_notes}>{evaluation.justification_notes}</p></div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2">
              {!isHidden('rfq') && (
                <div>
                  <p className="text-[8px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">RFQ</p>
                  {!isReadOnly('rfq') ? (
                    <CustomSelect value={editData.rfq} onChange={(e) => setEditData(prev => ({ ...prev, rfq: e.target.value }))} className={inputClass}>
                      <option value="">Select RFQ</option>
                      {rfqOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{evaluation.rfq_no || '-'}</p>)}
                </div>
              )}
              {!isHidden('recommended_vendor') && (
                <div>
                  <p className="text-[8px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Rec. Vendor</p>
                  {!isReadOnly('recommended_vendor') ? (
                    <CustomSelect value={editData.recommended_vendor} onChange={(e) => setEditData(prev => ({ ...prev, recommended_vendor: e.target.value }))} className={inputClass}>
                      <option value="">Select Vendor</option>
                      {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{evaluation.recommended_vendor_name || '-'}</p>)}
                </div>
              )}
              {!isHidden('approval_status') && (
                <div>
                  <p className="text-[8px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Status</p>
                  {!isReadOnly('approval_status') ? (
                    <CustomSelect value={editData.approval_status} onChange={(e) => setEditData(prev => ({ ...prev, approval_status: e.target.value }))} className={inputClass}>
                      <option value="PENDING">Pending</option>
                      <option value="APPROVED">Approved</option>
                      <option value="REJECTED">Rejected</option>
                    </CustomSelect>
                  ) : (<StatusBadge status={evaluation.approval_status_display || evaluation.approval_status} />)}
                </div>
              )}
              {!isHidden('justification_notes') && (
                <div className="col-span-2 sm:col-span-4">
                  <p className="text-[8px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Justification Notes</p>
                  {!isReadOnly('justification_notes') ? (
                    <textarea value={editData.justification_notes} onChange={(e) => setEditData(prev => ({ ...prev, justification_notes: e.target.value }))} rows={1} className={inputClass} />
                  ) : (<p className="text-[12px] text-slate-700">{evaluation.justification_notes || '-'}</p>)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Vendor Comparison table ── */}
        {comparisons.length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200">
            <div className="px-3 py-1.5 border-b border-slate-100">
              <h2 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Vendor Comparison ({comparisons.length})</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase whitespace-nowrap">Vendor</th>
                    <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase whitespace-nowrap">Total Cost</th>
                    <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase whitespace-nowrap">Lead Time</th>
                    <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase whitespace-nowrap">Payment</th>
                    <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase whitespace-nowrap">Freight</th>
                    <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase whitespace-nowrap">Score</th>
                    <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase whitespace-nowrap">Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisons.map((c, i) => {
                    const isRecommended = (c.vendor_name || '') === (evaluation.recommended_vendor_name || '');
                    return (
                      <tr key={c.id || i} className={`border-b border-slate-100 hover:bg-slate-50/60 transition-colors ${isRecommended ? 'bg-emerald-50/50' : ''}`}>
                        <td className="px-2 py-1.5 font-medium text-slate-800 whitespace-nowrap">
                          {c.vendor_name || '-'}
                          {isRecommended && <span className="ml-1 text-[9px] text-emerald-600 font-semibold">★</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtCurrency(c.total_cost)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{c.lead_time ? `${c.lead_time}d` : '-'}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{(c.payment_terms || '').replace(/_/g, ' ') || '-'}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{(c.freight_terms || '').replace(/_/g, ' ') || '-'}</td>
                        <td className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">{c.score || '-'}</td>
                        <td className="px-2 py-1.5 text-slate-500">{c.remarks || '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Attachments ── */}
        <div className="bg-white rounded-lg border border-slate-200">
          <FileAttachments module="EVALUATION" recordId={id} />
        </div>

      </div>
    </MainLayout>
  );
}
