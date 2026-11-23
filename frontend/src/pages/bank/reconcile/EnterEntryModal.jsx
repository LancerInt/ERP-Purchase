/**
 * Turn one unmatched bank-statement line into the ERP record it is missing.
 *
 * The statement is the SOURCE now that bank vouchers are no longer imported
 * from Tally, so this is the data-entry path, not a convenience. The line
 * already carries the date, amount and reference — the operator supplies only
 * what the bank cannot know: which party, and which document (if any).
 *
 * The direction is NOT a choice. A debit is money out, so it can only ever be
 * a vendor payment; a credit can only be a customer receipt. Offering both
 * would invite booking a refund as a purchase.
 *
 *   debit  -> vendor_payment (against a bill)  | bank_payment (on account)
 *   credit -> receivable_payment (an invoice)  | bank_receipt (on account)
 *
 * "On account" exists because a real statement row often settles no single
 * document — one transfer covering several bills, a part payment, a round-sum
 * advance. Making the money wait for a clean allocation is how a reconciliation
 * stalls; this records it against the party now and leaves allocation for later.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, X } from 'lucide-react';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

const num = (v) => Number(v) || 0;

export default function EnterEntryModal({ uploadId, line, onClose, onDone }) {
  const isDebit = num(line?.debit) > 0;
  const amount = isDebit ? num(line?.debit) : num(line?.credit);

  const [mode, setMode] = useState('document');   // 'document' | 'on_account'
  const [partyId, setPartyId] = useState('');
  const [docId, setDocId] = useState('');
  const [tds, setTds] = useState('');
  const [charges, setCharges] = useState('');
  const [docs, setDocs] = useState([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const { options: parties } = useLookup(
    isDebit ? '/api/vendors/' : '/api/customers/',
    { labelField: isDebit ? 'vendor_name' : 'customer_name' },
  );

  // Open documents for the chosen party. Fetched on demand rather than through
  // useLookup because the list is party-scoped and we need the balance on each
  // row to show what is actually still owed.
  useEffect(() => {
    if (!partyId || mode !== 'document') { setDocs([]); return undefined; }
    let cancelled = false;
    setDocsLoading(true);
    const url = isDebit
      ? `/api/purchase/bills/?vendor=${partyId}&page_size=200`
      : `/api/sales/receivables/?customer=${partyId}&page_size=200`;
    apiClient.get(url)
      .then((r) => {
        if (cancelled) return;
        const rows = r.data?.results || (Array.isArray(r.data) ? r.data : []);
        // `invoice_no` on the receivables list, NOT `invoice_reference` —
        // that one is the FK id and would render a raw UUID as the label.
        const mapped = rows.map((d) => (isDebit
          ? { id: d.id, label: d.bill_no || d.vendor_invoice_no || '—',
              date: d.bill_date, balance: num(d.balance_due) }
          : { id: d.id, label: d.invoice_no || '—',
              date: d.invoice_date, balance: num(d.balance) }));
        // Only what is still open — a fully settled document cannot take
        // another payment, and listing it just invites the over-balance error.
        setDocs(mapped.filter((d) => d.balance > 0));
      })
      .catch(() => { if (!cancelled) setDocs([]); })
      .finally(() => { if (!cancelled) setDocsLoading(false); });
    return () => { cancelled = true; };
  }, [partyId, mode, isDebit]);

  useEffect(() => { setDocId(''); }, [partyId, mode]);

  const target = mode === 'document'
    ? (isDebit ? 'vendor_payment' : 'receivable_payment')
    : (isDebit ? 'bank_payment' : 'bank_receipt');

  const selectedDoc = useMemo(
    () => docs.find((d) => String(d.id) === String(docId)) || null, [docs, docId]);

  // The server refuses an over-balance allocation; saying so here saves a round
  // trip and explains it next to the numbers rather than in a toast.
  const overBalance = mode === 'document' && selectedDoc && amount > selectedDoc.balance;

  const canSave = !!partyId && (mode === 'on_account' || (!!docId && !overBalance)) && !saving;

  const submit = useCallback(async () => {
    setSaving(true);
    try {
      await apiClient.post(`/api/finance/bank-statements/${uploadId}/create-entry/`, {
        line_id: line.id,
        target,
        document_id: mode === 'document' ? docId : partyId,
        ...(mode === 'on_account' && tds ? { tds_deducted: tds } : {}),
        ...(mode === 'on_account' && charges ? { bank_charges: charges } : {}),
      });
      toast.success(isDebit ? 'Payment recorded.' : 'Receipt recorded.');
      onDone?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [uploadId, line, target, mode, docId, partyId, tds, charges, isDebit, onDone]);

  const partyLabel = isDebit ? 'Vendor' : 'Customer';
  const docLabel = isDebit ? 'Bill' : 'Invoice';

  return (
    <div className="fixed inset-0 z-[70] bg-slate-900/40 flex items-center justify-center p-4"
      onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">
              Record {isDebit ? 'payment' : 'receipt'} from this line
            </h3>
            <p className="text-xl font-bold text-slate-900 tabular-nums leading-tight mt-0.5">
              {formatCurrency(amount)}
              <span className={`ml-2 text-[11px] font-semibold ${isDebit ? 'text-red-600' : 'text-green-600'}`}>
                {isDebit ? 'money out' : 'money in'}
              </span>
            </p>
            <p className="text-[11px] text-slate-400 truncate">
              {formatDate(line.txn_date)}
              {line.reference_no ? ` · ${line.reference_no}` : ''}
              {line.narration ? ` · ${line.narration}` : ''}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500 shrink-0"><X size={16} /></button>
        </div>

        <div className="overflow-auto p-4 space-y-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-1.5">
              What does this settle?
            </p>
            <div className="flex rounded-lg border border-slate-300 overflow-hidden">
              {[
                { k: 'document', l: `A specific ${docLabel.toLowerCase()}` },
                { k: 'on_account', l: 'On account' },
              ].map((o, i) => (
                <button key={o.k} type="button" onClick={() => setMode(o.k)}
                  className={`flex-1 px-3 py-2 text-xs font-medium transition ${i ? 'border-l border-slate-200' : ''} ${
                    mode === o.k ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                  {o.l}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-1.5">
              {mode === 'document'
                ? `Updates the ${docLabel.toLowerCase()}'s paid amount and status.`
                : `Records the money against the ${partyLabel.toLowerCase()} only — allocate it to ${docLabel.toLowerCase()}s later.`}
            </p>
          </div>

          <div>
            <label htmlFor="ee-party" className="block text-xs font-medium text-slate-600 mb-1">
              {partyLabel} <span className="text-red-500">*</span>
            </label>
            <CustomSelect
              name="party"
              value={partyId}
              onChange={(e) => setPartyId(e.target.value)}
              placeholder={`Select a ${partyLabel.toLowerCase()}…`}
              className="w-full"
            >
              {parties.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </CustomSelect>
          </div>

          {mode === 'document' && (
            <div>
              <label htmlFor="ee-doc" className="block text-xs font-medium text-slate-600 mb-1">
                Open {docLabel.toLowerCase()} <span className="text-red-500">*</span>
              </label>
              <CustomSelect
                name="document"
                value={docId}
                onChange={(e) => setDocId(e.target.value)}
                disabled={!partyId || docsLoading}
                placeholder={!partyId ? `Pick a ${partyLabel.toLowerCase()} first…`
                  : docsLoading ? 'Loading…'
                  : docs.length ? `Select a ${docLabel.toLowerCase()}…`
                  : `No open ${docLabel.toLowerCase()}s for this ${partyLabel.toLowerCase()}`}
                className="w-full"
              >
                {docs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label} · {formatDate(d.date)} · balance {formatCurrency(d.balance)}
                  </option>
                ))}
              </CustomSelect>
              {overBalance && (
                <p className="text-[11px] text-red-600 mt-1.5">
                  This line is {formatCurrency(amount)} but only {formatCurrency(selectedDoc.balance)} is
                  outstanding. Use “On account”, or pick a {docLabel.toLowerCase()} with a larger balance.
                </p>
              )}
            </div>
          )}

          {mode === 'on_account' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="ee-tds" className="block text-xs font-medium text-slate-600 mb-1">TDS deducted</label>
                <input id="ee-tds" type="number" min="0" step="0.01" value={tds}
                  onChange={(e) => setTds(e.target.value)} placeholder="0.00"
                  className="w-full h-9 rounded-lg border border-slate-300 px-2 text-sm tabular-nums" />
              </div>
              <div>
                <label htmlFor="ee-chg" className="block text-xs font-medium text-slate-600 mb-1">Bank charges</label>
                <input id="ee-chg" type="number" min="0" step="0.01" value={charges}
                  onChange={(e) => setCharges(e.target.value)} placeholder="0.00"
                  className="w-full h-9 rounded-lg border border-slate-300 px-2 text-sm tabular-nums" />
              </div>
              <p className="col-span-2 text-[11px] text-slate-400">
                The statement shows the NET figure. If {formatCurrency(amount)} arrived after a
                deduction, record the deduction here so it isn’t lost.
              </p>
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 px-4 py-3 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose}
            className="h-9 px-3 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={!canSave}
            className="h-9 px-3 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5">
            {saving && <Loader2 size={14} className="animate-spin" />}
            Record {isDebit ? 'payment' : 'receipt'}
          </button>
        </div>
      </div>
    </div>
  );
}
