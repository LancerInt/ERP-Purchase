import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, XCircle, CheckCircle2 } from 'lucide-react';
import MainLayout from '../../../../components/layout/MainLayout';
import PageHeader from '../../../../components/common/PageHeader';
import StatusBadge from '../../../../components/common/StatusBadge';
import apiClient from '../../../../utils/api.js';
import usePermissions from '../../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../../hooks/useFieldPermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatDateTime } from '@/utils/formatters';

const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? formatDate(d) : '-';
const CYCLE_LABEL = { WEEKLY: 'Weekly', FOURTEEN_DAYS: '14 Days', CUSTOM: 'Custom Range' };

export default function WagePaymentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canDelete, canApprove } = usePermissions();
  // Field-level visibility for the Wage Payment detail view.
  const { isHidden } = useFieldPermissions('Wage Payment');
  const [payment, setPayment] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isApproving, setIsApproving] = useState(false);

  const fetchPayment = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/purchase/wage-payments/${id}/`);
      setPayment(res.data);
    } catch (err) { if (err.response?.status !== 404) toast.error('Failed to load payment'); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchPayment(); }, [id]);

  const handleCancel = async () => {
    if (!(await confirm({ message: 'Cancel this payment and release all wage lines back to UNPAID?', isDangerous: true }))) return;
    setIsCancelling(true);
    try {
      await apiClient.post(`/api/purchase/wage-payments/${id}/cancel/`);
      toast.success('Payment cancelled — wage lines released');
      fetchPayment();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to cancel');
    } finally {
      setIsCancelling(false);
    }
  };

  const handleApprove = async () => {
    if (!(await confirm({ message: 'Approve this payment? All selected wage lines will be marked Paid and the parent wage entries will roll up to Paid status.' }))) return;
    setIsApproving(true);
    try {
      await apiClient.post(`/api/purchase/wage-payments/${id}/approve/`);
      toast.success('Payment approved — wage lines marked Paid');
      fetchPayment();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to approve');
    } finally {
      setIsApproving(false);
    }
  };

  if (isLoading) return <MainLayout><div className="text-center py-12 text-slate-500">Loading...</div></MainLayout>;
  if (!payment) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">Payment not found.</p>
        <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/freight/wages/payments')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Back to Payments
        </button>
      </div>
    </MainLayout>
  );

  const isCancelled = payment.status === 'CANCELLED';
  const lines = payment.paid_lines || [];

  return (
    <MainLayout>
      <PageHeader
        title={payment.payment_no}
        subtitle={`Wage settlement — ${payment.contractor_name}`}
        breadcrumbs={[
          { label: 'Freight & Billing', href: '/freight/inward' },
          { label: 'Wages', href: '/freight/wages' },
          { label: 'Payments', href: '/freight/wages/payments' },
          { label: payment.payment_no },
        ]}
      />

      {/* Compact header — status pill only. Cancel + Back live in the
          Actions sidebar card on the right so the page has a single
          place to act on the document. */}
      <div className="flex items-center justify-end mb-4">
        <StatusBadge status={payment.status_display || payment.status} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-4 sm:space-y-5">
          {/* Header info */}
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Payment Info</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              {!isHidden('contractor') && <Field label="Contractor"     value={payment.contractor_name} />}
              {!isHidden('payment_date') && <Field label="Payment Date"   value={fmtDate(payment.payment_date)} />}
              {!isHidden('cycle_type') && <Field label="Cycle"          value={CYCLE_LABEL[payment.cycle_type] || payment.cycle_type} />}
              {!isHidden('from_date') && <Field label="Period From"    value={fmtDate(payment.from_date)} />}
              {!isHidden('to_date') && <Field label="Period To"      value={fmtDate(payment.to_date)} />}
              {!isHidden('payment_mode') && <Field label="Payment Mode"   value={payment.payment_mode_display || payment.payment_mode} />}
              {!isHidden('reference_no') && <Field label="Reference No"   value={payment.reference_no || '-'} />}
              <Field label="Created By"     value={payment.created_by_name || '-'} />
              <Field label="Created At"     value={payment.created_at ? formatDateTime(payment.created_at) : '-'} />
            </div>
            {payment.remarks && !isHidden('remarks') && (
              <div className="mt-4 pt-4 border-t">
                <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">Remarks</p>
                <p className="text-sm text-slate-700">{payment.remarks}</p>
              </div>
            )}
          </div>

          {/* Settled lines */}
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Settled Wage Lines ({lines.length})</h3>
            {/* Desktop table */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '800px' }}>
                <thead>
                  <tr className="bg-primary-50 border-b-2 border-slate-300">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Wage Entry</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Source</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Work Date</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Type</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Ton</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Rate</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Amount</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Advance</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(l => (
                    <tr key={l.id} className="border-b border-slate-50 hover:bg-blue-50/20">
                      <td className="px-3 py-2"><button onClick={() => navigate(`/freight/wages/${l.entry_id}`)} className="text-primary-600 hover:underline text-xs">{l.entry_no}</button></td>
                      <td className="px-3 py-2 text-xs text-slate-600">{l.source_type_display}</td>
                      <td className="px-3 py-2 text-xs">{fmtDate(l.work_date)}</td>
                      <td className="px-3 py-2"><span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${l.wage_type === 'LOADING' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>{l.wage_type_display}</span></td>
                      <td className="px-3 py-2 text-right">{Number(l.tons || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                      <td className="px-3 py-2 text-right">{fmt(l.cost_per_ton)}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmt(l.amount)}</td>
                      <td className="px-3 py-2 text-right text-amber-700">{fmt(l.advance_paid)}</td>
                      <td className="px-3 py-2 text-right font-semibold text-emerald-700">{fmt(l.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="sm:hidden space-y-2">
              {lines.map(l => (
                <div key={l.id} className="border border-slate-200 rounded-lg bg-white p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <button onClick={() => navigate(`/freight/wages/${l.entry_id}`)} className="text-sm font-semibold text-primary-600 hover:underline truncate">{l.entry_no}</button>
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${l.wage_type === 'LOADING' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>{l.wage_type_display}</span>
                  </div>
                  <p className="text-xs text-slate-500 mb-2">{l.source_type_display} · {fmtDate(l.work_date)}</p>
                  <div className="grid grid-cols-3 gap-1 text-[11px]">
                    <div><span className="text-slate-500">Ton:</span> {Number(l.tons || 0).toLocaleString('en-IN')}</div>
                    <div><span className="text-slate-500">Rate:</span> {fmt(l.cost_per_ton)}</div>
                    <div><span className="text-slate-500">Amt:</span> {fmt(l.amount)}</div>
                    <div><span className="text-slate-500">Adv:</span> <span className="text-amber-700">{fmt(l.advance_paid)}</span></div>
                    <div className="col-span-2"><span className="text-slate-500">Bal:</span> <span className="text-emerald-700 font-semibold">{fmt(l.balance)}</span></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Sidebar — totals */}
        <div className="space-y-4 sm:space-y-5">
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Settlement Totals</h3>
            <div className="space-y-3">
              {!isHidden('line_count') && <Row label="Lines"          value={payment.line_count} />}
              {!isHidden('gross_wages') && <Row label="Gross Wages"    value={fmt(payment.gross_wages)} />}
              {!isHidden('total_advance') && <Row label="Advance Adjusted" value={fmt(payment.total_advance)} cls="text-amber-700" />}
              {!isHidden('net_payable') && (
                <div className="border-t pt-3">
                  <Row label="Net Payable"  value={fmt(payment.net_payable)}  cls="text-slate-900 font-bold" />
                </div>
              )}
              {!isHidden('paid_amount') && <Row label="Paid Amount"    value={fmt(payment.paid_amount)}  cls="text-emerald-700 font-bold" />}
              {Number(payment.balance_amount) !== 0 && !isHidden('balance_amount') && (
                <Row label="Balance"      value={fmt(payment.balance_amount)} cls="text-orange-600 font-bold" />
              )}
            </div>
          </div>
          {isCancelled && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
              <p className="font-semibold mb-1">Payment cancelled</p>
              <p className="text-xs">All settled wage lines have been released back to UNPAID and can now be picked up in a new payment.</p>
            </div>
          )}

          {/* Actions card — moved here from the Wage Entry detail page
              since this settlement document is what owns mutating state
              now.
                • Approve  (DRAFT only)   → mark payment + lines + entries Paid
                • Cancel   (DRAFT or COMPLETED) → release lines
                • Back to Payments         → navigate */}
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Actions</h3>
            {payment.status === 'DRAFT' && (
              <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                <span className="font-semibold">Draft.</span> Wage lines are reserved but not yet marked Paid. Click <strong>Approve</strong> below to finalize.
              </div>
            )}
            <div className="space-y-2">
              {canApprove('Wage Payment') && payment.status === 'DRAFT' && (
                <button
                  onClick={handleApprove}
                  disabled={isApproving}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                >
                  <CheckCircle2 size={14} /> {isApproving ? 'Approving…' : 'Approve & Mark Paid'}
                </button>
              )}
              {canDelete('Wage Payment') && !isCancelled && (
                <button
                  onClick={handleCancel}
                  disabled={isCancelling}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50"
                >
                  <XCircle size={14} /> {isCancelling ? 'Cancelling…' : 'Cancel Payment'}
                </button>
              )}
              <button
                onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/freight/wages/payments'))}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
              >
                <ArrowLeft size={14} /> Back to Payments
              </button>
            </div>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-sm text-slate-800 font-medium mt-0.5 break-words">{value}</p>
    </div>
  );
}

function Row({ label, value, cls = 'text-slate-800' }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-xs text-slate-500 uppercase">{label}</span>
      <span className={`text-base ${cls}`}>{value}</span>
    </div>
  );
}
