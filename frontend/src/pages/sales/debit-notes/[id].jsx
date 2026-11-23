/**
 * Sales -> Debit & Credit Notes -> one note.
 *
 * Until now there was no detail page for a note at all: clicking CN-0014 on a
 * dashboard drill-down threw the note away and dropped you on the whole notes
 * list. This shows the exact record that was clicked.
 *
 * Every field here comes from DebitNoteSerializer (backend/apps/sales/
 * serializers.py) -- nothing is invented and nothing is computed. The note has
 * no line items in the API, so none are shown; `settled_amount` is the only
 * derived figure and it is the serializer's own, read as given.
 *
 * Back honours `location.state.backTo`, which callers set to the full URL they
 * came from, query string included -- so returning lands on the same filtered
 * list, not a reset one.
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { ArrowLeft, FileText, Loader2, AlertCircle } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

function Row({ label, value, mono = false, wide = false }) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">{label}</dt>
      <dd className={`mt-0.5 text-sm text-slate-800 break-words ${mono ? 'tabular-nums' : ''}`}>{value}</dd>
    </div>
  );
}

export default function DebitNoteDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // The caller passes the full URL it came from, including its query string,
  // so Back restores that list exactly as it was left.
  const backTo = location.state?.backTo || '/sales/debit-notes';

  // A real browser Back, not a fresh navigation. `navigate(backTo)` PUSHED a
  // new entry, so leaving this note stacked a second copy of the drill-down on
  // top of it -- and pressing Back again came straight back to the note
  // instead of continuing out to the dashboard. `navigate(-1)` adds nothing,
  // so the trail stays honest. Same pattern the invoice, DC and order pages
  // already use. `backTo` is the fallback when there is no history to go back
  // to: a pasted link, or a new tab.
  const goBack = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate(backTo));

  const [note, setNote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true); setErr(null);
    apiClient.get(`/api/sales/debit-notes/${id}/`)
      .then(r => { if (!cancel) setNote(r.data); })
      .catch(e => { if (!cancel) setErr(e.response?.data?.detail || 'Could not load this note.'); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [id]);

  const isCredit = (note?.note_type || '').toUpperCase() === 'CREDIT';
  const title = note
    ? `${isCredit ? 'Credit' : 'Debit'} Note ${note.note_no || ''}`.trim()
    : 'Note';

  // `settled_amount` only knows about CASH — receipts the customer paid this
  // note off with. That is the whole story for one case and misleading for the
  // rest, so the tiles say what is actually known instead of printing a red
  // "Balance" under everything:
  //   CREDIT note          — money we gave back. It can never have a receipt,
  //                          so it always read 100% open in red. No balance.
  //   placement 'agst'     — Tally applied it to the bills it names: used up.
  //   placement 'new'      — a bill of its own, so an unpaid remainder is real.
  //   placement 'onacc'/'' — on no bill / not known; don't claim it is open.
  const amount = Number(note?.amount || 0);
  const settled = Number(note?.settled_amount || 0);
  const placement = note?.placement || '';
  const isOwnBill = !isCredit && placement === 'new';
  const balance = amount - settled;
  const placedLabel = {
    agst: 'Applied to bills',
    onacc: 'On account',
  }[placement] || 'Not on a bill';
  const tiles = isCredit
    ? [['Amount', formatCurrency(amount), 'text-slate-900'],
       ['Reduces what the customer owes', '—', 'text-slate-400']]
    : isOwnBill
      ? [['Amount', formatCurrency(amount), 'text-slate-900'],
         ['Received', formatCurrency(settled), 'text-emerald-700'],
         ['Still owed', formatCurrency(balance), balance > 0 ? 'text-rose-600' : 'text-slate-500']]
      : [['Amount', formatCurrency(amount), 'text-slate-900'],
         ['Received', formatCurrency(settled), 'text-emerald-700'],
         ['Where it sits', placedLabel, 'text-slate-600 text-base']];

  return (
    <MainLayout>
      <div className="px-3 sm:px-0 pb-10">
        <div className="flex items-center gap-2 mb-4">
          <button type="button" onClick={goBack}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
            title="Back to where you came from">
            <ArrowLeft size={16} /> Back
          </button>
        </div>

        {loading && (
          <div className="bg-white rounded-xl border border-slate-200 py-20 text-center">
            <Loader2 size={22} className="animate-spin mx-auto text-slate-400" />
            <p className="mt-2 text-sm text-slate-400">Loading note…</p>
          </div>
        )}

        {!loading && err && (
          <div className="bg-white rounded-xl border border-slate-200 py-16 text-center">
            <AlertCircle size={22} className="mx-auto text-rose-500" />
            <p className="mt-2 text-sm text-slate-600">{err}</p>
            <button type="button" onClick={goBack}
              className="mt-4 text-sm text-indigo-600 hover:underline">Go back</button>
          </div>
        )}

        {!loading && !err && note && (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <div className="min-w-0 flex items-start gap-3">
                <span className={`shrink-0 mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-lg ${isCredit ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                  <FileText size={18} />
                </span>
                <div className="min-w-0">
                  <h1 className="text-xl sm:text-2xl font-bold text-slate-900 break-words">{title}</h1>
                  <p className="text-sm text-slate-500 break-words">
                    {dash(note.party_name || note.customer_name || note.vendor_name)}
                    {note.note_date ? ` · ${formatDate(note.note_date)}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${isCredit ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                  {dash(note.note_type_display || note.note_type)}
                </span>
                {note.side_display && (
                  <span className="px-2.5 py-1 rounded-lg text-xs font-semibold border bg-slate-50 text-slate-600 border-slate-200">
                    {note.side_display}
                  </span>
                )}
                {note.kind && (
                  <span className="px-2.5 py-1 rounded-lg text-xs font-semibold border bg-indigo-50 text-indigo-700 border-indigo-200 capitalize">
                    {note.kind}
                  </span>
                )}
              </div>
            </div>

            {/* What is known about this note — see the `tiles` comment above.
                A red "still owed" is printed only where one is real. */}
            <div className={`grid grid-cols-1 gap-2.5 mb-4 ${tiles.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
              {tiles.map(([l, v, cls]) => (
                <div key={l} className="bg-white rounded-xl border border-slate-200 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">{l}</p>
                  <p className={`mt-0.5 text-lg font-bold tabular-nums ${cls}`}>{v}</p>
                </div>
              ))}
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-slate-700 mb-3">Details</h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3.5">
                <Row label="Note No" value={dash(note.note_no)} mono />
                <Row label="Date" value={note.note_date ? formatDate(note.note_date) : '—'} mono />
                <Row label="Party" value={dash(note.party_name || note.customer_name || note.vendor_name)} />
                <Row label="Company" value={dash(note.company_name)} />
                <Row label="Against Ref" mono value={
                  note.reference_link
                    ? <Link to={note.reference_link.path} className="text-indigo-600 hover:underline inline-flex items-center gap-1">{note.reference}<FileText size={12} /></Link>
                    : dash(note.reference)
                } />
                <Row label="Kind" value={<span className="capitalize">{dash(note.kind)}</span>} />
                <Row label="Reason" value={dash(note.reason)} wide />
                {note.narration && <Row label="Narration" value={note.narration} wide />}
              </dl>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 mt-3">
              <h2 className="text-sm font-semibold text-slate-700 mb-3">Record</h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3.5">
                <Row label="Created" value={note.created_at ? formatDate(note.created_at) : '—'} mono />
                <Row label="Last updated" value={note.updated_at ? formatDate(note.updated_at) : '—'} mono />
                {/* Present only on notes that came from Tally. Worth showing:
                    it is how a row here is matched back to its voucher. */}
                {note.tally_guid && <Row label="Tally voucher" value={note.tally_guid} mono wide />}
              </dl>
            </div>
          </>
        )}
      </div>
    </MainLayout>
  );
}
