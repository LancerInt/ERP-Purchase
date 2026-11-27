import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Calendar, RefreshCw, AlertTriangle, CheckSquare, Square } from 'lucide-react';
import MainLayout from '../../../../components/layout/MainLayout';
import PageHeader from '../../../../components/common/PageHeader';
import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';
import useLookup from '../../../../hooks/useLookup.js';
import { formatDate } from '@/utils/formatters';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const labelClass = 'block text-sm font-medium text-slate-700 mb-1';
const readOnlyClass = `${inputClass} bg-slate-50 cursor-not-allowed`;
const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? formatDate(d) : '-';

// Cycle picker: WEEKLY = last 7 days, FOURTEEN_DAYS = last 14 days,
// CUSTOM = user picks both ends. Helpers derive the date pair so the
// user just clicks a chip instead of typing two dates.
const cycleDates = (cycle, anchor = new Date()) => {
  const to = new Date(anchor);
  const from = new Date(anchor);
  if (cycle === 'WEEKLY')        from.setDate(to.getDate() - 6);
  else if (cycle === 'FOURTEEN_DAYS') from.setDate(to.getDate() - 13);
  else return { from_date: '', to_date: '' };
  const iso = (d) => d.toISOString().split('T')[0];
  return { from_date: iso(from), to_date: iso(to) };
};

export default function WagePaymentCreate() {
  const navigate = useNavigate();
  const [isSaving, setIsSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Header form
  const today = new Date().toISOString().split('T')[0];
  const initialCycle = cycleDates('WEEKLY');
  const [form, setForm] = useState({
    contractor: '',
    cycle_type: 'WEEKLY',
    from_date: initialCycle.from_date,
    to_date: initialCycle.to_date,
    payment_date: today,
    payment_mode: 'BANK',
    reference_no: '',
    remarks: '',
    paid_amount: '',
  });

  // Optional extra filters
  const [sourceTypeFilter, setSourceTypeFilter] = useState('');

  // Unpaid lines + selection
  const [unpaidLines, setUnpaidLines] = useState([]);
  const [isFetching, setIsFetching] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Contractor vendor list — restricted to vendor_type CONTRACTOR or WAGES.
  const { options: contractorOptions } = useLookup(
    '/api/vendors/?vendor_type=CONTRACTOR,WAGES',
    { labelField: 'vendor_name' },
  );

  const handleCycleChange = (cycle) => {
    if (cycle === form.cycle_type) return;
    setForm(prev => ({
      ...prev,
      cycle_type: cycle,
      ...(cycle === 'CUSTOM' ? {} : cycleDates(cycle)),
    }));
    setSelectedIds(new Set());
    setUnpaidLines([]);
  };

  const fetchUnpaid = async () => {
    if (!form.contractor) {
      toast.error('Pick a contractor first.');
      return;
    }
    setIsFetching(true);
    setSelectedIds(new Set());
    try {
      const params = new URLSearchParams({ contractor: form.contractor });
      if (form.from_date) params.append('from_date', form.from_date);
      if (form.to_date)   params.append('to_date',   form.to_date);
      if (sourceTypeFilter) params.append('source_type', sourceTypeFilter);
      const res = await apiClient.get(`/api/purchase/wage-payments/unpaid-lines/?${params}`);
      setUnpaidLines(res.data || []);
      if ((res.data || []).length === 0) {
        toast('No unpaid wage lines in this range.', { icon: 'ℹ️' });
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to fetch wage lines');
      setUnpaidLines([]);
    } finally {
      setIsFetching(false);
    }
  };

  // Refetch whenever contractor/dates/source-filter change AND a contractor is picked.
  useEffect(() => {
    if (form.contractor) fetchUnpaid();
    else { setUnpaidLines([]); setSelectedIds(new Set()); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.contractor, form.from_date, form.to_date, sourceTypeFilter]);

  // Toggle selection
  const toggleLine = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const allSelected = unpaidLines.length > 0 && selectedIds.size === unpaidLines.length;
  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(unpaidLines.map(l => l.id)));
  };

  // Aggregates over selected lines
  const totals = useMemo(() => {
    const picked = unpaidLines.filter(l => selectedIds.has(l.id));
    const loading   = picked.filter(l => l.wage_type === 'LOADING')  .reduce((s, l) => s + Number(l.amount   || 0), 0);
    const unloading = picked.filter(l => l.wage_type === 'UNLOADING').reduce((s, l) => s + Number(l.amount   || 0), 0);
    const gross   = loading + unloading;
    const advance = picked.reduce((s, l) => s + Number(l.advance_paid || 0), 0);
    const net = gross - advance;
    return { count: picked.length, loading, unloading, gross, advance, net };
  }, [unpaidLines, selectedIds]);

  // Auto-default paid_amount = net whenever selection changes (user can override)
  useEffect(() => {
    setForm(prev => ({ ...prev, paid_amount: totals.net > 0 ? totals.net.toFixed(2) : '0.00' }));
  }, [totals.net]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: value }));
    if (name === 'from_date' || name === 'to_date') {
      setForm(prev => ({ ...prev, cycle_type: 'CUSTOM' }));
    }
  };

  const handleSubmit = async () => {
    if (!form.contractor)            { toast.error('Contractor / Vendor is required.'); return; }
    if (selectedIds.size === 0)      { toast.error('Select at least one unpaid wage line.'); return; }
    if (!form.payment_date)          { toast.error('Payment date is required.'); return; }
    if (!form.from_date || !form.to_date) { toast.error('Date range is required.'); return; }
    const paid = parseFloat(form.paid_amount) || 0;
    if (paid <= 0)                   { toast.error('Payment amount must be greater than 0.'); return; }

    setIsSaving(true);
    try {
      const payload = {
        contractor: form.contractor,
        cycle_type: form.cycle_type,
        from_date: form.from_date,
        to_date: form.to_date,
        payment_date: form.payment_date,
        payment_mode: form.payment_mode,
        reference_no: form.reference_no,
        remarks: form.remarks,
        paid_amount: paid,
        line_ids: [...selectedIds],
      };
      const res = await apiClient.post('/api/purchase/wage-payments/', payload);
      toast.success(`${res.data.payment_no} created as Draft — ${selectedIds.size} line(s) reserved. Open the payment and click Approve to mark them Paid.`);
      navigate(`/freight/wages/payments/${res.data.id}`);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to create payment');
    } finally {
      setIsSaving(false);
      setConfirmOpen(false);
    }
  };

  const contractorName = useMemo(
    () => contractorOptions.find(o => o.value === form.contractor)?.label || '—',
    [contractorOptions, form.contractor],
  );

  return (
    <MainLayout>
      <PageHeader
        title="New Wage Payment"
        subtitle="Settle a contractor's wages for a weekly / 14-day / custom period"
        breadcrumbs={[
          { label: 'Freight & Billing', href: '/freight/inward' },
          { label: 'Wages', href: '/freight/wages' },
          { label: 'Payments', href: '/freight/wages/payments' },
          { label: 'New' },
        ]}
      />

      <div className="space-y-4 sm:space-y-5">
        {/* ── Payment header card ──────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Payment Cycle</h3>

          {/* Cycle picker chips */}
          <div className="flex flex-wrap gap-2 mb-4">
            {[
              { v: 'WEEKLY', label: 'Weekly (Last 7 Days)' },
              { v: 'FOURTEEN_DAYS', label: '14 Days (Last 2 Weeks)' },
              { v: 'CUSTOM', label: 'Custom Range' },
            ].map(o => (
              <button
                key={o.v}
                type="button"
                onClick={() => handleCycleChange(o.v)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                  form.cycle_type === o.v
                    ? 'bg-primary-50 text-primary-700 border-primary-300'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <Calendar size={14} /> {o.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className={labelClass}>From Date <span className="text-red-500">*</span></label>
              <CustomDatePicker name="from_date" value={form.from_date} onChange={handleChange} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>To Date <span className="text-red-500">*</span></label>
              <CustomDatePicker name="to_date" value={form.to_date} onChange={handleChange} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Contractor / Labour Vendor <span className="text-red-500">*</span></label>
              <CustomSelect name="contractor" value={form.contractor} onChange={handleChange} className={inputClass}>
                <option value="">Select contractor</option>
                {contractorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
              <p className="text-xs text-slate-400 mt-0.5">From Vendor Master · type CONTRACTOR or WAGES only</p>
            </div>
            <div>
              <label className={labelClass}>Source Type Filter</label>
              <CustomSelect value={sourceTypeFilter} onChange={e => setSourceTypeFilter(e.target.value)} className={inputClass}>
                <option value="">All Sources</option>
                <option value="PURCHASE_RECEIPT">Purchase Receipt</option>
                <option value="INVENTORY_TRANSFER">Inventory Transfer</option>
                <option value="INVENTORY_SHIFTING">Inventory Shifting</option>
                <option value="SALES_DISPATCH_CHALLAN">Dispatch Challan</option>
              </CustomSelect>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-end">
            <button
              type="button"
              onClick={fetchUnpaid}
              disabled={!form.contractor || isFetching}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 disabled:opacity-50"
            >
              <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} /> Refresh Unpaid Lines
            </button>
          </div>
        </div>

        {/* ── Unpaid lines selection ───────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <div className="flex items-center justify-between mb-4 pb-2 border-b">
            <h3 className="text-lg font-semibold text-slate-800">
              Unpaid Wage Lines {unpaidLines.length > 0 && <span className="text-sm font-normal text-slate-500 ml-2">({selectedIds.size} of {unpaidLines.length} selected)</span>}
            </h3>
            {unpaidLines.length > 0 && (
              <button
                type="button"
                onClick={toggleAll}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded"
              >
                {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                {allSelected ? 'Deselect All' : 'Select All'}
              </button>
            )}
          </div>

          {!form.contractor ? (
            <div className="text-center py-10 text-slate-400 text-sm">
              <Users size={32} className="mx-auto mb-2 text-slate-300" />
              Pick a contractor above to load their unpaid wage lines.
            </div>
          ) : isFetching ? (
            <div className="text-center py-10 text-slate-500">Loading lines...</div>
          ) : unpaidLines.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-sm">
              <AlertTriangle size={28} className="mx-auto mb-2 text-slate-300" />
              No unpaid wage lines for <strong>{contractorName}</strong> in this range.
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm" style={{ minWidth: '900px' }}>
                  <thead>
                    <tr className="bg-primary-50 border-b-2 border-slate-300">
                      <th className="px-3 py-2 w-10"></th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Wage Entry</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Source</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Doc No</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Work Date</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Type</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Ton</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Rate</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Amount</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Advance</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Balance</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unpaidLines.map(l => {
                      const checked = selectedIds.has(l.id);
                      return (
                        <tr key={l.id} className={`border-b border-slate-50 hover:bg-blue-50/30 cursor-pointer ${checked ? 'bg-primary-50/40' : ''}`} onClick={() => toggleLine(l.id)}>
                          <td className="px-3 py-2"><input type="checkbox" checked={checked} onChange={() => toggleLine(l.id)} onClick={e => e.stopPropagation()} className="rounded border-slate-300 text-primary-600 focus:ring-primary-500" /></td>
                          <td className="px-3 py-2 text-xs text-slate-600">{l.entry_no}</td>
                          <td className="px-3 py-2 text-xs text-slate-600">{l.source_type_display}</td>
                          <td className="px-3 py-2 text-xs text-slate-600">{l.source_doc_no || '-'}</td>
                          <td className="px-3 py-2 text-xs">{fmtDate(l.work_date)}</td>
                          <td className="px-3 py-2"><span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${l.wage_type === 'LOADING' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>{l.wage_type_display}</span></td>
                          <td className="px-3 py-2 text-right">{Number(l.tons || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                          <td className="px-3 py-2 text-right">{fmt(l.cost_per_ton)}</td>
                          <td className="px-3 py-2 text-right font-medium">{fmt(l.amount)}</td>
                          <td className="px-3 py-2 text-right text-amber-700">{fmt(l.advance_paid)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-emerald-700">{fmt(l.balance)}</td>
                          <td className="px-3 py-2 text-xs text-slate-500 truncate max-w-[160px]">{l.remarks || '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile-stacked cards */}
              <div className="sm:hidden space-y-2">
                {unpaidLines.map(l => {
                  const checked = selectedIds.has(l.id);
                  return (
                    <div key={l.id} onClick={() => toggleLine(l.id)} className={`border rounded-lg p-3 ${checked ? 'border-primary-300 bg-primary-50/40' : 'border-slate-200 bg-white'}`}>
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <input type="checkbox" checked={checked} onChange={() => toggleLine(l.id)} onClick={e => e.stopPropagation()} className="rounded border-slate-300 text-primary-600 focus:ring-primary-500" />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-800 truncate">{l.entry_no}</p>
                            <p className="text-xs text-slate-500 truncate">{l.source_type_display} · {l.source_doc_no || '-'}</p>
                          </div>
                        </div>
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${l.wage_type === 'LOADING' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>{l.wage_type_display}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-1 text-[11px]">
                        <div><span className="text-slate-500">Date:</span> {fmtDate(l.work_date)}</div>
                        <div><span className="text-slate-500">Ton:</span> {Number(l.tons || 0).toLocaleString('en-IN')}</div>
                        <div><span className="text-slate-500">Rate:</span> {fmt(l.cost_per_ton)}</div>
                        <div><span className="text-slate-500">Amt:</span> {fmt(l.amount)}</div>
                        <div><span className="text-slate-500">Adv:</span> <span className="text-amber-700">{fmt(l.advance_paid)}</span></div>
                        <div><span className="text-slate-500">Bal:</span> <span className="text-emerald-700 font-semibold">{fmt(l.balance)}</span></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* ── Totals + payment header ─────────────────────────────── */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Payment Summary</h3>

          {/* Totals strip */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
            <Stat label="Selected" value={totals.count} />
            <Stat label="Loading"   value={fmt(totals.loading)} />
            <Stat label="Unloading" value={fmt(totals.unloading)} />
            <Stat label="Gross"     value={fmt(totals.gross)}    cls="text-slate-800" />
            <Stat label="Advance"   value={fmt(totals.advance)}  cls="text-amber-700" />
            <Stat label="Net Payable" value={fmt(totals.net)}    cls="text-emerald-700 font-bold" />
          </div>

          {/* Payment details */}
          <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className={labelClass}>Payment Date <span className="text-red-500">*</span></label>
              <CustomDatePicker name="payment_date" value={form.payment_date} onChange={handleChange} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Payment Mode <span className="text-red-500">*</span></label>
              <CustomSelect name="payment_mode" value={form.payment_mode} onChange={handleChange} className={inputClass}>
                <option value="CASH">Cash</option>
                <option value="BANK">Bank Transfer</option>
                <option value="UPI">UPI</option>
                <option value="CHEQUE">Cheque</option>
                <option value="NEFT">NEFT</option>
                <option value="RTGS">RTGS</option>
                <option value="OTHER">Other</option>
              </CustomSelect>
            </div>
            <div>
              <label className={labelClass}>Reference No</label>
              <input type="text" name="reference_no" value={form.reference_no} onChange={handleChange} className={inputClass} placeholder="UTR, cheque no, txn id..." />
            </div>
            <div>
              <label className={labelClass}>Payment Amount <span className="text-red-500">*</span></label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-slate-400 text-sm">₹</span>
                <input type="number" step="0.01" min="0" name="paid_amount" value={form.paid_amount} onChange={handleChange} className={`${inputClass} pl-7`} placeholder="0.00" />
              </div>
              <p className="text-xs text-slate-400 mt-0.5">Defaults to Net Payable · editable if business allows</p>
            </div>
          </div>
          <div className="mt-4">
            <label className={labelClass}>Remarks</label>
            <textarea name="remarks" value={form.remarks} onChange={handleChange} rows={3} className={inputClass} placeholder="Notes for this payment cycle..." />
          </div>
        </div>

        {/* ── Actions ────────────────────────────────────────────── */}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/freight/wages/payments')} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={isSaving || selectedIds.size === 0 || !form.contractor}
            className="px-4 sm:px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : `Pay Selected Wages (${selectedIds.size})`}
          </button>
        </div>
      </div>

      {/* ── Confirmation modal ─────────────────────────────────────── */}
      {confirmOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setConfirmOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Confirm Wage Payment" className="bg-white rounded-xl shadow-2xl max-w-md w-full p-4 sm:p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-800 mb-2">Confirm Wage Payment</h3>
            <p className="text-sm text-slate-600 mb-4">
              Pay <strong className="text-emerald-700">{fmt(form.paid_amount)}</strong> to <strong>{contractorName}</strong> against <strong>{selectedIds.size}</strong> wage line(s) for the period <strong>{fmtDate(form.from_date)} → {fmtDate(form.to_date)}</strong>.
            </p>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-4">
              Once created, these wage lines will be marked Paid and locked from edits. The settlement can still be cancelled from the payment detail page to release them.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmOpen(false)} className="px-4 py-2 border border-slate-300 rounded text-sm text-slate-700 hover:bg-slate-50">Back</button>
              <button onClick={handleSubmit} disabled={isSaving} className="px-4 py-2 bg-emerald-600 text-white rounded text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
                {isSaving ? 'Creating…' : 'Confirm & Pay'}
              </button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}

function Stat({ label, value, cls = 'text-slate-800' }) {
  return (
    <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-base mt-0.5 ${cls}`}>{value}</p>
    </div>
  );
}

// Lucide Users icon (used in empty state) — imported lazily so we don't
// blow up the import list at the top.
function Users(props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={props.size || 24} height={props.size || 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
