import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, CheckCircle, XCircle } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const REASON_LABELS = { PARTY_SAMPLE: 'Party Sample', LAB_USE: 'Lab Use', EXTRA_BAG: 'Extra Bag', OTHER: 'Others' };
const loc = (wh, gd) => [wh, gd].filter(Boolean).join(' / ') || '-';

export default function MovementRequestDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canApprove = can('Stock Movement Request', 'approve');
  const [req, setReq] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const reload = () => apiClient.get(`/api/inventory/movement-requests/${id}/`).then((res) => setReq(res.data));

  useEffect(() => {
    apiClient.get(`/api/inventory/movement-requests/${id}/`)
      .then((res) => setReq(res.data))
      .catch((err) => { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); })
      .finally(() => setIsLoading(false));
  }, [id]);

  const runAction = async (action, message, successLabel) => {
    if (!(await confirm({ message, isDangerous: action === 'reject' }))) return;
    setBusy(true);
    try {
      await apiClient.post(`/api/inventory/movement-requests/${id}/${action}/`);
      toast.success(successLabel);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex justify-center py-20">
          <div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" />
        </div>
      </MainLayout>
    );
  }

  if (!req) {
    return (
      <MainLayout>
        <div className="text-center py-20">
          <p className="text-red-500 mb-3">Movement request not found.</p>
          <button onClick={() => navigate('/inventory/stock-movement')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back to Movement Requests
          </button>
        </div>
      </MainLayout>
    );
  }

  const isPending = req.status === 'DRAFT' || req.status === 'PENDING_APPROVAL';
  const Field = ({ label, value }) => (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">{label}</p>
      <p className="text-slate-900 font-medium mt-1 break-words">{value || '-'}</p>
    </div>
  );

  return (
    <MainLayout>
      <div className="text-sm text-slate-500 mb-3">
        <button onClick={() => navigate('/inventory/stock-movement')} className="hover:text-slate-700">Inventory</button>
        <span className="mx-2">/</span>
        <button onClick={() => navigate('/inventory/stock-movement')} className="hover:text-slate-700">Movement Requests</button>
        <span className="mx-2">/</span>
        <span className="text-slate-700 font-medium">{req.request_no}</span>
      </div>

      {/* Header + Approve at the top */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/inventory/stock-movement'))} aria-label="Back" title="Back" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg transition">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-bold text-slate-900">{req.request_no}</h1>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${
            req.movement_type === 'TRANSFER' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-amber-50 text-amber-700 border-amber-200'
          }`}>{req.movement_type_display || req.movement_type}</span>
          <StatusBadge status={req.status_display || req.status} />
        </div>
        {isPending && canApprove && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => runAction('approve', `Approve ${req.request_no}? It can then be pulled into a ${req.movement_type === 'TRANSFER' ? 'Stock Transfer' : 'Shifting'}.`, `${req.request_no} approved`)}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm font-semibold disabled:opacity-50"
            >
              <CheckCircle size={16} /> {busy ? 'Working…' : 'Approve'}
            </button>
            <button
              onClick={() => runAction('reject', `Reject ${req.request_no}?`, `${req.request_no} rejected`)}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition text-sm font-semibold disabled:opacity-50"
            >
              <XCircle size={16} /> Reject
            </button>
          </div>
        )}
      </div>

      {/* Details */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
        <h2 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Request Details</h2>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <Field label="Request No" value={req.request_no} />
          <Field label="Type" value={req.movement_type_display || req.movement_type} />
          <Field label="Date" value={req.request_date ? formatDate(req.request_date) : '-'} />
          <Field label="Company" value={req.company_name} />
          <Field label="From" value={loc(req.from_warehouse_name, req.from_godown_name)} />
          <Field label="To" value={loc(req.to_warehouse_name, req.to_godown_name)} />
          <Field label="Purpose / Reason" value={REASON_LABELS[req.reason_code] || req.reason_code} />
          <Field label="Total Qty" value={fmtQty(req.total_qty)} />
          <Field label="Raised By" value={req.raised_by_name} />
          <Field label="Approved By" value={req.approved_by_name} />
        </div>
        {req.remarks && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-xs uppercase tracking-wide text-slate-500 font-medium mb-1">Notes</p>
            <p className="text-slate-900 whitespace-pre-wrap">{req.remarks}</p>
          </div>
        )}
        {req.audio_note && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-xs uppercase tracking-wide text-slate-500 font-medium mb-1">Voice Note</p>
            <audio controls src={req.audio_note} className="w-full max-w-md" />
          </div>
        )}
      </div>

      {/* Line items */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
          Line Items ({(req.products || []).length})
        </h2>
        {(!req.products || req.products.length === 0) ? (
          <p className="text-sm text-slate-400 italic">No line items.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">#</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">Product</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">UOM</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-600">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {req.products.map((p, idx) => (
                  <tr key={p.id || idx} className="border-b border-slate-50">
                    <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                    <td className="px-3 py-2">
                      <p className="font-medium text-slate-800">{p.product_name || '-'}</p>
                      {p.product_sku && <p className="text-xs text-slate-400">{p.product_sku}</p>}
                    </td>
                    <td className="px-3 py-2">{p.uom || '-'}</td>
                    <td className="px-3 py-2 text-right font-semibold">{fmtQty(p.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
