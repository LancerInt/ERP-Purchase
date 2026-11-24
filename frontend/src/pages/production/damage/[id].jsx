import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Check, X, ArrowLeft, Loader2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate, formatDateTime } from '../../../utils/formatters.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-slate-800 mt-0.5 whitespace-pre-wrap">{value || '-'}</p>
    </div>
  );
}

export default function ProductionDamageDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canApprove } = usePermissions();
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [acting, setActing] = useState(false);

  const load = useCallback(() => {
    setIsLoading(true);
    apiClient.get(`/api/production/damages/${id}/`)
      .then((res) => { setData(res.data); setError(false); })
      .catch(() => setError(true))
      .finally(() => setIsLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const act = async (kind) => {
    if (kind === 'approve' && !(await confirm({ message: 'Approve this damage entry? The damaged quantities will be deducted from inventory.' }))) return;
    if (kind === 'reject' && !(await confirm({ message: 'Reject this damage entry?', isDangerous: true }))) return;
    setActing(true);
    try {
      await apiClient.post(`/api/production/damages/${id}/${kind}/`);
      toast.success(kind === 'approve' ? 'Approved — stock deducted.' : 'Rejected.');
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setActing(false);
    }
  };

  if (isLoading) {
    return <MainLayout><div className="flex justify-center py-20"><Loader2 className="animate-spin text-primary-600" /></div></MainLayout>;
  }
  if (error || !data) {
    return (
      <MainLayout>
        <div className="text-center py-20">
          <p className="text-red-500 mb-3">Damage entry not found.</p>
          <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/production/damage')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back
          </button>
        </div>
      </MainLayout>
    );
  }

  const canAct = canApprove('Production Damage') && (data.status === 'DRAFT' || data.status === 'PENDING_APPROVAL');

  return (
    <MainLayout>
      <PageHeader
        title={data.document_no}
        breadcrumbs={[{ label: 'Production' }, { label: 'Damage', href: '/production/damage' }, { label: data.document_no }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 space-y-5">
        <div className="flex items-center justify-between gap-3 pb-3 border-b">
          <div className="flex items-center gap-3">
            <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/production/damage'))} className="text-slate-500 hover:text-slate-800"><ArrowLeft size={18} /></button>
            <StatusBadge status={data.status_display || data.status} />
          </div>
          {canAct && (
            <div className="flex gap-2">
              <button onClick={() => act('reject')} disabled={acting} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50">
                <X size={15} /> Reject
              </button>
              <button onClick={() => act('approve')} disabled={acting} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50">
                {acting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Approve &amp; Deduct Stock
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Field label="Date" value={data.damage_date ? formatDate(data.damage_date) : '-'} />
          <Field label="Company" value={data.company_name} />
          <Field label="Warehouse" value={data.warehouse_name} />
          <Field label="Godown" value={data.godown_name} />
          <Field label="Created By" value={data.created_by_name} />
          {data.approved_at && <Field label={data.status === 'REJECTED' ? 'Rejected By' : 'Approved By'} value={data.approved_by_name} />}
          {data.approved_at && <Field label={data.status === 'REJECTED' ? 'Rejected At' : 'Approved At'} value={formatDateTime(data.approved_at)} />}
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Damaged Products ({(data.damage_items || []).length})</h3>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">Batch</th>
                  <th className="px-3 py-2 font-medium text-right">Qty</th>
                  <th className="px-3 py-2 font-medium">UOM</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {(data.damage_items || []).map((it) => (
                  <tr key={it.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-3 py-2">
                      {it.product_name || '-'}
                      {it.product_code && <span className="text-xs text-slate-400 ml-1">{it.product_code}</span>}
                    </td>
                    <td className="px-3 py-2">{it.batch || '-'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(it.quantity).toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2">{it.uom || '-'}</td>
                    <td className="px-3 py-2">{it.reason || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {data.remarks && <Field label="Remarks" value={data.remarks} />}
        {data.approval_remarks && <Field label="Approval Remarks" value={data.approval_remarks} />}
      </div>
    </MainLayout>
  );
}
