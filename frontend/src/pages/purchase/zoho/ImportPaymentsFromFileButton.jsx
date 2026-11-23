/**
 * "Import Payments" — upload a Tally Day Book (XML Data Interchange) and apply
 * its Payment vouchers to vendor bills, so Amount Paid / Outstanding tie Tally.
 *
 * Preview writes NOTHING (POST /api/purchase/payments/preview-file/): it shows
 * where each payment would land — Against-Reference (settles a real bill) vs
 * on-account (advances) vs FIFO — and the projected Outstanding. Apply
 * (POST …/apply-file/) writes amount_paid + payment records only; it never
 * touches Ex-GST/GST/Total. Same server core as the CLI import_vendor_payments.
 */
import { useState } from 'react';
import { Loader2, X, Banknote, FileUp, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import { Button } from '../../../components/ui';
import { fmtINRfull } from './shared.jsx';

export function ImportPaymentsFromFileButton({ f, onDone }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [company, setCompany] = useState(f?.company || 'SSB-002');
  const [from, setFrom] = useState(f?.from || '');
  const [to, setTo] = useState(f?.to || '');
  const [fifo, setFifo] = useState(false);
  const [data, setData] = useState(null);

  const fd = () => {
    const d = new FormData();
    d.append('file', file);
    d.append('company', company);
    d.append('from', from);
    d.append('to', to);
    return d;
  };

  const preview = async () => {
    if (!file) { toast.error('Attach the Day Book XML first.'); return; }
    setBusy(true); setData(null);
    try {
      const r = await apiClient.post('/api/purchase/payments/preview-file/', fd(),
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Preview failed.');
    } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!file) return;
    if (!window.confirm('Apply these payments to the bills? This writes amount_paid on matched bills.')) return;
    setBusy(true);
    try {
      const d = fd();
      if (fifo) d.append('fifo', '1');
      const r = await apiClient.post('/api/purchase/payments/apply-file/', d,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      toast.success(r.data.detail || 'Applied.');
      setData(null); setFile(null); setOpen(false);
      onDone && onDone();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Apply failed.');
    } finally { setBusy(false); }
  };

  return (
    <>
      <Button variant="outline" icon={Banknote} responsiveLabel onClick={() => setOpen(true)}>
        Import Payments
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-4">
          <div className="mt-8 w-full max-w-3xl rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <div className="flex items-center gap-2 font-semibold text-slate-800">
                <Banknote size={18} /> Import Payments from File
              </div>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <p className="text-sm text-slate-600">
                Upload the Tally <b>Day Book</b> (export as <b>XML — Data Interchange</b>). It settles each
                payment's <b>Against-Reference</b> bill; advances stay on-account. <b>Preview writes nothing.</b>
              </p>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm text-slate-600">Company code
                  <input value={company} onChange={(e) => setCompany(e.target.value)}
                         className="mt-1 w-full rounded border px-2 py-1" />
                </label>
                <div />
                <label className="text-sm text-slate-600">From
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                         className="mt-1 w-full rounded border px-2 py-1" />
                </label>
                <label className="text-sm text-slate-600">To
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                         className="mt-1 w-full rounded border px-2 py-1" />
                </label>
              </div>

              <label className="flex cursor-pointer items-center gap-2 rounded border-2 border-dashed p-3 text-sm hover:bg-slate-50">
                <FileUp size={16} />
                <span className="truncate">{file ? file.name : 'Choose Day Book XML…'}</span>
                <input type="file" accept=".xml" className="hidden"
                       onChange={(e) => { setFile(e.target.files?.[0] || null); setData(null); }} />
              </label>

              <Button onClick={preview} loading={busy}>Preview (no writes)</Button>

              {data && (
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded bg-slate-50 p-3">
                    <div>Payments read: <b>{data.count}</b></div>
                    <div>Resolved / unmatched: <b>{data.resolved}</b> / {data.unmatched}</div>
                    <div>Against-Reference (settles bills): <b>{fmtINRfull(data.against_ref)}</b></div>
                    <div>On-account (advances): {fmtINRfull(data.on_account)}</div>
                    <div>Would FIFO (only if enabled): {fmtINRfull(data.fifo)}</div>
                    <div>Already applied (skipped): {data.already}</div>
                  </div>

                  <div className="rounded border border-amber-200 bg-amber-50 p-3">
                    <div>Outstanding now: <b>{fmtINRfull(data.outstanding_now)}</b></div>
                    <div>After apply — safe (default): <b className="text-emerald-700">{fmtINRfull(data.outstanding_safe)}</b></div>
                    <div>After apply — with FIFO: {fmtINRfull(data.outstanding_fifo)}</div>
                  </div>

                  {data.vendors?.length > 0 && (
                    <div className="max-h-56 overflow-auto rounded border">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-slate-100">
                          <tr>
                            <th className="px-2 py-1 text-left">Vendor</th>
                            <th className="px-2 py-1 text-right">Paid</th>
                            <th className="px-2 py-1 text-right">→ Bills</th>
                            <th className="px-2 py-1 text-right">On-acct</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.vendors.map((v, i) => (
                            <tr key={i} className="border-t">
                              <td className="px-2 py-1">{v.name}</td>
                              <td className="px-2 py-1 text-right">{fmtINRfull(v.paid)}</td>
                              <td className="px-2 py-1 text-right">{fmtINRfull(v.applied)}</td>
                              <td className="px-2 py-1 text-right">{fmtINRfull(v.on_account)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={fifo} onChange={(e) => setFifo(e.target.checked)} />
                    Also FIFO leftover onto oldest bills (riskier — advances would settle old bills)
                  </label>
                  <div className="flex items-center gap-2 text-xs text-amber-700">
                    <AlertTriangle size={14} /> Apply writes amount_paid + payment records (reversible — each carries a Tally id).
                  </div>
                  <div className="flex gap-2">
                    <Button variant="danger" onClick={apply} loading={busy}>Apply to bills</Button>
                    <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default ImportPaymentsFromFileButton;
