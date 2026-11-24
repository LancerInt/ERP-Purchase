import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import { ArrowLeft, CheckCircle, XCircle, Flag } from 'lucide-react';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { confirm } from '@/components/common/confirm';

const fmtDate = (v) => v ? formatDate(v) : '-';
const fmtAmt = (v) => formatCurrency(v);
const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export default function StockTransferDCDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { isHidden } = useFieldPermissions('Stock Transfer');
  const { isHidden: isLineHidden } = useFieldPermissions('Stock Transfer Line');
  const [transfer, setTransfer] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isWorking, setIsWorking] = useState(false);

  const reload = () => {
    return apiClient.get(`/api/inventory/transfers/${id}/`).then((res) => setTransfer(res.data));
  };

  useEffect(() => {
    apiClient.get(`/api/inventory/transfers/${id}/`)
      .then((res) => setTransfer(res.data))
      .catch((err) => { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); })
      .finally(() => setIsLoading(false));
  }, [id]);

  const callAction = async (path, confirmText, successText) => {
    if (confirmText && !(await confirm({ message: confirmText, isDangerous: true }))) return;
    setIsWorking(true);
    try {
      await apiClient.post(`/api/inventory/transfers/${id}/${path}/`);
      toast.success(successText);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsWorking(false);
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

  if (!transfer) {
    return (
      <MainLayout>
        <div className="text-center py-20">
          <p className="text-red-500 mb-3">Transfer not found.</p>
          <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/inventory/transfers')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back to Transfers
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

  return (
    <MainLayout>
      <div className="text-sm text-slate-500 mb-3">
        <button onClick={() => navigate('/inventory/transfers')} className="hover:text-slate-700">Inventory</button>
        <span className="mx-2">/</span>
        <button onClick={() => navigate('/inventory/transfers')} className="hover:text-slate-700">Transfers</button>
        <span className="mx-2">/</span>
        <span className="text-slate-700 font-medium">{transfer.transfer_no}</span>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/inventory/transfers'))} aria-label="Back" title="Back" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg transition">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-bold text-slate-900">{transfer.transfer_no}</h1>
          <StatusBadge status={transfer.status} />
        </div>
        <div className="flex items-center gap-2">
          {transfer.status === 'DRAFT' && can('Stock Transfer', 'approve') && (
            <button
              onClick={() => callAction('approve', `Approve ${transfer.transfer_no}? This will move stock OUT of ${transfer.from_warehouse_name} and IN at ${transfer.to_warehouse_name}.`, 'Transfer approved')}
              disabled={isWorking}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm font-semibold disabled:opacity-50"
            >
              <CheckCircle size={16} /> Approve
            </button>
          )}
          {transfer.status === 'DRAFT' && can('Stock Transfer', 'cancel') && (
            <button
              onClick={() => callAction('cancel', `Cancel ${transfer.transfer_no}?`, 'Transfer cancelled')}
              disabled={isWorking}
              className="flex items-center gap-2 px-4 py-2 border border-red-300 rounded-lg text-red-600 hover:bg-red-50 transition text-sm font-medium disabled:opacity-50"
            >
              <XCircle size={16} /> Cancel
            </button>
          )}
          {transfer.status === 'APPROVED' && can('Stock Transfer', 'close') && (
            <button
              onClick={() => callAction('complete', `Mark ${transfer.transfer_no} as Completed?`, 'Transfer completed')}
              disabled={isWorking}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition text-sm font-semibold disabled:opacity-50"
            >
              <Flag size={16} /> Mark Completed
            </button>
          )}
        </div>
      </div>

      {/* Transfer Details */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
        <h2 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Transfer Details</h2>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <Field label="Transfer No" value={transfer.transfer_no} />
          {!isHidden('transfer_date') && <Field label="Transfer Date" value={fmtDate(transfer.transfer_date)} />}
          {!isHidden('company') && <Field label="Company" value={transfer.company_name} />}
          {!isHidden('from_warehouse') && <Field label="From Warehouse" value={transfer.from_warehouse_name} />}
          {!isHidden('from_godown') && <Field label="From Godown" value={transfer.from_godown_name} />}
          {!isHidden('to_warehouse') && <Field label="To Warehouse" value={transfer.to_warehouse_name} />}
          {!isHidden('to_godown') && <Field label="To Godown" value={transfer.to_godown_name} />}
          {!isHidden('status') && <Field label="Status" value={transfer.status} />}
          <Field label="Created" value={fmtDate(transfer.created_date)} />
          {!isHidden('dispatch_date') && <Field label="Dispatch Date" value={fmtDate(transfer.dispatch_date)} />}
          {!isHidden('transporter') && <Field label="Transporter" value={transfer.transporter_name} />}
          {!isHidden('freight_terms') && <Field label="Freight Terms" value={
            transfer.freight_terms === 'TO_PAY' ? 'To Pay'
              : transfer.freight_terms === 'PAID' ? 'Paid'
              : transfer.freight_terms
          } />}
          {!isHidden('vehicle_no') && <Field label="Vehicle No" value={transfer.vehicle_no} />}
        </div>
        {transfer.remarks && !isHidden('remarks') && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">Remarks</p>
            <p className="text-slate-900 mt-1 whitespace-pre-wrap">{transfer.remarks}</p>
          </div>
        )}
      </div>

      {/* Costs */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
        <h2 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Costs</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {!isHidden('loading_wages') && <Field label="Loading Wages" value={fmtAmt(transfer.loading_wages)} />}
          {!isHidden('freight_amount') && <Field label="Freight Amount" value={fmtAmt(transfer.freight_amount)} />}
          <Field label="Total Qty" value={fmtQty(transfer.total_qty)} />
        </div>
      </div>

      {/* Line Items */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
          Line Items ({(transfer.lines || []).length})
        </h2>
        {(!transfer.lines || transfer.lines.length === 0) ? (
          <p className="text-sm text-slate-400 italic">No line items.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">#</th>
                  {!isLineHidden('product') && <th className="text-left px-3 py-2 font-semibold text-slate-600">Product</th>}
                  {!isLineHidden('batch') && <th className="text-left px-3 py-2 font-semibold text-slate-600">Batch</th>}
                  {!isLineHidden('quantity') && <th className="text-right px-3 py-2 font-semibold text-slate-600">Quantity</th>}
                  {!isLineHidden('uom') && <th className="text-left px-3 py-2 font-semibold text-slate-600">UOM</th>}
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">Source Godown</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">Destination Godown</th>
                </tr>
              </thead>
              <tbody>
                {transfer.lines.map((l, idx) => (
                  <tr key={l.id || idx} className="border-b border-slate-50">
                    <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                    {!isLineHidden('product') && <td className="px-3 py-2">{l.product_name || '-'}</td>}
                    {!isLineHidden('batch') && <td className="px-3 py-2">{l.batch || '-'}</td>}
                    {!isLineHidden('quantity') && <td className="px-3 py-2 text-right">{fmtQty(l.quantity)}</td>}
                    {!isLineHidden('uom') && <td className="px-3 py-2">{l.uom || '-'}</td>}
                    <td className="px-3 py-2">{l.source_godown_name || '-'}</td>
                    <td className="px-3 py-2">{l.destination_godown_name || '-'}</td>
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
