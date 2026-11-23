/**
 * Import a bank statement and record the payments/receipts in it, WITHOUT
 * leaving the page you are on.
 *
 * Used by Purchase > Payments Made (side="debit") and Sales > Receivables
 * (side="credit"). The statement is simply the source of the entries; there is
 * no reconciliation step and no comparison, because at this stage there is
 * nothing to compare against — the whole point is to get the payments INTO the
 * ERP in the first place.
 *
 * Two steps, one modal:
 *   1. pick the bank account + file  -> uploaded with skip_match=1 (parse only)
 *   2. the parsed rows appear here   -> set a party (and optionally a document)
 *                                       per row and record it
 *
 * Rows disappear as they are recorded, so the list is always what is left to
 * do. Closing and re-opening resumes from the same place: the rows already
 * recorded stay linked server-side and are filtered out by `unrecorded=1`.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ChevronDown, Loader2, Upload, X } from 'lucide-react';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import apiClient from '../../utils/api.js';
import useLookup, { clearLookupCache } from '../../hooks/useLookup.js';
import { getApiErrorMessage } from '../../utils/formHelpers.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayISO = () => new Date().toISOString().slice(0, 10);

// The UNIQUE set of already-paid (no-voucher) bills whose amounts sum EXACTLY to
// a payment — so a lump that settled several pre-marked-paid bills can be
// pre-ticked for one-click apply instead of hunted for by hand. Works in integer
// paise to dodge float drift. Returns the bill ids, or null when there is no
// exact combination OR more than one (ambiguous → let the operator choose, never
// guess). Bounded (small subsets only) so a long bill list can't hang the row.
const findUniquePaidSubset = (bills, target, amountOf = (b) => b.amount_paid) => {
  const t = Math.round(round2(target) * 100);
  if (t <= 0) return null;
  const items = (bills || [])
    .map((b) => ({ id: b.id, cents: Math.round(num(amountOf(b)) * 100) }))
    .filter((x) => x.cents > 0 && x.cents <= t)
    .sort((a, b) => b.cents - a.cents);
  const MAX_N = 25, MAX_K = 6;
  if (!items.length || items.length > MAX_N) return null;
  const found = [];
  const dfs = (start, remaining, picked) => {
    if (found.length > 1) return;
    if (remaining === 0 && picked.length) { found.push([...picked]); return; }
    if (picked.length >= MAX_K) return;
    for (let i = start; i < items.length && found.length <= 1; i++) {
      if (items[i].cents > remaining) continue;
      picked.push(items[i].id);
      dfs(i + 1, remaining - items[i].cents, picked);
      picked.pop();
    }
  };
  dfs(0, t, []);
  return found.length === 1 ? found[0] : null;
};
// Sentinel option values in the Vendor picker for the two "not a vendor"
// paths — a genuine P&L cost (Expense) vs. a loan/advance/suspense
// counterparty (Ledger). See enterExpenseMode / enterLedgerMode below.
const EXPENSE_SENTINEL = '__EXPENSE__';
const LEDGER_SENTINEL = '__NEW_LEDGER__';
// Existing-ledger option values are namespaced so the picker's onChange can
// tell "pick this already-known ledger" apart from a real Vendor's UUID.
const LEDGER_PREFIX = 'ledger:';
// Same namespacing for Transporters — freight payments (debit side only).
// Picking one enters expense mode with `transporter` set, rather than a
// separate UI mode, since a transporter payment is structurally still an
// expense (see finance.bank_entry.create_expense_from_line).
const TRANSPORTER_PREFIX = 'transporter:';
// Own-account options — picking one records the line as a TRANSFER into that
// account (a sweep between our own accounts), not a vendor payment. Namespaced
// like the others so the picker's onChange tells it apart from a Vendor UUID.
const OWNACCT_PREFIX = 'ownacct:';

// Oldest-bill-first, same rule as the single-document default and as the
// standalone New Payment screen's lump-sum distribute — split a total
// across `docs` (already sorted oldest-first), each capped at its own
// balance, until the total is used up or the bills run out.
const distributeSplit = (docs, total) => {
  let remaining = round2(total);
  const next = {};
  for (const d of docs) {
    const pay = Math.min(remaining, d.balance);
    if (pay > 0) { next[d.id] = String(round2(pay)); remaining = round2(remaining - pay); }
  }
  return next;
};

// Top up an allocation oldest-first with whatever the line still has left
// unassigned. Amounts already typed are kept: each bill takes at most its
// own remaining headroom, so a part-allocated bill fills up before the
// next one is touched at all.
//
// Nothing calls this on its own — it runs only when the operator presses
// "Fill remaining", so which bills a lump sum paid stays something they
// asserted rather than something the screen assumed and pre-ticked.
const fillOldestFirst = (docs, current, amount) => {
  const next = { ...current };
  let remaining = round2(amount - Object.values(next).reduce((t, v) => t + num(v), 0));
  for (const doc of docs) {
    if (remaining <= 0) break;
    const headroom = round2(doc.balance - num(next[doc.id]));
    if (headroom <= 0) continue;
    const add = Math.min(remaining, headroom);
    next[doc.id] = String(round2(num(next[doc.id]) + add));
    remaining = round2(remaining - add);
  }
  return next;
};

// What a row will actually record, as {billId: amountString}. Kept DERIVED
// rather than stored until the operator touches a checkbox, so pickParty
// can keep seeding its oldest-open-bill / suggested-bill default (`doc`)
// without having to know the line's amount. The moment anything is
// checked, unchecked or typed, `alloc` is written to the draft and wins.
const effectiveAlloc = (d, amount) => {
  if (d.alloc) return d.alloc;
  if (!d.doc) return {};
  const bill = (d.docs || []).find((x) => x.id === d.doc);
  // Capped at the bill's own balance: a line bigger than the bill it was
  // matched to shows up as "short by" here instead of as the backend's
  // "Amount exceeds balance" AFTER clicking Record.
  return bill ? { [d.doc]: String(Math.min(amount, bill.balance)) } : {};
};

// Money out (a vendor payment) reads the debit column, money in reads credit.
const lineAmountOf = (row, isDebit) => round2(isDebit ? row.debit : row.credit);

// The one-line version shown in the collapsed Bill cell, plus the flag the
// Record button and the amber styling both key off. `balanced` is true for
// an empty allocation on purpose — recording nothing against a bill is a
// legitimate on-account payment, not an unfinished one.
const summariseAlloc = (row, d, isDebit) => {
  const amount = lineAmountOf(row, isDebit);
  const alloc = effectiveAlloc(d, amount);
  const picked = (d.docs || []).filter((x) => num(alloc[x.id]) > 0);
  const total = round2(picked.reduce((s, x) => s + num(alloc[x.id]), 0));
  // Over-allocating (more than the payment) is still invalid. Under-allocating
  // is fine on the debit side — the leftover is money paid ahead that becomes
  // an on-account advance on the vendor. `balanced` (exact or on-account-only)
  // keeps the green styling; `recordable` is what the Record button keys off.
  const over = total > amount;
  const onAccount = isDebit && picked.length > 0 && !over ? round2(amount - total) : 0;
  const balanced = picked.length === 0 || total === amount;
  const recordable = isDebit ? !over : balanced;
  const text = d.loading ? 'Loading…'
    : !d.party ? '—'
      : picked.length === 0 ? `On account (no ${isDebit ? 'bill' : 'invoice'})`
        : picked.length === 1 ? `${picked[0].label} · ${formatCurrency(total)}`
          : `${picked.length} ${isDebit ? 'bills' : 'invoices'} · ${formatCurrency(total)}`;
  return {
    amount, alloc, picked, total, balanced, over, onAccount, recordable, text,
    gap: over ? `Over by ${formatCurrency(round2(total - amount))} — remove some`
      : onAccount > 0 ? `${formatCurrency(onAccount)} → on account (advance)`
      : balanced ? '' : `Short by ${formatCurrency(Math.abs(round2(amount - total)))}`,
    // Whether "Fill remaining" would change anything: money still to
    // assign, and somewhere with room to take it. Debit only — a receipt
    // can only ever be one invoice (see toggleBill). Computed here rather
    // than in the panel so the COLLAPSED row can offer it too: being told
    // a row is short without being able to act on it, unless you first
    // expand the panel to find the button, is just a nag.
    canFill: isDebit
      && round2(amount - total) > 0
      && (d.docs || []).some((doc) => round2(doc.balance - num(alloc[doc.id])) > 0),
  };
};

// A transporter's outstanding freight slips mapped onto the shared `docs`
// shape the bill-allocation table and split helpers expect: {id, label, date,
// balance, total}. One place, so the freight table, distributeSplit and
// fillOldestFirst all read the same thing.
const freightDocsOf = (d) => (d.freightSlips || []).map((sl) => ({
  id: sl.id,
  label: sl.advice_no,
  date: sl.freight_date,
  balance: round2(sl.balance),
  total: round2(sl.total ?? sl.balance),
  // Searchable text: advice no + covered bill no(s) + LR/lorry + amount, so the
  // freight search box finds a slip by any of them (see freightSearchMatch).
  _search: [
    sl.advice_no,
    ...(sl.covered_bills || []),
    sl.lorry_no, sl.lr_no,
    String(sl.balance ?? ''), String(sl.payable ?? ''),
  ].filter(Boolean).join(' ').toLowerCase(),
}));

// Does a freight doc match the search text? Space-separated terms must ALL
// appear (so "ss045 new" narrows), each as a substring of the slip's _search.
const freightSearchMatch = (doc, q) => {
  const terms = (q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = doc._search || '';
  return terms.every((t) => hay.includes(t));
};

// Freight equivalent of effectiveAlloc: the slip→amount map a row will record.
// Until the operator touches the table it derives from the auto-match tick set
// (freightPick), each slip filled to its own balance oldest-first — so the
// pre-seeded exact match shows allocated, matching the bills' `doc` default.
const effectiveFreightAlloc = (d, amount) => {
  if (d.freightAlloc) return d.freightAlloc;
  const docs = freightDocsOf(d);
  const pickedIds = Object.keys(d.freightPick || {}).filter((id) => d.freightPick[id]);
  if (!pickedIds.length) return {};
  return distributeSplit(docs.filter((x) => pickedIds.includes(x.id)), amount);
};

// Freight equivalent of summariseAlloc — same allocated/balanced/on-account/
// canFill shape so BillAllocationRow and the Apply button behave identically.
const summariseFreight = (row, d, isDebit) => {
  const amount = lineAmountOf(row, isDebit);
  const docs = freightDocsOf(d);
  const alloc = effectiveFreightAlloc(d, amount);
  const picked = docs.filter((x) => num(alloc[x.id]) > 0);
  const total = round2(picked.reduce((s, x) => s + num(alloc[x.id]), 0));
  const over = total > amount;
  const onAccount = picked.length > 0 && !over ? round2(amount - total) : 0;
  const balanced = picked.length === 0 || total === amount;
  return {
    amount, alloc, docs, picked, total, balanced, over, onAccount,
    recordable: !over && picked.length > 0,
    gap: over ? `Over by ${formatCurrency(round2(total - amount))} — remove some`
      : onAccount > 0 ? `${formatCurrency(onAccount)} → on account (advance)`
      : balanced ? '' : `Short by ${formatCurrency(Math.abs(round2(amount - total)))}`,
    canFill: round2(amount - total) > 0
      && docs.some((doc) => round2(doc.balance - num(alloc[doc.id])) > 0),
  };
};

export default function ImportStatementModal({ side = 'debit', onClose, onRecorded, initialUploadId = null, initialAccount = '', embedded = false }) {
  const isDebit = side === 'debit';
  // When opened from the Import page for an already-uploaded statement, jump
  // straight to the rows step for that upload instead of the pick/upload step.
  const [step, setStep] = useState(initialUploadId ? 'rows' : 'pick');          // 'pick' | 'rows'
  const [account, setAccount] = useState(initialAccount || '');
  const [file, setFile] = useState(null);
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [uploadId, setUploadId] = useState(null);
  const [rows, setRows] = useState([]);
  const [draft, setDraft] = useState({});             // lineId -> {party, doc, docs}
  const [savingId, setSavingId] = useState(null);
  // Rows flagged as a likely duplicate (see row.duplicate_of) can't be
  // Recorded until explicitly acknowledged here — disabled by default
  // rather than just warned, since the failure mode (a vendor paid twice)
  // is expensive and a warning alone is one careless click away from the
  // same outcome. Not a hard block: date+amount alone can't fully rule out
  // two genuinely separate payments landing on the same day for the same
  // amount, so there has to be a way through, just not a silent one.
  const [ackedDupes, setAckedDupes] = useState(() => new Set());
  // The "Entered" tab: rows already recorded from this statement, each with an
  // Undo (revert). Loaded lazily when the tab is opened.
  const [rowsTab, setRowsTab] = useState('todo');       // 'todo' | 'entered'
  const [enteredRows, setEnteredRows] = useState([]);
  const [loadingEntered, setLoadingEntered] = useState(false);

  // real_bank=1 keeps the TDS/GST ledger rows an old Tally import created out
  // of a picker that should only ever list actual banks; include_cash=1 adds
  // the Cash account back in — a cash register gets imported here the same
  // way a bank statement does.
  const { options: accounts, raw: accountsRaw } = useLookup('/api/bank/accounts/?real_bank=1&include_cash=1', {
    // Lead with internal_alias when the account has one (CREDITOR/FREIGHT/
    // MAIZE/IOCC — see bank.BankAccount.internal_alias) so the purpose-
    // dedicated accounts jump out at a glance instead of requiring a full
    // read of the raw, inconsistently-formatted Tally nickname. Accounts
    // with no alias set (loan facilities, the operating accounts that
    // aren't swept to/from) fall back to the plain code · nickname label.
    labelField: (a) => a.internal_alias
      ? `${a.internal_alias} · ${a.code} · ${a.nickname}`
      : `${a.code} · ${a.nickname}`,
    valueField: 'id',
  });
  const { options: parties } = useLookup(
    isDebit ? '/api/vendors/' : '/api/customers/',
    { labelField: isDebit ? 'vendor_name' : 'customer_name' },
  );
  // Vendors created inline via the "not in Vendor master" shortcut below —
  // merged into the picker's options immediately so the row can select its
  // own brand-new vendor without waiting on a full re-fetch of the (cached,
  // shared-across-the-app) vendor lookup.
  const [extraParties, setExtraParties] = useState([]);
  const allParties = useMemo(() => [...parties, ...extraParties], [parties, extraParties]);
  // The company's OTHER bank accounts — destinations for an internal transfer
  // (money swept from this statement's account into a dedicated Expense /
  // Creditor / Freight / Maize account). Built from the already-loaded account
  // list, scoped to the same company as the statement's account and excluding
  // that account itself, labelled by alias + account number so the operator
  // can tell which is which (what the user asked for: pick the destination by
  // account no, shown as Expense/Creditor/Freight).
  const ownAccountOptions = useMemo(() => {
    const stmt = accountsRaw.find((a) => a.id === account);
    if (!stmt) return [];
    return accountsRaw
      .filter((a) => a.id !== account && a.company === stmt.company)
      .map((a) => ({
        value: a.id,
        label: (a.internal_alias ? `${a.internal_alias} · ` : '') + `${a.code} · ${a.account_number}`,
      }));
  }, [accountsRaw, account]);
  // For prefilling the quick-create form's Company field — a vendor still
  // needs one, and the statement's own bank account already says which
  // company this payment belongs to.
  const { options: companies } = useLookup(isDebit ? '/api/companies/' : null);
  // Only debit lines can be a vendor-less expense — Receivables has no
  // equivalent (a customer receipt always has a customer, by definition).
  const { options: expenseCategories } = useLookup(
    isDebit ? '/api/expense-categories/' : null, { labelField: 'name' },
  );
  // Ledgers — counterparties for a loan/advance/suspense movement, the
  // third option alongside a Vendor and an Expense (see finance.Ledger's
  // own docstring for why: forcing a multi-crore loan through the Expense
  // path would misstate the P&L). Listed so a repeat counterparty (the
  // same loan account across several statements) reuses one Ledger rather
  // than spawning a new one each time, same reasoning as extraParties below.
  const { options: ledgers } = useLookup('/api/finance/ledgers/', { labelField: 'name' });
  const [extraLedgers, setExtraLedgers] = useState([]);
  const allLedgers = useMemo(() => [...ledgers, ...extraLedgers], [ledgers, extraLedgers]);
  // Transporters — freight payments, debit side only (see
  // finance.bank_entry.create_expense_from_line's transporter_id: a
  // lorry/logistics payment is still recorded as an Expense, just
  // identified by the Transporter master instead of Vendor, since a real
  // Tally ledger showed these paid to named transporters directly, not
  // trade vendors).
  const { options: transporters } = useLookup(isDebit ? '/api/transporters/' : null, { labelField: 'name' });

  // Open documents for whichever party a row was assigned, fetched once per
  // party and cached on the row's draft so re-picking does not re-query.
  // Defaults the document to the OLDEST open bill/invoice for that party —
  // oldest-first is the simplest defensible allocation rule when nothing
  // more specific is known. `preferredDocId` overrides that default when
  // the caller already knows exactly which bill this is (see
  // suggested_doc_id — an exact outstanding-balance match found by
  // bank_reconciliation.suggest_parties_from_open_documents), so that
  // specific bill is what gets pre-selected instead of the oldest one.
  const pickParty = useCallback(async (lineId, partyId, preferredDocId, lineAmount) => {
    setDraft((d) => ({ ...d, [lineId]: { party: partyId, doc: '', docs: [], loading: !!partyId, paidMatch: null } }));
    if (!partyId) return;
    const url = isDebit
      ? `/api/purchase/bills/?vendor=${partyId}&page_size=200`
      : `/api/sales/receivables/?customer=${partyId}&page_size=200`;
    try {
      const r = await apiClient.get(url);
      const list = r.data?.results || (Array.isArray(r.data) ? r.data : []);
      const docs = list.map((d) => (isDebit
        ? { id: d.id, label: d.bill_no || d.vendor_invoice_no || '—', balance: num(d.balance_due), total: num(d.total_amount), date: d.bill_date }
        : { id: d.id, label: d.invoice_no || '—', balance: num(d.balance), date: d.invoice_date }))
        .filter((d) => d.balance > 0)
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const preferred = preferredDocId && docs.some((d) => d.id === preferredDocId) ? preferredDocId : '';
      setDraft((d) => ({ ...d, [lineId]: { ...(d[lineId] || {}), docs, doc: preferred || docs[0]?.id || '', loading: false } }));
      // Debit only: bills that read PAID but have no payment voucher (amount set
      // by a Zoho/Tally import). An EXACT single-bill match gets the one-click
      // green box; the full list lets the operator tick the SEVERAL a lump
      // payment settled (reopen + re-pay each, no balance change).
      if (isDebit) {
        try {
          const [exact, all] = await Promise.all([
            lineAmount
              ? apiClient.get(`/api/finance/bank-statements/paid-bill-matches/?vendor=${partyId}&amount=${lineAmount}`)
              : Promise.resolve({ data: { results: [] } }),
            apiClient.get(`/api/finance/bank-statements/paid-bill-matches/?vendor=${partyId}&all=1`),
          ]);
          const match = (exact.data?.results || [])[0] || null;
          const paidBills = all.data?.results || [];
          // No single-bill exact match? Try to auto-find the unique COMBINATION
          // of paid-no-voucher bills that sums to this payment and pre-tick it.
          const combo = !match && lineAmount ? findUniquePaidSubset(paidBills, lineAmount) : null;
          const paidPick = combo ? Object.fromEntries(combo.map((id) => [id, true])) : {};
          setDraft((d) => ({ ...d, [lineId]: { ...(d[lineId] || {}), paidMatch: match, paidBills, paidPick, paidAuto: !!combo } }));
        } catch { /* best-effort */ }
      }
    } catch {
      setDraft((d) => ({ ...d, [lineId]: { ...(d[lineId] || {}), docs: [], loading: false } }));
    }
  }, [isDebit]);

  // A narration names a real payee with no Vendor/Customer record at all
  // (row.unmatched_name_guess) — opening the full New Vendor form in a new
  // tab turned out to be more friction than it saved (a separate browsing
  // context needs its own inherited session, and even then the operator
  // loses their place in this list). The API's actual minimum for a vendor
  // is just a name and a company — GSTIN/PAN/address are enforced by the
  // full form's UI, not the backend — so this creates one with a sensible
  // default (Unregistered; edit it properly later from the Vendor master
  // if it does turn out to be GST-registered) without ever leaving this modal.
  const toggleCreateVendor = useCallback((row) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      const turningOn = !d.createVendorMode;
      return {
        ...s,
        [row.id]: {
          ...d,
          createVendorMode: turningOn,
          newVendorName: turningOn ? (d.newVendorName || row.unmatched_name_guess || '') : d.newVendorName,
          newVendorCompany: turningOn
            ? (d.newVendorCompany || accountsRaw.find((a) => a.id === account)?.company || '')
            : d.newVendorCompany,
        },
      };
    });
  }, [accountsRaw, account]);

  const createVendorFromRow = useCallback(async (row) => {
    const d = draft[row.id] || {};
    const vendor_name = (d.newVendorName || '').trim();
    if (!vendor_name) { toast.error('Enter a name for the new vendor.'); return; }
    const company = d.newVendorCompany || accountsRaw.find((a) => a.id === account)?.company || '';
    if (!company) { toast.error('Pick which company this vendor belongs to.'); return; }
    setSavingId(row.id);
    try {
      const { data } = await apiClient.post('/api/vendors/', {
        vendor_name, company, gst_treatment: 'UNREGISTERED',
      });
      setExtraParties((p) => [...p, { value: data.id, label: data.vendor_name }]);
      toast.success(`Vendor "${data.vendor_name}" created.`);
      pickParty(row.id, data.id, undefined, lineAmountOf(row, isDebit));
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  }, [draft, accountsRaw, account, pickParty]);

  // "Not a vendor — record as a ledger entry" is the OTHER non-vendor path:
  // a loan, an advance, a suspense movement — money that isn't a trade
  // payable and isn't a P&L cost either. Forcing it through Expense would
  // misstate the P&L for exactly the transactions most likely to need this
  // (a lakhs/crores-sized one-off, not a routine bill). See finance.Ledger.
  // Declared here (rather than alongside enterExpenseMode further down)
  // because loadRows below needs selectExistingLedger for auto-matching —
  // it must exist before that useCallback's dependency array evaluates.
  const enterLedgerMode = useCallback((row) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      return {
        ...s,
        [row.id]: {
          ...d,
          party: '',
          ledgerMode: true, expenseMode: false,
          ledgerId: '',
          newLedgerName: d.newLedgerName || row.unmatched_name_guess || '',
          newLedgerType: d.newLedgerType || 'OTHER',
        },
      };
    });
  }, []);

  // Picking an ALREADY-KNOWN ledger (e.g. the same loan account a previous
  // statement's line also moved money against) skips the create-new form
  // entirely — nothing left to fill in, just record against it. Also used
  // by loadRows to auto-select a backend-suggested Ledger match, the same
  // way pickParty auto-selects a confirmed Vendor match.
  const selectExistingLedger = useCallback((row, ledgerId, ledgerName) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      return {
        ...s,
        [row.id]: { ...d, party: '', ledgerMode: true, expenseMode: false, ledgerId, newLedgerName: ledgerName },
      };
    });
  }, []);

  // Picking a Transporter (from the list, or auto-matched via
  // suggested_transporter_id) enters expense mode with `transporter` set —
  // reuses the existing expense mini-form (Title/Category/Paid-to) rather
  // than a separate UI mode, since a freight payment is structurally still
  // an expense. Declared here (not with enterExpenseMode further down) for
  // the same reason as selectExistingLedger — loadRows needs it before its
  // own useCallback dependency array evaluates.
  const selectExistingTransporter = useCallback((row, transporterId, transporterName) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      return {
        ...s,
        [row.id]: {
          ...d,
          party: '', ledgerMode: false, expenseMode: true,
          transporter: transporterId,
          expenseTitle: d.expenseTitle || row.narration || '',
          expensePartyName: transporterName,
          freightSlips: undefined, freightPick: {}, freightAuto: false,
        },
      };
    });
    // Pull this transporter's OUTSTANDING separate-slip freight so a freight
    // payment can be tied to the exact slips it settled (not just booked as a
    // generic expense). Auto-tick the unique set that sums to the payment.
    if (transporterId && row.freight_direction !== 'LOCAL') {
      const dirParam = row.freight_direction === 'OUTWARD' ? '&freight_direction=OUTWARD' : '';
      apiClient.get(`/api/finance/bank-statements/transporter-freight/?transporter=${transporterId}${dirParam}`)
        .then((r) => {
          const slips = r.data?.results || [];
          const amt = lineAmountOf(row, isDebit);
          const combo = amt ? findUniquePaidSubset(slips, amt, (sl) => sl.balance) : null;
          const freightPick = combo ? Object.fromEntries(combo.map((id) => [id, true])) : {};
          setDraft((s) => ({ ...s, [row.id]: { ...(s[row.id] || {}), freightSlips: slips, freightPick, freightAuto: !!combo } }));
        })
        .catch(() => { /* best-effort — fall back to the plain expense form */ });
    }
  }, [isDebit]);

  // Picking one of our OWN accounts (from the list, or auto-matched via
  // internal_transfer_to_account_id) records the line as a transfer INTO that
  // account. Declared here, like selectExistingLedger/Transporter above, so
  // loadRows can reference it before its own dependency array evaluates.
  const enterTransferMode = useCallback((row, toAccountId, toAccountLabel) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      return {
        ...s,
        [row.id]: {
          ...d,
          party: '', expenseMode: false, ledgerMode: false,
          transferMode: true, toAccount: toAccountId, toAccountLabel: toAccountLabel || '',
        },
      };
    });
  }, []);

  const loadRows = useCallback(async (id) => {
    const r = await apiClient.get(
      `/api/finance/bank-statements/${id}/lines/?side=${side}&unrecorded=1`);
    const results = r.data?.results || [];
    setRows(results);
    // The backend already found a confident match for some rows — same
    // payment/receipt already entered in Tally, matched by reference/date/
    // amount (see finance.bank_reconciliation.suggest_parties). Pre-fill
    // those instead of making the operator look the vendor up again for a
    // transaction the system already recognises. A row can't get both —
    // suggested_ledger_id only ever comes back when there was no vendor
    // match — but party wins if it somehow did, since a real Vendor record
    // is the more specific answer.
    results.forEach((row) => {
      if (row.suggested_party_id) pickParty(row.id, row.suggested_party_id, row.suggested_doc_id, lineAmountOf(row, isDebit));
      else if (row.suggested_transporter_id) selectExistingTransporter(row, row.suggested_transporter_id, row.suggested_transporter_name);
      // A remembered payee->expense mapping (e.g. a SALARY payee) with no vendor/
      // bill match: auto-enter expense mode with the category pre-filled, so a
      // salary line records as an EXPENSE and never sits in the Vendor slot as if
      // "Salary" were a vendor. Debit side only (expenses are money out).
      else if (isDebit && row.suggested_expense_category_id) enterExpenseMode(row);
      else if (row.suggested_ledger_id) selectExistingLedger(row, row.suggested_ledger_id, row.suggested_ledger_name);
      // A transfer into one of our own accounts whose destination the backend
      // could tie to a specific account — pre-select it so the operator just
      // clicks Record (they can still change it, or Mark as internal instead).
      else if (row.internal_transfer_to_account_id) enterTransferMode(row, row.internal_transfer_to_account_id, row.internal_transfer_to_account_label);
    });
    return r.data;
    // enterExpenseMode is a stable useCallback([]) defined below; it's omitted
    // from deps deliberately to avoid a temporal-dead-zone reference here (the
    // body runs after render, where it's initialised).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, pickParty, selectExistingTransporter, selectExistingLedger, enterTransferMode, isDebit]);

  // Opened from the Import page against an existing statement: load its rows
  // straight away (the pick/upload step is skipped).
  useEffect(() => {
    if (!initialUploadId) return;
    setUploadId(initialUploadId);
    setStep('rows');
    loadRows(initialUploadId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUploadId]);

  // The "Entered" tab — rows already recorded from this statement.
  const loadEntered = useCallback(async () => {
    if (!uploadId) return;
    setLoadingEntered(true);
    try {
      const r = await apiClient.get(`/api/finance/bank-statements/${uploadId}/lines/?side=${side}&recorded=1`);
      setEnteredRows(r.data?.results || []);
    } catch { /* keep whatever was shown */ }
    finally { setLoadingEntered(false); }
  }, [uploadId, side]);

  // Revert a recorded row — it drops back into "To record".
  const undoRow = useCallback(async (row) => {
    setSavingId(row.id);
    try {
      await apiClient.post(`/api/finance/bank-statements/${uploadId}/undo-entry/`, { line_id: row.id });
      setEnteredRows((rs) => rs.filter((r) => r.id !== row.id));
      await loadRows(uploadId);   // the undone row reappears to record
      onRecorded?.();             // refresh the statement's Detected/Entered/Missing
      toast.success('Reverted — moved back to “To record”.');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  }, [uploadId, loadRows, onRecorded]);

  // A short label for what a recorded line became.
  const enteredAs = useCallback((row) => {
    if (row.is_internal_transfer) return `🏦 Transfer${row.transfer_to_account_label ? ` → ${row.transfer_to_account_label}` : ''}`;
    switch (row.matched_source) {
      case 'vendor_payment': return 'Vendor payment';
      case 'bank_payment': return 'Bank payment';
      case 'bank_receipt': return 'Bank receipt';
      case 'receivable_payment': return 'Customer receipt';
      case 'expense_entry': return 'Expense';
      case 'ledger_transaction': return 'Ledger';
      default: return 'Recorded';
    }
  }, []);

  const upload = useCallback(async () => {
    if (!account || !file) { toast.error('Pick a bank account and a file.'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('bank_account', account);
      fd.append('statement_file', file);
      fd.append('statement_period_start', from);
      fd.append('statement_period_end', to);
      // Parse only. Nothing to reconcile against yet.
      fd.append('skip_match', '1');
      const { data } = await apiClient.post('/api/finance/bank-statements/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 700000,   // a scanned PDF goes through vision extraction
      });
      if (data.parsing_status === 'ERROR') {
        toast.error(data.parse_error || 'Could not read this statement.');
        return;
      }
      setUploadId(data.id);
      const res = await loadRows(data.id);
      setStep('rows');
      // reused_existing: this exact file was already uploaded for this
      // account — the backend handed back THAT upload instead of parsing a
      // duplicate copy, so what's left is whatever wasn't recorded yet.
      toast.success(data.reused_existing
        ? `Already uploaded before — ${res.count} row(s) still left to record.`
        : `${res.count} ${isDebit ? 'payment' : 'receipt'} row(s) read from the statement.`);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [account, file, from, to, loadRows, isDebit]);

  // Toggling split mode on seeds it with the oldest-first distribution over
  // the row's own full amount — same default the single-document dropdown
  // already uses, just spread across as many bills as it takes instead of
  // stopping at one. Toggling off clears any typed allocation.
  const toggleBillsOpen = useCallback((rowId) => {
    setDraft((s) => ({ ...s, [rowId]: { ...s[rowId], billsOpen: !s[rowId]?.billsOpen } }));
  }, []);

  // Ticking/unticking a bill re-spreads the line's own amount oldest-first
  // across whatever is now ticked, each capped at its balance — so the
  // common cases need no typing at all: tick one bill and it takes the
  // whole line, tick three and they fill up in date order. Amounts typed
  // afterwards stand until the ticked set changes again.
  //
  // Only the debit side can hold more than one: create-split-entry is
  // vendor-only (a lump-sum RTGS settling several bills), and there is no
  // receivable equivalent — so on the credit side ticking one unticks the
  // rest rather than building a split the backend would refuse.
  const toggleBill = useCallback((row, billId) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      const amount = lineAmountOf(row, isDebit);
      const current = effectiveAlloc(d, amount);
      const wasOn = billId in current;
      let ids;
      if (wasOn) ids = Object.keys(current).filter((id) => id !== billId);
      else if (isDebit) ids = [...Object.keys(current), billId];
      else ids = [billId];
      const picked = (d.docs || []).filter((x) => ids.includes(x.id));
      return { ...s, [row.id]: { ...d, alloc: distributeSplit(picked, amount) } };
    });
  }, [isDebit]);

  const fillRemaining = useCallback((row) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      const amount = lineAmountOf(row, isDebit);
      return {
        ...s,
        [row.id]: { ...d, alloc: fillOldestFirst(d.docs || [], effectiveAlloc(d, amount), amount) },
      };
    });
  }, [isDebit]);

  const setAllocAmount = useCallback((row, billId, val) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      const base = effectiveAlloc(d, lineAmountOf(row, isDebit));
      return { ...s, [row.id]: { ...d, alloc: { ...base, [billId]: val } } };
    });
  }, [isDebit]);

  // ── Freight-slip allocation — the SAME per-document table/behaviour as the
  // vendor bills above, but over a transporter's outstanding freight slips.
  // The slips are mapped to the shared `docs` shape {id,label,date,balance,
  // total} (see freightDocsOf) so distributeSplit / fillOldestFirst / the
  // BillAllocationRow table all apply unchanged. Allocation lives in
  // d.freightAlloc; it starts undefined so pickParty's auto-match (freightPick
  // / freightAuto) still seeds the oldest/exact default until the operator
  // touches a row, at which point freightAlloc is written and wins.
  const toggleFreightAlloc = useCallback((row, slipId) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      const amount = lineAmountOf(row, isDebit);
      const docs = freightDocsOf(d);
      const current = effectiveFreightAlloc(d, amount);
      const ids = (slipId in current)
        ? Object.keys(current).filter((id) => id !== slipId)
        : [...Object.keys(current), slipId];
      const picked = docs.filter((x) => ids.includes(x.id));
      return { ...s, [row.id]: { ...d, freightAlloc: distributeSplit(picked, amount) } };
    });
  }, [isDebit]);

  const setFreightAmount = useCallback((row, slipId, val) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      const base = effectiveFreightAlloc(d, lineAmountOf(row, isDebit));
      return { ...s, [row.id]: { ...d, freightAlloc: { ...base, [slipId]: val } } };
    });
  }, [isDebit]);

  const fillFreightRemaining = useCallback((row) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      const amount = lineAmountOf(row, isDebit);
      return {
        ...s,
        [row.id]: { ...d, freightAlloc: fillOldestFirst(freightDocsOf(d), effectiveFreightAlloc(d, amount), amount) },
      };
    });
  }, [isDebit]);

  // For a debit that names no vendor at all (audit fees, a GST/TDS payment,
  // a bank fee) — an alternative to the vendor+bill picker, not something
  // narration alone can reliably auto-detect the way internal transfers
  // are, so the operator opts into it per row. Title defaults to the
  // narration since that's usually already a decent description.
  const toggleExpenseMode = useCallback((row) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      const turningOn = !d.expenseMode;
      return {
        ...s,
        [row.id]: {
          ...d,
          expenseMode: turningOn,
          expenseTitle: turningOn ? (d.expenseTitle || row.narration || '') : d.expenseTitle,
          // Pre-fill the category from a remembered payee->expense mapping.
          expenseCategory: turningOn ? (d.expenseCategory || row.suggested_expense_category_id || '') : d.expenseCategory,
        },
      };
    });
  }, []);

  // "Not a vendor — record as an expense" lives as an option INSIDE the
  // same Vendor picker rather than a separate toggle elsewhere on the row:
  // one control, one decision, instead of hunting for a different one once
  // you've already decided "not a vendor". For a genuine P&L cost (audit
  // fees, a bank charge, a tax payment) with no payee worth naming.
  const enterExpenseMode = useCallback((row) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      return {
        ...s,
        [row.id]: {
          ...d,
          party: '',
          expenseMode: true, ledgerMode: false,
          expenseTitle: d.expenseTitle || row.narration || '',
          expenseCategory: d.expenseCategory || row.suggested_expense_category_id || '',
          expensePartyName: d.expensePartyName || row.unmatched_name_guess || '',
        },
      };
    });
  }, []);

  const recordLedgerEntry = useCallback(async (row) => {
    const d = draft[row.id] || {};
    if (!d.ledgerId && !(d.newLedgerName || '').trim()) {
      toast.error('Enter a name for the ledger.'); return;
    }
    if (row.duplicate_of && !ackedDupes.has(row.id)) return;
    setSavingId(row.id);
    try {
      const { data } = await apiClient.post(`/api/finance/bank-statements/${uploadId}/create-ledger-entry/`, {
        line_id: row.id,
        ledger_id: d.ledgerId || undefined,
        ledger_name: d.ledgerId ? undefined : d.newLedgerName,
        ledger_type: d.ledgerId ? undefined : d.newLedgerType,
      });
      if (!d.ledgerId) {
        setExtraLedgers((l) => [...l, { value: data.ledger_id, label: data.ledger_name }]);
      }
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      onRecorded?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  }, [draft, uploadId, onRecorded, ackedDupes]);

  const recordExpense = useCallback(async (row) => {
    const d = draft[row.id] || {};
    const title = (d.expenseTitle || '').trim();
    if (!title) { toast.error('Enter a short title for this expense.'); return; }
    if (row.duplicate_of && !ackedDupes.has(row.id)) return;
    setSavingId(row.id);
    try {
      await apiClient.post(`/api/finance/bank-statements/${uploadId}/create-expense-entry/`, {
        line_id: row.id,
        title,
        category_id: d.expenseCategory || undefined,
        vendor_id: d.party || undefined,
        transporter_id: d.transporter || undefined,
        party_name: d.party ? '' : (d.expensePartyName || ''),
      });
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      onRecorded?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  }, [draft, uploadId, onRecorded, ackedDupes]);

  // Record the line as a transfer into one of our OWN accounts (the
  // destination picked in the dropdown). No vendor/expense/voucher is created
  // — Tally holds the contra — this just records WHERE the money went and
  // drops the row from the queue.
  const recordTransfer = useCallback(async (row) => {
    const d = draft[row.id] || {};
    if (!d.toAccount) { toast.error('Pick which of your accounts the money went to.'); return; }
    if (row.duplicate_of && !ackedDupes.has(row.id)) return;
    setSavingId(row.id);
    try {
      await apiClient.post(`/api/finance/bank-statements/${uploadId}/create-transfer-entry/`, {
        line_id: row.id,
        to_account_id: d.toAccount,
      });
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      onRecorded?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  }, [draft, uploadId, onRecorded, ackedDupes]);

  // Apply this payment to a bill that reads PAID but has no payment voucher:
  // reopens it and records the payment, so the bill gets a real Payment
  // History and its balance is unchanged (no double count).
  const applyToPaidBill = useCallback(async (row, match) => {
    if (row.duplicate_of && !ackedDupes.has(row.id)) return;
    setSavingId(row.id);
    try {
      await apiClient.post(`/api/finance/bank-statements/${uploadId}/apply-to-paid-bill/`, {
        line_id: row.id, bill_id: match.id,
      });
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      onRecorded?.();
      toast.success(`Recorded against ${match.vendor_invoice_no || match.bill_no} — the bill now shows this payment.`);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  }, [uploadId, onRecorded, ackedDupes]);

  // Tick/untick one of the vendor's already-paid (no-voucher) bills that this
  // lump payment settled.
  const togglePaidBill = useCallback((row, billId) => {
    setDraft((s) => {
      const d = s[row.id] || {};
      const pick = { ...(d.paidPick || {}) };
      if (pick[billId]) delete pick[billId]; else pick[billId] = true;
      return { ...s, [row.id]: { ...d, paidPick: pick } };
    });
  }, []);

  // Apply this payment across SEVERAL already-paid (no-voucher) bills: each is
  // reopened and re-paid so it gets a real voucher, balances unchanged.
  const applyToPaidBills = useCallback(async (row, billIds) => {
    if (row.duplicate_of && !ackedDupes.has(row.id)) return;
    setSavingId(row.id);
    try {
      await apiClient.post(`/api/finance/bank-statements/${uploadId}/apply-to-paid-bills/`, {
        line_id: row.id, bill_ids: billIds,
      });
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      onRecorded?.();
      toast.success(`Recorded across ${billIds.length} already-paid bill${billIds.length === 1 ? '' : 's'} — each now shows this payment.`);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  }, [uploadId, onRecorded, ackedDupes]);

  // Apply this payment across the picked freight slip(s), each for the amount
  // ALLOCATED to it (partial allowed, like the vendor bills): records a real
  // freight payment on each and leaves the line's leftover on account. `alloc`
  // is the slip→amount map from summariseFreight.
  const applyToFreight = useCallback(async (row, alloc) => {
    if (row.duplicate_of && !ackedDupes.has(row.id)) return;
    const allocations = Object.entries(alloc || {})
      .filter(([, amt]) => num(amt) > 0)
      .map(([freight_id, amt]) => ({ freight_id, amount: round2(amt) }));
    if (!allocations.length) { toast.error('Tick at least one freight slip.'); return; }
    setSavingId(row.id);
    try {
      await apiClient.post(`/api/finance/bank-statements/${uploadId}/apply-to-freight/`, {
        line_id: row.id, allocations,
        freight_direction: row.freight_direction || 'INWARD',
      });
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      onRecorded?.();
      toast.success(`Recorded against ${allocations.length} freight slip${allocations.length === 1 ? '' : 's'} — each now shows this payment.`);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  }, [uploadId, onRecorded, ackedDupes]);

  const record = useCallback(async (row) => {
    const d = draft[row.id] || {};
    if (!d.party) { toast.error(`Pick a ${isDebit ? 'vendor' : 'customer'} first.`); return; }
    if (row.duplicate_of && !ackedDupes.has(row.id)) return;
    setSavingId(row.id);
    try {
      const amount = lineAmountOf(row, isDebit);
      const allocations = Object.entries(effectiveAlloc(d, amount))
        .filter(([, amt]) => num(amt) > 0)
        .map(([bill_id, amt]) => ({ bill_id, amount: round2(amt) }));
      const total = round2(allocations.reduce((s, a) => s + a.amount, 0));

      // Over-allocating (more than the payment) is never valid.
      if (total > amount) {
        toast.error(`Allocated ${formatCurrency(total)} of ${formatCurrency(amount)} — over by ${formatCurrency(round2(total - amount))}. Remove some.`);
        return;
      }
      // Receivables has no split/advance path — keep the exact-match rule there.
      if (!isDebit && allocations.length && total !== amount) {
        toast.error(`Allocated ${formatCurrency(total)} of ${formatCurrency(amount)} — short by ${formatCurrency(round2(amount - total))}. The two must match exactly.`);
        return;
      }
      // Debit: whatever the bills don't cover is money paid ahead → advance.
      const onAccount = isDebit && allocations.length ? round2(amount - total) : 0;

      if (allocations.length === 0) {
        // Whole payment on account — no bill ticked.
        await apiClient.post(`/api/finance/bank-statements/${uploadId}/create-entry/`, {
          line_id: row.id,
          target: isDebit ? 'bank_payment' : 'bank_receipt',
          document_id: d.party,
        });
      } else if (allocations.length > 1 || onAccount > 0) {
        // Several bills, or bills + an on-account remainder (advance) — split.
        await apiClient.post(`/api/finance/bank-statements/${uploadId}/create-split-entry/`, {
          line_id: row.id,
          allocations,
          on_account_amount: onAccount,
        });
      } else {
        // Exactly one bill, exact amount — keep the single-FK create-entry.
        await apiClient.post(`/api/finance/bank-statements/${uploadId}/create-entry/`, {
          line_id: row.id,
          target: isDebit ? 'vendor_payment' : 'receivable_payment',
          document_id: allocations[0].bill_id,
        });
      }
      // Recording this row can change bill/invoice balances for its party —
      // confirmed live: two rows for the same vendor, the first row's
      // payment fully settled a bill (balance -> 0) the second row's Bill
      // dropdown had already fetched and pre-selected BEFORE that happened,
      // and clicking Record on the second row failed with "Amount exceeds
      // balance (0.00)". Any other still-open row for the SAME party has
      // that same stale docs list — refresh it now rather than let the
      // operator hit the same failure.
      const staleSiblings = rows.filter((r) => r.id !== row.id && draft[r.id]?.party === d.party);
      staleSiblings.forEach((r) => pickParty(r.id, d.party, undefined, lineAmountOf(r, isDebit)));
      if (staleSiblings.length) {
        toast('Refreshed bill balances for other row(s) with this vendor.', { icon: 'ℹ️' });
      }
      // Drop it from the list rather than refetching everything — the operator
      // is working down a list and a wholesale reload loses their place.
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      onRecorded?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  }, [draft, uploadId, isDebit, onRecorded, rows, pickParty]);

  // For a line that never went to an outside party at all — a transfer
  // between two of our own accounts (see internal_transfer_guess). Records
  // nothing: Tally already has the full picture of the transfer, so this
  // just clears the line from the queue instead of forcing a vendor pick
  // that could never be right.
  const markInternal = useCallback(async (row) => {
    setSavingId(row.id);
    try {
      await apiClient.post(`/api/finance/bank-statements/${uploadId}/mark-internal/`, {
        line_id: row.id,
        internal: true,
      });
      setRows((rs) => rs.filter((r) => r.id !== row.id));
      onRecorded?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSavingId(null);
    }
  }, [uploadId, onRecorded]);

  const remaining = rows.length;
  const title = isDebit ? 'Import payments from a bank statement'
                        : 'Import receipts from a bank statement';

  return (
    <div
      className={embedded ? 'w-full' : 'fixed inset-0 z-[70] bg-slate-900/40 flex items-center justify-center p-4'}
      onClick={embedded ? undefined : onClose}
    >
      <div
        className={embedded
          ? 'bg-white rounded-xl border border-slate-200 w-full flex flex-col max-h-[72vh]'
          : 'bg-white rounded-xl shadow-xl w-full max-w-6xl max-h-[92dvh] flex flex-col'}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
            <p className="text-[11px] text-slate-400">
              {step === 'pick'
                ? 'CSV or Excel export, or a PDF/photo — a scan is read automatically.'
                : `${remaining} row(s) left to record. They appear in this list until you record them.`}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500 shrink-0"><X size={16} /></button>
        </div>

        {step === 'pick' ? (
          <div className="p-4 space-y-4 overflow-auto">
            <div>
              <label htmlFor="is-acct" className="block text-xs font-medium text-slate-600 mb-1">
                Bank account <span className="text-red-500">*</span>
              </label>
              <CustomSelect
                name="bank_account"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="Select the account this statement is for…"
                className="w-full"
              >
                {accounts.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </CustomSelect>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="is-from" className="block text-xs font-medium text-slate-600 mb-1">Period start</label>
                <CustomDatePicker
                  name="statement_period_start"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label htmlFor="is-to" className="block text-xs font-medium text-slate-600 mb-1">Period end</label>
                <CustomDatePicker
                  name="statement_period_end"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
            </div>
            <div>
              <label htmlFor="is-file" className="block text-xs font-medium text-slate-600 mb-1">
                Statement file <span className="text-red-500">*</span>
              </label>
              <input id="is-file" type="file" accept=".csv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="w-full text-sm file:mr-3 file:h-9 file:px-3 file:rounded-lg file:border-0 file:bg-slate-100 file:text-slate-700" />
            </div>
          </div>
        ) : (
          <div className="overflow-auto">
            <div className="flex items-center gap-2 px-4 pt-3 border-b border-slate-100">
              <button type="button" onClick={() => setRowsTab('todo')}
                className={`-mb-px px-3 py-2 text-xs font-medium border-b-2 ${rowsTab === 'todo' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                To record ({remaining})
              </button>
              <button type="button" onClick={() => { setRowsTab('entered'); loadEntered(); }}
                className={`-mb-px px-3 py-2 text-xs font-medium border-b-2 ${rowsTab === 'entered' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                Entered{enteredRows.length ? ` (${enteredRows.length})` : ''}
              </button>
            </div>
            {rowsTab === 'entered' ? (
              loadingEntered ? (
                <p className="text-sm text-slate-400 py-10 text-center">Loading…</p>
              ) : enteredRows.length === 0 ? (
                <p className="text-sm text-slate-400 py-10 text-center">Nothing recorded from this statement yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold w-28">Date</th>
                      <th className="px-3 py-2 text-left font-semibold">Narration</th>
                      <th className="px-3 py-2 text-right font-semibold w-36">Amount</th>
                      <th className="px-3 py-2 text-left font-semibold w-48">Entered as</th>
                      <th className="px-3 py-2 w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {enteredRows.map((erow) => (
                      <tr key={erow.id} className="border-b border-slate-100 align-top">
                        <td className="px-3 py-2 whitespace-nowrap text-slate-500">{erow.txn_date ? formatDate(erow.txn_date) : '—'}</td>
                        <td className="px-3 py-2"><span className="block max-w-[320px] truncate" title={erow.narration}>{erow.narration || '—'}</span></td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{formatCurrency(num(isDebit ? erow.debit : erow.credit))}</td>
                        <td className="px-3 py-2 text-slate-700">{enteredAs(erow)}</td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => undoRow(erow)} disabled={savingId === erow.id}
                            className="h-7 px-2.5 rounded-lg border border-slate-300 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                            {savingId === erow.id ? 'Undoing…' : 'Undo'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : remaining === 0 ? (
              <p className="text-sm text-slate-400 py-12 text-center">
                Everything in this statement has been recorded.
              </p>
            ) : (
              <table className="w-full text-sm table-fixed">
                {/* `sticky` on <thead> itself is unreliable — some browsers
                    never actually pin it, others pin it but paint the row
                    beneath right through it since <thead> has no box of its
                    own to stay opaque. Sticky positioning + an opaque
                    background belong on each <th>, so this row genuinely
                    stays above scrolled content instead of the first visible
                    data row's text bleeding into the header band. */}
                <thead className="border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="sticky top-0 z-10 bg-slate-50 w-28 px-3 py-2 text-left font-semibold">Date</th>
                    <th className="sticky top-0 z-10 bg-slate-50 px-3 py-2 text-left font-semibold">Narration</th>
                    <th className="sticky top-0 z-10 bg-slate-50 w-36 px-3 py-2 text-right font-semibold">Amount</th>
                    <th className="sticky top-0 z-10 bg-slate-50 w-56 px-3 py-2 text-left font-semibold">{isDebit ? 'Vendor' : 'Customer'}</th>
                    <th className="sticky top-0 z-10 bg-slate-50 w-40 px-3 py-2 text-left font-semibold">{isDebit ? 'Bill' : 'Invoice'}</th>
                    <th className="sticky top-0 z-10 bg-slate-50 w-32 px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const d = draft[row.id] || {};
                    const allocSummary = summariseAlloc(row, d, isDebit);
                    // Multi-bill "apply to already-paid bills" tallies.
                    const paidPick = d.paidPick || {};
                    const pickedPaid = (d.paidBills || []).filter((b) => paidPick[b.id]);
                    const paidSum = round2(pickedPaid.reduce((t, b) => t + num(b.amount_paid), 0));
                    const paidExact = pickedPaid.length > 0 && paidSum === lineAmountOf(row, isDebit);
                    // Transporter freight slips — allocated per-slip in the same
                    // table/behaviour as the vendor bills (summariseFreight).
                    const freightSummary = summariseFreight(row, d, isDebit);
                    // Search box over the slips (advice no / covered bill / LR /
                    // amount). Filtering only hides rows from the TABLE — the
                    // allocation + totals in freightSummary stay over the full set,
                    // so a typed amount on a now-hidden slip is never lost.
                    const freightQuery = d.freightSearch || '';
                    const freightVisibleDocs = freightQuery
                      ? freightSummary.docs.filter((doc) => freightSearchMatch(doc, freightQuery))
                      : freightSummary.docs;
                    return (
                      <Fragment key={row.id}>
                      <tr className={`border-b border-slate-100 align-top ${row.duplicate_of ? 'bg-red-50/60' : ''}`}>
                        <td className="px-3 py-2 whitespace-nowrap overflow-hidden text-slate-500">{formatDate(row.txn_date)}</td>
                        <td className="px-3 py-2">
                          {row.beneficiary && <span className="block font-semibold text-slate-800 text-[13px]">To: {row.beneficiary}</span>}
                          <span className="block break-words leading-snug text-[11px] text-slate-500" title={row.narration}>{row.narration || '—'}</span>
                          {row.reference_no && <span className="text-[11px] text-slate-400">{row.reference_no}</span>}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium ${isDebit ? 'text-red-600' : 'text-green-600'}`}>
                          {formatCurrency(num(isDebit ? row.debit : row.credit))}
                        </td>
                        <td className="px-3 py-2">
                          <CustomSelect
                            name={`party-${row.id}`}
                            value={
                              d.transferMode ? (d.toAccount ? OWNACCT_PREFIX + d.toAccount : '')
                              : d.expenseMode ? (d.transporter ? TRANSPORTER_PREFIX + d.transporter : EXPENSE_SENTINEL)
                              : d.ledgerMode ? (d.ledgerId ? LEDGER_PREFIX + d.ledgerId : LEDGER_SENTINEL)
                              : (d.party || '')
                            }
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === EXPENSE_SENTINEL) enterExpenseMode(row);
                              else if (v === LEDGER_SENTINEL) enterLedgerMode(row);
                              else if (v.startsWith(TRANSPORTER_PREFIX)) {
                                const id = v.slice(TRANSPORTER_PREFIX.length);
                                selectExistingTransporter(row, id, transporters.find((t) => String(t.value) === id)?.label || '');
                              } else if (v.startsWith(LEDGER_PREFIX)) {
                                const id = v.slice(LEDGER_PREFIX.length);
                                selectExistingLedger(row, id, allLedgers.find((l) => String(l.value) === id)?.label || '');
                              } else if (v.startsWith(OWNACCT_PREFIX)) {
                                const id = v.slice(OWNACCT_PREFIX.length);
                                enterTransferMode(row, id, ownAccountOptions.find((o) => String(o.value) === id)?.label || '');
                              } else pickParty(row.id, v, undefined, lineAmountOf(row, isDebit));
                            }}
                            placeholder="Select…"
                            className="w-full"
                          >
                            {/* Not every payment is to a trade Vendor. Both
                                non-vendor destinations sit IN the same
                                picker as the vendor list, rather than a
                                separate control elsewhere on the row — one
                                decision (what IS this?), not "pick a vendor,
                                then go hunting for the right toggle if it
                                isn't one". A genuine P&L cost routes to
                                Expense; a loan/advance/suspense movement
                                (see finance.Ledger) routes to a Ledger
                                instead — forcing the latter through Expense
                                would misstate the P&L for exactly the
                                transactions most likely to need this. */}
                            <option value={EXPENSE_SENTINEL}>🧾 Not a vendor — record as an expense</option>
                            <option value={LEDGER_SENTINEL}>📒 Not a vendor — record as a new ledger (loan/advance/other)</option>
                            {allLedgers.map((l) => (
                              <option key={`ledger-${l.value}`} value={LEDGER_PREFIX + l.value}>📒 {l.label}</option>
                            ))}
                            {/* Freight — a lorry/logistics payment, not a trade
                                vendor. Listed directly like Ledgers above so a
                                known transporter is a one-click pick; a rare,
                                one-off transporter still goes through "record
                                as an expense" with a free-text "Paid to" name
                                instead (see ExpenseDetailRow). */}
                            {isDebit && transporters.map((t) => (
                              <option key={`transporter-${t.value}`} value={TRANSPORTER_PREFIX + t.value}>🚛 {t.label}</option>
                            ))}
                            {/* Transfer to one of OUR OWN accounts — a sweep
                                from this account into a dedicated Expense /
                                Creditor / Freight / Maize account, identified
                                by alias + account number. Not a vendor payment
                                and not a P&L expense; records WHERE the money
                                went (Tally holds the contra) instead of the
                                bare "mark as internal transfer". */}
                            {ownAccountOptions.map((o) => (
                              <option key={`ownacct-${o.value}`} value={OWNACCT_PREFIX + o.value}>🏦 Transfer to {o.label}</option>
                            ))}
                            {allParties.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                          </CustomSelect>
                          {/* Three confidence tiers, worded without naming which
                              backend system supplied the match (an
                              implementation detail, not something an operator
                              needs to know): 'confirmed' found this exact
                              payment/receipt already recorded elsewhere in the
                              books (reference/date/amount match); 'bill_match'
                              found exactly one OPEN bill/invoice whose
                              outstanding balance equals this line's amount — a
                              real inference from your own records, not a
                              recorded fact, so it's worded and colored between
                              the other two; 'guess' only recognised the
                              party's name inside the narration text — least
                              certain, worth a second look. Either way it's
                              just a pre-fill, not locked. */}
                          {row.suggested_party_id && d.party === row.suggested_party_id && (
                            row.suggested_party_source === 'confirmed' ? (
                              <span className="block mt-0.5 text-[10px] text-emerald-600">auto-matched</span>
                            ) : row.suggested_party_source === 'bill_match' ? (
                              <span className="block mt-0.5 text-[10px] text-sky-600">matches an open bill — verify</span>
                            ) : (
                              <span className="block mt-0.5 text-[10px] text-amber-600">guessed — please verify</span>
                            )
                          )}
                          {/* The narration names a real payee, but nothing in
                              the Vendor master matches it at all. Offered as
                              a SEPARATE opt-in from the picker above (rather
                              than always shown) since most of the time
                              "not a vendor" above is the right call for a
                              one-off — this is for the case where the name
                              is a genuine, recurring supplier worth
                              onboarding as a real Vendor record. */}
                          {!d.party && !d.expenseMode && !d.ledgerMode && !d.transferMode && row.unmatched_name_guess && (
                            <label className="flex items-center gap-1 mt-0.5 text-[10px] font-medium text-blue-600 cursor-pointer">
                              <input type="checkbox" checked={!!d.createVendorMode}
                                onChange={() => toggleCreateVendor(row)} />
                              "{row.unmatched_name_guess}" isn't a one-off — create a Vendor for it
                            </label>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {/* One control for both the one-bill and the
                              several-bills case: this collapsed summary
                              opens the tick-list below. The dropdown it
                              replaced could only ever name ONE bill, so
                              splitting needed a second, separate mode —
                              and neither view showed what a payment would
                              leave still owing. */}
                          {!d.expenseMode && !d.ledgerMode && !d.transferMode && (
                            <button
                              type="button"
                              disabled={!d.party || d.loading}
                              onClick={() => toggleBillsOpen(row.id)}
                              aria-expanded={!!d.billsOpen}
                              className={`w-full flex items-center gap-1.5 text-left px-2 py-1.5 rounded-lg border text-[11px] transition
                                disabled:opacity-50 disabled:cursor-not-allowed
                                ${allocSummary.balanced
                                  ? 'border-slate-300 bg-white hover:border-slate-400 text-slate-700'
                                  : 'border-amber-300 bg-amber-50 text-amber-800 hover:border-amber-400'}`}
                            >
                              <span className="truncate flex-1">{allocSummary.text}</span>
                              <ChevronDown
                                size={13}
                                className={`shrink-0 text-slate-400 transition-transform ${d.billsOpen ? 'rotate-180' : ''}`}
                              />
                            </button>
                          )}
                          {d.paidMatch && isDebit && !d.expenseMode && !d.ledgerMode && !d.transferMode && (
                            <div className="mt-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5">
                              <div className="text-[10px] text-emerald-800 leading-snug">
                                Matches already-paid bill <strong>{d.paidMatch.vendor_invoice_no || d.paidMatch.bill_no}</strong> ({formatCurrency(num(d.paidMatch.amount_paid))}) — it has no payment recorded on it yet.
                              </div>
                              <button type="button" onClick={() => applyToPaidBill(row, d.paidMatch)}
                                disabled={savingId === row.id || (row.duplicate_of && !ackedDupes.has(row.id))}
                                className="mt-1 h-7 px-2.5 rounded-md bg-emerald-600 text-white text-[11px] font-medium hover:bg-emerald-700 disabled:opacity-50">
                                {savingId === row.id ? 'Applying…' : 'Apply payment to this bill'}
                              </button>
                            </div>
                          )}
                          {/* The multi-bill "apply to already-paid bills" picker
                              renders as a FULL-WIDTH row below (the narrow Vendor
                              cell crushed the bill no/date/amount) — see further
                              down, keyed off the same d.paidBills. */}
                          {/* Turning expense/ledger mode ON happens from the
                              Vendor picker itself (the "Not a vendor" options)
                              — this is only for backing back out of either. */}
                          {isDebit && (d.expenseMode || d.ledgerMode || d.transferMode) && (
                            <button type="button" onClick={() => setDraft((s) => ({ ...s, [row.id]: { ...s[row.id], expenseMode: false, ledgerMode: false, transferMode: false, toAccount: undefined } }))}
                              className="block mt-1 text-[10px] font-medium text-slate-500 hover:underline">
                              Use a vendor + bill instead
                            </button>
                          )}
                          {!d.expenseMode && !d.ledgerMode && !d.transferMode && !d.billsOpen && !allocSummary.balanced && (
                            <span className="flex items-center gap-1.5 mt-1 text-[10px] font-medium text-amber-700">
                              {allocSummary.gap}
                              {allocSummary.canFill && (
                                <button type="button" onClick={() => fillRemaining(row)}
                                  className="text-blue-600 hover:underline font-medium">
                                  Fill
                                </button>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => (d.ledgerMode ? recordLedgerEntry(row) : d.expenseMode ? recordExpense(row) : d.transferMode ? recordTransfer(row) : record(row))}
                            disabled={savingId === row.id
                              || (row.duplicate_of && !ackedDupes.has(row.id))
                              // Only the bill-allocation path can be out of
                              // balance; expense/ledger/transfer rows don't use it.
                              || (!d.expenseMode && !d.ledgerMode && !d.transferMode && !allocSummary.recordable)}
                            title={allocSummary.gap || undefined}
                            className={`h-8 px-2.5 rounded-lg text-white text-[11px] font-medium disabled:opacity-50 whitespace-nowrap ${row.duplicate_of ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
                            {savingId === row.id ? 'Saving…' : d.ledgerMode ? 'Record ledger entry' : d.expenseMode ? 'Record expense' : d.transferMode ? 'Record transfer' : row.duplicate_of ? 'Record anyway' : 'Record'}
                          </button>
                        </td>
                      </tr>
                      {/* Multi-bill "apply to already-paid (no-voucher) bills" —
                          a FULL-WIDTH row so each bill's no/date/amount reads on
                          one line (the narrow Vendor cell crushed it). */}
                      {!d.paidMatch && (d.paidBills || []).length > 0 && isDebit
                        && !d.expenseMode && !d.ledgerMode && !d.transferMode && (
                        <tr className="bg-emerald-50/40 border-b border-slate-100">
                          <td colSpan={6} className="px-3 pb-2 -mt-1">
                            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-1.5">
                                <span className="text-[11px] text-emerald-800 leading-snug">
                                  {d.paidAuto && paidExact ? (
                                    <>✓ <strong>Auto-matched {pickedPaid.length} already-paid bill(s)</strong> to this {formatCurrency(lineAmountOf(row, isDebit))} (no payment was recorded on them). Review &amp; apply — or adjust the ticks below.</>
                                  ) : (
                                    <><strong>{(d.paidBills || []).length} already-paid bill(s)</strong> with no payment recorded yet — tick the ones this {formatCurrency(lineAmountOf(row, isDebit))} covers.</>
                                  )}
                                </span>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className={`text-[11px] font-medium tabular-nums ${paidExact ? 'text-emerald-700' : 'text-amber-700'}`}>
                                    Ticked {formatCurrency(paidSum)} / {formatCurrency(lineAmountOf(row, isDebit))}{paidExact ? ' ✓' : ''}
                                  </span>
                                  <button type="button"
                                    onClick={() => applyToPaidBills(row, pickedPaid.map((b) => b.id))}
                                    disabled={!paidExact || savingId === row.id || (row.duplicate_of && !ackedDupes.has(row.id))}
                                    className="h-7 px-3 rounded-md bg-emerald-600 text-white text-[11px] font-medium hover:bg-emerald-700 disabled:opacity-50">
                                    {savingId === row.id ? 'Applying…' : (pickedPaid.length ? `Apply to ${pickedPaid.length} bill${pickedPaid.length === 1 ? '' : 's'}` : 'Apply')}
                                  </button>
                                </div>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-0.5 max-h-52 overflow-auto">
                                {(d.paidBills || []).map((b) => (
                                  <label key={b.id} className="flex items-center gap-2 text-[11px] whitespace-nowrap cursor-pointer py-0.5 rounded hover:bg-emerald-100/60 px-1">
                                    <input type="checkbox" className="shrink-0" checked={!!paidPick[b.id]} onChange={() => togglePaidBill(row, b.id)} />
                                    <span className="font-medium text-slate-800">{b.vendor_invoice_no || b.bill_no}</span>
                                    <span className="text-slate-400">{formatDate(b.bill_date)}</span>
                                    <span className="ml-auto tabular-nums font-medium text-slate-700">{formatCurrency(num(b.amount_paid))}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      {/* Transporter freight slips — a freight payment ties to the
                          specific inbound freight advice(s) it settled (a real
                          freight-payment record), instead of only a generic
                          expense. Shown when a transporter with outstanding slips
                          is selected; the expense form below stays as a fallback. */}
                      {d.expenseMode && d.transporter && (d.freightSlips || []).length > 0 && isDebit && (
                        <>
                          <tr className="bg-sky-50/40 border-b border-slate-100">
                            <td colSpan={6} className="px-3 pt-2 pb-1 -mt-1">
                              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                <span className="text-[11px] text-sky-800 leading-snug">
                                  🚛 <strong>{(d.freightSlips || []).length} outstanding {row.freight_direction === 'OUTWARD' ? 'outward ' : ''}freight slip(s)</strong> for this transporter — allocate this {formatCurrency(lineAmountOf(row, isDebit))} across them (partial is fine; the leftover goes on account).
                                </span>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className={`text-[11px] font-medium tabular-nums ${freightSummary.balanced && freightSummary.picked.length ? 'text-sky-700' : 'text-amber-700'}`}>
                                    Allocated {formatCurrency(freightSummary.total)} / {formatCurrency(lineAmountOf(row, isDebit))}{freightSummary.balanced && freightSummary.picked.length ? ' ✓' : ''}
                                  </span>
                                  <button type="button"
                                    onClick={() => applyToFreight(row, freightSummary.alloc)}
                                    disabled={!freightSummary.recordable || savingId === row.id}
                                    className="h-7 px-3 rounded-md bg-sky-600 text-white text-[11px] font-medium hover:bg-sky-700 disabled:opacity-50">
                                    {savingId === row.id ? 'Applying…' : (freightSummary.picked.length ? `Apply to ${freightSummary.picked.length} slip${freightSummary.picked.length === 1 ? '' : 's'}` : 'Apply')}
                                  </button>
                                </div>
                              </div>
                              {/* Search the slips — by advice no, covered bill no,
                                  LR / lorry, or amount. Shown once there are enough
                                  to be worth filtering. */}
                              {(d.freightSlips || []).length > 3 && (
                                <div className="mt-1.5 flex items-center gap-2">
                                  <input
                                    type="text"
                                    value={freightQuery}
                                    onChange={(e) => setDraft((s) => ({ ...s, [row.id]: { ...(s[row.id] || {}), freightSearch: e.target.value } }))}
                                    placeholder="Search slip — advice no, bill no, LR / vehicle, amount…"
                                    className="flex-1 h-7 px-2 rounded-md border border-sky-200 bg-white text-[11px] focus:ring-1 focus:ring-sky-400"
                                  />
                                  {freightQuery && (
                                    <span className="text-[10px] text-sky-700 tabular-nums shrink-0">
                                      {freightVisibleDocs.length}/{freightSummary.docs.length}
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                          <BillAllocationRow
                            summary={freightSummary}
                            docs={freightVisibleDocs}
                            onToggle={(slipId) => toggleFreightAlloc(row, slipId)}
                            onAmount={(slipId, val) => setFreightAmount(row, slipId, val)}
                            onFill={() => fillFreightRemaining(row)}
                            isDebit={isDebit}
                          />
                        </>
                      )}
                      {row.duplicate_of && (
                        <tr className="bg-red-50/60 border-b border-slate-100">
                          <td colSpan={6} className="px-3 pb-1.5 -mt-1">
                            <div
                              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-red-700 bg-red-100/80 border border-red-200 rounded-lg px-2 py-1"
                              title={`${row.duplicate_of.party_name || 'A payment'} already has ${row.duplicate_of.voucher_no} for ${formatCurrency(row.duplicate_of.amount)}, matching this line's date and amount — possibly the same transaction from a different upload of this statement.`}
                            >
                              <span className="truncate">
                                ⚠ Duplicate of <strong>{row.duplicate_of.voucher_no}</strong> ({formatCurrency(row.duplicate_of.amount)})
                              </span>
                              <label className="flex items-center gap-1 font-medium cursor-pointer shrink-0 ml-auto">
                                <input
                                  type="checkbox"
                                  checked={ackedDupes.has(row.id)}
                                  onChange={(e) => setAckedDupes((s) => {
                                    const next = new Set(s);
                                    if (e.target.checked) next.add(row.id); else next.delete(row.id);
                                    return next;
                                  })}
                                />
                                Confirm this is a separate payment, not a duplicate
                              </label>
                            </div>
                          </td>
                        </tr>
                      )}
                      {row.internal_transfer_guess && !row.duplicate_of && (
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <td colSpan={6} className="px-3 pb-1.5 -mt-1">
                            <div
                              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-600 bg-slate-100 border border-slate-200 rounded-lg px-2 py-1"
                              title="Bank narrations naming your own account nicknames (Creditor/Freight/Maize/CC) mean money moved between your own accounts, not to a vendor — Tally records this as a Contra voucher, so there's nothing new to enter here."
                            >
                              <span className="truncate">
                                🔁 Looks like a transfer to one of your own accounts (<strong>{row.internal_transfer_guess}</strong>), not a vendor payment
                              </span>
                              <button type="button" onClick={() => markInternal(row)} disabled={savingId === row.id}
                                className="ml-auto shrink-0 h-6 px-2 rounded-md bg-slate-600 text-white text-[10px] font-medium hover:bg-slate-700 disabled:opacity-50">
                                {savingId === row.id ? 'Saving…' : 'Mark as internal transfer'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {/* A repeat narration for a counterparty already
                          classified as "not a vendor" in an earlier
                          statement — same one-click treatment as internal
                          transfer above, rather than silently pre-filling
                          the dropdown and leaving the operator to notice and
                          go find the Record button on their own. Only shown
                          while still ON the auto-matched selection — if they
                          picked something else from the dropdown this banner
                          would be stale, misleading advice. */}
                      {row.suggested_ledger_id && !row.duplicate_of && d.ledgerId === row.suggested_ledger_id && (
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <td colSpan={6} className="px-3 pb-1.5 -mt-1">
                            <div
                              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-600 bg-slate-100 border border-slate-200 rounded-lg px-2 py-1"
                              title="This name was already recorded as a Ledger (loan/advance/suspense) on an earlier statement — not a vendor."
                            >
                              <span className="truncate">
                                📒 Matches your existing ledger <strong>{row.suggested_ledger_name}</strong> — not a vendor
                              </span>
                              <button type="button" onClick={() => recordLedgerEntry(row)} disabled={savingId === row.id}
                                className="ml-auto shrink-0 h-6 px-2 rounded-md bg-slate-600 text-white text-[10px] font-medium hover:bg-slate-700 disabled:opacity-50">
                                {savingId === row.id ? 'Saving…' : 'Record ledger entry'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {d.createVendorMode && (
                        <CreateVendorRow
                          row={row}
                          draft={d}
                          companies={companies}
                          savingId={savingId}
                          onChange={(patch) => setDraft((s) => ({ ...s, [row.id]: { ...s[row.id], ...patch } }))}
                          onCreate={() => createVendorFromRow(row)}
                        />
                      )}
                      {d.expenseMode && (
                        <ExpenseDetailRow
                          row={row}
                          draft={d}
                          categories={expenseCategories}
                          transporters={isDebit ? transporters : []}
                          onChange={(patch) => setDraft((s) => ({ ...s, [row.id]: { ...s[row.id], ...patch } }))}
                        />
                      )}
                      {/* Only shown creating a NEW ledger — picking an
                          EXISTING one already has everything it needs. */}
                      {d.ledgerMode && !d.ledgerId && (
                        <LedgerDetailRow
                          row={row}
                          draft={d}
                          onChange={(patch) => setDraft((s) => ({ ...s, [row.id]: { ...s[row.id], ...patch } }))}
                        />
                      )}
                      {d.billsOpen && !d.expenseMode && !d.ledgerMode && !d.transferMode && (
                        <BillAllocationRow
                          summary={allocSummary}
                          docs={d.docs || []}
                          isDebit={isDebit}
                          onToggle={(billId) => toggleBill(row, billId)}
                          onAmount={(billId, val) => setAllocAmount(row, billId, val)}
                          onFill={() => fillRemaining(row)}
                        />
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        <div className="border-t border-slate-200 px-4 py-3 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose}
            className="h-9 px-3 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50">
            {step === 'rows' ? 'Done' : 'Cancel'}
          </button>
          {step === 'pick' && (
            <button type="button" onClick={upload} disabled={busy || !account || !file}
              className="h-9 px-3 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {busy ? 'Reading the statement…' : 'Read statement'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// The open-document tick-list shown under a row. This is the ONLY bill
// picker — the dropdown it replaced could name one bill and nothing else,
// so a lump sum settling several needed a whole second mode to express,
// and neither view ever showed what a payment would leave still owing.
//
// Ticking is the whole interaction in the common case: distributeSplit
// fills the amounts oldest-first, so one tick takes the entire line and
// three fill up in date order. The Amount column stays editable for the
// part-payment case. Credit (receivables) allows one tick at a time —
// see toggleBill.
//
// The total must match the line exactly before Record will submit it;
// create-split-entry enforces the same server-side, so this is the
// earlier, friendlier half of that check, not the only one.
function BillAllocationRow({ summary, docs, onToggle, onAmount, onFill, isDebit }) {
  const { alloc, amount, total, balanced, canFill } = summary;
  const allocated = total > 0;
  return (
    <tr className="bg-slate-50/60 border-b border-slate-100">
      <td colSpan={6} className="px-3 py-2">
        <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500 sticky top-0">
                <tr>
                  <th className="w-8 px-2.5 py-1.5" />
                  <th className="text-left px-2.5 py-1.5 font-medium">{isDebit ? 'Bill' : 'Invoice'}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium">Date</th>
                  <th className="text-right px-2.5 py-1.5 font-medium">Balance Due</th>
                  <th className="text-right px-2.5 py-1.5 font-medium w-32">Amount</th>
                  <th className="text-right px-2.5 py-1.5 font-medium">Balance After</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => {
                  const ticked = num(alloc[doc.id]) > 0;
                  const after = round2(doc.balance - num(alloc[doc.id]));
                  return (
                    <tr key={doc.id} className={`border-t border-slate-100 ${ticked ? 'bg-blue-50/40' : ''}`}>
                      <td className="px-2.5 py-1.5">
                        <input
                          type="checkbox"
                          checked={ticked}
                          onChange={() => onToggle(doc.id)}
                          aria-label={`Pay ${doc.label}`}
                          className="cursor-pointer accent-blue-600"
                        />
                      </td>
                      <td className="px-2.5 py-1.5 font-medium text-slate-700">
                        {doc.label}
                        {/* A partly paid bill needs its full value spelled
                            out, or "Due X" alone reads as the whole bill. */}
                        {doc.total > doc.balance && (
                          <span className="ml-1 text-[10px] font-normal text-slate-400">
                            of {formatCurrency(doc.total)}
                          </span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 text-slate-500 whitespace-nowrap">{formatDate(doc.date)}</td>
                      <td className="px-2.5 py-1.5 text-right text-slate-600 tabular-nums">{formatCurrency(doc.balance)}</td>
                      <td className="px-2.5 py-1.5">
                        <input
                          type="number" step="0.01" min="0" max={doc.balance}
                          value={alloc[doc.id] ?? ''}
                          onChange={(e) => onAmount(doc.id, e.target.value)}
                          disabled={!ticked}
                          className="w-full border border-slate-300 rounded px-1.5 py-1 text-right text-xs tabular-nums
                                     focus:ring-1 focus:ring-primary-500 disabled:bg-slate-50 disabled:text-slate-300"
                          placeholder="0.00"
                        />
                      </td>
                      <td className={`px-2.5 py-1.5 text-right tabular-nums font-medium
                        ${!ticked ? 'text-slate-400' : after === 0 ? 'text-emerald-600' : 'text-slate-700'}`}>
                        {formatCurrency(after)}
                        {ticked && after === 0 && <span className="ml-1 text-[10px] font-normal">settled</span>}
                      </td>
                    </tr>
                  );
                })}
                {docs.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2.5 py-3 text-center text-slate-400">
                      No open {isDebit ? 'bills' : 'invoices'} for this {isDebit ? 'vendor' : 'customer'} — record it on account.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className={`flex flex-wrap items-center justify-between gap-x-3 px-2.5 py-1.5 text-[11px] font-medium
            ${!allocated ? 'bg-slate-50 text-slate-500' : balanced ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            <span>
              {allocated
                ? `Allocated ${formatCurrency(total)} of ${formatCurrency(amount)}`
                : `Nothing ticked — records ${formatCurrency(amount)} on account`}
            </span>
            <span className="flex items-center gap-2">
              {allocated && !balanced && <span>{summary.gap}{summary.recordable ? '' : ' — must match exactly to record'}</span>}
              {canFill && (
                <button
                  type="button"
                  onClick={onFill}
                  className="h-6 px-2 rounded-md bg-blue-600 text-white text-[10px] font-medium
                             hover:bg-blue-700 whitespace-nowrap"
                >
                  Fill remaining oldest-first
                </button>
              )}
            </span>
          </div>
        </div>
      </td>
    </tr>
  );
}

// Shown when a row is toggled into "record as an expense instead" mode —
// title + category are the only real inputs; a vendor from the row's own
// picker is used if one is already selected, otherwise a free-text
// "Paid to" name is offered so a payee that never got a Vendor record
// (or a pure statutory/bank fee with no payee at all) isn't blocked.
function ExpenseDetailRow({ row, draft, categories, transporters = [], onChange }) {
  return (
    <tr className="bg-slate-50/60 border-b border-slate-100">
      <td colSpan={6} className="px-3 py-2">
        <div className="border border-slate-200 rounded-lg bg-white p-2.5 flex flex-wrap gap-2.5 items-end">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[10px] font-medium text-slate-500 mb-1">Title</label>
            <input
              type="text" value={draft.expenseTitle || ''}
              onChange={(e) => onChange({ expenseTitle: e.target.value })}
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs focus:ring-1 focus:ring-primary-500"
              placeholder="e.g. Stock Audit Charges"
            />
          </div>
          <div className="w-44">
            <label className="block text-[10px] font-medium text-slate-500 mb-1">Category</label>
            <CustomSelect
              name={`expense-cat-${row.id}`}
              value={draft.expenseCategory || ''}
              onChange={(e) => onChange({ expenseCategory: e.target.value })}
              placeholder="Uncategorised"
              className="w-full"
            >
              {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
          </div>
          {/* Freight only — a known transporter picked here structurally
              links the expense to the Transporter master (same as picking
              one directly from the main Vendor picker above); leave blank
              and just fill "Paid to" for a rare, one-off transporter that
              isn't worth formalising into the master — e.g. the shared
              "Freight Outward Charges - RCM" bucket, where the Title stays
              the same across many entries and "Paid to" carries the
              specific payee (ARK Transport, VRL, ...) each time. */}
          {transporters.length > 0 && (
            <div className="w-44">
              <label className="block text-[10px] font-medium text-slate-500 mb-1">Transporter (optional)</label>
              <CustomSelect
                name={`expense-transporter-${row.id}`}
                value={draft.transporter || ''}
                onChange={(e) => onChange({ transporter: e.target.value })}
                placeholder="Not a known transporter"
                className="w-full"
              >
                {transporters.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </CustomSelect>
            </div>
          )}
          {!draft.party && (
            <div className="w-44">
              <label className="block text-[10px] font-medium text-slate-500 mb-1">Paid to (optional)</label>
              <input
                type="text" value={draft.expensePartyName || ''}
                onChange={(e) => onChange({ expensePartyName: e.target.value })}
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs focus:ring-1 focus:ring-primary-500"
                placeholder="e.g. ABC Auditors"
              />
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

// Shown when the "not in Vendor master" checkbox is ticked — creates a
// vendor with just the two fields the API actually requires (name,
// company); GSTIN/PAN/address are only enforced by the full New Vendor
// form's UI, not the backend, and can be filled in properly later from the
// Vendor master if this one turns out to be GST-registered.
function CreateVendorRow({ row, draft, companies, savingId, onChange, onCreate }) {
  return (
    <tr className="bg-blue-50/40 border-b border-slate-100">
      <td colSpan={6} className="px-3 py-2">
        <div className="border border-slate-200 rounded-lg bg-white p-2.5 flex flex-wrap gap-2.5 items-end">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[10px] font-medium text-slate-500 mb-1">Vendor name</label>
            <input
              type="text" value={draft.newVendorName || ''}
              onChange={(e) => onChange({ newVendorName: e.target.value })}
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs focus:ring-1 focus:ring-primary-500"
              placeholder="e.g. Ramkumar"
            />
          </div>
          <div className="w-44">
            <label className="block text-[10px] font-medium text-slate-500 mb-1">Company</label>
            <CustomSelect
              name={`new-vendor-company-${row.id}`}
              value={draft.newVendorCompany || ''}
              onChange={(e) => onChange({ newVendorCompany: e.target.value })}
              placeholder="Select…"
              className="w-full"
            >
              {companies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
          </div>
          <button type="button" onClick={onCreate} disabled={savingId === row.id}
            className="h-8 px-3 rounded-lg bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap">
            {savingId === row.id ? 'Creating…' : 'Create vendor'}
          </button>
        </div>
      </td>
    </tr>
  );
}

// Mirrors finance.Ledger.LEDGER_TYPE_CHOICES on the backend.
const LEDGER_TYPE_OPTIONS = [
  { value: 'LOAN_GIVEN', label: 'Loan Given' },
  { value: 'LOAN_TAKEN', label: 'Loan Taken' },
  { value: 'ADVANCE', label: 'Advance' },
  { value: 'SUSPENSE', label: 'Suspense' },
  { value: 'OTHER', label: 'Other' },
];

// Shown when a row is toggled into "record as a new ledger entry" mode —
// for money that's neither a trade payable nor a P&L cost (a loan, an
// advance, a suspense movement). Just a name + a rough classification;
// deliberately not vendor-shaped (no GSTIN, no address) since that's the
// whole point of this path existing.
function LedgerDetailRow({ row, draft, onChange }) {
  return (
    <tr className="bg-slate-50/60 border-b border-slate-100">
      <td colSpan={6} className="px-3 py-2">
        <div className="border border-slate-200 rounded-lg bg-white p-2.5 flex flex-wrap gap-2.5 items-end">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[10px] font-medium text-slate-500 mb-1">Ledger name</label>
            <input
              type="text" value={draft.newLedgerName || ''}
              onChange={(e) => onChange({ newLedgerName: e.target.value })}
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs focus:ring-1 focus:ring-primary-500"
              placeholder="e.g. Ramkumar"
            />
          </div>
          <div className="w-44">
            <label className="block text-[10px] font-medium text-slate-500 mb-1">Type</label>
            <CustomSelect
              name={`ledger-type-${row.id}`}
              value={draft.newLedgerType || 'OTHER'}
              onChange={(e) => onChange({ newLedgerType: e.target.value })}
              className="w-full"
            >
              {LEDGER_TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </CustomSelect>
          </div>
        </div>
      </td>
    </tr>
  );
}
