import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Upload, Loader2, Link2, AlertTriangle, CheckCircle, HelpCircle, Search, ShieldCheck, Download } from 'lucide-react';
import MainLayout from '../../../../components/layout/MainLayout';
import PageHeader from '../../../../components/common/PageHeader';
import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';
import { confirm } from '@/components/common/confirm';
import { formatCurrency } from '@/utils/formatters';

// Reconcile Apr–Sep payments to their bills from the Tally Day Book.
//   1. Upload the Day Book XML(s) -> DRY-RUN preview (an EXACT simulation of
//      Apply — "Will link" is precisely what Apply will do). Nothing changes.
//   2. If it looks right, click Apply -> links each payment to its bill(s).
// Apply only sets the bill FK (and splits a lump that paid several bills); it
// never touches amount_paid, so no balance moves. The uploaded files are kept
// in state so Apply re-sends the exact same set the preview was built from.
const TONE = {
  good:   'text-emerald-700',
  muted:  'text-slate-500',
  warn:   'text-amber-700',
  review: 'text-orange-700',
};

export default function ReconcilePayments() {
  // Which company every tool on this page runs against. SS was done first; PPS
  // Motors etc. turned out to be UAI bills the SS-scoped tools never saw.
  const [company, setCompany] = useState('SSB-002');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [digging, setDigging] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [marking, setMarking] = useState(false);
  const [linkingProv, setLinkingProv] = useState(false);
  const [result, setResult] = useState(null);
  const [applied, setApplied] = useState(null);
  const [deep, setDeep] = useState(null);      // investigate() result
  const [audit, setAudit] = useState(null);    // audit-paid-bills result
  const [markDone, setMarkDone] = useState(null);  // mark-unpaid write result
  const [linkProvDone, setLinkProvDone] = useState(null);  // link-provable write result
  const [files, setFiles] = useState(null);   // the File[] the preview used
  // Payables sync (the definitive 'match outstanding to Tally') — own file.
  const [payBusy, setPayBusy] = useState(false);
  const [payFiles, setPayFiles] = useState(null);
  const [paySync, setPaySync] = useState(null);     // dry-run result
  const [paySyncDone, setPaySyncDone] = useState(null);
  // Create missing bills from a Tally purchase-voucher export.
  const [pbBusy, setPbBusy] = useState(false);
  const [pbFiles, setPbFiles] = useState(null);
  const [pbDry, setPbDry] = useState(null);
  const [pbDone, setPbDone] = useState(null);
  // Link leftover on-account payments to their vendor's bill by amount.
  const [amtBusy, setAmtBusy] = useState(false);
  const [amtDry, setAmtDry] = useState(null);
  const [amtDone, setAmtDone] = useState(null);
  // Link from the Tally Day Book's "who paid what" (vendor+amount+date).
  const [dbmBusy, setDbmBusy] = useState(false);
  const [dbmFiles, setDbmFiles] = useState(null);
  const [dbmDry, setDbmDry] = useState(null);
  const [dbmDone, setDbmDone] = useState(null);
  // Read-only: explain each expense payment from the Tally Expenses export.
  const [expBusy, setExpBusy] = useState(false);
  const [expResult, setExpResult] = useState(null);

  const onUpload = useCallback(async (picked) => {
    if (!picked?.length) return;
    const arr = Array.from(picked);
    setBusy(true); setResult(null); setApplied(null); setDeep(null); setAudit(null); setFiles(arr);
    try {
      const fd = new FormData();
      arr.forEach((f) => fd.append('files', f));
      const { data } = await apiClient.post('/api/finance/reconcile-payments/preview/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 180000,   // parsing 6 Day Books + matching can take a while
      });
      setResult(data);
      toast.success(`Read ${data.payments_parsed} payments.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); setFiles(null); }
    finally { setBusy(false); }
  }, []);

  const onApply = useCallback(async () => {
    if (!files?.length) return;
    const n = result?.summary?.will_link || 0;
    const ok = await confirm({
      title: 'Apply reconciliation?',
      message: `This will link ${n} payment${n === 1 ? '' : 's'} to their bill(s) from the Day Book. ` +
        `A payment that settled several bills is split into one voucher per bill. ` +
        `Only the bill link is set — no amount is changed, so no balance moves. ` +
        `You can undo a link by deleting the payment.`,
      confirmLabel: 'Apply',
    });
    if (!ok) return;
    setApplying(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      const { data } = await apiClient.post('/api/finance/reconcile-payments/apply/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 180000,
      });
      setApplied(data);
      toast.success(`Linked ${data.payments_linked} payments.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setApplying(false); }
  }, [files, result]);

  const onAudit = useCallback(async () => {
    if (!files?.length) { toast.error('Upload the Day Book XML(s) first.'); return; }
    setAuditing(true); setAudit(null);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      fd.append('company', company);
      const { data } = await apiClient.post('/api/finance/reconcile-payments/audit-paid-bills/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 180000,
      });
      setAudit(data); setMarkDone(null); setLinkProvDone(null);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setAuditing(false); }
  }, [files, company]);

  // Mark the real-doubtful SS bills Unpaid. Dry-run first (to get the exact
  // SS-scoped count), then a hard confirm, then write. Reversible server-side.
  const onMarkUnpaid = useCallback(async () => {
    if (!files?.length) return;
    setMarking(true);
    try {
      const dry = new FormData();
      files.forEach((f) => dry.append('files', f));
      dry.append('company', company);
      const { data: d } = await apiClient.post('/api/finance/reconcile-payments/mark-doubtful-unpaid/', dry, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 180000,
      });
      const n = d.would_unpay || 0;
      if (!n) { toast('Nothing to mark unpaid.'); setMarking(false); return; }
      const ok = await confirm({
        title: 'Mark these bills Unpaid?',
        message: `This will set ${n} ${d.company} bill${n === 1 ? '' : 's'} (${formatCurrency(Number(d.total_amount) || 0)}) ` +
          `that have NO payment proof back to Unpaid (Open). This RAISES outstanding by that amount. ` +
          `It is reversible (Undo restores them). Re-import each month's payments and the matching ones ` +
          `go Paid with a linked payment. Continue?`,
        isDangerous: true, confirmLabel: `Mark ${n} Unpaid`,
      });
      if (!ok) { setMarking(false); return; }
      const wr = new FormData();
      files.forEach((f) => wr.append('files', f));
      wr.append('write', '1');
      wr.append('company', company);
      const { data } = await apiClient.post('/api/finance/reconcile-payments/mark-doubtful-unpaid/', wr, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 180000,
      });
      setMarkDone(data);
      toast.success(`${data.unpaid} bills marked Unpaid.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setMarking(false); }
  }, [files, company]);

  // Attach the Tally payment to each provable bill (link-only). Dry-run first
  // for the exact SS count, then confirm, then write.
  const onLinkProvable = useCallback(async () => {
    if (!files?.length) return;
    setLinkingProv(true);
    try {
      const dry = new FormData();
      files.forEach((f) => dry.append('files', f));
      dry.append('company', company);
      const { data: d } = await apiClient.post('/api/finance/reconcile-payments/link-provable/', dry, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      const n = d.bills_linked || 0;
      if (!n) { toast('Nothing to link.'); setLinkingProv(false); return; }
      const ok = await confirm({
        title: 'Attach Tally payments?',
        message: `This will attach the Tally payment to ${n} ${d.company} bill${n === 1 ? '' : 's'} ` +
          `(${formatCurrency(Number(d.total_amount) || 0)}) that are paid but have no payment record. ` +
          `Only the payment link is added — no amount or balance changes. Continue?`,
        confirmLabel: `Link ${n}`,
      });
      if (!ok) { setLinkingProv(false); return; }
      const wr = new FormData();
      files.forEach((f) => wr.append('files', f));
      wr.append('write', '1');
      wr.append('company', company);
      const { data } = await apiClient.post('/api/finance/reconcile-payments/link-provable/', wr, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      setLinkProvDone(data);
      toast.success(`Linked ${data.bills_linked} bills.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setLinkingProv(false); }
  }, [files, company]);

  const onUndoUnpaid = useCallback(async () => {
    const ok = await confirm({
      title: 'Undo — restore paid status?',
      message: 'This puts back the paid amount + status on every bill this tool marked Unpaid. Continue?',
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    setMarking(true);
    try {
      const fd = new FormData();
      fd.append('write', '1');
      const { data } = await apiClient.post('/api/finance/reconcile-payments/undo-doubtful-unpaid/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 180000,
      });
      setMarkDone(null);
      toast.success(`Restored ${data.restored} bills.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setMarking(false); }
  }, []);

  // ---- Payables sync: upload Tally Bills-Payable XML -> dry-run ------------
  const onPayablesUpload = useCallback(async (picked) => {
    if (!picked?.length) return;
    const arr = Array.from(picked);
    setPayBusy(true); setPaySync(null); setPaySyncDone(null); setPayFiles(arr);
    try {
      const fd = new FormData();
      arr.forEach((f) => fd.append('files', f));
      fd.append('company', company);
      const { data } = await apiClient.post('/api/finance/reconcile-payments/reconcile-from-payables/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      setPaySync(data);
      toast.success(`Read ${data.tally_bills} Tally pending bills.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); setPayFiles(null); }
    finally { setPayBusy(false); }
  }, [company]);

  const onApplySync = useCallback(async () => {
    if (!payFiles?.length || !paySync) return;
    const changes = (paySync.erp_opened_or_adjusted || 0) + (paySync.erp_marked_paid || 0);
    const ok = await confirm({
      title: 'Match outstanding to Tally?',
      message: `This sets ${changes} ${paySync.company} bills' paid status to match Tally's bill-wise ` +
        `outstanding (opens ${paySync.erp_opened_or_adjusted}, marks ${paySync.erp_marked_paid} paid). ` +
        `After this, ERP outstanding = ${formatCurrency(Number(paySync.erp_outstanding_after) || 0)} ` +
        `(Tally total ${formatCurrency(Number(paySync.tally_pending_total) || 0)}). Reversible. Continue?`,
      isDangerous: true, confirmLabel: 'Match to Tally',
    });
    if (!ok) return;
    setPayBusy(true);
    try {
      const fd = new FormData();
      payFiles.forEach((f) => fd.append('files', f));
      fd.append('write', '1');
      fd.append('company', company);
      const { data } = await apiClient.post('/api/finance/reconcile-payments/reconcile-from-payables/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      setPaySyncDone(data);
      toast.success('Outstanding matched to Tally.');
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setPayBusy(false); }
  }, [payFiles, paySync, company]);

  const onUndoSync = useCallback(async () => {
    const ok = await confirm({
      title: 'Undo the Tally match?',
      message: 'Restore every bill this tool changed back to its previous paid status. Continue?',
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    setPayBusy(true);
    try {
      const fd = new FormData();
      fd.append('write', '1');
      const { data } = await apiClient.post('/api/finance/reconcile-payments/undo-payables-sync/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      setPaySyncDone(null); setPaySync(null);
      toast.success(`Restored ${data.restored} bills.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setPayBusy(false); }
  }, []);

  // ---- Create missing bills from Tally purchase vouchers ------------------
  const onPbUpload = useCallback(async (picked) => {
    if (!picked?.length) return;
    const arr = Array.from(picked);
    setPbBusy(true); setPbDry(null); setPbDone(null); setPbFiles(arr);
    try {
      const fd = new FormData();
      arr.forEach((f) => fd.append('files', f));
      fd.append('company', company);
      const { data } = await apiClient.post('/api/finance/reconcile-payments/create-bills-from-purchase/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      setPbDry(data);
      toast.success(`Read ${data.purchase_bills_read} purchase bills.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); setPbFiles(null); }
    finally { setPbBusy(false); }
  }, [company]);

  const onCreatePbills = useCallback(async () => {
    if (!pbFiles?.length || !pbDry) return;
    const n = pbDry.would_create || 0;
    const ok = await confirm({
      title: 'Create missing bills?',
      message: `This will create ${n} ${pbDry.company} bills (${formatCurrency(Number(pbDry.total_amount) || 0)}) ` +
        `from your Tally purchase vouchers — Open, with total + GST, under existing vendors. ` +
        `${pbDry.no_vendor_match} are skipped (no matching vendor). Reversible. Continue?`,
      confirmLabel: `Create ${n} bills`,
    });
    if (!ok) return;
    setPbBusy(true);
    try {
      const fd = new FormData();
      pbFiles.forEach((f) => fd.append('files', f));
      fd.append('write', '1');
      fd.append('company', company);
      const { data } = await apiClient.post('/api/finance/reconcile-payments/create-bills-from-purchase/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      setPbDone(data);
      toast.success(`Created ${data.created} bills.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setPbBusy(false); }
  }, [pbFiles, pbDry, company]);

  const onUndoPbills = useCallback(async () => {
    const ok = await confirm({
      title: 'Delete the bills this created?',
      message: 'Deletes the bills created by this tool that have no payment linked. Use this to clean up before re-running. Continue?',
      isDangerous: true, confirmLabel: 'Delete created bills',
    });
    if (!ok) return;
    setPbBusy(true);
    try {
      const fd = new FormData();
      fd.append('write', '1');
      const { data } = await apiClient.post('/api/finance/reconcile-payments/undo-created-bills/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      setPbDone(null); setPbDry(null);
      toast.success(`Deleted ${data.deleted} bills.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setPbBusy(false); }
  }, []);

  // ---- Link leftover on-account payments by amount (no Day Book needed) ----
  // Catches payments whose bill is in the ERP but the Tally voucher had no bill
  // allocation (expense / GST-journal bills). Link-only; already-paid bills are
  // skipped so duplicate payments stay on-account.
  const onLinkByAmount = useCallback(async () => {
    setAmtBusy(true); setAmtDone(null); setAmtDry(null);
    try {
      const { data } = await apiClient.post('/api/finance/reconcile-payments/link-by-amount/', { company }, {
        timeout: 300000,
      });
      setAmtDry(data);
      toast.success(`${data.linked} will link · ${data.no_bill_match} have no amount-match.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setAmtBusy(false); }
  }, [company]);

  const onApplyAmount = useCallback(async () => {
    const n = amtDry?.linked || 0;
    if (!n) return;
    const ok = await confirm({
      title: 'Link payments to bills by amount?',
      message: `This will attach ${n} on-account payment${n === 1 ? '' : 's'} to their vendor's bill ` +
        `of the same amount. Only the bill link is set — no amount or balance changes, and ` +
        `already-paid bills are skipped. Reversible. Continue?`,
      confirmLabel: `Link ${n}`,
    });
    if (!ok) return;
    setAmtBusy(true);
    try {
      const { data } = await apiClient.post('/api/finance/reconcile-payments/link-by-amount/',
        { write: '1', company }, { timeout: 300000 });
      setAmtDone(data); setAmtDry(null);
      toast.success(`Linked ${data.linked} payments to their bills.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setAmtBusy(false); }
  }, [amtDry, company]);

  const onUndoAmountLink = useCallback(async () => {
    const ok = await confirm({
      title: 'Undo the amount links?',
      message: 'Clears the bill link on every payment this tool attached by amount. Continue?',
      confirmLabel: 'Unlink',
    });
    if (!ok) return;
    setAmtBusy(true);
    try {
      const { data } = await apiClient.post('/api/finance/reconcile-payments/undo-amount-link/',
        { write: '1' }, { timeout: 300000 });
      setAmtDone(null);
      toast.success(`Unlinked ${data.unlinked} payments.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setAmtBusy(false); }
  }, []);

  // Link from the Tally Day Book's "who paid what": match a payment to its
  // voucher by vendor+amount+date, link to the bill the voucher names.
  const onDbmUpload = useCallback(async (picked) => {
    if (!picked?.length) return;
    const arr = Array.from(picked);
    setDbmBusy(true); setDbmDry(null); setDbmDone(null); setDbmFiles(arr);
    try {
      const fd = new FormData();
      arr.forEach((f) => fd.append('files', f));
      fd.append('company', company);
      const { data } = await apiClient.post('/api/finance/reconcile-payments/link-daybook-by-match/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      setDbmDry(data);
      toast.success(`${data.linked} will link · ${data.bill_not_in_erp} bills not in ERP`);
    } catch (e) { toast.error(getApiErrorMessage(e)); setDbmFiles(null); }
    finally { setDbmBusy(false); }
  }, [company]);

  // Read-only: upload the Tally Expenses export → show what each expense payment paid for.
  const onExpUpload = useCallback(async (picked) => {
    if (!picked?.length) return;
    const arr = Array.from(picked);
    setExpBusy(true); setExpResult(null);
    try {
      const fd = new FormData();
      arr.forEach((f) => fd.append('files', f));
      fd.append('company', company);
      const { data } = await apiClient.post('/api/finance/reconcile-payments/match-expense-payments/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      setExpResult(data);
      toast.success(`${data.payments_matched} expense payments explained.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setExpBusy(false); }
  }, [company]);

  const downloadExpenseCsv = useCallback(() => {
    const rows = expResult?.samples || [];
    if (!rows.length) return;
    const head = ['Payment ref', 'Vendor', 'Amount', 'Payment date', 'Expense bill', 'Category', 'Expense date'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = rows.map((r) => [r.payment_ref, r.vendor, r.amount, r.pay_date, r.expense_ref, r.category, r.exp_date].map(esc).join(','));
    const blob = new Blob([[head.map(esc).join(','), ...body].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'expense-payments-explained.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [expResult]);

  const onApplyDbm = useCallback(async () => {
    if (!dbmFiles?.length || !dbmDry?.linked) return;
    const n = dbmDry.linked;
    const ok = await confirm({
      title: 'Link payments from the Day Book?',
      message: `This links ${n} on-account payment${n === 1 ? '' : 's'} to the bill their Tally voucher ` +
        `names (matched by vendor + amount + date). Link-only — no balance change. Reversible. Continue?`,
      confirmLabel: `Link ${n}`,
    });
    if (!ok) return;
    setDbmBusy(true);
    try {
      const fd = new FormData();
      dbmFiles.forEach((f) => fd.append('files', f));
      fd.append('write', '1');
      fd.append('company', company);
      const { data } = await apiClient.post('/api/finance/reconcile-payments/link-daybook-by-match/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000,
      });
      setDbmDone(data); setDbmDry(null);
      toast.success(`Linked ${data.linked} payments.`);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setDbmBusy(false); }
  }, [dbmFiles, dbmDry, company]);

  const onInvestigate = useCallback(async () => {
    if (!files?.length) return;
    setDigging(true); setDeep(null);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      const { data } = await apiClient.post('/api/finance/reconcile-payments/investigate/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 180000,
      });
      setDeep(data);
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setDigging(false); }
  }, [files]);

  const s = result?.summary;
  const Card = ({ label, value, cls, icon: Icon }) => (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 uppercase font-medium">{label}</p>
        {Icon && <Icon size={16} className={cls} />}
      </div>
      <p className={`text-2xl font-bold mt-1 ${cls}`}>{value}</p>
    </div>
  );

  return (
    <MainLayout>
      <PageHeader title="Reconcile Payments from Tally" subtitle="Match Apr–Sep outstanding to Tally, and attach payment history" />

      {/* Every tool below runs against THIS company. SS was done first; PPS Motors
          etc. turned out to be UAI bills the SS-scoped tools never looked at. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-lg p-3">
        <span className="text-sm font-medium text-slate-700">Company:</span>
        <select value={company} onChange={(e) => setCompany(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-slate-300 text-sm font-medium text-slate-800 bg-white">
          <option value="SSB-002">SS Biochem (SSB-002)</option>
          <option value="UAI-001">United Agro (UAI-001)</option>
        </select>
        <span className="text-xs text-slate-500">All the tools on this page — match, create, link, audit — run against the selected company.</span>
      </div>

      {/* THE definitive match: set every SS bill to Tally's bill-wise pending. */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold text-indigo-900">① Match outstanding to Tally (bill-wise)</p>
            <p className="text-xs text-indigo-700 mt-0.5">
              Upload Tally's <strong>Bills Payable / Outstandings</strong> export. Each ERP bill is set to Tally's pending
              (open) or marked Paid (settled) → <strong>ERP outstanding = Tally, bill by bill.</strong> Dry-run first; reversible.
            </p>
          </div>
          <label className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer ${payBusy ? 'bg-indigo-300 text-white' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}>
            {payBusy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            {payBusy ? 'Working…' : 'Upload Payables XML'}
            <input type="file" accept=".xml" className="hidden" disabled={payBusy}
              onChange={(e) => { onPayablesUpload(e.target.files); e.target.value = ''; }} />
          </label>
        </div>

        {paySync && !paySyncDone && (
          <div className="mt-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <SyncStat label="Tally pending bills" value={paySync.tally_bills} sub={formatCurrency(Number(paySync.tally_pending_total) || 0)} />
              <SyncStat label="Matched in ERP" value={paySync.tally_matched_in_erp} sub={`${paySync.tally_not_found_in_erp} not found`} />
              <SyncStat label="Will open / adjust" value={paySync.erp_opened_or_adjusted} sub={`${paySync.erp_marked_paid} → marked paid`} />
              <SyncStat label="ERP outstanding after" value={formatCurrency(Number(paySync.erp_outstanding_after) || 0)} sub={`was ${formatCurrency(Number(paySync.erp_outstanding_before) || 0)}`} highlight />
            </div>
            {paySync.tally_not_found_in_erp > 0 && (
              <div className="mt-2">
                <p className="text-[11px] text-amber-700 mb-2">
                  ⚠ {paySync.tally_not_found_in_erp} Tally bills ({formatCurrency(Number(paySync.tally_not_found_amount) || 0)}) not matched — sorted by what to do:
                </p>
                {paySync.not_found_buckets && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] mb-2">
                    <div className="rounded border border-slate-200 bg-white p-2">
                      <p className="text-slate-500">⛟ Freight — in freight module</p>
                      <p className="font-bold text-slate-700">{paySync.not_found_buckets.freight.count} <span className="font-normal text-slate-400">({formatCurrency(Number(paySync.not_found_buckets.freight.amount) || 0)})</span></p>
                    </div>
                    <div className="rounded border border-slate-200 bg-white p-2">
                      <p className="text-slate-500">📅 Prior-year — in opening balances</p>
                      <p className="font-bold text-slate-700">{paySync.not_found_buckets.prior_year.count} <span className="font-normal text-slate-400">({formatCurrency(Number(paySync.not_found_buckets.prior_year.amount) || 0)})</span></p>
                    </div>
                    <div className="rounded border border-orange-200 bg-orange-50 p-2">
                      <p className="text-orange-600">✎ Ref differs — fix the ref</p>
                      <p className="font-bold text-orange-700">{paySync.not_found_buckets.ref_other_vendor.count} <span className="font-normal text-orange-400">({formatCurrency(Number(paySync.not_found_buckets.ref_other_vendor.amount) || 0)})</span></p>
                    </div>
                    <div className="rounded border border-rose-200 bg-rose-50 p-2">
                      <p className="text-rose-600">➕ Missing — import these</p>
                      <p className="font-bold text-rose-700">{paySync.not_found_buckets.missing_current.count} <span className="font-normal text-rose-400">({formatCurrency(Number(paySync.not_found_buckets.missing_current.amount) || 0)})</span></p>
                    </div>
                  </div>
                )}
                {paySync.not_found_samples_by_bucket && (
                  <button type="button" onClick={() => downloadCleanupCsv(paySync.not_found_samples_by_bucket)}
                    className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-amber-300 text-amber-800 hover:bg-amber-100">
                    <Download size={14} /> Download cleanup list (fix-ref + import)
                  </button>
                )}
                {paySync.not_found_samples?.length > 0 && (
                  <div className="mt-2 border border-amber-200 rounded bg-white max-h-64 overflow-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 bg-amber-50 text-amber-700">
                        <tr><th className="text-left px-2 py-1">Ref</th><th className="text-left px-2 py-1">Party</th><th className="text-right px-2 py-1">Pending</th><th className="text-left px-2 py-1">Why</th></tr>
                      </thead>
                      <tbody>
                        {paySync.not_found_samples.map((r, i) => (
                          <tr key={i} className="border-t border-amber-100">
                            <td className="px-2 py-1 whitespace-nowrap font-medium">{r.ref || '-'}</td>
                            <td className="px-2 py-1">{r.party}</td>
                            <td className="px-2 py-1 text-right whitespace-nowrap">{formatCurrency(Number(r.pending) || 0)}</td>
                            <td className={`px-2 py-1 ${r.why?.includes('another vendor') ? 'text-orange-600' : 'text-slate-500'}`}>{r.why}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 mt-3">
              <button type="button" onClick={onApplySync} disabled={payBusy}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">
                <Link2 size={16} /> Match to Tally
              </button>
              <span className="text-xs text-indigo-700">Target: ERP outstanding → {formatCurrency(Number(paySync.erp_outstanding_after) || 0)} (Tally {formatCurrency(Number(paySync.tally_pending_total) || 0)})</span>
            </div>
          </div>
        )}
        {paySyncDone && (
          <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-indigo-900">
              <CheckCircle size={16} className="inline mr-1" />
              Matched to Tally — opened {paySyncDone.erp_opened_or_adjusted}, marked paid {paySyncDone.erp_marked_paid}.
              ERP outstanding is now <strong>{formatCurrency(Number(paySyncDone.erp_outstanding_after) || 0)}</strong>.
            </p>
            <button type="button" onClick={onUndoSync} disabled={payBusy}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100">
              Undo — restore previous
            </button>
          </div>
        )}
      </div>

      {/* Create the missing bills from the Tally purchase register. */}
      <div className="bg-teal-50 border border-teal-200 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold text-teal-900">Create missing bills from Tally purchases</p>
            <p className="text-xs text-teal-700 mt-0.5">
              Upload Tally's <strong>All Purchase Vouchers</strong> export. Creates the bills that aren't in the ERP yet
              (total + GST + supplier ref), under existing vendors → then their <strong>payments link</strong> and the match ties.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onUndoPbills} disabled={pbBusy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-white border border-teal-300 text-teal-700 hover:bg-teal-100">
              Undo created
            </button>
            <label className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer ${pbBusy ? 'bg-teal-300 text-white' : 'bg-teal-600 text-white hover:bg-teal-700'}`}>
              {pbBusy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              {pbBusy ? 'Working…' : 'Upload Purchase XML'}
              <input type="file" accept=".xml" className="hidden" disabled={pbBusy}
                onChange={(e) => { onPbUpload(e.target.files); e.target.value = ''; }} />
            </label>
          </div>
        </div>
        {pbDry && !pbDone && (
          <div className="mt-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <SyncStat label="Purchase bills read" value={pbDry.purchase_bills_read} />
              <SyncStat label="Will create (missing)" value={pbDry.would_create} sub={formatCurrency(Number(pbDry.total_amount) || 0)} highlight />
              <SyncStat label="Already in ERP" value={pbDry.already_in_erp} />
              <SyncStat label="No vendor match" value={pbDry.no_vendor_match} sub="skipped" />
            </div>
            {pbDry.samples?.length > 0 && (
              <div className="mt-3 border border-teal-200 rounded bg-white max-h-64 overflow-auto">
                <p className="text-[11px] text-teal-700 px-2 py-1 border-b border-teal-100">Sample of what will be created — spot-check a few in Bills first</p>
                <table className="w-full text-[11px]">
                  <thead className="text-teal-600"><tr><th className="text-left px-2 py-1">Vendor</th><th className="text-left px-2 py-1">Ref</th><th className="text-left px-2 py-1">Date</th><th className="text-right px-2 py-1">Total</th></tr></thead>
                  <tbody>
                    {pbDry.samples.map((r, i) => (
                      <tr key={i} className="border-t border-teal-50">
                        <td className="px-2 py-1">{r.vendor}</td>
                        <td className="px-2 py-1 whitespace-nowrap font-medium">{r.ref}</td>
                        <td className="px-2 py-1 whitespace-nowrap">{r.date}</td>
                        <td className="px-2 py-1 text-right whitespace-nowrap">{formatCurrency(Number(r.total) || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {pbDry.would_create > 0 && (
              <button type="button" onClick={onCreatePbills} disabled={pbBusy}
                className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-teal-600 text-white hover:bg-teal-700">
                <Upload size={16} /> Create {pbDry.would_create} bills
              </button>
            )}
          </div>
        )}
        {pbDone && (
          <p className="mt-3 text-sm text-teal-900">
            <CheckCircle size={16} className="inline mr-1" />
            Created <strong>{pbDone.created}</strong> bills ({formatCurrency(Number(pbDone.total_amount) || 0)}).
            Now re-run <strong>① Match to Tally</strong> and <strong>② Link the provable bills</strong> → payments link + outstanding ties.
          </p>
        )}
      </div>

      {/* Link leftover on-account payments to their vendor's bill by amount —
          catches the ones with no Day Book bill allocation (expense bills). */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold text-indigo-900">Link leftover "–" payments by amount</p>
            <p className="text-xs text-indigo-700 mt-0.5">
              For on-account payments whose <strong>bill is already in the ERP</strong> but the Tally voucher had no
              bill allocation (expense / GST-journal bills, e.g. PPS Motors). Matches each to its vendor's bill of the
              <strong> same amount</strong>. <strong>Link-only — no balance change</strong>; already-paid bills are skipped
              (so duplicate payments stay "–"). No upload needed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onUndoAmountLink} disabled={amtBusy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100">
              Undo
            </button>
            <button type="button" onClick={onLinkByAmount} disabled={amtBusy}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ${amtBusy ? 'bg-indigo-300 text-white' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}>
              {amtBusy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
              {amtBusy ? 'Working…' : 'Link by amount'}
            </button>
          </div>
        </div>
        {amtDry && !amtDone && (
          <div className="mt-3">
            <div className="grid grid-cols-2 gap-2 text-xs mb-2">
              <SyncStat label="Will link" value={amtDry.linked} highlight />
              <SyncStat label="No amount-match" value={amtDry.no_bill_match} sub="freight / advance / contra / amount differs" />
            </div>
            {amtDry.linked > 0 && (
              <button type="button" onClick={onApplyAmount} disabled={amtBusy}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">
                <Link2 size={16} /> Link {amtDry.linked}
              </button>
            )}
            {amtDry.no_match_samples?.length > 0 && (
              <div className="mt-3 border border-indigo-200 rounded bg-white max-h-64 overflow-auto">
                <p className="text-[11px] text-indigo-700 px-2 py-1 border-b border-indigo-100">
                  Why the rest didn't link — payment amount vs the vendor's unlinked bill totals
                </p>
                <table className="w-full text-[11px]">
                  <thead className="text-indigo-600"><tr>
                    <th className="text-left px-2 py-1">Vendor</th>
                    <th className="text-right px-2 py-1">Payment</th>
                    <th className="text-center px-2 py-1">Unlinked bills</th>
                    <th className="text-left px-2 py-1">Their bill totals</th>
                  </tr></thead>
                  <tbody>
                    {amtDry.no_match_samples.map((r, i) => (
                      <tr key={i} className="border-t border-indigo-50">
                        <td className="px-2 py-1">{r.vendor}</td>
                        <td className="px-2 py-1 text-right whitespace-nowrap font-medium">{formatCurrency(Number(r.amount) || 0)}</td>
                        <td className="px-2 py-1 text-center">{r.unlinked_bills}</td>
                        <td className="px-2 py-1">{(r.bill_totals || []).map((t) => formatCurrency(Number(t) || 0)).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {amtDone && (
          <p className="mt-3 text-sm text-indigo-900">
            <CheckCircle size={16} className="inline mr-1" />
            Linked <strong>{amtDone.linked}</strong> payments to their bills (no balance change).
            {amtDone.no_bill_match > 0 && <> {amtDone.no_bill_match} had no matching unlinked bill (freight / advances / contra — correctly left "–").</>}
          </p>
        )}

        {/* Method 2: use Tally's Day Book "who paid what" — matches the payment to
            its voucher by vendor+amount+date and links the bill the voucher names. */}
        <div className="mt-4 pt-3 border-t border-indigo-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-indigo-700 max-w-xl">
              <strong>Or use Tally's "who paid what":</strong> upload the Day Book(s). Each payment is matched to its
              Tally voucher by <strong>vendor + amount + date</strong> and linked to the bill the voucher names —
              and it lists the bills Tally paid that <strong>aren't in the ERP yet</strong>.
            </p>
            <label className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer ${dbmBusy ? 'bg-indigo-300 text-white' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}>
              {dbmBusy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              {dbmBusy ? 'Working…' : 'Link from Day Book'}
              <input type="file" accept=".xml" multiple className="hidden" disabled={dbmBusy}
                onChange={(e) => { onDbmUpload(e.target.files); e.target.value = ''; }} />
            </label>
          </div>
          {dbmDry && !dbmDone && (
            <div className="mt-3">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs mb-2">
                <SyncStat label="Will link" value={dbmDry.linked} highlight />
                <SyncStat label="Bills Tally paid, not in ERP" value={dbmDry.bill_not_in_erp} sub="create these to link" />
                <SyncStat label="No payment match" value={dbmDry.no_payment_match} />
              </div>
              {dbmDry.linked > 0 && (
                <button type="button" onClick={onApplyDbm} disabled={dbmBusy}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">
                  <Link2 size={16} /> Link {dbmDry.linked}
                </button>
              )}
              {dbmDry.bills_missing_samples?.length > 0 && (
                <div className="mt-3 border border-indigo-200 rounded bg-white max-h-64 overflow-auto">
                  <p className="text-[11px] text-indigo-700 px-2 py-1 border-b border-indigo-100">
                    Bills Tally paid that aren't in the ERP — create these next
                  </p>
                  <table className="w-full text-[11px]">
                    <thead className="text-indigo-600"><tr>
                      <th className="text-left px-2 py-1">Bill</th>
                      <th className="text-left px-2 py-1">Party</th>
                      <th className="text-right px-2 py-1">Amount</th>
                      <th className="text-left px-2 py-1">Date</th>
                    </tr></thead>
                    <tbody>
                      {dbmDry.bills_missing_samples.map((r, i) => (
                        <tr key={i} className="border-t border-indigo-50">
                          <td className="px-2 py-1 font-medium whitespace-nowrap">{r.bill}</td>
                          <td className="px-2 py-1">{r.party}</td>
                          <td className="px-2 py-1 text-right whitespace-nowrap">{formatCurrency(Number(r.amount) || 0)}</td>
                          <td className="px-2 py-1 whitespace-nowrap">{r.date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {dbmDone && (
            <p className="mt-3 text-sm text-indigo-900">
              <CheckCircle size={16} className="inline mr-1" />
              Linked <strong>{dbmDone.linked}</strong> payments from the Day Book (no balance change).
              {dbmDone.bill_not_in_erp > 0 && <> {dbmDone.bill_not_in_erp} bills Tally paid aren't in the ERP — create those to link their payments.</>}
            </p>
          )}
        </div>
      </div>

      {/* Read-only: explain each expense payment from the Tally Expenses export. */}
      <div className="bg-sky-50 border border-sky-200 rounded-lg p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold text-sky-900">What did the expense payments pay for? <span className="text-[11px] font-normal text-sky-600">(read-only)</span></p>
            <p className="text-xs text-sky-700 mt-0.5">
              Upload Tally's <strong>Expenses export</strong> (GST Journals). Each on-account "–" payment is matched to the
              expense bill it paid (vendor + amount + date) and shown with its <strong>bill ref + category</strong>.
              <strong> Nothing is created or changed</strong> — expenses are already booked as EXPJRNL; this only explains them.
            </p>
          </div>
          <label className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer ${expBusy ? 'bg-sky-300 text-white' : 'bg-sky-600 text-white hover:bg-sky-700'}`}>
            {expBusy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            {expBusy ? 'Working…' : 'Upload Expenses XML'}
            <input type="file" accept=".xml" multiple className="hidden" disabled={expBusy}
              onChange={(e) => { onExpUpload(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
        {expResult && (
          <div className="mt-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <SyncStat label="Expense bills read" value={expResult.expense_bills_read} sub={formatCurrency(Number(expResult.expense_total) || 0)} />
              <SyncStat label="Payments explained" value={expResult.payments_matched} sub={formatCurrency(Number(expResult.matched_amount) || 0)} highlight />
              <SyncStat label="Not an expense match" value={expResult.payments_unmatched} sub="freight / creditor / contra" />
              <SyncStat label="Categories" value={(expResult.by_category || []).length} />
            </div>
            {expResult.by_category?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {expResult.by_category.map((c, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-full text-[11px] bg-white border border-sky-200 text-sky-700">{c.category} ({c.count})</span>
                ))}
              </div>
            )}
            {expResult.samples?.length > 0 && (
              <>
                <button type="button" onClick={downloadExpenseCsv}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-sky-300 text-sky-700 hover:bg-sky-100">
                  <Download size={14} /> Download ({expResult.samples.length})
                </button>
                <div className="mt-2 border border-sky-200 rounded bg-white max-h-80 overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead className="text-sky-600"><tr>
                      <th className="text-left px-2 py-1">Vendor</th>
                      <th className="text-right px-2 py-1">Amount</th>
                      <th className="text-left px-2 py-1">Paid for (bill)</th>
                      <th className="text-left px-2 py-1">Category</th>
                    </tr></thead>
                    <tbody>
                      {expResult.samples.map((r, i) => (
                        <tr key={i} className="border-t border-sky-50">
                          <td className="px-2 py-1">{r.vendor}</td>
                          <td className="px-2 py-1 text-right whitespace-nowrap">{formatCurrency(Number(r.amount) || 0)}</td>
                          <td className="px-2 py-1 whitespace-nowrap font-medium">{r.expense_ref}</td>
                          <td className="px-2 py-1">{r.category}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-800">② Upload Tally Day Book(s) — add payment history</p>
            <p className="text-xs text-slate-500 mt-0.5">Drop the Apr–Sep Day Book XML files. First you get a <strong>dry-run</strong> that shows <strong>exactly</strong> what Apply will do — <strong>nothing changes</strong> until you click Apply.</p>
          </div>
          <label className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer ${busy ? 'bg-slate-300 text-slate-600' : 'bg-primary-600 text-white hover:bg-primary-700'}`}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            {busy ? 'Analysing…' : 'Upload Day Book XML'}
            <input type="file" accept=".xml" multiple className="hidden" disabled={busy}
              onChange={(e) => { onUpload(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
      </div>

      {/* Trust check — the FIRST question: is "Paid" real? Runs off the same
          uploaded Day Books. Read-only. */}
      {files?.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-slate-800">Is “Paid” real? — check every paid bill</p>
              <p className="text-xs text-slate-500 mt-0.5">For each paid bill: <strong>proven</strong> (has a payment), <strong>provable</strong> (Day Book has it), or <strong>doubtful</strong> (no proof — investigate). <strong>Read-only.</strong></p>
            </div>
            <button
              type="button" onClick={onAudit} disabled={auditing}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${auditing ? 'bg-slate-200 text-slate-500' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}
            >
              {auditing ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
              {auditing ? 'Checking all bills…' : 'Check paid bills'}
            </button>
          </div>
          {audit && (
            <div className="mt-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <AuditCard tone="emerald" label="Really paid (proven)" b={audit.proven} hint="Has a payment record" />
                <AuditCard tone="amber" label="Paid in Tally (provable)" b={audit.provable} hint="Day Book has the payment — can attach proof" />
                <AuditCard tone="rose" label="No proof (doubtful)" b={audit.doubtful} hint="Marked paid, nothing backs it — investigate" />
              </div>
              {audit.doubtful_breakdown && (
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                  <div className="rounded border border-slate-200 bg-slate-50 p-2">
                    <p className="text-slate-500">Real bills, fully paid — no proof</p>
                    <p className="font-bold text-rose-700">{audit.doubtful_breakdown.real_full_paid.count} <span className="font-normal text-slate-500">({formatCurrency(Number(audit.doubtful_breakdown.real_full_paid.amount) || 0)})</span></p>
                  </div>
                  <div className="rounded border border-slate-200 bg-slate-50 p-2">
                    <p className="text-slate-500">Real bills, part-paid — no proof</p>
                    <p className="font-bold text-rose-700">{audit.doubtful_breakdown.real_part_paid.count} <span className="font-normal text-slate-500">({formatCurrency(Number(audit.doubtful_breakdown.real_part_paid.amount) || 0)})</span></p>
                  </div>
                  <div className="rounded border border-slate-200 bg-slate-50 p-2">
                    <p className="text-slate-500">Opening / journal — ignore</p>
                    <p className="font-bold text-slate-500">{audit.doubtful_breakdown.opening_or_journal.count} <span className="font-normal">({formatCurrency(Number(audit.doubtful_breakdown.opening_or_journal.amount) || 0)})</span></p>
                  </div>
                </div>
              )}
              <p className="text-xs text-slate-500 mt-3">{audit.note}</p>

              {/* Link the PROVABLE bills — attach the Tally payment (link-only). */}
              {audit.provable?.count > 0 && (
                <div className="mt-4 flex items-center justify-between gap-3 flex-wrap bg-amber-50 border border-amber-200 rounded-lg p-4">
                  {!linkProvDone ? (
                    <>
                      <p className="text-sm text-amber-900">
                        <strong>{audit.provable.count}</strong> bills are <strong>paid in Tally</strong> but show no payment inside.
                        Attach their Tally payment — <strong>no balance change</strong>, just adds the Payment History.
                      </p>
                      <button
                        type="button" onClick={onLinkProvable} disabled={linkingProv}
                        className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${linkingProv ? 'bg-amber-300 text-white' : 'bg-amber-600 text-white hover:bg-amber-700'}`}
                      >
                        {linkingProv ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                        {linkingProv ? 'Linking…' : 'Link the provable bills'}
                      </button>
                    </>
                  ) : (
                    <p className="text-sm text-amber-900">
                      <CheckCircle size={16} className="inline mr-1" />
                      Done — attached payments to <strong>{linkProvDone.bills_linked}</strong> bills
                      ({formatCurrency(Number(linkProvDone.total_amount) || 0)}). They now show their Payment History. No balance changed.
                    </p>
                  )}
                </div>
              )}

              <DoubtfulList rows={audit.doubtful.samples} total={(audit.doubtful_breakdown?.real_full_paid.count || 0) + (audit.doubtful_breakdown?.real_part_paid.count || 0)} />

              {/* Mark the no-proof SS bills Unpaid (reversible), so a month-by-
                  month re-import can re-pay + link the real ones. */}
              {((audit.doubtful_breakdown?.real_full_paid.count || 0) + (audit.doubtful_breakdown?.real_part_paid.count || 0)) > 0 && (
                <div className="mt-4 flex items-center justify-between gap-3 flex-wrap bg-rose-50 border border-rose-200 rounded-lg p-4">
                  {!markDone ? (
                    <>
                      <p className="text-sm text-rose-800">
                        Mark these <strong>no-proof SS bills</strong> back to <strong>Unpaid</strong>, then re-import month by month —
                        matched payments go Paid + linked. <strong>Reversible.</strong>
                      </p>
                      <button
                        type="button" onClick={onMarkUnpaid} disabled={marking}
                        className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${marking ? 'bg-rose-300 text-white' : 'bg-rose-600 text-white hover:bg-rose-700'}`}
                      >
                        {marking ? <Loader2 size={16} className="animate-spin" /> : <AlertTriangle size={16} />}
                        {marking ? 'Working…' : 'Mark no-proof bills Unpaid'}
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-rose-800">
                        <CheckCircle size={16} className="inline mr-1" />
                        Done — <strong>{markDone.unpaid}</strong> bills ({formatCurrency(Number(markDone.total_amount) || 0)}) set to Unpaid.
                        Now re-import each month's payments. Changed your mind?
                      </p>
                      <button
                        type="button" onClick={onUndoUnpaid} disabled={marking}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap bg-white border border-rose-300 text-rose-700 hover:bg-rose-100"
                      >
                        {marking ? <Loader2 size={16} className="animate-spin" /> : null}
                        Undo — restore paid status
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Card label="Will link" value={s.will_link} cls="text-emerald-700" icon={Link2} />
            <Card label="Already linked" value={s.already_linked} cls="text-slate-500" icon={CheckCircle} />
            <Card label="Needs review" value={s.needs_review} cls="text-orange-700" icon={HelpCircle} />
            <Card label="No match" value={s.no_match} cls="text-amber-700" icon={AlertTriangle} />
          </div>

          <p className="text-xs text-slate-500 mb-4">{result.note}</p>

          {/* Apply bar — shows only when there is something to link and it
              hasn't been applied yet. */}
          {s.will_link > 0 && !applied && (
            <div className="flex items-center justify-between gap-3 bg-emerald-50 border border-emerald-200 rounded-lg p-4 mb-4">
              <p className="text-sm text-emerald-800">
                Ready to link <strong>{s.will_link}</strong> payment{s.will_link === 1 ? '' : 's'} to their bills.
                This only sets the bill link — <strong>no balance changes.</strong>
              </p>
              <button
                type="button" onClick={onApply} disabled={applying}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${applying ? 'bg-emerald-300 text-white' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
              >
                {applying ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                {applying ? 'Linking…' : `Apply — link ${s.will_link}`}
              </button>
            </div>
          )}

          {applied && (
            <div className="bg-white border border-emerald-200 rounded-lg p-4 mb-4">
              <div className="flex items-center gap-2 text-emerald-700 mb-2">
                <CheckCircle size={18} />
                <p className="text-sm font-semibold">Done — {applied.payments_linked} payments linked</p>
              </div>
              <ul className="text-xs text-slate-600 space-y-0.5 ml-6 list-disc">
                <li>{applied.payments_linked} payments connected to their bill(s)</li>
                <li>{applied.split_vouchers_created} extra voucher(s) created for lump payments that settled several bills</li>
              </ul>
              <p className="text-xs text-slate-500 mt-2">{applied.note}</p>
            </div>
          )}

          {/* One panel per reason, so the operator sees WHY each voucher landed
              where it did. "Will link" first, then review buckets, then no-match. */}
          <div className="grid lg:grid-cols-2 gap-4">
            {result.reasons.map((r) => (
              <ReasonTable key={r.key} r={r} />
            ))}
          </div>

          {/* Deep dive — classify EVERY row in the three non-linkable buckets
              (not just the 12 samples) so we can decide what's worth recovering. */}
          {(s.needs_review > 0 || s.no_match > 0) && (
            <div className="mt-6">
              {!deep && (
                <button
                  type="button" onClick={onInvestigate} disabled={digging}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ${digging ? 'bg-slate-200 text-slate-500' : 'bg-slate-800 text-white hover:bg-slate-900'}`}
                >
                  {digging ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                  {digging ? 'Analysing every row…' : 'Dig deeper into the rest'}
                </button>
              )}
              {deep && (
                <div className="space-y-4">
                  <DeepBucket b={deep.bucket1_no_erp_payment} />
                  <DeepBucket b={deep.bucket3_bill_other_vendor} />
                  <DeepBucket b={deep.bucket2_bill_not_in_erp} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </MainLayout>
  );
}

function SyncStat({ label, value, sub, highlight }) {
  return (
    <div className={`rounded border p-2 ${highlight ? 'bg-white border-indigo-300' : 'bg-white/60 border-indigo-200'}`}>
      <p className="text-indigo-500">{label}</p>
      <p className={`font-bold ${highlight ? 'text-indigo-800 text-sm' : 'text-indigo-900'}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-500">{sub}</p>}
    </div>
  );
}

const AUDIT_TONE = {
  emerald: { box: 'bg-emerald-50 border-emerald-200', num: 'text-emerald-700', lbl: 'text-emerald-800' },
  amber:   { box: 'bg-amber-50 border-amber-200',     num: 'text-amber-700',   lbl: 'text-amber-800' },
  rose:    { box: 'bg-rose-50 border-rose-200',       num: 'text-rose-700',    lbl: 'text-rose-800' },
};

function AuditCard({ tone, label, b, hint }) {
  const t = AUDIT_TONE[tone];
  return (
    <div className={`rounded-lg border p-3 ${t.box}`}>
      <p className={`text-xs font-semibold ${t.lbl}`}>{label}</p>
      <p className={`text-2xl font-bold mt-1 ${t.num}`}>{b?.count ?? 0}</p>
      <p className="text-xs text-slate-500">{formatCurrency(Number(b?.amount) || 0)}</p>
      <p className="text-[11px] text-slate-500 mt-1">{hint}</p>
    </div>
  );
}

function downloadCleanupCsv(buckets) {
  const rows = [];
  (buckets.ref_other_vendor || []).forEach((r) => rows.push(['Fix the ref (bill is in ERP under a different ref)', r.party, r.ref, r.pending, r.date]));
  (buckets.missing_current || []).forEach((r) => rows.push(['Import the bill (not in ERP)', r.party, r.ref, r.pending, r.date]));
  const head = ['Action', 'Vendor', 'Tally ref', 'Pending', 'Date'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [head.join(',')].concat(rows.map((r) => r.map(esc).join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'tally-reconcile-cleanup.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function downloadDoubtfulCsv(rows) {
  const head = ['Bill No', 'Invoice No', 'Vendor', 'Company', 'Kind', 'Paid', 'Total'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.join(',')].concat(
    rows.map((r) => [r.bill_no, r.invoice_no, r.vendor, r.company,
      r.paid_kind === 'partial' ? 'part-paid' : 'full', r.paid, r.total].map(esc).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'paid-bills-no-proof.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function DoubtfulList({ rows, total }) {
  if (!rows?.length) return null;
  return (
    <div className="mt-4 border border-rose-200 rounded-lg">
      <div className="flex items-center justify-between p-3 border-b border-rose-200">
        <p className="text-sm font-semibold text-rose-800">
          Real bills marked Paid with NO proof — investigate these ({total})
        </p>
        <button
          type="button" onClick={() => downloadDoubtfulCsv(rows)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-rose-300 text-rose-700 hover:bg-rose-100"
        >
          <Download size={14} /> Download list ({rows.length})
        </button>
      </div>
      <div className="overflow-auto max-h-96">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-rose-50 text-rose-700">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Bill No</th>
              <th className="text-left px-3 py-1.5 font-medium">Invoice No</th>
              <th className="text-left px-3 py-1.5 font-medium">Vendor</th>
              <th className="text-left px-3 py-1.5 font-medium">Co.</th>
              <th className="text-left px-3 py-1.5 font-medium">Kind</th>
              <th className="text-right px-3 py-1.5 font-medium">Paid</th>
              <th className="text-right px-3 py-1.5 font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-rose-100">
                <td className="px-3 py-1.5 whitespace-nowrap font-medium">{r.bill_no || '-'}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{r.invoice_no || '-'}</td>
                <td className="px-3 py-1.5">{r.vendor}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{r.company}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {r.paid_kind === 'partial'
                    ? <span className="text-amber-600">part-paid</span>
                    : <span className="text-rose-600">full</span>}
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">{formatCurrency(Number(r.paid) || 0)}</td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">{formatCurrency(Number(r.total) || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > rows.length && (
        <p className="text-[11px] text-slate-400 px-3 py-1.5 border-t border-rose-100">showing {rows.length} of {total}</p>
      )}
    </div>
  );
}

// A friendlier label per group key. Unknown keys fall back to the raw key.
const GROUP_LABEL = {
  recoverable: 'Vendor exists + bill present — recoverable by re-import',
  vendor_no_bill: 'Vendor exists, no bill — would go on-account',
  no_vendor: 'No matching vendor in ERP — set up vendor first',
  duplicate_vendor: 'Duplicate vendor (same supplier) — linkable after a merge',
  freight_clash: 'Freight number clash — leave',
  unrelated_clash: 'Unrelated number clash — leave',
  freight: 'Freight / logistics',
  fuel: 'Fuel',
  labour: 'Labour / staffing',
  other: 'Other — worth eyeballing',
};

function DeepBucket({ b }) {
  if (!b) return null;
  const groups = Object.entries(b.groups || {});
  const total = groups.reduce((n, [, g]) => n + (g.count || 0), 0);
  const [open, setOpen] = useState(null);
  return (
    <div className="bg-white rounded-lg border border-slate-200">
      <div className="p-3 border-b border-slate-200">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-800">{b.label}</p>
          <span className="text-sm font-bold text-slate-600">{total}</span>
        </div>
        {b.help && <p className="text-xs text-slate-500 mt-1">{b.help}</p>}
      </div>
      <div className="divide-y divide-slate-100">
        {groups.filter(([, g]) => g.count > 0).map(([key, g]) => (
          <div key={key}>
            <button
              type="button" onClick={() => setOpen(open === key ? null : key)}
              className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-slate-50"
            >
              <span className="text-xs text-slate-700">{GROUP_LABEL[key] || key}</span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-slate-500">{formatCurrency(Number(g.amount) || 0)}</span>
                <span className="text-sm font-semibold text-slate-800 tabular-nums w-10 text-right">{g.count}</span>
              </span>
            </button>
            {open === key && g.samples?.length > 0 && (
              <div className="overflow-auto max-h-72 border-t border-slate-100 bg-slate-50/50">
                <table className="w-full text-xs">
                  <thead className="text-slate-400">
                    <tr>
                      <th className="text-left px-3 py-1 font-medium">Vch</th>
                      <th className="text-left px-3 py-1 font-medium">Tally party</th>
                      <th className="text-left px-3 py-1 font-medium">Amount</th>
                      {g.samples[0]?.vendor && <th className="text-left px-3 py-1 font-medium">ERP vendor</th>}
                      {g.samples[0]?.pay_vendor && <th className="text-left px-3 py-1 font-medium">Pay vendor → bill vendor</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {g.samples.map((row, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-3 py-1 whitespace-nowrap">{row.vch || '-'}</td>
                        <td className="px-3 py-1">{row.party}</td>
                        <td className="px-3 py-1 whitespace-nowrap">{formatCurrency(Number(row.amount) || 0)}</td>
                        {row.vendor && <td className="px-3 py-1">{row.vendor}</td>}
                        {row.pay_vendor && <td className="px-3 py-1">{row.pay_vendor} <span className="text-slate-400">→</span> {row.bill_vendor} <span className="text-slate-400">({row.bill})</span></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReasonTable({ r }) {
  if (!r.samples?.length) return null;
  const cls = TONE[r.tone] || 'text-slate-600';
  return (
    <div className="bg-white rounded-lg border border-slate-200">
      <div className="flex items-center justify-between p-3 border-b border-slate-200">
        <p className={`text-sm font-semibold ${cls}`}>{r.label}</p>
        <span className={`text-sm font-bold ${cls}`}>{r.count}</span>
      </div>
      <div className="overflow-auto max-h-80">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Vch</th>
              <th className="text-left px-3 py-1.5 font-medium">Party</th>
              <th className="text-left px-3 py-1.5 font-medium">Amount</th>
              {r.key === 'linkable' && <th className="text-left px-3 py-1.5 font-medium">Bill(s)</th>}
            </tr>
          </thead>
          <tbody>
            {r.samples.map((row, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-3 py-1.5 whitespace-nowrap">{row.vch || '-'}</td>
                <td className="px-3 py-1.5">{row.party}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{formatCurrency(Number(row.amount) || 0)}</td>
                {r.key === 'linkable' && (
                  <td className="px-3 py-1.5">
                    <span className="whitespace-nowrap">{(row.bills || []).join(', ')}</span>
                    {row.bill_already_paid
                      ? <span className="ml-1 text-[10px] text-emerald-600">paid — link only</span>
                      : <span className="ml-1 text-[10px] text-amber-600">would apply</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.count > r.samples.length && (
        <p className="text-[11px] text-slate-400 px-3 py-1.5 border-t border-slate-100">
          showing {r.samples.length} of {r.count}
        </p>
      )}
    </div>
  );
}
