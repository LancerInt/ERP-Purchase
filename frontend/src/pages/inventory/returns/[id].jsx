import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import { ArrowLeft, CheckCircle, Trash2 } from 'lucide-react';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { confirm } from '@/components/common/confirm';

const fmtDate = (v) => v ? formatDate(v) : '-';
const fmtAmt = (v) => formatCurrency(v);
const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export default function SalesReturnDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { isHidden } = useFieldPermissions('Sales Return');
  const [advice, setAdvice] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const canDelete = can('Sales Return', 'delete');
  const canApprovePerm = can('Sales Return', 'approve');

  const reload = () => apiClient.get(`/api/inventory/returns/${id}/`).then((res) => setAdvice(res.data));

  useEffect(() => {
    apiClient.get(`/api/inventory/returns/${id}/`)
      .then((res) => setAdvice(res.data))
      .catch((err) => { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); })
      .finally(() => setIsLoading(false));
  }, [id]);

  const handleApprove = async () => {
    if (!(await confirm({ message: `Approve ${advice.return_no}? Returned quantities will be added to ${advice.warehouse_name || 'the warehouse'} stock ledger.`, isDangerous: true }))) return;
    setIsWorking(true);
    try {
      await apiClient.post(`/api/inventory/returns/${id}/approve/`);
      toast.success('Return approved — stock ledger updated');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsWorking(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete ${advice.return_no}? Any ledger entries it posted will be reversed.`, isDangerous: true }))) return;
    setIsWorking(true);
    try {
      await apiClient.delete(`/api/inventory/returns/${id}/`);
      toast.success('Return deleted');
      navigate('/inventory/returns');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
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

  if (!advice) {
    return (
      <MainLayout>
        <div className="text-center py-20">
          <p className="text-red-500 mb-3">Return not found.</p>
          <button onClick={() => navigate('/inventory/returns')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back to Returns
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

  // Approve shows only when the user HAS the approve permission AND the
  // advice is still in an approvable state.
  const canApprove = canApprovePerm && ['DRAFT', 'PENDING'].includes(advice.approval_status);

  return (
    <MainLayout>
      <div className="text-sm text-slate-500 mb-3">
        <button onClick={() => navigate('/inventory/returns')} className="hover:text-slate-700">Inventory</button>
        <span className="mx-2">/</span>
        <button onClick={() => navigate('/inventory/returns')} className="hover:text-slate-700">Returns</button>
        <span className="mx-2">/</span>
        <span className="text-slate-700 font-medium">{advice.return_no}</span>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/inventory/returns'))} aria-label="Back" title="Back" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg transition">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-bold text-slate-900">{advice.return_no}</h1>
          <StatusBadge status={advice.approval_status} />
        </div>
        <div className="flex items-center gap-2">
          {canApprove && (
            <button
              onClick={handleApprove}
              disabled={isWorking}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm font-semibold disabled:opacity-50"
            >
              <CheckCircle size={16} /> Approve
            </button>
          )}
          {canDelete && (
            <button
              onClick={handleDelete}
              disabled={isWorking}
              className="flex items-center gap-2 px-4 py-2 border border-red-300 rounded-lg text-red-600 hover:bg-red-50 transition text-sm font-medium disabled:opacity-50"
            >
              <Trash2 size={16} /> Delete
            </button>
          )}
        </div>
      </div>

      {/* Return Details */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 mb-4">
        <h2 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Return Details</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Field label="Return No" value={advice.return_no} />
          {!isHidden('return_type') && <Field label="Return Type" value={advice.return_type} />}
          {!isHidden('return_date') && <Field label="Return Date" value={fmtDate(advice.return_date)} />}
          {!isHidden('customer') && <Field label="Customer" value={advice.customer_name} />}
          {!isHidden('company') && <Field label="Company" value={advice.company_name} />}
          {!isHidden('received_warehouse') && <Field label="Warehouse" value={advice.warehouse_name} />}
          {!isHidden('sales_order_no') && <Field label="Sales Order No" value={advice.sales_order_no} />}
          {!isHidden('delivery_challan_no') && <Field label="Delivery Challan No" value={advice.delivery_challan_no} />}
          {!isHidden('original_invoice_no') && <Field label="Original Invoice No" value={advice.original_invoice_no} />}
          <Field label="Source Document" value={advice.source_document} />
          {!isHidden('reason') && <Field label="Reason" value={advice.reason} />}
          {!isHidden('freight_terms') && <Field label="Freight Terms" value={advice.freight_terms} />}
          {!isHidden('transporter') && <Field label="Transporter" value={advice.transporter_name} />}
          {!isHidden('vehicle_no') && <Field label="Vehicle No" value={advice.vehicle_no} />}
          {!isHidden('qc_requirement') && <Field label="QC Requirement" value={advice.qc_requirement} />}
          {!isHidden('qc_status') && <Field label="QC Status" value={advice.qc_status} />}
          <Field label="Total Qty" value={fmtQty(advice.total_qty)} />
          <Field label="Total Amount" value={fmtAmt(advice.total_amount)} />
        </div>
        {advice.remarks && !isHidden('remarks') && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">Remarks</p>
            <p className="text-slate-900 mt-1 whitespace-pre-wrap">{advice.remarks}</p>
          </div>
        )}
      </div>

      {/* Line Items */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">
          Line Items ({(advice.lines || []).length})
        </h2>
        {(!advice.lines || advice.lines.length === 0) ? (
          <p className="text-sm text-slate-400 italic">No line items.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">#</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">Product</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">Batch</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">UOM</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-600">Return Qty</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-600">Rate</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-600">Amount</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">Remarks</th>
                </tr>
              </thead>
              <tbody>
                {advice.lines.map((line, idx) => (
                  <tr key={line.id || idx} className="border-b">
                    <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                    <td className="px-3 py-2">
                      <div className="text-slate-900">{line.product_name || '-'}</div>
                      {line.product_sku && <div className="text-[10px] text-slate-400">SKU: {line.product_sku}</div>}
                    </td>
                    <td className="px-3 py-2">{line.batch || '-'}</td>
                    <td className="px-3 py-2">{line.uom || '-'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(line.return_qty || line.quantity_returned)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtAmt(line.rate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtAmt(line.amount)}</td>
                    <td className="px-3 py-2 text-slate-600">{line.item_remarks || '-'}</td>
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
