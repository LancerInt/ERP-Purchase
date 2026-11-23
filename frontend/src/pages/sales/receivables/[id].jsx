import { confirm } from '@/components/common/confirm';
import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { formatCurrency, formatDate } from '@/utils/formatters';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Edit3, Trash2, FileText, DollarSign, Download, Wallet } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FileAttachments from '../components/FileAttachments';
import exportToExcel from '../../../utils/exportExcel.js';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export default function ReceivableDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canView } = usePermissions();
  const { isHidden } = useFieldPermissions('Receivable');
  // Recording a receipt creates a payment row on the receivable, so it's
  // gated on the Receivable Create (or Edit) permission — matching the
  // backend, which now honours the "Create" checkbox for record_payment.
  const canReceivePayment = canCreate('Receivable') || canEdit('Receivable');
  // Cross-module nav: invoice link gated on Sales Invoice view perm.
  const canSeeInvoice = canView('Sales Invoice');
  const [rec, setRec] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [isPaying, setIsPaying] = useState(false);
  const [ledger, setLedger] = useState(null);
  const [showApplyForm, setShowApplyForm] = useState(false);
  const [openAdvances, setOpenAdvances] = useState([]);
  const [advancesLoading, setAdvancesLoading] = useState(false);
  const [applyAdvanceId, setApplyAdvanceId] = useState('');
  const [applyAmount, setApplyAmount] = useState('');
  const [applyDate, setApplyDate] = useState(new Date().toISOString().slice(0, 10));
  const [applyNotes, setApplyNotes] = useState('');
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => { fetchData(); }, [id]);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/sales/receivables/${id}/`);
      setRec(res.data);
      // Full Tally-style ledger for the customer: opening balance + invoices +
      // debit/credit notes + receipts with a running balance and closing total.
      if (res.data.customer) {
        apiClient.get(`/api/sales/receivables/customer-ledger/?customer=${res.data.customer}`)
          .then(r => setLedger(r.data)).catch(() => {});
      }
    } catch (err) { if (err.response?.status !== 404) toast.error('Failed to load'); }
    finally { setIsLoading(false); }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: 'Delete this receivable entry?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/receivables/${id}/`);
      toast.success('Deleted');
      navigate('/sales/receivables');
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed'); }
  };

  const handleRecordPayment = async (e) => {
    e.preventDefault();
    const amt = parseFloat(payAmount);
    if (!amt || amt <= 0) { toast.error('Amount must be > 0'); return; }
    if (amt > Number(rec.balance)) { toast.error(`Amount exceeds balance (${formatCurrency(rec.balance)})`); return; }

    setIsPaying(true);
    try {
      await apiClient.post(`/api/sales/receivables/${id}/record_payment/`, { amount: payAmount });
      toast.success(amt >= Number(rec.balance) ? 'Full payment received — Invoice closed!' : 'Payment recorded!');
      setShowPaymentForm(false);
      setPayAmount('');
      fetchData();
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setIsPaying(false); }
  };

  const openApplyForm = async () => {
    if (!rec?.customer) { toast.error('Customer is missing on this receivable.'); return; }
    setShowApplyForm(true);
    setAdvancesLoading(true);
    try {
      const r = await apiClient.get(`/api/sales/advances/?customer=${rec.customer}&open=1&page_size=500`);
      const list = r.data?.results || r.data || [];
      setOpenAdvances(list);
      if (list.length === 1) setApplyAdvanceId(list[0].id);
    } catch {
      toast.error('Failed to load advances');
    } finally {
      setAdvancesLoading(false);
    }
  };

  const closeApplyForm = () => {
    setShowApplyForm(false);
    setApplyAdvanceId('');
    setApplyAmount('');
    setApplyNotes('');
    setApplyDate(new Date().toISOString().slice(0, 10));
  };

  const selectedAdvance = openAdvances.find(a => a.id === applyAdvanceId);
  const applyCap = (() => {
    if (!selectedAdvance || !rec) return 0;
    const adv = Number(selectedAdvance.balance_unused || 0);
    const bal = Number(rec.balance || 0);
    return Math.min(adv, bal);
  })();

  const handleApplyAdvance = async (e) => {
    e.preventDefault();
    if (!applyAdvanceId) { toast.error('Select an advance.'); return; }
    const amt = parseFloat(applyAmount);
    if (!amt || amt <= 0) { toast.error('Amount must be > 0'); return; }
    if (amt > applyCap + 0.001) { toast.error(`Amount exceeds applicable limit (${formatCurrency(applyCap)})`); return; }
    setIsApplying(true);
    try {
      await apiClient.post(`/api/sales/advances/${applyAdvanceId}/apply/`, {
        receivable_id: id,
        amount: applyAmount,
        payment_date: applyDate,
        notes: applyNotes || '',
      });
      toast.success(amt >= Number(rec.balance) ? 'Advance applied — Invoice closed!' : 'Advance applied to invoice!');
      closeApplyForm();
      fetchData();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsApplying(false);
    }
  };

  const fmt = (v) => formatCurrency(v);
  const fmtDate = (d) => d ? formatDate(d) : '-';
  const Info = ({ label, children, className = '' }) => (<div className={className}><p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p><p className="text-sm sm:text-base text-slate-900 font-semibold mt-0.5 break-words">{children}</p></div>);

  if (isLoading) return <MainLayout><div className="space-y-4">{[1, 2, 3].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;
  if (!rec) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">Receivable not found.</p>
        <button onClick={() => navigate('/sales/receivables')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Back to Receivables
        </button>
      </div>
    </MainLayout>
  );

  // What the customer still owes on this bill, settled by ANY means — cash, a
  // credit note, a TDS journal, money on account. `balance`/`payment_status`
  // know only about cash, so a settled bill showed a red balance and an
  // "Overdue" badge while the invoice's own page read Paid. Served by the API
  // as settled_balance / settled_status (SettledStatusMixin).
  const owed = rec.settled_balance !== undefined && rec.settled_balance !== null
    ? Number(rec.settled_balance) : Number(rec.balance || 0);
  const owedStatus = rec.settled_status || rec.payment_status;
  const isPaid = owedStatus === 'PAID';
  // Edit/Delete are locked the moment any CASH lands — PARTIALLY_PAID and PAID
  // both count as "post-approval" for this row. Deliberately still the cash
  // field: this is a permission, not a figure, and must not loosen or tighten
  // because a credit note moved.
  const isReceivableLocked = ['PAID', 'PARTIALLY_PAID'].includes(rec.payment_status);

  return (
    <MainLayout>
      <div className="max-w-7xl space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/receivables'))} className="p-1 text-slate-500 hover:text-slate-700"><ArrowLeft size={20} /></button>
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900">Receivable Entry</h1>
            </div>
            <div className="flex items-center gap-4 ml-8">
              <StatusBadge status={owedStatus} />
            </div>
          </div>
          <div className="flex items-center gap-3 ml-8 sm:ml-0">
            {rec.invoice_no && (
              rec.invoice_reference && canSeeInvoice ? (
                <button onClick={() => navigate(`/sales/invoices/${rec.invoice_reference}`)} className="flex items-center gap-1.5 text-sm font-semibold text-blue-700 hover:text-blue-900 hover:underline">
                  <FileText size={14} /> {rec.invoice_no}
                </button>
              ) : (
                <span className="flex items-center gap-1.5 text-sm text-slate-600"><FileText size={14} /> {rec.invoice_no}</span>
              )
            )}
            {canEdit('Receivable') && !isReceivableLocked && (
              <button onClick={() => navigate(`/sales/receivables/${id}/edit`)} className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium"><Edit3 size={16} /> Edit</button>
            )}
            {canDelete('Receivable') && !isReceivableLocked && (
              <button onClick={handleDelete} className="flex items-center gap-2 px-4 py-2 border border-red-300 rounded-lg text-red-600 hover:bg-red-50 text-sm font-medium"><Trash2 size={16} /> Delete</button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
          <div className="lg:col-span-2 space-y-4 sm:space-y-6">
            {/* Receivable Details */}
            <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Receivable Details</h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-3 gap-y-3">
                {!isHidden('customer') && <Info label="Customer" className="col-span-2 lg:col-span-1">{rec.customer_name || '-'}</Info>}
                {!isHidden('invoice_date') && <Info label="Invoice Date">{fmtDate(rec.invoice_date)}</Info>}
                {!isHidden('due_date') && <Info label="Due Date">{fmtDate(rec.due_date)}</Info>}
                {!isHidden('amount') && <Info label="Invoice Amount">{fmt(rec.amount)}</Info>}
                {!isHidden('amount_paid') && <Info label="Amount Received"><span className="text-green-700">{fmt(rec.amount_paid)}</span></Info>}
                {!isHidden('balance') && <Info label="Balance"><span className={owed > 0 ? 'text-orange-600' : 'text-slate-400'}>{fmt(owed)}</span></Info>}
              </div>
            </div>

            {/* Additional Notes */}
            {!isHidden('notes') && rec.notes && (
              <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
                <h2 className="text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Additional Notes</h2>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{rec.notes}</p>
              </div>
            )}

            {/* Record Payment / Apply Advance */}
            {!isPaid && canReceivePayment && (
              <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4 pb-2 border-b">
                  <h2 className="text-lg font-semibold text-slate-900">Receive Payment</h2>
                  <div className="flex flex-wrap items-center gap-2">
                    {!showPaymentForm && (
                      <button onClick={() => { setShowPaymentForm(true); setShowApplyForm(false); }} className="inline-flex items-center gap-1 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
                        <DollarSign size={16} /> Record Payment
                      </button>
                    )}
                    {!showApplyForm && (
                      <button onClick={() => { setShowPaymentForm(false); openApplyForm(); }} className="inline-flex items-center gap-1 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
                        <Wallet size={16} /> Apply Advance
                      </button>
                    )}
                  </div>
                </div>
                {showPaymentForm && (
                  <form onSubmit={handleRecordPayment} className="p-4 bg-green-50 rounded-lg border border-green-200">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 items-end">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">Amount to Receive <span className="text-red-500">*</span></label>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-slate-400 text-sm">₹</span>
                          <input type="number" step="0.01" min="0.01" max={rec.balance} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} className={`${inputClass} pl-7`} placeholder="0.00" required />
                        </div>
                        <p className="text-xs text-slate-500 mt-1">Balance: {fmt(rec.balance)}</p>
                      </div>
                      <div className="flex gap-2">
                        <button type="submit" disabled={isPaying} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">{isPaying ? 'Saving...' : 'Record'}</button>
                        <button type="button" onClick={() => { setShowPaymentForm(false); setPayAmount(''); }} className="px-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                      </div>
                    </div>
                    {payAmount && parseFloat(payAmount) >= Number(rec.balance) && (
                      <div className="mt-3 p-3 bg-green-100 rounded-lg text-sm text-green-800 font-medium">
                        This will fully settle the receivable and close the invoice.
                      </div>
                    )}
                  </form>
                )}
                {showApplyForm && (
                  <form onSubmit={handleApplyAdvance} className="p-4 bg-indigo-50 rounded-lg border border-indigo-200">
                    {advancesLoading ? (
                      <p className="text-sm text-slate-500">Loading open advances…</p>
                    ) : openAdvances.length === 0 ? (
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <p className="text-sm text-slate-700">No open advances for <span className="font-semibold">{rec.customer_name || 'this customer'}</span>.</p>
                        <div className="flex gap-2">
                          <button type="button" onClick={() => navigate('/sales/advances/new')} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">+ Record Advance</button>
                          <button type="button" onClick={closeApplyForm} className="px-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4">
                          <div className="col-span-2 md:col-span-2">
                            <label className="block text-sm font-medium text-slate-700 mb-1">Advance <span className="text-red-500">*</span></label>
                            <CustomSelect value={applyAdvanceId} onChange={(e) => { setApplyAdvanceId(e.target.value); setApplyAmount(''); }} className={inputClass} required>
                              <option value="">Select an open advance…</option>
                              {openAdvances.map(a => (
                                <option key={a.id} value={a.id}>
                                  {a.advance_no} — Balance {formatCurrency(a.balance_unused || 0)} ({a.received_date || ''})
                                </option>
                              ))}
                            </CustomSelect>
                            {selectedAdvance && (
                              <p className="text-xs text-slate-500 mt-1">
                                Advance balance: {formatCurrency(selectedAdvance.balance_unused || 0)} · Invoice balance: {fmt(rec.balance)} · Max applicable: <span className="font-semibold text-indigo-700">{formatCurrency(applyCap)}</span>
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Amount <span className="text-red-500">*</span></label>
                            <div className="relative">
                              <span className="absolute left-3 top-2.5 text-slate-400 text-sm">₹</span>
                              <input type="number" step="0.01" min="0.01" max={applyCap || undefined} value={applyAmount} onChange={(e) => setApplyAmount(e.target.value)} className={`${inputClass} pl-7`} placeholder="0.00" required disabled={!applyAdvanceId} />
                            </div>
                            {selectedAdvance && (
                              <button type="button" onClick={() => setApplyAmount(applyCap.toFixed(2))} className="text-xs text-indigo-700 hover:underline mt-1">Use max {formatCurrency(applyCap)}</button>
                            )}
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Payment Date</label>
                            <CustomDatePicker value={applyDate} onChange={(e) => setApplyDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} className={inputClass} />
                          </div>
                        </div>
                        <div className="mt-3">
                          <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                          <input type="text" value={applyNotes} onChange={(e) => setApplyNotes(e.target.value)} className={inputClass} placeholder="Optional — e.g. 'Drawdown against ADV-0001 for INV-0099'" />
                        </div>
                        {applyAmount && parseFloat(applyAmount) >= Number(rec.balance) && (
                          <div className="mt-3 p-3 bg-indigo-100 rounded-lg text-sm text-indigo-800 font-medium">
                            This will fully settle the receivable and close the invoice.
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2 mt-4">
                          <button type="submit" disabled={isApplying || !applyAdvanceId} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">{isApplying ? 'Applying…' : 'Apply Advance'}</button>
                          <button type="button" onClick={closeApplyForm} className="px-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                        </div>
                      </>
                    )}
                  </form>
                )}
              </div>
            )}

            {/* Payment History */}
            <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
              <div className="flex items-center justify-between mb-4 pb-2 border-b">
                <h2 className="text-lg font-semibold text-slate-900">
                  Received Records {rec.payments?.length > 0 && <span className="text-slate-400 font-normal text-sm">({rec.payments.length} entries)</span>}
                </h2>
                {rec.payments?.length > 0 && (
                  <button onClick={() => {
                    const sorted = [...rec.payments].sort((a, b) => new Date(a.payment_date) - new Date(b.payment_date) || new Date(a.created_at) - new Date(b.created_at));
                    const invoiceAmt = Number(rec.amount) || 0;
                    const totalPaid = Number(rec.amount_paid) || 0;
                    const trackedTotal = rec.payments.reduce((s, p) => s + Number(p.amount), 0);
                    const untrackedPaid = totalPaid - trackedTotal;
                    let runningBalance = invoiceAmt - untrackedPaid;
                    let runningReceived = untrackedPaid;
                    const rows = [];
                    if (untrackedPaid > 0) {
                      rows.push({
                        sr_no: 1,
                        customer_name: rec.customer_name || '-',
                        invoice_no: rec.invoice_no || '-',
                        invoice_date: rec.invoice_date || '-',
                        due_date: rec.due_date || '-',
                        invoice_amount: invoiceAmt.toFixed(2),
                        payment_date: fmtDate(rec.created_at || rec.invoice_date),
                        amount_received: untrackedPaid.toFixed(2),
                        running_total: runningReceived.toFixed(2),
                        balance_after: runningBalance.toFixed(2),
                        payment_status: owedStatus || '-',
                        notes: 'Prior payments',
                      });
                    }
                    sorted.forEach((p) => {
                      const amt = Number(p.amount);
                      runningReceived += amt;
                      runningBalance -= amt;
                      rows.push({
                        sr_no: rows.length + 1,
                        customer_name: rec.customer_name || '-',
                        invoice_no: rec.invoice_no || '-',
                        invoice_date: rec.invoice_date || '-',
                        due_date: rec.due_date || '-',
                        invoice_amount: invoiceAmt.toFixed(2),
                        payment_date: p.payment_date || '-',
                        amount_received: amt.toFixed(2),
                        running_total: runningReceived.toFixed(2),
                        balance_after: runningBalance.toFixed(2),
                        payment_status: owedStatus || '-',
                        notes: p.notes || '-',
                      });
                    });
                    rows.push({
                      sr_no: '', customer_name: '', invoice_no: '', invoice_date: '', due_date: '',
                      invoice_amount: '', payment_date: 'TOTAL',
                      amount_received: totalPaid.toFixed(2),
                      running_total: '', balance_after: (invoiceAmt - totalPaid).toFixed(2),
                      payment_status: '', notes: '',
                    });
                    exportToExcel(rows, [
                      { field: 'sr_no', header: 'Sr No' },
                      { field: 'customer_name', header: 'Customer Name' },
                      { field: 'invoice_no', header: 'Invoice No' },
                      { field: 'invoice_date', header: 'Invoice Date' },
                      { field: 'due_date', header: 'Due Date' },
                      { field: 'invoice_amount', header: 'Invoice Amount (₹)' },
                      { field: 'payment_date', header: 'Payment Date' },
                      { field: 'amount_received', header: 'Amount Received (₹)' },
                      { field: 'running_total', header: 'Running Total (₹)' },
                      { field: 'balance_after', header: 'Balance After (₹)' },
                      { field: 'payment_status', header: 'Payment Status' },
                      { field: 'notes', header: 'Notes' },
                    ], `received-records-${rec.invoice_no || 'receivable'}-${rec.customer_name || 'customer'}-${new Date().toISOString().slice(0, 10)}`);
                    toast.success('Received records downloaded!');
                  }} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition">
                    <Download size={16} /> Download Excel
                  </button>
                )}
              </div>
              {rec.payments && rec.payments.length > 0 ? (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-xs sm:text-sm">
                    <thead>
                      <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                        <th className="text-left px-2 sm:px-4 py-2 text-xs text-slate-500 font-semibold uppercase whitespace-nowrap">#</th>
                        <th className="text-left px-2 sm:px-4 py-2 text-xs text-slate-500 font-semibold uppercase whitespace-nowrap">Payment Date</th>
                        <th className="text-right px-2 sm:px-4 py-2 text-xs text-slate-500 font-semibold uppercase whitespace-nowrap">Amount Received</th>
                        <th className="text-right px-2 sm:px-4 py-2 text-xs text-slate-500 font-semibold uppercase whitespace-nowrap">Running Total</th>
                        <th className="text-right px-2 sm:px-4 py-2 text-xs text-slate-500 font-semibold uppercase whitespace-nowrap">Balance After</th>
                        <th className="text-left px-2 sm:px-4 py-2 text-xs text-slate-500 font-semibold uppercase whitespace-nowrap">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const sorted = [...rec.payments].sort((a, b) => new Date(a.payment_date) - new Date(b.payment_date) || new Date(a.created_at) - new Date(b.created_at));
                        const invoiceAmt = Number(rec.amount) || 0;
                        const totalPaid = Number(rec.amount_paid) || 0;
                        const trackedTotal = rec.payments.reduce((s, p) => s + Number(p.amount), 0);
                        const untrackedPaid = totalPaid - trackedTotal;
                        let runningBalance = invoiceAmt - untrackedPaid;
                        let runningReceived = untrackedPaid;
                        const tableRows = [];
                        if (untrackedPaid > 0) {
                          tableRows.push(
                            <tr key="prior" className="border-b bg-amber-50/50">
                              <td className="px-2 sm:px-4 py-2 text-slate-500">1</td>
                              <td className="px-2 sm:px-4 py-2 text-slate-500 whitespace-nowrap">{fmtDate(rec.created_at || rec.invoice_date)}</td>
                              <td className="px-2 sm:px-4 py-2 text-right font-semibold text-green-700 whitespace-nowrap">{fmt(untrackedPaid)}</td>
                              <td className="px-2 sm:px-4 py-2 text-right font-medium text-emerald-600 whitespace-nowrap">{fmt(runningReceived)}</td>
                              <td className="px-2 sm:px-4 py-2 text-right font-medium whitespace-nowrap">
                                <span className={runningBalance > 0 ? 'text-orange-600' : 'text-slate-400'}>{fmt(runningBalance)}</span>
                              </td>
                              <td className="px-2 sm:px-4 py-2 text-slate-400 text-xs italic">Prior payments</td>
                            </tr>
                          );
                        }
                        sorted.forEach((p, i) => {
                          const amt = Number(p.amount);
                          runningReceived += amt;
                          runningBalance -= amt;
                          tableRows.push(
                            <tr key={p.id} className="border-b hover:bg-primary-50/40 transition-colors">
                              <td className="px-2 sm:px-4 py-2 text-slate-500">{tableRows.length + 1}</td>
                              <td className="px-2 sm:px-4 py-2 text-slate-700 font-medium whitespace-nowrap">{fmtDate(p.payment_date)}</td>
                              <td className="px-2 sm:px-4 py-2 text-right font-semibold text-green-700 whitespace-nowrap">{fmt(amt)}</td>
                              <td className="px-2 sm:px-4 py-2 text-right font-medium text-emerald-600 whitespace-nowrap">{fmt(runningReceived)}</td>
                              <td className="px-2 sm:px-4 py-2 text-right font-medium whitespace-nowrap">
                                <span className={runningBalance > 0 ? 'text-orange-600' : 'text-slate-400'}>{fmt(runningBalance)}</span>
                              </td>
                              <td className="px-2 sm:px-4 py-2 text-slate-500 text-xs">{p.notes || '-'}</td>
                            </tr>
                          );
                        });
                        return tableRows;
                      })()}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-100 border-t-2 font-bold">
                        <td colSpan="2" className="px-2 sm:px-4 py-2 text-right text-slate-700 whitespace-nowrap">Total Received:</td>
                        <td className="px-2 sm:px-4 py-2 text-right text-green-700 whitespace-nowrap">{fmt(rec.amount_paid)}</td>
                        <td className="px-2 sm:px-4 py-2 text-right text-emerald-700 whitespace-nowrap">{fmt(rec.amount_paid)}</td>
                        <td className="px-2 sm:px-4 py-2 text-right text-orange-700 whitespace-nowrap">{fmt(owed)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-400 text-center py-4">No payment records yet. Use "Receive Payment" to record payments — each entry will appear here as a separate row.</p>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
              <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-3">Payment Summary</h3>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div><p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">Received</p><p className="text-lg sm:text-xl font-bold text-green-700 mt-0.5">{fmt(rec.amount_paid)}</p></div>
                  <div><p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">Balance</p><p className={`text-lg sm:text-xl font-bold mt-0.5 ${owed > 0 ? 'text-orange-600' : 'text-slate-400'}`}>{fmt(owed)}</p></div>
                </div>
                {/* Progress bar */}
                <div>
                  <div className="w-full bg-slate-200 rounded-full h-2.5">
                    <div className="bg-green-600 h-2.5 rounded-full" style={{ width: `${Math.min(100, (Number(rec.amount_paid) / Math.max(1, Number(rec.amount))) * 100)}%` }}></div>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{Math.round((Number(rec.amount_paid) / Math.max(1, Number(rec.amount))) * 100)}% received</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
              <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-3">Actions</h3>
              <div className={`grid ${rec.invoice_reference ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
                <button onClick={() => navigate('/sales/receivables')} className="px-3 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">← Back to Ledger</button>
                {rec.invoice_reference && (
                  <button onClick={() => navigate(`/sales/invoices/${rec.invoice_reference}`)} className="px-3 py-2 text-sm bg-primary-50 text-primary-700 rounded-lg hover:bg-primary-100">View Invoice</button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Customer Receivable Ledger — Tally-style running statement:
            opening balance + invoices (Dr) + debit/credit notes + receipts (Cr),
            with a running balance and Opening / Current Total / Closing footer. */}
        {ledger && Array.isArray(ledger.rows) && (() => {
          const num = (v) => Number(v || 0);
          const opening = num(ledger.opening_balance);
          const curD = num(ledger.current_debit);
          const curC = num(ledger.current_credit);
          const closing = num(ledger.closing_balance);
          const rows = ledger.rows;
          const typeColor = (t) => t === 'Receipt'
            ? 'bg-green-50 text-green-700'
            : t === 'Credit Note' ? 'bg-emerald-50 text-emerald-700'
            : t === 'Debit Note' ? 'bg-rose-50 text-rose-700'
            : 'bg-blue-50 text-blue-700';

          return (
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 mt-4 sm:mt-6">
            <div className="mb-4">
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 break-words">Customer Receivable Ledger — {ledger.customer_name || rec.customer_name}</h2>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <p className="text-xs text-slate-500">Full statement — invoices, debit &amp; credit notes and receipts ({ledger.count} entr{ledger.count === 1 ? 'y' : 'ies'})</p>
              <button onClick={() => {
                const xr = [];
                xr.push({ date: '', particulars: 'Opening Balance', type: '', doc_no: '', debit: opening > 0 ? opening.toFixed(2) : '', credit: opening < 0 ? Math.abs(opening).toFixed(2) : '', balance: opening.toFixed(2) });
                rows.forEach(r => xr.push({
                  date: r.date || '-', particulars: r.type, type: r.type, doc_no: r.doc_no || '-',
                  debit: num(r.debit) ? num(r.debit).toFixed(2) : '', credit: num(r.credit) ? num(r.credit).toFixed(2) : '',
                  balance: num(r.balance).toFixed(2),
                }));
                xr.push({ date: '', particulars: 'Current Total', type: '', doc_no: '', debit: curD.toFixed(2), credit: curC.toFixed(2), balance: '' });
                xr.push({ date: '', particulars: 'Closing Balance', type: '', doc_no: '', debit: '', credit: '', balance: closing.toFixed(2) });
                exportToExcel(xr, [
                  { field: 'date', header: 'Date' },
                  { field: 'particulars', header: 'Particulars' },
                  { field: 'doc_no', header: 'Voucher No' },
                  { field: 'debit', header: 'Debit (₹)' },
                  { field: 'credit', header: 'Credit (₹)' },
                  { field: 'balance', header: 'Balance (₹)' },
                ], `receivable-ledger-${ledger.customer_name || rec.customer_name || 'customer'}-${new Date().toISOString().slice(0, 10)}`);
                toast.success('Statement downloaded!');
              }} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition">
                <Download size={14} /> Download Excel
              </button>
              </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <div className="bg-slate-50 rounded-lg px-3 py-2 border">
                <p className="text-[10px] font-semibold text-slate-500 uppercase">Opening Balance</p>
                <p className="text-lg font-bold text-slate-900">{fmt(opening)}</p>
              </div>
              <div className="bg-blue-50 rounded-lg px-3 py-2 border border-blue-200">
                <p className="text-[10px] font-semibold text-blue-600 uppercase">Current Debit</p>
                <p className="text-lg font-bold text-blue-700">{fmt(curD)}</p>
              </div>
              <div className="bg-emerald-50 rounded-lg px-3 py-2 border border-emerald-200">
                <p className="text-[10px] font-semibold text-emerald-600 uppercase">Current Credit</p>
                <p className="text-lg font-bold text-emerald-700">{fmt(curC)}</p>
              </div>
              <div className={`rounded-lg px-3 py-2 border ${closing > 0 ? 'bg-orange-50 border-orange-200' : 'bg-emerald-50 border-emerald-200'}`}>
                <p className={`text-[10px] font-semibold uppercase ${closing > 0 ? 'text-orange-600' : 'text-emerald-600'}`}>Closing Balance</p>
                <p className={`text-lg font-bold ${closing > 0 ? 'text-orange-700' : 'text-emerald-700'}`}>{fmt(closing)}</p>
              </div>
            </div>

            {/* Ledger Table */}
            <div className="overflow-x-auto border rounded-lg">
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-2 sm:px-4 py-2 text-xs text-slate-500 font-semibold uppercase whitespace-nowrap">#</th>
                    <th className="text-left px-2 sm:px-4 py-2 text-xs text-slate-500 font-semibold uppercase whitespace-nowrap">Date</th>
                    <th className="text-left px-2 sm:px-4 py-2 text-xs text-slate-500 font-semibold uppercase whitespace-nowrap">Particulars</th>
                    <th className="text-left px-2 sm:px-4 py-2 text-xs text-slate-500 font-semibold uppercase whitespace-nowrap">Voucher No</th>
                    <th className="text-right px-2 sm:px-4 py-2 text-xs text-blue-600 font-semibold uppercase whitespace-nowrap">Debit</th>
                    <th className="text-right px-2 sm:px-4 py-2 text-xs text-emerald-600 font-semibold uppercase whitespace-nowrap">Credit</th>
                    <th className="text-right px-2 sm:px-4 py-2 text-xs text-orange-600 font-semibold uppercase whitespace-nowrap">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b bg-slate-50/70">
                    <td className="px-2 sm:px-4 py-2 text-slate-400"></td>
                    <td className="px-2 sm:px-4 py-2 text-slate-500 whitespace-nowrap"></td>
                    <td className="px-2 sm:px-4 py-2 font-semibold text-slate-700" colSpan="3">Opening Balance</td>
                    <td className="px-2 sm:px-4 py-2"></td>
                    <td className="px-2 sm:px-4 py-2 text-right font-semibold text-slate-700 whitespace-nowrap">{fmt(opening)}</td>
                  </tr>
                  {rows.map((r, i) => {
                    const d = num(r.debit), c = num(r.credit);
                    return (
                      <tr key={i} className="border-b hover:bg-primary-50/40 transition-colors">
                        <td className="px-2 sm:px-4 py-2 text-slate-500">{i + 1}</td>
                        <td className="px-2 sm:px-4 py-2 text-slate-600 whitespace-nowrap">{fmtDate(r.date)}</td>
                        <td className="px-2 sm:px-4 py-2 whitespace-nowrap">
                          <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${typeColor(r.type)}`}>{r.type}</span>
                        </td>
                        <td className="px-2 sm:px-4 py-2 whitespace-nowrap">
                          {r.ref_id
                            ? <button onClick={() => navigate(`/sales/invoices/${r.ref_id}`)} className="text-blue-700 hover:underline font-medium text-xs">{r.doc_no || '-'}</button>
                            : <span className="text-slate-600 text-xs">{r.doc_no || '-'}</span>}
                        </td>
                        <td className="px-2 sm:px-4 py-2 text-right font-medium text-blue-700 whitespace-nowrap">{d ? fmt(d) : <span className="text-slate-300">-</span>}</td>
                        <td className="px-2 sm:px-4 py-2 text-right font-medium text-emerald-700 whitespace-nowrap">{c ? fmt(c) : <span className="text-slate-300">-</span>}</td>
                        <td className="px-2 sm:px-4 py-2 text-right font-semibold text-orange-600 whitespace-nowrap">{fmt(num(r.balance))}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 border-t-2 font-semibold">
                    <td colSpan="6" className="px-2 sm:px-4 py-2 text-right text-slate-600 whitespace-nowrap">Opening Balance:</td>
                    <td className="px-2 sm:px-4 py-2 text-right text-slate-700 whitespace-nowrap">{fmt(opening)}</td>
                  </tr>
                  <tr className="bg-slate-100 font-bold">
                    <td colSpan="4" className="px-2 sm:px-4 py-2 text-right text-slate-700 whitespace-nowrap">Current Total:</td>
                    <td className="px-2 sm:px-4 py-2 text-right text-blue-700 whitespace-nowrap">{fmt(curD)}</td>
                    <td className="px-2 sm:px-4 py-2 text-right text-emerald-700 whitespace-nowrap">{fmt(curC)}</td>
                    <td className="px-2 sm:px-4 py-2"></td>
                  </tr>
                  <tr className="bg-slate-200/70 font-bold">
                    <td colSpan="6" className="px-2 sm:px-4 py-2 text-right text-slate-800 whitespace-nowrap">Closing Balance:</td>
                    <td className="px-2 sm:px-4 py-2 text-right text-orange-700 whitespace-nowrap">{fmt(closing)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          );
        })()}

        <FileAttachments module="RECEIVABLE" recordId={id} readOnly />
      </div>
    </MainLayout>
  );
}
