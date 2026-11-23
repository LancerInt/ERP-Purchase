import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import { ArrowLeft, CheckCircle } from 'lucide-react';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const fmtDate = (v) => v ? formatDate(v) : '-';
const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

const REASON_LABELS = {
  DAMAGE: 'Damage',
  SPACE_OPTIMISATION: 'Space Optimisation',
  AUDIT: 'Audit',
  OTHER: 'Other',
};

export default function WarehouseShiftingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { isHidden } = useFieldPermissions('Shifting');
  const [shifting, setShifting] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isApproving, setIsApproving] = useState(false);
  const canApprove = can('Shifting', 'approve');

  const reload = () => apiClient.get(`/api/inventory/shifting/${id}/`).then((res) => setShifting(res.data));

  useEffect(() => {
    apiClient.get(`/api/inventory/shifting/${id}/`)
      .then((res) => setShifting(res.data))
      .catch((err) => { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); })
      .finally(() => setIsLoading(false));
  }, [id]);

  const handleApprove = async () => {
    if (!(await confirm({ message: `Approve ${shifting.shifting_no}? This will move stock OUT of ${shifting.from_godown_name} and IN to ${shifting.to_godown_name} within ${shifting.warehouse_name}.`, isDangerous: true }))) return;
    setIsApproving(true);
    try {
      await apiClient.post(`/api/inventory/shifting/${id}/approve/`);
      toast.success(`${shifting.shifting_no} approved`);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsApproving(false);
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

  if (!shifting) {
    return (
      <MainLayout>
        <div className="text-center py-20">
          <p className="text-red-500 mb-3">Shifting not found.</p>
          <button onClick={() => navigate('/inventory/shifting')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back to Shifting
          </button>
        </div>
      </MainLayout>
    );
  }

  const Field = ({ label, value }) => (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">{label}</p>
      <p className="text-slate-900 font-medium mt-1">{value || '-'}</p>
    </div>
  );

  const isDraft = shifting.status === 'DRAFT' || shifting.status === 'PENDING_APPROVAL';

  return (
    <MainLayout>
      <div className="text-sm text-slate-500 mb-3">
        <button onClick={() => navigate('/inventory/shifting')} className="hover:text-slate-700">Inventory</button>
        <span className="mx-2">/</span>
        <button onClick={() => navigate('/inventory/shifting')} className="hover:text-slate-700">Shifting</button>
        <span className="mx-2">/</span>
        <span className="text-slate-700 font-medium">{shifting.shifting_no}</span>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/inventory/shifting'))} aria-label="Back" title="Back" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg transition">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-bold text-slate-900">{shifting.shifting_no}</h1>
          <StatusBadge status={shifting.status} />
        </div>
        <div className="flex items-center gap-2">
          {isDraft && canApprove && (
            <button
              onClick={handleApprove}
              disabled={isApproving}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm font-semibold disabled:opacity-50"
            >
              <CheckCircle size={16} /> {isApproving ? 'Approving...' : 'Approve'}
            </button>
          )}
        </div>
      </div>

      {/* Shifting Details */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
        <h2 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Shifting Details</h2>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <Field label="Shifting No" value={shifting.shifting_no} />
          <Field label="Request Date" value={fmtDate(shifting.request_date)} />
          {!isHidden('warehouse') && <Field label="Warehouse" value={shifting.warehouse_name} />}
          {!isHidden('from_godown') && <Field label="From Godown" value={shifting.from_godown_name} />}
          {!isHidden('to_godown') && <Field label="To Godown" value={shifting.to_godown_name} />}
          {!isHidden('reason_code') && <Field label="Reason Code" value={REASON_LABELS[shifting.reason_code] || shifting.reason_code} />}
          <Field label="Total Qty" value={fmtQty(shifting.total_qty)} />
        </div>
        {shifting.other_reason && !isHidden('other_reason') && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-xs uppercase tracking-wide text-slate-500 font-medium mb-1">Other Reason / Notes</p>
            <p className="text-slate-900 whitespace-pre-wrap">{shifting.other_reason}</p>
          </div>
        )}
      </div>

      {/* Line Items */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
          Line Items ({(shifting.products || []).length})
        </h2>
        {(!shifting.products || shifting.products.length === 0) ? (
          <p className="text-sm text-slate-400 italic">No line items.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">#</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">Product</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">Batch</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-600">Available Stock</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-600">Shift Qty</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">UOM</th>
                </tr>
              </thead>
              <tbody>
                {shifting.products.map((p, idx) => (
                  <tr key={p.id || idx} className="border-b border-slate-50">
                    <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                    <td className="px-3 py-2">
                      <p className="font-medium text-slate-800">{p.product_name || '-'}</p>
                      {p.product_sku && <p className="text-xs text-slate-400">{p.product_sku}</p>}
                    </td>
                    <td className="px-3 py-2">{p.batch || '-'}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{fmtQty(p.available_stock)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{fmtQty(p.quantity)}</td>
                    <td className="px-3 py-2">{p.uom || '-'}</td>
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
