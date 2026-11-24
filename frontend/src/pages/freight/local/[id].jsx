import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Truck, IndianRupee, FileText, Loader2, Wallet, Plus, X } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import FileAttachments from '../../purchase/components/FileAttachments';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

const TYPE_LABEL = {
  LOCAL_FREIGHT: 'Local Freight', STOCK_TRANSFER: 'Stock Transfer',
  UNLOADING_CHARGES: 'Unloading Charges', INWARD_CHARGES: 'Inward Charges',
  OUTWARD_CHARGES: 'Outward Charges',
};
const MODES = ['BANK', 'NEFT', 'RTGS', 'UPI', 'CHEQUE', 'CASH', 'OTHER'];
const money = (v) => formatCurrency(Number(v) || 0);
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function Row({ label, value, strong }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-500 shrink-0">{label}</span>
      <span className={`text-sm text-right ${strong ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>{value || '—'}</span>
    </div>
  );
}

export default function LocalFreightDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [lf, setLf] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Record-payment modal + the payment being viewed (clickable row).
  const [showPay, setShowPay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ payment_date: today(), amount_paid: '', payment_mode: 'BANK', reference_no: '', paid_to: '' });
  const [viewPay, setViewPay] = useState(null);

  const load = () => {
    setLoading(true);
    return apiClient.get(`/api/purchase/local-freight/${id}/`)
      .then((r) => { setLf(r.data); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const back = () => window.history.state?.idx > 0 ? navigate(-1) : navigate('/freight/local');

  const submitPayment = async (e) => {
    e.preventDefault();
    if (!form.amount_paid || Number(form.amount_paid) <= 0) { toast.error('Enter an amount greater than 0'); return; }
    setSaving(true);
    try {
      await apiClient.post(`/api/purchase/local-freight/${id}/add-payment/`, {
        payment_date: form.payment_date || today(),
        amount_paid: form.amount_paid,
        payment_mode: form.payment_mode,
        reference_no: form.reference_no,
        paid_to: form.paid_to,
      });
      toast.success('Payment recorded');
      setShowPay(false);
      setForm({ payment_date: today(), amount_paid: '', payment_mode: 'BANK', reference_no: '', paid_to: '' });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || 'Could not record the payment');
    } finally { setSaving(false); }
  };

  if (loading && !lf) {
    return <MainLayout><div className="flex items-center gap-2 p-8 text-slate-500"><Loader2 size={18} className="animate-spin" /> Loading…</div></MainLayout>;
  }
  if (error || !lf) {
    return (
      <MainLayout>
        <div className="p-6">
          <button onClick={back} className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"><ArrowLeft size={16} /> Back to Local Freight</button>
          <p className="text-red-500 mt-4">Could not load this local freight record.</p>
        </div>
      </MainLayout>
    );
  }

  const balance = Number(lf.balance) || 0;
  // Payment History — the amount booked inline with the slip (if any) + real
  // LocalFreightPayment vouchers (clickable, like the Bills page).
  const payRows = [
    ...(Number(lf.amount_pay) > 0 ? [{ key: 'inline', no: null, date: lf.date, amount: lf.amount_pay, mode: lf.payment_mode || '—', ref: 'Booked with slip' }] : []),
    ...(lf.payments || []).map((p, i) => ({ key: p.id || `p${i}`, no: p.payment_no || null, date: p.payment_date, amount: p.amount_paid, mode: p.payment_mode || '—', ref: p.reference_no || p.paid_to || '—', raw: p })),
  ];

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={back} className="p-2 rounded-lg hover:bg-slate-100 shrink-0" title="Back to Local Freight"><ArrowLeft size={18} /></button>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 truncate">{lf.freight_no}</h1>
            <p className="text-sm text-slate-500">Local Freight · {TYPE_LABEL[lf.freight_type] || lf.freight_type}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {balance > 0 && (
              <button onClick={() => setShowPay(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
                <Plus size={15} /> Record Payment
              </button>
            )}
            {lf.is_dc && (
              <span className="px-2.5 py-1 rounded-lg bg-fuchsia-100 text-fuchsia-700 text-xs font-semibold">DC / Branch Transfer</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Freight details */}
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-2"><Truck size={15} className="text-blue-500" /> Freight</h2>
            <Row label="Date" value={lf.date ? formatDate(lf.date) : '—'} />
            <Row label="Company" value={lf.company_name} />
            <Row label="Factory / Warehouse" value={lf.factory_name} />
            <Row label="Transporter" value={lf.transporter_name} />
            <Row label="Lorry No" value={lf.lorry_no} />
            <Row label="Bill No" value={lf.bill_no} />
            <Row label="Bill Date" value={lf.bill_date ? formatDate(lf.bill_date) : '—'} />
            {lf.remarks ? <Row label="Remarks" value={lf.remarks} /> : null}
          </div>

          {/* Amounts — freight is the only money on this record */}
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-2"><IndianRupee size={15} className="text-emerald-500" /> Amounts</h2>
            <Row label="Freight Amount" value={money(lf.freight_amount)} />
            {Number(lf.additional_freight_amount) ? <Row label="Additional" value={money(lf.additional_freight_amount)} /> : null}
            {Number(lf.less_amount) ? <Row label="Less / Round-off" value={money(lf.less_amount)} /> : null}
            {Number(lf.tds_less) ? <Row label="TDS" value={money(lf.tds_less)} /> : null}
            <Row label="Payable" value={money(lf.payable_amount)} strong />
            <Row label="Paid" value={money(lf.total_paid)} />
            <Row label="Balance" value={money(lf.balance)} strong />
          </div>
        </div>

        {/* DC / branch-transfer — reference only, never booked */}
        {lf.is_dc && (
          <div className="bg-fuchsia-50/40 rounded-lg border border-fuchsia-200 p-5">
            <h2 className="text-xs font-semibold text-fuchsia-700 uppercase tracking-wide mb-2">DC / Branch Transfer — reference only (goods value is not booked)</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10">
              <Row label="DC No" value={lf.dc_no} />
              <Row label="From → To" value={[lf.dc_from, lf.dc_to].filter(Boolean).join(' → ')} />
              <Row label="Material" value={lf.dc_material} />
              <Row label="Goods Value" value={Number(lf.dc_value) > 0 ? money(lf.dc_value) : '—'} />
            </div>
          </div>
        )}

        {/* Payment History — real payment vouchers are clickable, like the Bills page */}
        {payRows.length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3 flex items-center gap-2"><Wallet size={15} className="text-emerald-500" /> Payment History ({payRows.length})</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-3 font-medium">Payment No</th>
                    <th className="py-2 px-3 font-medium">Date</th>
                    <th className="py-2 px-3 font-medium text-right">Amount</th>
                    <th className="py-2 px-3 font-medium">Mode</th>
                    <th className="py-2 pl-3 font-medium">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {payRows.map((p) => (
                    <tr key={p.key} className="border-b border-slate-50 last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {p.no ? (
                          <button onClick={() => setViewPay(p.raw)} className="font-medium text-primary-600 hover:text-primary-800 hover:underline">{p.no}</button>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap text-slate-700">{p.date ? formatDate(p.date) : '—'}</td>
                      <td className="py-2 px-3 text-right font-semibold tabular-nums text-slate-900">{money(p.amount)}</td>
                      <td className="py-2 px-3 text-slate-600">{p.mode}</td>
                      <td className="py-2 pl-3 text-slate-500">{p.ref}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Attached bill / slip — same component the Bills page uses */}
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3 flex items-center gap-2"><FileText size={15} className="text-slate-400" /> Attached bill / slip</h2>
          <FileAttachments module="FREIGHT" recordId={id} />
        </div>
      </div>

      {/* Record Payment modal */}
      {showPay && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowPay(false)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={submitPayment} className="bg-white rounded-xl w-full max-w-md p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-slate-900">Record Payment · {lf.freight_no}</h3>
              <button type="button" onClick={() => setShowPay(false)} className="p-1 text-slate-400 hover:text-slate-700"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500">Balance due: <span className="font-semibold text-amber-600">{money(balance)}</span></p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-500">Date
                <input type="date" value={form.payment_date} max={today()} onChange={(e) => setForm({ ...form, payment_date: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs text-slate-500">Amount
                <input type="number" step="0.01" value={form.amount_paid} onChange={(e) => setForm({ ...form, amount_paid: e.target.value })} placeholder={balance.toFixed(2)} className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs text-slate-500">Mode
                <select value={form.payment_mode} onChange={(e) => setForm({ ...form, payment_mode: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm">
                  {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label className="text-xs text-slate-500">Reference / NEFT no
                <input value={form.reference_no} onChange={(e) => setForm({ ...form, reference_no: e.target.value })} className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs text-slate-500 col-span-2">Paid to (optional)
                <input value={form.paid_to} onChange={(e) => setForm({ ...form, paid_to: e.target.value })} placeholder={lf.transporter_name || ''} className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowPay(false)} className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">Cancel</button>
              <button type="submit" disabled={saving} className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5">{saving && <Loader2 size={14} className="animate-spin" />}Save Payment</button>
            </div>
          </form>
        </div>
      )}

      {/* Payment detail popup (clicking a Payment No) */}
      {viewPay && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setViewPay(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl w-full max-w-sm p-5 space-y-1">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-primary-600">{viewPay.payment_no || 'Payment'}</h3>
              <button onClick={() => setViewPay(null)} className="p-1 text-slate-400 hover:text-slate-700"><X size={18} /></button>
            </div>
            <Row label="Date" value={viewPay.payment_date ? formatDate(viewPay.payment_date) : '—'} />
            <Row label="Amount" value={money(viewPay.amount_paid)} strong />
            <Row label="Mode" value={viewPay.payment_mode} />
            <Row label="Reference" value={viewPay.reference_no} />
            <Row label="Paid To" value={viewPay.paid_to} />
            {viewPay.notes ? <Row label="Notes" value={viewPay.notes} /> : null}
          </div>
        </div>
      )}
    </MainLayout>
  );
}
