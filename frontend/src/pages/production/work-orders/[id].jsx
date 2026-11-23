import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Trash2, Paperclip, Download, Check, X as XIcon } from 'lucide-react';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { confirm } from '@/components/common/confirm';
import { promptText } from '@/components/common/prompt';
import { formatDate } from '@/utils/formatters';

const STAGE_FLOW = [
  { value: 'MATERIAL_ISSUE', label: 'Material Issued' },
  { value: 'PACKING', label: 'Packing' },
  { value: 'QC', label: 'Quality Check' },
  { value: 'CLOSED', label: 'Closed' },
];

const fmtQty = (v) =>
  Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtMoney = (v) =>
  `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (v) =>
  v ? formatDate(v) : '-';
const fmtBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export default function WorkOrderDetail() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { canDelete, canApprove, canReject } = usePermissions();
  // Field-level permissions for the Work Order header — hide HIDDEN fields'
  // display rows for the current user's role. (This is a read-only detail
  // page, so there are no editable inputs to lock READ_ONLY.)
  const { isHidden } = useFieldPermissions('Work Order');
  // Line-item field permissions for the read-only Input/Output tables.
  const { isHidden: isInHidden } = useFieldPermissions('Work Order Input');
  const { isHidden: isOutHidden } = useFieldPermissions('Work Order Output');

  const [data, setData] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isApproving, setIsApproving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiClient.get(`/api/production/work-orders/${id}/`),
      apiClient.get('/api/production/attachments/', {
        params: { module: 'WORK_ORDER', record_id: id },
      }),
    ])
      .then(([wo, atts]) => {
        if (cancelled) return;
        setData(wo.data);
        setAttachments(atts.data?.results || atts.data || []);
      })
      .catch((err) => {
        toast.error(getApiErrorMessage(err) || 'Failed to load Work Order.');
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // Derive the timeline status from the WO's current stage_status.
  const timeline = useMemo(() => {
    if (!data) return [];
    const currentIdx = STAGE_FLOW.findIndex((s) => s.value === data.stage_status);
    return STAGE_FLOW.map((s, idx) => {
      let status = 'PENDING';
      if (currentIdx === -1) {
        status = 'PENDING';
      } else if (idx < currentIdx) {
        status = 'COMPLETED';
      } else if (idx === currentIdx) {
        // The "current" stage hasn't been completed yet.
        status = data.stage_status === 'CLOSED' ? 'COMPLETED' : 'IN_PROGRESS';
      }
      return { ...s, status };
    });
  }, [data]);

  const completedStages = timeline.filter((t) => t.status === 'COMPLETED').length;
  const totalStages = timeline.length;
  const progress = totalStages ? Math.round((completedStages / totalStages) * 100) : 0;

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete "${data.work_order_no || data.batch_id}"? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/production/work-orders/${id}/`);
      toast.success('Work Order deleted.');
      navigate('/production/work-orders');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  const handleApprove = async () => {
    if (!(await confirm({ message: `Approve "${data.work_order_no || data.batch_id}"?` }))) return;
    setIsApproving(true);
    try {
      const res = await apiClient.post(`/api/production/work-orders/${id}/approve/`);
      setData(res.data);
      toast.success('Work Order approved.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to approve.');
    } finally {
      setIsApproving(false);
    }
  };

  const handleReject = async () => {
    const remarks = await promptText({ title: 'Reject Work Order', label: 'Reason for rejection', placeholder: 'Optional', multiline: true, confirmLabel: 'Reject', isDangerous: true });
    if (remarks === null) return;
    setIsApproving(true);
    try {
      const res = await apiClient.post(`/api/production/work-orders/${id}/reject/`, {
        approval_remarks: remarks,
      });
      setData(res.data);
      toast.success('Work Order rejected.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to reject.');
    } finally {
      setIsApproving(false);
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />
          ))}
        </div>
      </MainLayout>
    );
  }

  if (!data) return null;

  const inputRows = data.input_consumptions || [];
  const outputRows = data.output_products || [];

  return (
    <MainLayout>
      <PageHeader
        title={data.work_order_no || data.batch_id}
        subtitle={`${data.finished_product_name || '-'} · ${data.process_name || '-'}`}
        breadcrumbs={[
          { label: 'Production', href: '/production' },
          { label: 'Work Orders', href: '/production/work-orders' },
          { label: data.work_order_no || data.batch_id },
        ]}
      />

      <div className="flex justify-end items-center gap-2 mb-4">
        <span className="mr-auto inline-flex items-center gap-2 text-sm">
          <span className="text-slate-500">Approval:</span>
          <StatusBadge status={data.approval_status || 'PENDING'} />
          {data.approved_by_name && data.approval_status !== 'PENDING' && (
            <span className="text-xs text-slate-400">by {data.approved_by_name}</span>
          )}
        </span>
        {/* Once the WO is APPROVED its stock movements are posted to
            the Inventory Ledger — Reject and Delete are hidden so the
            operator can't silently reverse or remove the posting from
            the detail page. To undo an approved WO, use the soft-delete
            flow from the list page (which runs the proper ledger
            reversal). */}
        {canApprove('Work Order') && data.approval_status !== 'APPROVED' && data.approval_status !== 'REJECTED' && (
          <button type="button" onClick={handleApprove} disabled={isApproving}
            className="inline-flex items-center gap-1 px-4 py-2 bg-emerald-50 text-emerald-700 rounded-lg text-sm font-medium hover:bg-emerald-100 border border-emerald-200 disabled:opacity-50">
            <Check size={14} /> {isApproving ? 'Approving…' : 'Approve'}
          </button>
        )}
        {canReject('Work Order') && data.approval_status !== 'APPROVED' && data.approval_status !== 'REJECTED' && (
          <button type="button" onClick={handleReject} disabled={isApproving}
            className="inline-flex items-center gap-1 px-4 py-2 bg-amber-50 text-amber-700 rounded-lg text-sm font-medium hover:bg-amber-100 border border-amber-200 disabled:opacity-50">
            <XIcon size={14} /> Reject
          </button>
        )}
        {canDelete('Work Order') && data.approval_status !== 'APPROVED' && (
          <button type="button" onClick={handleDelete}
            className="inline-flex items-center gap-1 px-4 py-2 bg-red-50 text-red-700 rounded-lg text-sm font-medium hover:bg-red-100 border border-red-200">
            <Trash2 size={14} /> Delete
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">
        <div className="lg:col-span-2 space-y-4 sm:space-y-5">
          {/* Details */}
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-xl font-semibold text-slate-900 mb-4">Details</h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
              {!isHidden('work_order_no') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Work Order No</p>
                <p className="text-slate-900 font-mono mt-1">{data.work_order_no || '-'}</p>
              </div>
              )}
              {!isHidden('batch_id') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Batch ID</p>
                <p className="text-slate-900 font-mono mt-1">{data.batch_id || '-'}</p>
              </div>
              )}
              {!isHidden('finished_product') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Product</p>
                <p className="text-slate-900 font-semibold mt-1">{data.finished_product_name || '-'}</p>
              </div>
              )}
              {!isHidden('process') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Process</p>
                <p className="text-slate-900 font-medium mt-1">
                  {data.process_name || data.process_name_snapshot || '-'}
                </p>
              </div>
              )}
              {!isHidden('company') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Company</p>
                <p className="text-slate-900 mt-1">{data.company_name || '-'}</p>
              </div>
              )}
              {!isHidden('warehouse') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Warehouse</p>
                <p className="text-slate-900 mt-1">{data.warehouse_name || data.warehouse_code || '-'}</p>
              </div>
              )}
              {!isHidden('bom_template') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">BOM Template</p>
                <p className="text-slate-900 mt-1">
                  {data.bom_template_name || data.bom_template_code || '-'}
                  {data.template_revision ? <span className="text-xs text-slate-400 ml-2">Rev {data.template_revision}</span> : null}
                </p>
              </div>
              )}
              {!isHidden('machine_name') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Machine</p>
                <p className="text-slate-900 mt-1">{data.machine_name_label || '-'}</p>
              </div>
              )}
              {!isHidden('date') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Date</p>
                <p className="text-slate-900 mt-1">{fmtDate(data.date)}</p>
              </div>
              )}
              {!isHidden('production_date') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Production Date</p>
                <p className="text-slate-900 mt-1">{fmtDate(data.production_date)}</p>
              </div>
              )}
              {!isHidden('stage_status') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Stage</p>
                <div className="mt-1"><StatusBadge status={data.stage_status || 'MATERIAL_ISSUE'} /></div>
              </div>
              )}
              {!isHidden('wage_method') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Wage Method</p>
                <p className="text-slate-900 mt-1">{data.wage_method || '-'}</p>
              </div>
              )}
              {!isHidden('total_estimated_material_cost') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Total Material Cost</p>
                <p className="text-emerald-700 font-semibold mt-1">{fmtMoney(data.total_estimated_material_cost)}</p>
              </div>
              )}
              {!isHidden('cost_per_output_unit') && (
              <div>
                <p className="text-xs text-slate-500 font-medium">Cost / Output Unit</p>
                <p className="text-emerald-700 font-semibold mt-1">{fmtMoney(data.cost_per_output_unit)}</p>
              </div>
              )}
            </div>

            {!isHidden('notes') && data.notes && (
              <div className="mt-4 pt-6 border-t border-slate-200">
                <p className="text-xs text-slate-500 font-medium">Notes</p>
                <p className="text-slate-900 mt-2 whitespace-pre-wrap">{data.notes}</p>
              </div>
            )}

            {!isHidden('approval_remarks') && data.approval_remarks && (
              <div className="mt-4 pt-4 border-t border-slate-200">
                <p className="text-xs text-slate-500 font-medium">Approval Remarks</p>
                <p className="text-slate-700 mt-1 whitespace-pre-wrap">{data.approval_remarks}</p>
              </div>
            )}
          </div>

          {/* Input Products */}
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
              Input Products <span className="text-xs text-slate-400 font-normal">{inputRows.length} item(s)</span>
            </h3>
            {inputRows.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No input rows.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ minWidth: '700px' }}>
                  <thead>
                    <tr className="bg-slate-50 border-b">
                      <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                      {!isInHidden('product') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Product</th>}
                      {!isInHidden('uom') && <th className="px-2 py-2 text-left font-semibold text-slate-600">UOM</th>}
                      {!isInHidden('bom_standard_qty') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Input Qty</th>}
                      {!isInHidden('available_stock') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Stock</th>}
                      <th className="px-2 py-2 text-right font-semibold text-emerald-700">Total Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inputRows.map((row, idx) => (
                      <tr key={row.id || idx} className="border-b">
                        <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                        {!isInHidden('product') && <td className="px-2 py-2 text-slate-800 font-medium">{row.product_name || '-'}</td>}
                        {!isInHidden('uom') && <td className="px-2 py-2 text-slate-700">{row.uom || '-'}</td>}
                        {!isInHidden('bom_standard_qty') && <td className="px-2 py-2 text-right text-slate-700">{fmtQty(row.bom_standard_qty)}</td>}
                        {!isInHidden('available_stock') && <td className="px-2 py-2 text-right text-slate-700">{fmtQty(row.available_stock)}</td>}
                        <td className="px-2 py-2 text-right font-semibold text-emerald-700">{fmtMoney(row.estimated_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Output Products */}
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
              Output Products <span className="text-xs text-slate-400 font-normal">{outputRows.length} item(s)</span>
            </h3>
            {outputRows.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No output rows.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ minWidth: '700px' }}>
                  <thead>
                    <tr className="bg-slate-50 border-b">
                      <th className="px-2 py-2 text-left font-semibold text-slate-600 w-10">#</th>
                      {!isOutHidden('product') && <th className="px-2 py-2 text-left font-semibold text-slate-600">Output Product</th>}
                      {!isOutHidden('uom') && <th className="px-2 py-2 text-left font-semibold text-slate-600">UOM</th>}
                      {!isOutHidden('available_stock') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Stock</th>}
                      {!isOutHidden('planned_output_qty') && <th className="px-2 py-2 text-right font-semibold text-slate-600">Output Qty</th>}
                      {!isOutHidden('expected_output_qty') && <th className="px-2 py-2 text-right font-semibold text-emerald-700">Expected</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {outputRows.map((row, idx) => (
                      <tr key={row.id || idx} className="border-b">
                        <td className="px-2 py-2 font-mono text-slate-400">{idx + 1}</td>
                        {!isOutHidden('product') && <td className="px-2 py-2 text-slate-800 font-medium">{row.product_name || '-'}</td>}
                        {!isOutHidden('uom') && <td className="px-2 py-2 text-slate-700">{row.uom || '-'}</td>}
                        {!isOutHidden('available_stock') && <td className="px-2 py-2 text-right text-slate-700">{fmtQty(row.available_stock)}</td>}
                        {!isOutHidden('planned_output_qty') && <td className="px-2 py-2 text-right text-slate-700">{fmtQty(row.planned_output_qty)}</td>}
                        {!isOutHidden('expected_output_qty') && <td className="px-2 py-2 text-right font-semibold text-emerald-700">{fmtQty(row.expected_output_qty)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Progress */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
            <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-3">Progress</h3>
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs sm:text-sm text-slate-600 font-medium">Overall</p>
                  <p className="text-base font-bold text-slate-900">{progress}%</p>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2.5">
                  <div className="bg-blue-600 h-2.5 rounded-full transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200">
                <p className="text-xs sm:text-sm text-slate-600 font-medium mb-2">Stage Breakdown</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {timeline.map((step) => (
                    <div key={step.value} className="flex items-center gap-2 text-xs">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${
                        step.status === 'COMPLETED' ? 'bg-green-600'
                          : step.status === 'IN_PROGRESS' ? 'bg-blue-600'
                            : 'bg-slate-300'
                      }`} />
                      <span className="text-slate-700 truncate">{step.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-blue-50 rounded-lg border border-blue-200 p-3 flex items-center justify-between">
            <p className="text-xs sm:text-sm text-slate-600 font-medium">Completed Stages</p>
            <p className="text-xl font-bold text-blue-900">{completedStages}/{totalStages}</p>
          </div>
        </div>
      </div>

      {/* Production Timeline — horizontal */}
      <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5 mt-4 sm:mt-6">
        <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-4">Production Timeline</h3>
        <div className="flex overflow-x-auto ios-scroll touch-pan-x pb-1">
          {timeline.map((step, idx) => (
            <div key={step.value} className="flex flex-col items-center flex-1 min-w-[84px]">
              {/* Icon row with left/right connectors joining adjacent steps */}
              <div className="flex items-center w-full">
                <div className={`h-0.5 flex-1 ${idx === 0 ? 'bg-transparent' : (timeline[idx - 1].status === 'COMPLETED' ? 'bg-green-600' : 'bg-slate-200')}`} />
                <div className={`w-9 h-9 rounded-full flex items-center justify-center border-2 shrink-0 ${
                  step.status === 'COMPLETED' ? 'border-green-600 bg-green-50'
                    : step.status === 'IN_PROGRESS' ? 'border-blue-600 bg-blue-50'
                      : 'border-slate-300 bg-slate-50'
                }`}>
                  <div className={`w-2 h-2 rounded-full ${
                    step.status === 'COMPLETED' ? 'bg-green-600'
                      : step.status === 'IN_PROGRESS' ? 'bg-blue-600'
                        : 'bg-slate-300'
                  }`} />
                </div>
                <div className={`h-0.5 flex-1 ${idx === timeline.length - 1 ? 'bg-transparent' : (step.status === 'COMPLETED' ? 'bg-green-600' : 'bg-slate-200')}`} />
              </div>
              <div className="mt-2 text-center px-1">
                <div className="text-xs font-semibold text-slate-900 leading-tight">{step.label}</div>
                <StatusBadge status={step.status} className="mt-1" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Attachments — moved to the bottom */}
      <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5 mt-4 sm:mt-6">
        <div className="flex items-center gap-2 mb-3 pb-2 border-b">
          <Paperclip size={18} className="text-slate-600" />
          <h3 className="text-base sm:text-lg font-semibold text-slate-800">Attachments</h3>
          <span className="text-xs text-slate-400">{attachments.length} file(s)</span>
        </div>
        {attachments.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No files attached.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <Paperclip size={14} className="text-slate-400 flex-shrink-0" />
                <span className="flex-1 truncate text-slate-700">{a.file_name}</span>
                <span className="text-xs text-slate-400">{fmtBytes(a.file_size)}</span>
                <a href={a.file} target="_blank" rel="noreferrer"
                  className="p-1 text-blue-600 hover:bg-blue-50 rounded" title="Download">
                  <Download size={14} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </MainLayout>
  );
}
