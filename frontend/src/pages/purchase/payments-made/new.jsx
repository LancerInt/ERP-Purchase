import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup, { clearLookupCache } from '../../../hooks/useLookup.js';

// Round to 2 decimals, returning a Number (avoids float drift in allocation).
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const inr = (n) => `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '-');

// Zoho-style "Payments Made": pick a vendor, see every open bill, type one
// lump-sum and it auto-distributes oldest-bill-first across the Payment
// column. Per-bill amounts stay editable, and the vendor's open advances can
// be applied per bill on top. Saving posts a single bulk-payment request that
// records one payment line per bill atomically.
export default function CreatePaymentMade() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { options: vendorOptions } = useLookup('/api/vendors/');
  // `fresh` so a bill paid in a prior visit doesn't linger from the module
  // cache — fully-paid bills must drop off this screen immediately.
  const { raw: billsRaw } = useLookup('/api/purchase/bills/', { fresh: true });

  const [header, setHeader] = useState({
    vendor: '',
    payment_date: new Date().toISOString().split('T')[0],
    payment_mode: 'BANK_TRANSFER',
    bank_name: '',
    reference_no: '',
    notes: '',
  });
  const [lumpSum, setLumpSum] = useState('');     // the "Payment Made" total
  const [payments, setPayments] = useState({});   // bill_id -> cash amount (string)
  const [advApplied, setAdvApplied] = useState({}); // bill_id -> advance amount (string)
  const [selected, setSelected] = useState({});   // bill_id -> false when user deselects (default: all selected)
  const [advances, setAdvances] = useState([]);   // open advance credits, FIFO order
  const [isLoading, setIsLoading] = useState(false);

  // Open bills for the chosen vendor, oldest bill-date first. The balance
  // check is authoritative — a fully-paid bill never shows even if its status
  // flag is stale.
  const bills = useMemo(() => {
    if (!header.vendor) return [];
    return billsRaw
      .filter(b => b.vendor === header.vendor
        && (Number(b.balance_due) || 0) > 0
        && ['OPEN', 'PARTIALLY_PAID'].includes(b.status))
      .sort((a, b) => String(a.bill_date || '').localeCompare(String(b.bill_date || '')));
  }, [billsRaw, header.vendor]);

  const totalAdvanceAvailable = useMemo(
    () => advances.reduce((s, a) => s + (Number(a.balance) || 0), 0),
    [advances],
  );

  // When the vendor changes, load their open advances and reset the grid.
  useEffect(() => {
    setPayments({});
    setAdvApplied({});
    setSelected({});
    setLumpSum('');
    setAdvances([]);
    if (!header.vendor) return;
    apiClient
      .get(`/api/purchase/vendor-credits/available-for-bill/?vendor_id=${header.vendor}&credit_type=ADVANCE`)
      .then(r => {
        const rows = r.data?.results || r.data || [];
        // FIFO: consume the oldest advance first.
        rows.sort((a, b) => String(a.credit_date || '').localeCompare(String(b.credit_date || '')));
        setAdvances(rows.filter(a => (Number(a.balance) || 0) > 0));
      })
      .catch(() => setAdvances([]));
  }, [header.vendor]);

  // Preselect a vendor if arriving with ?vendor= or ?bill_id=
  useEffect(() => {
    const billId = searchParams.get('bill_id');
    const vendorId = searchParams.get('vendor');
    if (vendorId && !header.vendor) {
      setHeader(prev => ({ ...prev, vendor: vendorId }));
    } else if (billId && billsRaw.length && !header.vendor) {
      const b = billsRaw.find(x => String(x.id) === String(billId));
      if (b?.vendor) setHeader(prev => ({ ...prev, vendor: b.vendor }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, billsRaw]);

  // Each bill's remaining due after the advance the user applied to it.
  const dueAfterAdvance = (b) => Math.max(0, (Number(b.balance_due) || 0) - (Number(advApplied[b.id]) || 0));

  // Bill selection — every open bill is selected by default; the user can
  // un-tick bills they don't want to pay now. A bill counts as selected unless
  // it was explicitly toggled off. Deselected bills are excluded from the
  // lump-sum distribution, the totals and the saved payment.
  const isSelected = (id) => selected[id] !== false;
  const allSelected = bills.length > 0 && bills.every((b) => isSelected(b.id));
  const toggleBill = (id) => {
    const willSelect = !isSelected(id);
    setSelected((prev) => ({ ...prev, [id]: willSelect }));
    if (!willSelect) {
      setPayments((prev) => { const n = { ...prev }; delete n[id]; return n; });
      setAdvApplied((prev) => { const n = { ...prev }; delete n[id]; return n; });
    }
  };
  const toggleAll = () => {
    const next = {};
    bills.forEach((b) => { next[b.id] = !allSelected; });
    setSelected(next);
    if (allSelected) { setPayments({}); setAdvApplied({}); setLumpSum(''); }
  };

  // Auto-distribute the lump-sum oldest-first across the SELECTED bills' cash
  // Payment column.
  const distribute = (total) => {
    let remaining = round2(total);
    const next = {};
    for (const b of bills) {
      if (!isSelected(b.id)) continue;
      const pay = Math.min(remaining, dueAfterAdvance(b));
      if (pay > 0) { next[b.id] = String(round2(pay)); remaining = round2(remaining - pay); }
    }
    setPayments(next);
  };

  const handleLumpSum = (val) => {
    setLumpSum(val);
    distribute(val);
  };

  // One-click "Apply Advance": auto-fill the Advance column oldest-first across
  // the SELECTED bills, capped by each bill's remaining due (after any cash
  // already entered) and the vendor's total available advance balance.
  const applyAdvance = () => {
    let remaining = round2(totalAdvanceAvailable);
    const next = {};
    for (const b of bills) {
      if (!isSelected(b.id)) continue;
      const due = Number(b.balance_due) || 0;
      const cash = Number(payments[b.id]) || 0;
      const apply = Math.min(remaining, round2(due - cash));
      if (apply > 0) { next[b.id] = String(round2(apply)); remaining = round2(remaining - apply); }
    }
    setAdvApplied(next);
  };

  const setCash = (billId, val, cap) => {
    let v = val;
    if (cap != null && (Number(val) || 0) > cap) v = String(round2(cap));
    setPayments(prev => ({ ...prev, [billId]: v }));
  };

  const setAdvance = (billId, val, cap) => {
    let v = val;
    if (cap != null && (Number(val) || 0) > cap) v = String(round2(cap));
    setAdvApplied(prev => ({ ...prev, [billId]: v }));
  };

  const clearApplied = () => { setPayments({}); setAdvApplied({}); setLumpSum(''); };

  const totalCash = useMemo(
    () => bills.reduce((s, b) => s + (Number(payments[b.id]) || 0), 0),
    [bills, payments],
  );
  const totalAdvanceUsed = useMemo(
    () => bills.reduce((s, b) => s + (Number(advApplied[b.id]) || 0), 0),
    [bills, advApplied],
  );
  const totalApplied = round2(totalCash + totalAdvanceUsed);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!header.vendor) { toast.error('Select a vendor.'); return; }

    const allocations = bills
      .filter(b => isSelected(b.id))
      .map(b => ({ bill_id: b.id, amount: round2(payments[b.id]) }))
      .filter(a => a.amount > 0);

    // FIFO-split each bill's advance amount across the open advance credits.
    const pool = advances.map(a => ({ id: a.id, remaining: Number(a.balance) || 0 }));
    const advance_allocations = [];
    for (const b of bills) {
      if (!isSelected(b.id)) continue;
      let need = round2(advApplied[b.id]);
      if (need <= 0) continue;
      for (const c of pool) {
        if (need <= 0) break;
        if (c.remaining <= 0) continue;
        const take = round2(Math.min(need, c.remaining));
        advance_allocations.push({ credit_id: c.id, bill_id: b.id, amount: take });
        c.remaining = round2(c.remaining - take);
        need = round2(need - take);
      }
    }

    if (!allocations.length && !advance_allocations.length) {
      toast.error('Enter a payment amount on at least one bill.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await apiClient.post('/api/purchase/payments-made/bulk-payment/', {
        vendor: header.vendor,
        payment_date: header.payment_date,
        payment_mode: header.payment_mode,
        bank_name: header.bank_name,
        reference_no: header.reference_no,
        notes: header.notes,
        allocations,
        advance_allocations,
      });
      // Bills just changed (balances down, some now fully PAID) — drop the
      // cached list so the next visit refetches and paid bills disappear.
      clearLookupCache('/api/purchase/bills/');
      toast.success(res.data?.detail || 'Payment recorded successfully!');
      navigate('/purchase/payments-made');
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass = "w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";
  const labelClass = "block text-xs font-semibold text-slate-700 mb-0.5";
  const cellInput = "w-full border border-slate-300 rounded px-2 py-1 text-sm text-right focus:ring-1 focus:ring-primary-500";
  const hasAdvances = totalAdvanceAvailable > 0;

  return (
    <MainLayout>
      <PageHeader
        title="Record Payment"
        breadcrumbs={[
          { label: 'Purchase', path: '/purchase' },
          { label: 'Payments Made', path: '/purchase/payments-made' },
          { label: 'New Payment' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Header */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
            <div>
              <label className={labelClass}>Vendor <span className="text-red-500">*</span></label>
              <CustomSelect name="vendor" value={header.vendor} onChange={(e) => setHeader(p => ({ ...p, vendor: e.target.value }))} required className={inputClass}>
                <option value="">Select Vendor</option>
                {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>
            <div>
              <label className={labelClass}>Payment Date <span className="text-red-500">*</span></label>
              <CustomDatePicker name="payment_date" value={header.payment_date} onChange={(e) => setHeader(p => ({ ...p, payment_date: e.target.value }))} required className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Payment Made (total)</label>
              <input type="number" step="0.01" min="0" value={lumpSum} onChange={(e) => handleLumpSum(e.target.value)} className={inputClass} placeholder="Enter amount to auto-distribute" disabled={!bills.length} />
            </div>
            <div>
              <label className={labelClass}>Payment Mode</label>
              <CustomSelect name="payment_mode" value={header.payment_mode} onChange={(e) => setHeader(p => ({ ...p, payment_mode: e.target.value }))} className={inputClass}>
                <option value="BANK_TRANSFER">Bank Transfer</option>
                <option value="CASH">Cash</option>
                <option value="CHEQUE">Cheque</option>
                <option value="UPI">UPI</option>
                <option value="NEFT">NEFT</option>
                <option value="RTGS">RTGS</option>
              </CustomSelect>
            </div>
            <div>
              <label className={labelClass}>Paid Through (Bank)</label>
              <input type="text" value={header.bank_name} onChange={(e) => setHeader(p => ({ ...p, bank_name: e.target.value }))} className={inputClass} placeholder="e.g. ICICI - Bank Account" />
            </div>
            <div>
              <label className={labelClass}>Reference No</label>
              <input type="text" value={header.reference_no} onChange={(e) => setHeader(p => ({ ...p, reference_no: e.target.value }))} className={inputClass} placeholder="UTR / Cheque / Txn ref" />
            </div>
          </div>

          {/* Bills grid */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800">Outstanding Bills</h3>
              {(totalApplied > 0) && (
                <button type="button" onClick={clearApplied} className="text-xs font-medium text-primary-600 hover:underline">Clear Applied Amount</button>
              )}
            </div>
            {hasAdvances && (
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <p className="text-xs text-emerald-700">Advance available for this vendor: <span className="font-semibold">{inr(totalAdvanceAvailable)}</span> — apply it per bill in the Advance column, or</p>
                <button type="button" onClick={applyAdvance} className="text-xs font-medium px-2.5 py-1 rounded-md border border-emerald-300 text-emerald-700 hover:bg-emerald-50">Apply Advance</button>
              </div>
            )}

            {!header.vendor ? (
              <p className="text-sm text-slate-500 italic py-4 sm:py-5 text-center">Select a vendor to list their outstanding bills.</p>
            ) : bills.length === 0 ? (
              <p className="text-sm text-slate-500 italic py-4 sm:py-5 text-center">No outstanding bills for this vendor.</p>
            ) : (
              <div className="overflow-auto border border-slate-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b text-slate-600">
                      <th className="px-3 py-2 w-10 text-center">
                        <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all bills" className="cursor-pointer" />
                      </th>
                      <th className="text-left px-3 py-2 font-medium">Bill Date</th>
                      <th className="text-left px-3 py-2 font-medium">Bill #</th>
                      <th className="text-left px-3 py-2 font-medium">Due Date</th>
                      <th className="text-right px-3 py-2 font-medium">Bill Amount</th>
                      <th className="text-right px-3 py-2 font-medium">Amount Due</th>
                      {hasAdvances && <th className="text-right px-3 py-2 font-medium w-36">Advance</th>}
                      <th className="text-right px-3 py-2 font-medium w-36">Payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bills.map(b => {
                      const due = Number(b.balance_due) || 0;
                      const adv = Number(advApplied[b.id]) || 0;
                      const cash = Number(payments[b.id]) || 0;
                      const advRemainingPool = round2(totalAdvanceAvailable - totalAdvanceUsed + adv);
                      const advCap = round2(Math.min(due - cash, advRemainingPool));
                      const cashCap = round2(due - adv);
                      const sel = isSelected(b.id);
                      return (
                        <tr key={b.id} className={`border-b last:border-0 hover:bg-primary-50/40 transition-colors ${sel ? '' : 'opacity-50'}`}>
                          <td className="px-3 py-2 text-center">
                            <input type="checkbox" checked={sel} onChange={() => toggleBill(b.id)} aria-label={`Select bill ${b.bill_no}`} className="cursor-pointer" />
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDate(b.bill_date)}</td>
                          <td className="px-3 py-2 whitespace-nowrap font-medium text-slate-800">{b.bill_no}</td>
                          <td className="px-3 py-2 whitespace-nowrap text-slate-500">{fmtDate(b.due_date)}</td>
                          <td className="px-3 py-2 text-right text-slate-600">{inr(b.total_amount)}</td>
                          <td className="px-3 py-2 text-right text-slate-800 font-medium">{inr(due)}</td>
                          {hasAdvances && (
                            <td className="px-3 py-2">
                              <input type="number" step="0.01" min="0" max={advCap} disabled={!sel} value={advApplied[b.id] || ''} onChange={(e) => setAdvance(b.id, e.target.value, advCap)} className={`${cellInput} disabled:bg-slate-100 disabled:cursor-not-allowed`} placeholder="0.00" />
                            </td>
                          )}
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" min="0" max={cashCap} disabled={!sel} value={payments[b.id] || ''} onChange={(e) => setCash(b.id, e.target.value, cashCap)} className={`${cellInput} disabled:bg-slate-100 disabled:cursor-not-allowed`} placeholder="0.00" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 border-t font-semibold text-slate-800">
                      <td className="px-3 py-2" colSpan={6}>Total</td>
                      {hasAdvances && <td className="px-3 py-2 text-right">{inr(totalAdvanceUsed)}</td>}
                      <td className="px-3 py-2 text-right">{inr(totalCash)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {bills.length > 0 && (
              <div className="mt-3 flex flex-col sm:flex-row sm:justify-end gap-1 text-sm">
                <div className="sm:text-right">
                  {totalAdvanceUsed > 0 && <p className="text-emerald-700">Advance applied: <span className="font-semibold">{inr(totalAdvanceUsed)}</span></p>}
                  <p className="text-slate-700">Cash / bank payment: <span className="font-semibold">{inr(totalCash)}</span></p>
                  <p className="text-slate-900 text-base">Total applied: <span className="font-bold">{inr(totalApplied)}</span></p>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className={labelClass}>Notes</label>
            <textarea value={header.notes} onChange={(e) => setHeader(p => ({ ...p, notes: e.target.value }))} rows={2} className={inputClass} placeholder="Additional notes..." />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading || totalApplied <= 0} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isLoading ? 'Saving...' : `Save Payment${totalApplied > 0 ? ` (${inr(totalApplied)})` : ''}`}
            </button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
