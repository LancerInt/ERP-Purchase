import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Trash2, ArrowLeft } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? formatDate(d) : '-';

export default function WageEntryDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete, canApprove } = usePermissions();
  // Field-level visibility — header fields from 'Wage Entry', the wage
  // line table columns from 'Wage Entry Line'.
  const { isHidden } = useFieldPermissions('Wage Entry');
  const { isHidden: isLineHidden } = useFieldPermissions('Wage Entry Line');
  const [entry, setEntry] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchEntry = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/purchase/wage-entries/${id}/`);
      setEntry(res.data);
    } catch (err) { if (err.response?.status !== 404) toast.error('Failed to load wage entry'); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchEntry(); }, [id]);

  const handleConfirm = async () => {
    try {
      const res = await apiClient.post(`/api/purchase/wage-entries/${id}/confirm/`);
      setEntry(res.data);
      toast.success('Wage entry confirmed!');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to confirm'); }
  };

  const handleApprove = async () => {
    try {
      const res = await apiClient.post(`/api/purchase/wage-entries/${id}/confirm/`);
      setEntry(res.data);
      toast.success('Wage entry approved!');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to approve'); }
  };

  const handleClose = async () => {
    try {
      const res = await apiClient.post(`/api/purchase/wage-entries/${id}/close/`);
      setEntry(res.data);
      toast.success('Wage entry closed!');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to close'); }
  };

  const handleCancel = async () => {
    if (!(await confirm({ message: 'Cancel this wage entry?', isDangerous: true }))) return;
    try {
      const res = await apiClient.post(`/api/purchase/wage-entries/${id}/cancel/`);
      setEntry(res.data);
      toast.success('Wage entry cancelled');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to cancel'); }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete ${entry?.entry_no}? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/purchase/wage-entries/${id}/`);
      toast.success('Wage entry deleted');
      navigate('/freight/wages');
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to delete'); }
  };

  const InfoField = ({ label, children }) => (
    <div><p className="text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p><p className="text-slate-900 font-semibold mt-1">{children || '-'}</p></div>
  );

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" /></div></MainLayout>;
  if (!entry) return <MainLayout><div className="text-center py-20 text-red-500">Wage entry not found<br/><button onClick={() => navigate('/freight/wages')} className="mt-4 text-blue-600 underline">Back to list</button></div></MainLayout>;

  const lines = entry.wage_lines || [];
  const totalAmt = Number(entry.total_amount) || 0;
  const totalAdv = Number(entry.total_advance) || 0;
  const totalBal = Number(entry.total_balance) || 0;

  return (
    <MainLayout>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/freight/wages'))} aria-label="Back to list" title="Back to list" className="p-1 text-slate-500 hover:text-slate-700"><ArrowLeft size={20} /></button>
            <h1 className="text-2xl font-bold text-slate-900">{entry.entry_no}</h1>
          </div>
          <div className="flex items-center gap-4 ml-8">
            <StatusBadge status={entry.status_display || entry.status} />
            <p className="text-slate-500 text-sm">{fmtDate(entry.date)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap ml-8 sm:ml-0">
          {canDelete('Wage Entry') && entry.status === 'DRAFT' && (
            <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-600 bg-red-50 rounded-lg hover:bg-red-100"><Trash2 size={14} /> Delete</button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">
        <div className="lg:col-span-2 space-y-4 sm:space-y-5">
          {/* Reference Details */}
          <div className="bg-white rounded-lg border p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Reference Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
              <InfoField label="Entry No">{entry.entry_no}</InfoField>
              {!isHidden('date') && <InfoField label="Date">{fmtDate(entry.date)}</InfoField>}
              {!isHidden('receipt') && (
                <InfoField label="Purchase Receipt">
                  <span className="text-primary-600 cursor-pointer" onClick={() => navigate(`/purchase/receipts/${entry.receipt}`)}>{entry.receipt_no}</span>
                </InfoField>
              )}
              <InfoField label="Vendor">{entry.vendor_name}</InfoField>
              <InfoField label="PO Numbers">{(entry.po_numbers || []).join(', ')}</InfoField>
              <InfoField label="Receipt Date">{fmtDate(entry.receipt_date)}</InfoField>
            </div>
          </div>

          {/* Wage Rows */}
          <div className="bg-white rounded-lg border p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Loading / Unloading Wages ({lines.length})</h3>
            {lines.length === 0 ? (
              <p className="text-slate-400 text-center py-4 sm:py-5">No wage entries</p>
            ) : (
              <>
              {/* Mobile-stacked wage rows. */}
              <div className="sm:hidden space-y-2 mb-3">
                {lines.map((l, i) => (
                  <div key={`m-${l.id || i}`} className="border border-slate-200 rounded bg-white p-2">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="min-w-0">
                        <p className="text-[10px] uppercase text-slate-500">Line #{i + 1}</p>
                        <span className={`inline-block mt-0.5 px-2 py-0.5 rounded text-xs font-semibold ${l.wage_type === 'LOADING' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                          {l.wage_type_display || l.wage_type}
                        </span>
                      </div>
                      {!isLineHidden('wage_amount') && <p className="shrink-0 font-bold text-slate-900 whitespace-nowrap text-sm">{fmt(l.amount)}</p>}
                    </div>
                    <div className="grid grid-cols-2 gap-1 text-xs">
                      {!isLineHidden('contractor') && <div><span className="text-slate-500">Contractor:</span> <span className="text-slate-700 font-medium">{l.contractor_name || '-'}</span></div>}
                      <div><span className="text-slate-500">Date:</span> <span className="text-slate-700">{fmtDate(l.work_date)}</span></div>
                      <div className="col-span-2"><span className="text-slate-500">Status:</span> {l.payment_status === 'PAID' ? (
                        <button onClick={() => navigate(`/freight/wages/payments/${l.wage_payment}`)} className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
                          ✓ Paid · {l.wage_payment_no}
                        </button>
                      ) : (
                        <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">Unpaid</span>
                      )}</div>
                      {l.remarks && !isLineHidden('remarks') && (
                        <div className="col-span-2"><span className="text-slate-500">Remarks:</span> <span className="text-slate-600 break-words">{l.remarks}</span></div>
                      )}
                    </div>
                  </div>
                ))}
                {!isLineHidden('wage_amount') && (
                  <div className="bg-slate-50 border border-slate-200 rounded p-2 flex justify-between text-sm font-semibold">
                    <span>Total</span><span>{fmt(totalAmt)}</span>
                  </div>
                )}
              </div>
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b">
                      <th className="text-left px-3 py-2 text-xs text-slate-500 uppercase">#</th>
                      <th className="text-left px-3 py-2 text-xs text-slate-500 uppercase">Type</th>
                      {!isLineHidden('contractor') && <th className="text-left px-3 py-2 text-xs text-slate-500 uppercase">Contractor</th>}
                      <th className="text-left px-3 py-2 text-xs text-slate-500 uppercase">Work Date</th>
                      {!isLineHidden('wage_amount') && <th className="text-right px-3 py-2 text-xs text-slate-500 uppercase">Amount</th>}
                      <th className="text-left px-3 py-2 text-xs text-slate-500 uppercase">Payment</th>
                      {!isLineHidden('remarks') && <th className="text-left px-3 py-2 text-xs text-slate-500 uppercase">Remarks</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={l.id || i} className="border-b hover:bg-slate-50">
                        <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-semibold ${l.wage_type === 'LOADING' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                            {l.wage_type_display || l.wage_type}
                          </span>
                        </td>
                        {!isLineHidden('contractor') && <td className="px-3 py-2 font-medium">{l.contractor_name || '-'}</td>}
                        <td className="px-3 py-2">{fmtDate(l.work_date)}</td>
                        {!isLineHidden('wage_amount') && <td className="px-3 py-2 text-right font-medium">{fmt(l.amount)}</td>}
                        <td className="px-3 py-2">
                          {l.payment_status === 'PAID' ? (
                            <button onClick={() => navigate(`/freight/wages/payments/${l.wage_payment}`)} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
                              ✓ {l.wage_payment_no}
                            </button>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">Unpaid</span>
                          )}
                        </td>
                        {!isLineHidden('remarks') && <td className="px-3 py-2 text-xs text-slate-500">{l.remarks || '-'}</td>}
                      </tr>
                    ))}
                  </tbody>
                  {!isLineHidden('wage_amount') && (
                    <tfoot>
                      <tr className="bg-slate-50 font-semibold border-t-2">
                        <td colSpan={3 + (isLineHidden('contractor') ? 0 : 1)} className="px-3 py-2 text-right text-slate-700">Total:</td>
                        <td className="px-3 py-2 text-right">{fmt(totalAmt)}</td>
                        <td colSpan={1 + (isLineHidden('remarks') ? 0 : 1)}></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              </>
            )}
          </div>

          {/* Remarks */}
          {entry.overall_remarks && !isHidden('overall_remarks') && (
            <div className="bg-white rounded-lg border p-4 sm:p-5">
              <h3 className="text-lg font-semibold text-slate-800 mb-3 pb-2 border-b">Remarks</h3>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{entry.overall_remarks}</p>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4 sm:space-y-5">
          <div className="bg-white rounded-lg border p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Summary</h3>
            <div className="space-y-3">
              <div className="flex justify-between"><span className="text-sm text-slate-500">Status</span><StatusBadge status={entry.status_display || entry.status} /></div>
              <div><p className="text-xs text-slate-500 uppercase">Total Wage Amount</p><p className="text-2xl font-bold text-slate-900 mt-1">{fmt(totalAmt)}</p></div>
              <div className="pt-2 border-t">
                <div className="flex justify-between"><span className="text-sm text-slate-500">Entries</span><span className="text-sm font-medium">{lines.length}</span></div>
                {entry.created_by_name && <div className="flex justify-between"><span className="text-sm text-slate-500">Created By</span><span className="text-sm font-medium">{entry.created_by_name}</span></div>}
              </div>
            </div>
          </div>

          {/* The mutating Actions card (Amount Settled / Close / Cancel)
              has been moved to the Wage Payment detail page — state
              changes now flow through the settlement document, not the
              individual wage entry. Only navigation lives here. */}
          {entry.status === 'PAID' && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-sm text-emerald-700">
              <p className="font-semibold mb-1">Settled</p>
              <p className="text-xs">All wage lines have been paid via a Wage Payment. Manage cancellation from the payment detail page.</p>
            </div>
          )}
          <div className="bg-white rounded-lg border p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Navigate</h3>
            <div className="space-y-2">
              {entry.receipt && (
                <button onClick={() => navigate(`/purchase/receipts/${entry.receipt}`)} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
                  View Purchase Receipt
                </button>
              )}
              <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/freight/wages')} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
                &larr; Back to List
              </button>
            </div>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
