import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowLeft, ChevronDown, ChevronRight, Paperclip, Download,
  Award, FileText, CheckCircle2,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';

/**
 * Quote Response — RFQ detail view.
 *
 * Lists every vendor quote received for a given RFQ:
 *   - vendor name, total amount, currency, lead time, status
 *   - per-vendor line items (expandable row)
 *   - attachments (the original PDF the vendor uploaded)
 *
 * Distinct from the Evaluation page (which compares quotes side-by-side
 * to pick a winner). Reachable from the row-click on /purchase/quotes;
 * the "Evaluate" button on that list still goes to evaluations.
 */
// Show the free-text terms in place of the literal "CUSTOM" code so the
// detail view reads naturally (falls back to the code, then a dash).
const fmtPaymentTerms = (q) =>
  (q.payment_terms === 'CUSTOM' && q.custom_payment_terms)
    ? q.custom_payment_terms
    : (q.payment_terms || '-');

export default function QuoteResponseDetailPage() {
  const { rfqId } = useParams();
  const navigate = useNavigate();
  const { canCreate, canEdit } = usePermissions();
  const { isHidden } = useFieldPermissions('Quote');
  const { isHidden: isLineHidden } = useFieldPermissions('Quote Line');

  const [rfq, setRfq] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [attachmentsByQuote, setAttachmentsByQuote] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        // RFQ header
        const rfqRes = await apiClient.get(`/api/purchase/rfq/${rfqId}/`);
        if (cancelled) return;
        setRfq(rfqRes.data);

        // All quotes for this RFQ
        const qRes = await apiClient.get(`/api/purchase/quotes/?rfq=${rfqId}&page_size=500`);
        const list = qRes.data?.results || qRes.data || [];
        if (cancelled) return;
        setQuotes(list);

        // Attachments per quote (one request per quote — small N, vendors per RFQ < 20)
        const attMap = {};
        await Promise.all(
          list.map((q) =>
            apiClient
              .get(`/api/purchase/attachments/?module=QUOTE&record_id=${q.id}`)
              .then((r) => {
                attMap[q.id] = r.data?.results || r.data || [];
              })
              .catch(() => {
                attMap[q.id] = [];
              }),
          ),
        );
        if (cancelled) return;
        setAttachmentsByQuote(attMap);
      } catch (err) {
        if (err.response?.status !== 404) toast.error('Failed to load RFQ quote details');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [rfqId]);

  const sortedQuotes = useMemo(() => {
    // Show chosen vendor first, then by total ascending, then by created date.
    return [...quotes].sort((a, b) => {
      if (a.chosen_flag && !b.chosen_flag) return -1;
      if (!a.chosen_flag && b.chosen_flag) return 1;
      const ta = parseFloat(a.total_cost) || Infinity;
      const tb = parseFloat(b.total_cost) || Infinity;
      if (ta !== tb) return ta - tb;
      return (a.quote_date || '').localeCompare(b.quote_date || '');
    });
  }, [quotes]);

  const totals = useMemo(() => {
    const amounts = quotes
      .map((q) => parseFloat(q.total_cost))
      .filter((n) => !isNaN(n) && n > 0);
    if (amounts.length === 0) return { lowest: null, highest: null, count: quotes.length };
    return {
      lowest: Math.min(...amounts),
      highest: Math.max(...amounts),
      count: quotes.length,
    };
  }, [quotes]);

  const toggleExpand = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fmtMoney = (val, currency) => {
    if (val == null || val === '') return '-';
    const n = parseFloat(val);
    if (isNaN(n)) return val;
    return `${currency || '₹'}${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </MainLayout>
    );
  }

  if (!rfq) {
    return (
      <MainLayout>
        <div className="text-center py-16 text-slate-500">RFQ not found.</div>
      </MainLayout>
    );
  }

  // Gating for the header actions, matching the quotes-list "Evaluate" gate:
  //  - Evaluate stays disabled until every invited vendor's response is
  //    recorded, so a winner is never picked from a partial set. Primary
  //    measure is the invited-vendor count (rfq.vendors) — same basis as the
  //    list page's invited_count — falling back to quote_count_expected; if
  //    neither is known we don't gate (completeness is unknowable).
  //  - Record Response lets the operator enter the remaining quotes in place,
  //    instead of detouring back to the RFQ each time.
  const expected = (Array.isArray(rfq.vendors) ? rfq.vendors.length : 0) || Number(rfq.quote_count_expected) || 0;
  const recordedCount = quotes.length;
  const allRecorded = expected === 0 || recordedCount >= expected;
  const pendingCount = Math.max(0, expected - recordedCount);

  return (
    <MainLayout>
      <div className="space-y-3">
        {/* Header bar */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <button
              type="button"
              onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/quotes'))}
              className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"
            >
              <ArrowLeft size={14} /> Back to Quote Responses
            </button>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
              Quote Responses — {rfq.rfq_no}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              All vendor quotes received for this RFQ
              {expected > 0 && (
                <span className={`ml-2 font-medium ${allRecorded ? 'text-emerald-600' : 'text-amber-600'}`}>
                  · {recordedCount} of {expected} recorded{allRecorded ? '' : ` — ${pendingCount} pending`}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to={`/purchase/rfq/${rfqId}`}
              className="inline-flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <FileText size={14} /> View RFQ
            </Link>
            {/* Record Response — enter a remaining vendor's quote right here
                instead of going back to the RFQ. Locked once a winner has been
                chosen (mirrors the RFQ detail "Quote Response" button). */}
            {canCreate('Quote') && (
              rfq.is_evaluated ? (
                <button
                  type="button"
                  disabled
                  title="Quotes for this RFQ have already been evaluated — new responses are locked"
                  className="inline-flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg bg-slate-200 text-slate-500 text-xs sm:text-sm font-medium cursor-not-allowed whitespace-nowrap"
                >
                  <FileText size={14} /> Record Response
                </button>
              ) : (
                <Link
                  to={`/purchase/quotes/new?rfq=${rfqId}`}
                  // Prominent (green) while responses are still pending — the
                  // action to take; recedes to a neutral button once every
                  // response is in, so Evaluate reads as the next step.
                  className={`inline-flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium whitespace-nowrap ${
                    allRecorded
                      ? 'border border-slate-300 text-slate-700 hover:bg-slate-50'
                      : 'bg-green-600 text-white hover:bg-green-700'
                  }`}
                >
                  <FileText size={14} /> Record Response
                </Link>
              )
            )}
            {/* Evaluate — enabled only once every expected response is recorded,
                so a winner isn't chosen from an incomplete set. */}
            {canCreate('Quote Evaluation') && (
              allRecorded ? (
                <Link
                  to={`/purchase/evaluations?rfq_id=${rfqId}`}
                  className="inline-flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg bg-primary-600 text-white text-xs sm:text-sm font-medium hover:bg-primary-700 whitespace-nowrap"
                >
                  <Award size={14} /> Evaluate Quotes
                </Link>
              ) : (
                <button
                  type="button"
                  disabled
                  title={`Record all ${expected} expected responses first — ${recordedCount} of ${expected} recorded`}
                  className="inline-flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg bg-slate-200 text-slate-400 text-xs sm:text-sm font-medium cursor-not-allowed whitespace-nowrap"
                >
                  <Award size={14} /> Evaluate Quotes
                </button>
              )
            )}
          </div>
        </div>

        {/* RFQ summary card */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <div className="bg-white rounded-lg border border-slate-200 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">RFQ No</p>
            <p className="text-sm font-semibold text-slate-900 mt-0.5">{rfq.rfq_no || '-'}</p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">RFQ Date</p>
            <p className="text-sm font-semibold text-slate-900 mt-0.5">{rfq.rfq_date || '-'}</p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">Quotes Received</p>
            <p className="text-sm font-semibold text-primary-700 mt-0.5">{totals.count}</p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">Lowest Quote</p>
            <p className="text-sm font-semibold text-emerald-700 mt-0.5">
              {totals.lowest != null ? fmtMoney(totals.lowest, rfq.currency_symbol) : '-'}
            </p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">Highest Quote</p>
            <p className="text-sm font-semibold text-slate-700 mt-0.5">
              {totals.highest != null ? fmtMoney(totals.highest, rfq.currency_symbol) : '-'}
            </p>
          </div>
        </div>

        {/* Vendor quotes table */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          {sortedQuotes.length === 0 ? (
            <div className="text-center py-16 text-slate-400 italic">
              No quotes received yet for this RFQ.
            </div>
          ) : (
            <div className="overflow-x-auto ios-scroll">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="w-10 px-2 py-2"></th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Vendor</th>
                    {!isHidden('quote_date') && <th className="text-left px-3 py-2 font-medium text-slate-600 hidden sm:table-cell">Quote Date</th>}
                    {!isHidden('price_valid_till') && <th className="text-left px-3 py-2 font-medium text-slate-600 hidden sm:table-cell">Valid Till</th>}
                    {!isHidden('lead_time_days') && <th className="text-left px-3 py-2 font-medium text-slate-600 hidden sm:table-cell">Lead Time</th>}
                    {!isHidden('payment_terms') && <th className="text-left px-3 py-2 font-medium text-slate-600 hidden sm:table-cell">Payment Terms</th>}
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Total Amount</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600 hidden sm:table-cell">Attachments</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedQuotes.map((q) => {
                    const isOpen = expanded.has(q.id);
                    const atts = attachmentsByQuote[q.id] || [];
                    const lines = q.line_items || q.quote_lines || [];
                    const isChosen = !!q.chosen_flag;
                    return (
                      <>
                        <tr
                          key={q.id}
                          className={`border-b cursor-pointer transition-colors ${
                            isChosen
                              // The chosen quote gets an unmistakable
                              // visual: solid emerald background, thick
                              // green left border. Driven by
                              // chosen_flag (set on Evaluation submit),
                              // so the highlight survives refresh and
                              // moves automatically when the user
                              // re-evaluates a different vendor.
                              ? 'bg-emerald-50 hover:bg-emerald-100 border-l-4 border-l-emerald-500'
                              : 'hover:bg-slate-50'
                          }`}
                          onClick={() => toggleExpand(q.id)}
                        >
                          <td className="px-2 py-2 text-slate-400">
                            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </td>
                          <td className="px-3 py-2">
                            <div className={`font-medium ${isChosen ? 'text-emerald-900' : 'text-slate-900'}`}>
                              {q.vendor_name || q.vendor_name_text || '-'}
                            </div>
                            {q.quote_no && (
                              <div className="text-xs text-slate-500 mt-0.5">Quote #{q.quote_no}</div>
                            )}
                            {isChosen && (
                              <div className="text-[10px] uppercase tracking-wide text-emerald-700 mt-0.5">
                                Chosen Vendor · Selected in Evaluation
                              </div>
                            )}
                          </td>
                          {!isHidden('quote_date') && <td className="px-3 py-2 text-slate-700 hidden sm:table-cell">{q.quote_date || '-'}</td>}
                          {!isHidden('price_valid_till') && <td className="px-3 py-2 text-slate-700 hidden sm:table-cell">{q.price_valid_till || '-'}</td>}
                          {!isHidden('lead_time_days') && <td className="px-3 py-2 text-slate-700 hidden sm:table-cell">{q.lead_time_days || '-'}</td>}
                          {!isHidden('payment_terms') && <td className="px-3 py-2 text-slate-700 hidden sm:table-cell">{fmtPaymentTerms(q)}</td>}
                          <td className="px-3 py-2 text-right font-semibold text-slate-900">
                            {fmtMoney(q.total_cost, rfq.currency_symbol || q.currency)}
                          </td>
                          <td className="px-3 py-2 hidden sm:table-cell">
                            {atts.length === 0 ? (
                              <span className="text-xs text-slate-400 italic">No file</span>
                            ) : (
                              <div className="flex flex-wrap items-center gap-1.5">
                                {atts.map((a) => (
                                  <a
                                    key={a.id}
                                    href={a.file_url || a.file}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-slate-50 hover:bg-primary-50 hover:border-primary-300 text-xs text-slate-700 hover:text-primary-700 max-w-[180px]"
                                    title={a.file_name || a.file}
                                  >
                                    <Paperclip size={11} className="flex-shrink-0" />
                                    <span className="truncate">{a.file_name || 'file'}</span>
                                  </a>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {/* Chosen rows render a custom badge instead
                                of going through StatusBadge so the
                                "Selected Quote" wording + check icon are
                                consistent with the row highlight, even
                                if StatusBadge doesn't know that status. */}
                            {isChosen ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-600 text-white">
                                <CheckCircle2 size={13} /> Selected Quote
                              </span>
                            ) : (
                              <StatusBadge status={q.status_display || q.status || 'Submitted'} />
                            )}
                          </td>
                        </tr>

                        {isOpen && (
                          <tr key={`${q.id}-detail`} className="border-b bg-slate-50/50">
                            <td colSpan={9} className="px-3 sm:px-4 py-3">
                              {/* Mobile-only quick facts — these columns are
                                  hidden in the table on phones, so surface
                                  them here on expand instead of losing them. */}
                              <div className="sm:hidden grid grid-cols-2 gap-2 mb-3 text-xs">
                                {!isHidden('quote_date') && <div className="bg-white rounded p-2 border border-slate-200"><div className="text-[10px] uppercase text-slate-400 font-medium">Quote Date</div><div className="text-slate-700 mt-0.5">{q.quote_date || '-'}</div></div>}
                                {!isHidden('price_valid_till') && <div className="bg-white rounded p-2 border border-slate-200"><div className="text-[10px] uppercase text-slate-400 font-medium">Valid Till</div><div className="text-slate-700 mt-0.5">{q.price_valid_till || '-'}</div></div>}
                                {!isHidden('lead_time_days') && <div className="bg-white rounded p-2 border border-slate-200"><div className="text-[10px] uppercase text-slate-400 font-medium">Lead Time</div><div className="text-slate-700 mt-0.5">{q.lead_time_days || '-'}</div></div>}
                                {!isHidden('payment_terms') && <div className="bg-white rounded p-2 border border-slate-200"><div className="text-[10px] uppercase text-slate-400 font-medium">Payment Terms</div><div className="text-slate-700 mt-0.5">{fmtPaymentTerms(q)}</div></div>}
                              </div>
                              {/* Vendor address + remarks + currency. Mirrors
                                  the Quote Create form's Quote Details and
                                  Additional Information sections. Currency is
                                  always shown when present (helpful when the
                                  Total Amount column above uses a generic ₹). */}
                              {(q.vendor_address || q.remarks || q.delivery_terms || q.freight_terms || q.currency) && (
                                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 mb-3 text-xs">
                                  {!isHidden('currency') && q.currency && (
                                    <div className="bg-white rounded p-2 border border-slate-200">
                                      <div className="text-[10px] uppercase text-slate-400 font-medium">Currency</div>
                                      <div className="text-slate-700 mt-0.5">{q.currency}</div>
                                    </div>
                                  )}
                                  {q.vendor_address && (
                                    <div className="bg-white rounded p-2 border border-slate-200">
                                      <div className="text-[10px] uppercase text-slate-400 font-medium">Vendor Address</div>
                                      <div className="text-slate-700 mt-0.5">{q.vendor_address}</div>
                                    </div>
                                  )}
                                  {!isHidden('delivery_terms') && q.delivery_terms && (
                                    <div className="bg-white rounded p-2 border border-slate-200">
                                      <div className="text-[10px] uppercase text-slate-400 font-medium">Delivery Terms</div>
                                      <div className="text-slate-700 mt-0.5">{q.delivery_terms}</div>
                                    </div>
                                  )}
                                  {!isHidden('freight_terms') && q.freight_terms && (
                                    <div className="bg-white rounded p-2 border border-slate-200">
                                      <div className="text-[10px] uppercase text-slate-400 font-medium">Freight Terms</div>
                                      <div className="text-slate-700 mt-0.5">{q.freight_terms}</div>
                                    </div>
                                  )}
                                  {!isHidden('remarks') && q.remarks && (
                                    <div className="bg-white rounded p-2 border border-slate-200 md:col-span-3 lg:col-span-4">
                                      <div className="text-[10px] uppercase text-slate-400 font-medium">Remarks</div>
                                      <div className="text-slate-700 mt-0.5 whitespace-pre-wrap">{q.remarks}</div>
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Line items */}
                              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1">
                                Line Items ({lines.length})
                              </div>
                              {lines.length === 0 ? (
                                <div className="text-xs text-slate-400 italic py-2">No line items on this quote.</div>
                              ) : (
                                <>
                                {/* Mobile-stacked quote line items. */}
                                <div className="sm:hidden space-y-2">
                                  {lines.map((l, idx) => {
                                    const qty = parseFloat(l.quantity_offered || l.quantity) || 0;
                                    const rate = parseFloat(l.unit_price || l.rate) || 0;
                                    const gst = parseFloat(l.gst || l.tax || 0);
                                    const base = qty * rate;
                                    const total = base + (base * gst / 100);
                                    return (
                                      <div key={`m-${l.id || idx}`} className="border border-slate-200 rounded bg-white p-2 text-xs">
                                        <div className="flex items-start justify-between gap-2 mb-1">
                                          <div className="min-w-0">
                                            <p className="text-[10px] uppercase text-slate-500">Line #{idx + 1}</p>
                                            <p className="font-semibold text-slate-800 break-words">{l.item_name || l.product_name || l.product_service_name || l.machinery_name || l.service_catalogue_name || l.description || '-'}</p>
                                          </div>
                                          <p className="shrink-0 font-bold text-slate-900 whitespace-nowrap">{fmtMoney(total, rfq.currency_symbol || q.currency)}</p>
                                        </div>
                                        <div className="grid grid-cols-3 gap-1 text-[10px]">
                                          {!isLineHidden('quantity_offered') && <div><span className="text-slate-500">Qty:</span> <span className="text-slate-700">{qty || '-'} {!isLineHidden('uom') ? (l.uom || '') : ''}</span></div>}
                                          {!isLineHidden('unit_price') && <div><span className="text-slate-500">Rate:</span> <span className="text-slate-700">{fmtMoney(rate, rfq.currency_symbol || q.currency)}</span></div>}
                                          {!isLineHidden('gst') && <div><span className="text-slate-500">GST:</span> <span className="text-slate-700">{gst ? `${gst}%` : '-'}</span></div>}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                                <div className="hidden sm:block bg-white rounded border border-slate-200 overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead className="bg-slate-100">
                                      <tr>
                                        <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                                        <th className="text-left px-3 py-2 font-medium text-slate-600">Product</th>
                                        {!isLineHidden('quantity_offered') && <th className="text-right px-3 py-2 font-medium text-slate-600">Qty</th>}
                                        {/* Physical dimensions — same four columns as the
                                            Create page table. Suppressed entirely when no
                                            line on this quote has any dimensions set, so
                                            existing quotes don't get four blank columns. */}
                                        {lines.some(l => l.length || l.width || l.breadth || l.height) && (
                                          <>
                                            <th className="text-right px-3 py-2 font-medium text-slate-600">Length</th>
                                            <th className="text-right px-3 py-2 font-medium text-slate-600">Width</th>
                                            <th className="text-right px-3 py-2 font-medium text-slate-600">Breadth</th>
                                            <th className="text-right px-3 py-2 font-medium text-slate-600">Height</th>
                                          </>
                                        )}
                                        {!isLineHidden('uom') && <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>}
                                        {!isLineHidden('unit_price') && <th className="text-right px-3 py-2 font-medium text-slate-600">Unit Price</th>}
                                        {!isLineHidden('gst') && <th className="text-right px-3 py-2 font-medium text-slate-600">GST %</th>}
                                        <th className="text-right px-3 py-2 font-medium text-slate-600">Total</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(() => {
                                        const showDims = lines.some(l => l.length || l.width || l.breadth || l.height);
                                        return lines.map((l, idx) => {
                                          const qty = parseFloat(l.quantity_offered || l.quantity) || 0;
                                          const rate = parseFloat(l.unit_price || l.rate) || 0;
                                          const gst = parseFloat(l.gst || l.tax || 0);
                                          const base = qty * rate;
                                          const total = base + (base * gst / 100);
                                          const fmtDim = (v) => (v === null || v === undefined || v === '') ? '-' : v;
                                          return (
                                            <tr key={l.id || idx} className="border-t border-slate-100">
                                              <td className="px-3 py-1.5 text-slate-500">{idx + 1}</td>
                                              <td className="px-3 py-1.5 text-slate-800">
                                                {/* Prefer item_name (unified) so Machinery / Service
                                                    rows render correctly. Fall back to legacy product
                                                    fields for older rows. */}
                                                {l.item_name || l.product_name || l.product_service_name || l.machinery_name || l.service_catalogue_name || l.description || '-'}
                                                {l.item_type && l.item_type !== 'PRODUCT' && (
                                                  <span className={`ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium align-middle ${
                                                    l.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'
                                                  }`}>
                                                    {l.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                                                  </span>
                                                )}
                                                {!isLineHidden('specification') && l.specification && (
                                                  <div className="text-[10px] text-slate-500">{l.specification}</div>
                                                )}
                                              </td>
                                              {!isLineHidden('quantity_offered') && <td className="px-3 py-1.5 text-right text-slate-700">{qty || '-'}</td>}
                                              {showDims && (
                                                <>
                                                  <td className="px-3 py-1.5 text-right text-slate-700">{fmtDim(l.length)}</td>
                                                  <td className="px-3 py-1.5 text-right text-slate-700">{fmtDim(l.width)}</td>
                                                  <td className="px-3 py-1.5 text-right text-slate-700">{fmtDim(l.breadth)}</td>
                                                  <td className="px-3 py-1.5 text-right text-slate-700">{fmtDim(l.height)}</td>
                                                </>
                                              )}
                                              {!isLineHidden('uom') && <td className="px-3 py-1.5 text-slate-700">{l.uom || '-'}</td>}
                                              {!isLineHidden('unit_price') && (
                                              <td className="px-3 py-1.5 text-right text-slate-700">
                                                {fmtMoney(rate, rfq.currency_symbol || q.currency)}
                                              </td>
                                              )}
                                              {!isLineHidden('gst') && (
                                              <td className="px-3 py-1.5 text-right text-slate-700">
                                                {gst ? `${gst}%` : '-'}
                                              </td>
                                              )}
                                              <td className="px-3 py-1.5 text-right font-medium text-slate-900">
                                                {fmtMoney(total, rfq.currency_symbol || q.currency)}
                                              </td>
                                            </tr>
                                          );
                                        });
                                      })()}
                                    </tbody>
                                  </table>
                                </div>
                                </>
                              )}

                              {canEdit('Quote') && (
                                <div className="mt-3 flex justify-end">
                                  <Link
                                    to={`/purchase/quotes/${q.id}/edit`}
                                    className="inline-flex items-center gap-1 px-3 py-1 rounded border border-slate-300 text-xs font-medium text-slate-700 hover:bg-white"
                                  >
                                    Open full quote
                                  </Link>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
