import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FileAttachments from '../components/FileAttachments';
import { ArrowLeft } from 'lucide-react';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? formatDate(d) : '-';

const REASON_MAP = {
  DAMAGED: 'Damaged', EXPIRED: 'Expired', WRONG_ITEM: 'Wrong Item',
  QUALITY_ISSUE: 'Quality Issue', SHORT_QUANTITY: 'Short Quantity', OTHER: 'Other',
};

export default function MaterialRejectionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canApprove, canDelete } = usePermissions();
  const { isHidden } = useFieldPermissions('Material Rejection');
  const [rejection, setRejection] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/purchase/rejections/${id}/`);
      setRejection(res.data);
    } catch (err) { if (err.response?.status !== 404) toast.error('Failed to load rejection'); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchData(); }, [id]);

  const handleApprove = async () => {
    try {
      const res = await apiClient.post(`/api/purchase/rejections/${id}/approve/`);
      setRejection(res.data);
      toast.success('Rejection approved!');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to approve'); }
  };

  const handleMarkReturned = async () => {
    try {
      const res = await apiClient.post(`/api/purchase/rejections/${id}/mark-returned/`);
      setRejection(res.data);
      toast.success('Marked as returned!');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: 'Delete this rejection?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/rejections/${id}/`);
      toast.success('Deleted');
      navigate('/purchase/rejections');
    } catch (err) { toast.error('Failed to delete'); }
  };

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" /></div></MainLayout>;
  if (!rejection) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">Rejection not found.</p>
        <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/rejections'))} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Back to Rejections
        </button>
      </div>
    </MainLayout>
  );

  const lines = rejection.rejection_lines || [];
  const isDraft = rejection.status === 'DRAFT';
  const isApproved = rejection.status === 'APPROVED';

  return (
    <MainLayout>
      <div className="max-w-6xl space-y-3">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/rejections'))} className="p-1 text-slate-500 hover:text-slate-700">←</button>
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900">{rejection.rejection_no}</h1>
              <StatusBadge status={rejection.status_display || rejection.status} />
            </div>
            <p className="text-sm text-slate-500 ml-8">Created on {fmtDate(rejection.rejection_date)}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isDraft && canApprove('Material Rejection') && (
              <button onClick={handleApprove} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">Approve</button>
            )}
            {isApproved && rejection.return_to_vendor && (
              <button onClick={handleMarkReturned} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Mark Returned</button>
            )}
            {canDelete('Material Rejection') && isDraft && (
              <button onClick={handleDelete} className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50">Delete</button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 space-y-3">
            {/* Rejection Details */}
            <div className="bg-white rounded-lg border p-3 sm:p-4">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Rejection Details</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2 text-sm">
                {!isHidden('receipt_advice') && (
                <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">Receipt / GRN</span>
                  <button onClick={() => navigate(`/purchase/receipts/${rejection.receipt_advice}`)} className="text-primary-600 hover:underline font-medium">{rejection.receipt_no}</button>
                </div>
                )}
                {!isHidden('purchase_order') && (
                <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">PO Number</span><span className="font-medium">{rejection.po_no || '-'}</span></div>
                )}
                {!isHidden('vendor') && (
                <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">Vendor</span><span className="font-medium">{rejection.vendor_name || '-'}</span></div>
                )}
                {!isHidden('warehouse') && (
                <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">Warehouse</span><span className="font-medium">{rejection.warehouse_name || '-'}</span></div>
                )}
                <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">Rejected By</span><span className="font-medium">{rejection.rejected_by_name || '-'}</span></div>
                {!isHidden('rejection_date') && (
                <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">Date</span><span className="font-medium">{fmtDate(rejection.rejection_date)}</span></div>
                )}
              </div>
              {rejection.description && !isHidden('description') && (
                <div className="mt-3 pt-3 border-t"><span className="text-xs font-semibold text-slate-700 block mb-0.5">Description</span><p className="text-sm">{rejection.description}</p></div>
              )}
            </div>

            {/* Line Items */}
            <div className="bg-white rounded-lg border p-3 sm:p-4">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Rejected Items ({lines.length})</h3>
              {/* Mobile-stacked Rejected Items — read-only summary
                  per line so the screen never side-scrolls on phones. */}
              <div className="sm:hidden space-y-3 mb-4">
                {lines.map((l, i) => (
                  <div key={`m-${l.id || i}`} className="border border-slate-200 rounded-lg bg-white overflow-hidden">
                    <div className="flex items-start justify-between px-3 py-2 bg-slate-50 border-b border-slate-100 gap-2">
                      <div className="min-w-0">
                        <p className="text-[11px] uppercase tracking-wide text-slate-500">Line #{l.line_no || i + 1}</p>
                        <p className="text-sm font-semibold text-slate-800 break-words">{l.item_name || l.product_name || '-'}</p>
                        {l.item_type && l.item_type !== 'PRODUCT' && (
                          <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${l.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'}`}>
                            {l.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                          </span>
                        )}
                      </div>
                      <p className="shrink-0 text-sm font-bold text-red-700 whitespace-nowrap">{fmt(l.total_value)}</p>
                    </div>
                    <div className="px-3 py-2 grid grid-cols-3 gap-x-2 gap-y-2 text-xs">
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">Received</p>
                        <p className="text-slate-700">{l.received_quantity}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">Accepted</p>
                        <p className="text-emerald-700">{l.accepted_quantity}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">Rejected</p>
                        <p className="text-red-700 font-semibold">{l.rejected_quantity}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">UOM</p>
                        <p className="text-slate-700">{l.uom}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">Batch</p>
                        <p className="text-slate-700">{l.batch_no || '-'}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">Rate</p>
                        <p className="text-slate-700">{fmt(l.unit_price)}</p>
                      </div>
                      <div className="col-span-3">
                        <p className="text-[10px] uppercase text-slate-500">Reason</p>
                        <span className="inline-block px-2 py-0.5 bg-red-50 text-red-700 text-xs font-medium rounded">{REASON_MAP[l.rejection_reason] || l.rejection_reason}</span>
                      </div>
                      {l.remarks && (
                        <div className="col-span-3">
                          <p className="text-[10px] uppercase text-slate-500">Remarks</p>
                          <p className="text-xs text-slate-600 break-words">{l.remarks}</p>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex justify-between">
                  <span className="text-slate-700 font-semibold">Total Rejected Value</span>
                  <span className="text-red-700 font-bold">{fmt(rejection.total_rejected_value)}</span>
                </div>
              </div>
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Item</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Received</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Accepted</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Rejected</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Batch</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Rate</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Value</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Reason</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={l.id || i} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{l.line_no || i + 1}</td>
                        <td className="px-3 py-2 font-medium">
                          {l.item_name || l.product_name || '-'}
                          {l.item_type && l.item_type !== 'PRODUCT' && (
                            <span className={`ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium align-middle ${
                              l.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'
                            }`}>
                              {l.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">{l.received_quantity}</td>
                        <td className="px-3 py-2 text-right text-emerald-600">{l.accepted_quantity}</td>
                        <td className="px-3 py-2 text-right text-red-600 font-semibold">{l.rejected_quantity}</td>
                        <td className="px-3 py-2">{l.uom}</td>
                        <td className="px-3 py-2">{l.batch_no || '-'}</td>
                        <td className="px-3 py-2 text-right">{fmt(l.unit_price)}</td>
                        <td className="px-3 py-2 text-right text-red-600 font-medium">{fmt(l.total_value)}</td>
                        <td className="px-3 py-2"><span className="px-2 py-0.5 bg-red-50 text-red-700 text-xs font-medium rounded">{REASON_MAP[l.rejection_reason] || l.rejection_reason}</span></td>
                        <td className="px-3 py-2 text-xs text-slate-500">{l.remarks || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 font-semibold border-t-2">
                      <td colSpan="8" className="px-3 py-2 text-right">Total Rejected Value:</td>
                      <td className="px-3 py-2 text-right text-red-700">{fmt(rejection.total_rejected_value)}</td>
                      <td colSpan="2"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Return Details */}
            {rejection.return_to_vendor && !isHidden('return_to_vendor') && (
              <div className="bg-white rounded-lg border p-3 sm:p-4">
                <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Return Details</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2 text-sm">
                  <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">Return to Vendor</span><span className="text-green-600 font-semibold">Yes</span></div>
                  {!isHidden('return_type') && (
                  <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">Return Type</span><span className="font-medium">{rejection.return_type_display || rejection.return_type || '-'}</span></div>
                  )}
                  {!isHidden('return_date') && (
                  <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">Return Date</span><span className="font-medium">{fmtDate(rejection.return_date)}</span></div>
                  )}
                  {!isHidden('replacement_expected_date') && (
                  <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">Replacement Expected</span><span className="font-medium">{fmtDate(rejection.replacement_expected_date)}</span></div>
                  )}
                  {!isHidden('debit_note_required') && (
                  <div><span className="text-xs font-semibold text-slate-700 block mb-0.5">Debit Note Required</span><span className={`font-medium ${rejection.debit_note_required ? 'text-green-600' : 'text-slate-400'}`}>{rejection.debit_note_required ? 'Yes' : 'No'}</span></div>
                  )}
                </div>
              </div>
            )}

            <FileAttachments module="REJECTION" recordId={id} />
          </div>

          {/* Summary Sidebar */}
          <div className="space-y-3">
            <div className="bg-white rounded-lg border p-3 sm:p-4">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Summary</h3>
              <div className="space-y-3">
                <div className="flex justify-between"><span className="text-sm text-slate-500">Status</span><StatusBadge status={rejection.status_display || rejection.status} /></div>
                <div><p className="text-xs text-slate-500 uppercase">Total Rejected Value</p><p className="text-2xl font-bold text-red-700 mt-1">{fmt(rejection.total_rejected_value)}</p></div>
                <div className="flex justify-between"><span className="text-sm text-slate-500">Items</span><span className="text-sm font-medium">{lines.length}</span></div>
                <div className="flex justify-between"><span className="text-sm text-slate-500">Return to Vendor</span><span className="text-sm font-medium">{rejection.return_to_vendor ? 'Yes' : 'No'}</span></div>
                <div className="flex justify-between"><span className="text-sm text-slate-500">Debit Note</span><span className="text-sm font-medium">{rejection.debit_note_required ? 'Required' : 'Not Required'}</span></div>
              </div>
            </div>
            <div className="bg-white rounded-lg border p-3 sm:p-4">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Actions</h3>
              <div className="space-y-2">
                <button onClick={() => navigate(`/purchase/receipts/${rejection.receipt_advice}`)} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">View Receipt</button>
                <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/rejections'))} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">← Back to List</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
