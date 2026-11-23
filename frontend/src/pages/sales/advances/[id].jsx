import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { formatCurrency, formatDate } from '@/utils/formatters';
/**
 * Customer Advance — detail page.
 *
 * Three jobs:
 *   1. Show the advance's identity + running balance.
 *   2. Apply panel: pick an open ReceivableLedger row for the same
 *      customer, enter how much to draw down, post — backend creates
 *      a ReceivablePayment with `sourced_from_advance` set and
 *      decrements `balance_unused` atomically.
 *   3. History: every prior application, click-through to the source
 *      invoice.
 *
 * Apply / Close are gated on `balance_unused > 0` and `status !=
 * CLOSED`. CLOSED advances are read-only.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Wallet, IndianRupee, CheckCircle2, AlertCircle, XCircle } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';

const fmt = (v) => formatCurrency(v);
const fmtDate = (d) => d
  ? formatDate(d)
  : '-';
const todayISO = () => new Date().toISOString().slice(0, 10);

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export default function CustomerAdvanceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canView } = usePermissions();
  // Cross-module nav: history rows link to the source invoice. Hide
  // the click-through when the user can't view Sales Invoices.
  const canSeeInvoice = canView('Sales Invoice');

  const [advance, setAdvance] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Open receivables for this customer — populated when the apply
  // panel opens. Filter: same customer + balance > 0 + not PAID.
  const [openReceivables, setOpenReceivables] = useState([]);
  const [loadingReceivables, setLoadingReceivables] = useState(false);

  // Apply panel state
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyForm, setApplyForm] = useState({
    receivable_id: '',
    amount: '',
    payment_date: todayISO(),
    notes: '',
  });
  const [isApplying, setIsApplying] = useState(false);

  // Close panel state
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [isClosing, setIsClosing] = useState(false);

  const fetchAdvance = async () => {
    // Guard against `id` being undefined during the brief window
    // between mount and useParams resolving — without this the
    // fetch would fire `/api/sales/advances/undefined/` and the
    // backend logs 404 spam.
    if (!id || id === 'undefined') {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const r = await apiClient.get(`/api/sales/advances/${id}/`);
      setAdvance(r.data);
    } catch (err) {
      if (err.response?.status !== 404) toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!id || id === 'undefined') return;
    fetchAdvance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const loadReceivables = async () => {
    if (!advance?.customer) return;
    setLoadingReceivables(true);
    try {
      const r = await apiClient.get('/api/sales/receivables/', {
        params: { customer: advance.customer, page_size: 200 },
      });
      const rows = r.data?.results || r.data || [];
      // Filter to ones with money owed. PAID rows can still be in the
      // result set if record_payment hit zero, so exclude them too.
      setOpenReceivables(
        rows.filter(rr => Number(rr.balance) > 0 && rr.payment_status !== 'PAID'),
      );
    } catch {
      toast.error('Failed to load open invoices for this customer.');
    } finally {
      setLoadingReceivables(false);
    }
  };

  const openApplyPanel = () => {
    setApplyForm({
      receivable_id: '',
      amount: '',
      payment_date: todayISO(),
      notes: '',
    });
    setApplyOpen(true);
    loadReceivables();
  };

  const submitApply = async (ev) => {
    ev.preventDefault();
    const amt = parseFloat(applyForm.amount);
    if (!applyForm.receivable_id) { toast.error('Pick a receivable.'); return; }
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a positive amount.'); return; }
    const selected = openReceivables.find(r => r.id === applyForm.receivable_id);
    if (selected && amt > Number(selected.balance)) {
      toast.error(`Amount exceeds invoice balance (${fmt(selected.balance)}).`);
      return;
    }
    if (amt > Number(advance.balance_unused)) {
      toast.error(`Amount exceeds advance balance (${fmt(advance.balance_unused)}).`);
      return;
    }
    setIsApplying(true);
    try {
      await apiClient.post(`/api/sales/advances/${id}/apply/`, applyForm);
      toast.success('Advance applied.');
      setApplyOpen(false);
      fetchAdvance();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Apply failed.');
    } finally {
      setIsApplying(false);
    }
  };

  const submitClose = async () => {
    setIsClosing(true);
    try {
      await apiClient.post(`/api/sales/advances/${id}/close/`, { reason: closeReason });
      toast.success('Advance closed.');
      setCloseOpen(false);
      setCloseReason('');
      fetchAdvance();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Close failed.');
    } finally {
      setIsClosing(false);
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="text-center py-16 text-slate-400">Loading…</div>
      </MainLayout>
    );
  }
  if (!advance) {
    return (
      <MainLayout>
        <div className="text-center py-16">
          <p className="text-slate-600">Advance not found.</p>
          <button onClick={() => navigate('/sales/advances')} className="mt-3 text-primary-600 hover:underline">
            Back to Advances
          </button>
        </div>
      </MainLayout>
    );
  }

  const canApply = advance.status !== 'CLOSED' && Number(advance.balance_unused) > 0;

  return (
    <MainLayout>
      <div className="max-w-7xl space-y-4 sm:space-y-6">
        {/* Header — title row + action buttons. Stacks on phones. */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/advances'))} className="p-1 text-slate-500 hover:text-slate-700" title="Back">
                <ArrowLeft size={20} />
              </button>
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900 break-all">{advance.advance_no}</h1>
            </div>
            <div className="flex items-center flex-wrap gap-3 ml-8">
              <StatusBadge status={advance.status_display || advance.status} />
              <p className="text-slate-500 text-sm">Received on {fmtDate(advance.received_date)}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 flex-wrap ml-8 sm:ml-0">
            {canApply && (
              <button onClick={openApplyPanel}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700">
                <CheckCircle2 size={16} /> Apply to Invoice
              </button>
            )}
            {canApply && (
              <button onClick={() => setCloseOpen(true)}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 border border-red-300 text-red-700 rounded-lg text-sm font-medium hover:bg-red-50">
                <XCircle size={16} /> Close
              </button>
            )}
          </div>
        </div>

        {/* Summary chips */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-slate-500 uppercase font-medium">Customer</p>
            <p className="text-sm sm:text-base font-semibold text-slate-900 mt-1 break-words">{advance.customer_name || '-'}</p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-slate-500 uppercase font-medium">Amount</p>
            <p className="text-base sm:text-xl font-bold text-slate-900 mt-1 tabular-nums truncate">{fmt(advance.amount)}</p>
          </div>
          <div className={`rounded-lg border p-3 sm:p-4 ${Number(advance.balance_unused) > 0 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
            <p className={`text-[10px] sm:text-xs uppercase font-medium ${Number(advance.balance_unused) > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>Balance Unused</p>
            <p className={`text-base sm:text-xl font-bold mt-1 tabular-nums truncate ${Number(advance.balance_unused) > 0 ? 'text-amber-900' : 'text-emerald-900'}`}>
              {fmt(advance.balance_unused)}
            </p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-slate-500 uppercase font-medium">Mode / Ref</p>
            <p className="text-sm font-medium text-slate-900 mt-1 truncate">{advance.payment_mode_display || advance.payment_mode}</p>
            {advance.reference_no && <p className="text-xs text-slate-500 mt-0.5 truncate">{advance.reference_no}</p>}
          </div>
        </div>

        {advance.notes && (
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <p className="text-xs text-slate-500 uppercase font-medium mb-1">Notes</p>
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{advance.notes}</p>
          </div>
        )}

        {/* Application history */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-3 sm:px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h3 className="font-semibold text-slate-800">Applied to invoices</h3>
            <span className="text-xs text-slate-500">{advance.applications?.length || 0} application(s)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                <tr className="text-left text-slate-600">
                  <th className="px-3 sm:px-4 py-2 font-semibold whitespace-nowrap">Date</th>
                  <th className="px-3 sm:px-4 py-2 font-semibold whitespace-nowrap">Invoice</th>
                  <th className="px-3 sm:px-4 py-2 font-semibold text-right whitespace-nowrap">Amount</th>
                  <th className="px-3 sm:px-4 py-2 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody>
                {(advance.applications || []).length === 0 && (
                  <tr><td colSpan={4} className="text-center py-8 text-slate-400">No applications yet — use "Apply to Invoice" to draw this advance down.</td></tr>
                )}
                {(advance.applications || []).map(a => (
                  <tr key={a.id} className="border-b last:border-b-0 hover:bg-primary-50/40 transition-colors">
                    <td className="px-3 sm:px-4 py-2 text-slate-600 whitespace-nowrap">{fmtDate(a.payment_date)}</td>
                    <td className="px-3 sm:px-4 py-2 whitespace-nowrap">
                      {a.invoice_id ? (
                        canSeeInvoice ? (
                          <button onClick={() => navigate(`/sales/invoices/${a.invoice_id}`)}
                            className="text-indigo-700 hover:text-indigo-900 hover:underline font-medium">
                            {a.invoice_no || '(open)'}
                          </button>
                        ) : (
                          <span className="text-slate-700 font-medium">{a.invoice_no || '(open)'}</span>
                        )
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-3 sm:px-4 py-2 text-right tabular-nums font-medium whitespace-nowrap">{fmt(a.amount)}</td>
                    <td className="px-3 sm:px-4 py-2 text-slate-600">{a.notes || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Apply modal */}
      {applyOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-3 sm:p-4" onClick={() => setApplyOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90dvh] overflow-y-auto" role="dialog" aria-modal="true" aria-label="Apply advance to an invoice" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 sm:px-5 py-3 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-800">Apply advance to an invoice</h3>
              <p className="text-xs text-slate-500 mt-1">
                Drawing down {formatCurrency(advance.balance_unused)} available
                from {advance.customer_name}.
              </p>
            </div>
            <form onSubmit={submitApply} className="px-4 sm:px-5 py-4 space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Open Invoice (Receivable) <span className="text-red-500">*</span></label>
                <CustomSelect required value={applyForm.receivable_id}
                  onChange={(e) => setApplyForm(prev => ({ ...prev, receivable_id: e.target.value }))}
                  className={inputClass}>
                  <option value="">{loadingReceivables ? 'Loading…' : 'Select an open invoice'}</option>
                  {openReceivables.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.invoice_no || '(no invoice no)'} — Balance {fmt(r.balance)}
                    </option>
                  ))}
                </CustomSelect>
                {!loadingReceivables && openReceivables.length === 0 && (
                  <p className="text-xs text-amber-700 mt-1">No open invoices found for this customer.</p>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Amount (₹) <span className="text-red-500">*</span></label>
                  <input type="number" step="0.01" min="0.01"
                    max={advance.balance_unused}
                    value={applyForm.amount}
                    onChange={(e) => setApplyForm(prev => ({ ...prev, amount: e.target.value }))}
                    className={inputClass} placeholder="0.00" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Payment Date</label>
                  <CustomDatePicker value={applyForm.payment_date}
                    onChange={(e) => setApplyForm(prev => ({ ...prev, payment_date: e.target.value }))}
                    max={todayISO()} className={inputClass} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea rows={2} value={applyForm.notes}
                  onChange={(e) => setApplyForm(prev => ({ ...prev, notes: e.target.value }))}
                  className={inputClass} placeholder="Optional — e.g. 'Adjusting against partial dispatch invoice'" />
              </div>
              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
                <button type="button" onClick={() => setApplyOpen(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
                  Cancel
                </button>
                <button type="submit" disabled={isApplying || openReceivables.length === 0}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
                  {isApplying ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Close modal */}
      {closeOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-3 sm:p-4" onClick={() => setCloseOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md" role="dialog" aria-modal="true" aria-label="Close this advance" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 sm:px-5 py-3 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-800">Close this advance</h3>
              <p className="text-xs text-slate-500 mt-1">
                Closing leaves the remaining {formatCurrency(advance.balance_unused)} unallocated.
                Use this when the leftover was refunded or written off — record the refund payment off-ledger.
              </p>
            </div>
            <div className="px-4 sm:px-5 py-4 space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Reason (optional)</label>
                <textarea rows={3} value={closeReason} onChange={(e) => setCloseReason(e.target.value)}
                  className={inputClass} placeholder="e.g. 'Refunded via UTR …'" />
              </div>
              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <button type="button" onClick={() => setCloseOpen(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
                  Cancel
                </button>
                <button type="button" onClick={submitClose} disabled={isClosing}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                  {isClosing ? 'Closing…' : 'Close Advance'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
