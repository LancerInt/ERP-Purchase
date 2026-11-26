import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowLeft, Paperclip,
  Award, FileText, CheckCircle2,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';

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
  const [activeTab, setActiveTab] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const rfqRes = await apiClient.get(`/api/purchase/rfq/${rfqId}/`);
        if (cancelled) return;
        setRfq(rfqRes.data);

        const qRes = await apiClient.get(`/api/purchase/quotes/?rfq=${rfqId}&page_size=500`);
        const list = qRes.data?.results || qRes.data || [];
        if (cancelled) return;
        setQuotes(list);
        if (list.length > 0) setActiveTab(list[0].id);

        const attMap = {};
        await Promise.all(
          list.map((q) =>
            apiClient
              .get(`/api/purchase/attachments/?module=QUOTE&record_id=${q.id}`)
              .then((r) => { attMap[q.id] = r.data?.results || r.data || []; })
              .catch(() => { attMap[q.id] = []; }),
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
    return [...quotes].sort((a, b) => {
      if (a.chosen_flag && !b.chosen_flag) return -1;
      if (!a.chosen_flag && b.chosen_flag) return 1;
      const ta = parseFloat(a.total_cost) || Infinity;
      const tb = parseFloat(b.total_cost) || Infinity;
      if (ta !== tb) return ta - tb;
      return (a.quote_date || '').localeCompare(b.quote_date || '');
    });
  }, [quotes]);

  useEffect(() => {
    if (sortedQuotes.length > 0 && !sortedQuotes.find(q => q.id === activeTab)) {
      setActiveTab(sortedQuotes[0].id);
    }
  }, [sortedQuotes, activeTab]);

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

  const lowestId = useMemo(() => {
    let min = Infinity, id = null;
    quotes.forEach(q => {
      const t = parseFloat(q.total_cost);
      if (!isNaN(t) && t > 0 && t < min) { min = t; id = q.id; }
    });
    return id;
  }, [quotes]);

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

  const expected = (Array.isArray(rfq.vendors) ? rfq.vendors.length : 0) || Number(rfq.quote_count_expected) || 0;
  const recordedCount = quotes.length;
  const allRecorded = expected === 0 || recordedCount >= expected;
  const pendingCount = Math.max(0, expected - recordedCount);

  const activeQuote = sortedQuotes.find(q => q.id === activeTab);
  const activeAtts = activeQuote ? (attachmentsByQuote[activeQuote.id] || []) : [];
  const activeLines = activeQuote ? (activeQuote.line_items || activeQuote.quote_lines || []) : [];

  const thCls = "text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap";

  return (
    <MainLayout>
      <div className="space-y-2">
        {/* Header row */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/quotes'))}
            className="p-1 text-slate-400 hover:text-slate-700 transition"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-base font-bold text-slate-900 mr-1">{rfq.rfq_no}</h1>
          {expected > 0 && (
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
              allRecorded
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}>
              {recordedCount}/{expected} recorded{!allRecorded ? ` · ${pendingCount} pending` : ''}
            </span>
          )}
          <div className="flex-1" />
          <Link
            to={`/purchase/rfq/${rfqId}`}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 text-[11px] font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap"
          >
            <FileText size={12} /> View RFQ
          </Link>
          {canCreate('Quote') && (
            rfq.is_evaluated ? (
              <button
                type="button"
                disabled
                title="Quotes already evaluated — new responses locked"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-100 text-slate-400 text-[11px] font-medium cursor-not-allowed whitespace-nowrap"
              >
                <FileText size={12} /> Record Response
              </button>
            ) : (
              <Link
                to={`/purchase/quotes/new?rfq=${rfqId}`}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap ${
                  allRecorded
                    ? 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                    : 'bg-green-600 text-white hover:bg-green-700'
                }`}
              >
                <FileText size={12} /> Record Response
              </Link>
            )
          )}
          {canCreate('Quote Evaluation') && (
            allRecorded ? (
              <Link
                to={`/purchase/evaluations?rfq_id=${rfqId}`}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-primary-600 text-white text-[11px] font-medium hover:bg-primary-700 whitespace-nowrap"
              >
                <Award size={12} /> Evaluate
              </Link>
            ) : (
              <button
                type="button"
                disabled
                title={`Record all ${expected} expected responses first`}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-100 text-slate-400 text-[11px] font-medium cursor-not-allowed whitespace-nowrap"
              >
                <Award size={12} /> Evaluate
              </button>
            )
          )}
        </div>

        {/* Summary stats */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="bg-emerald-50 border border-emerald-200 rounded-md px-3 py-1.5 min-w-[100px]">
            <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-emerald-500 font-semibold">Lowest</div>
            <div className="text-[13px] font-bold text-emerald-700">{totals.lowest != null ? fmtMoney(totals.lowest, rfq.currency_symbol) : '-'}</div>
            {lowestId && <div className="text-[9px] text-emerald-500">{sortedQuotes.find(q => q.id === lowestId)?.vendor_name}</div>}
          </div>
          <div className="bg-red-50 border border-red-200 rounded-md px-3 py-1.5 min-w-[100px]">
            <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-red-400 font-semibold">Highest</div>
            <div className="text-[13px] font-bold text-slate-700">{totals.highest != null ? fmtMoney(totals.highest, rfq.currency_symbol) : '-'}</div>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-md px-3 py-1.5 min-w-[80px]">
            <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-blue-400 font-semibold">Received</div>
            <div className="text-[13px] font-bold text-blue-700">{totals.count}</div>
          </div>
          {pendingCount > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5 min-w-[80px]">
              <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-amber-400 font-semibold">Pending</div>
              <div className="text-[13px] font-bold text-amber-700">{pendingCount}</div>
            </div>
          )}
          <div className="flex-1" />
          <div className="text-[10px] text-slate-400">
            RFQ Date: <span className="text-slate-600 font-medium">{rfq.rfq_date || '-'}</span>
          </div>
        </div>

        {/* Vendor tabs + content */}
        {sortedQuotes.length === 0 ? (
          <div className="bg-white rounded-lg border border-slate-200 text-center py-16 text-slate-400 text-[12px] italic">
            No quotes received yet for this RFQ.
          </div>
        ) : (
          <>
            {/* Tab bar */}
            <div className="flex gap-0.5 overflow-x-auto pb-0 -mb-px" style={{ scrollbarWidth: 'none' }}>
              {sortedQuotes.map((q) => {
                const isActive = q.id === activeTab;
                const isChosen = !!q.chosen_flag;
                const isLowest = q.id === lowestId;
                return (
                  <button
                    key={q.id}
                    onClick={() => setActiveTab(q.id)}
                    className={`flex-shrink-0 px-3 py-1.5 text-[11px] font-semibold rounded-t-md border border-b-0 transition whitespace-nowrap ${
                      isActive
                        ? isChosen
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                          : 'bg-white text-slate-900 border-slate-200'
                        : isChosen
                          ? 'bg-emerald-50/50 text-emerald-600 border-transparent hover:bg-emerald-50'
                          : 'bg-slate-50 text-slate-500 border-transparent hover:bg-slate-100'
                    }`}
                  >
                    {q.vendor_name || q.vendor_name_text || 'Vendor'}
                    <span className={`ml-1.5 ${isLowest ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {fmtMoney(q.total_cost, rfq.currency_symbol || q.currency)}
                    </span>
                    {isChosen && <span className="ml-1 text-emerald-600">✓</span>}
                    {isLowest && !isChosen && <span className="ml-1 text-emerald-500 text-[9px]">★</span>}
                  </button>
                );
              })}
            </div>

            {/* Tab content */}
            {activeQuote && (
              <div className={`bg-white rounded-b-lg rounded-tr-lg border overflow-hidden ${
                activeQuote.chosen_flag ? 'border-emerald-200' : 'border-slate-200'
              }`}>
                {/* Chosen vendor banner */}
                {activeQuote.chosen_flag && (
                  <div className="bg-emerald-50 border-b border-emerald-200 px-3 py-1.5 flex items-center gap-2">
                    <CheckCircle2 size={13} className="text-emerald-600" />
                    <span className="text-[11px] font-semibold text-emerald-700">Selected Quote — Chosen in Evaluation</span>
                  </div>
                )}

                {/* Field grid */}
                <div className="px-3 py-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-1.5">
                    <div>
                      <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Total Amount</div>
                      <div className={`text-[12px] font-bold ${activeQuote.id === lowestId ? 'text-emerald-700' : 'text-slate-900'}`}>
                        {fmtMoney(activeQuote.total_cost, rfq.currency_symbol || activeQuote.currency)}
                      </div>
                    </div>
                    {!isHidden('payment_terms') && (
                      <div>
                        <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Payment Terms</div>
                        <div className="text-[12px] text-slate-700">{fmtPaymentTerms(activeQuote)}</div>
                      </div>
                    )}
                    {!isHidden('price_valid_till') && (
                      <div>
                        <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Valid Till</div>
                        <div className="text-[12px] text-slate-700">{activeQuote.price_valid_till || '-'}</div>
                      </div>
                    )}
                    {!isHidden('currency') && (
                      <div>
                        <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Currency</div>
                        <div className="text-[12px] text-slate-700">{activeQuote.currency || '-'}</div>
                      </div>
                    )}
                    {!isHidden('lead_time_days') && (
                      <div>
                        <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Lead Time</div>
                        <div className="text-[12px] text-slate-700">{activeQuote.lead_time_days || '-'}</div>
                      </div>
                    )}
                    {!isHidden('quote_date') && (
                      <div>
                        <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Quote Date</div>
                        <div className="text-[12px] text-slate-700">{activeQuote.quote_date || '-'}</div>
                      </div>
                    )}
                    {!isHidden('delivery_terms') && activeQuote.delivery_terms && (
                      <div>
                        <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Delivery Terms</div>
                        <div className="text-[12px] text-slate-700">{activeQuote.delivery_terms}</div>
                      </div>
                    )}
                    {!isHidden('freight_terms') && activeQuote.freight_terms && (
                      <div>
                        <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Freight Terms</div>
                        <div className="text-[12px] text-slate-700">{activeQuote.freight_terms}</div>
                      </div>
                    )}
                    <div>
                      <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Status</div>
                      <div className="text-[12px]">
                        {activeQuote.chosen_flag ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                            <CheckCircle2 size={11} /> Selected
                          </span>
                        ) : (
                          <StatusBadge status={activeQuote.status_display || activeQuote.status || 'Submitted'} />
                        )}
                      </div>
                    </div>
                    {activeQuote.vendor_address && (
                      <div className="col-span-2">
                        <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Vendor Address</div>
                        <div className="text-[12px] text-slate-700">{activeQuote.vendor_address}</div>
                      </div>
                    )}
                    {/* Attachments inline */}
                    <div className={activeAtts.length > 1 ? 'col-span-2' : ''}>
                      <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Attachments</div>
                      <div className="mt-0.5">
                        {activeAtts.length === 0 ? (
                          <span className="text-[11px] text-slate-400 italic">No files</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {activeAtts.map((a) => (
                              <a
                                key={a.id}
                                href={a.file_url || a.file}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 hover:bg-primary-50 hover:border-primary-300 text-[10px] text-slate-600 hover:text-primary-700 max-w-[160px]"
                                title={a.file_name || a.file}
                              >
                                <Paperclip size={9} className="flex-shrink-0" />
                                <span className="truncate">{a.file_name || 'file'}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  {!isHidden('remarks') && activeQuote.remarks && (
                    <div className="mt-2 pt-1.5 border-t border-slate-100">
                      <div style={{ fontSize: 9 }} className="uppercase tracking-wide text-slate-400 font-semibold">Remarks</div>
                      <div className="text-[12px] text-slate-600 whitespace-pre-wrap mt-0.5">{activeQuote.remarks}</div>
                    </div>
                  )}
                </div>

                {/* Line items table */}
                <div className="border-t border-slate-100">
                  <div className="px-3 py-1.5 bg-slate-50/50">
                    <span style={{ fontSize: 10 }} className="font-semibold text-slate-500 uppercase tracking-wider">
                      Line Items ({activeLines.length})
                    </span>
                  </div>
                  {activeLines.length === 0 ? (
                    <div className="px-3 py-4 text-[11px] text-slate-400 italic">No line items on this quote.</div>
                  ) : (
                    <>
                      {/* Mobile cards */}
                      <div className="sm:hidden px-3 py-2 space-y-2">
                        {activeLines.map((l, idx) => {
                          const qty = parseFloat(l.quantity_offered || l.quantity) || 0;
                          const rate = parseFloat(l.unit_price || l.rate) || 0;
                          const gst = parseFloat(l.gst || l.tax || 0);
                          const base = qty * rate;
                          const total = base + (base * gst / 100);
                          return (
                            <div key={`m-${l.id || idx}`} className="border border-slate-200 rounded bg-white p-2 text-[11px]">
                              <div className="flex items-start justify-between gap-2 mb-1">
                                <div className="min-w-0">
                                  <p className="text-[9px] uppercase text-slate-400 font-semibold">#{idx + 1}</p>
                                  <p className="font-semibold text-slate-800 break-words text-[11px]">{l.item_name || l.product_name || l.product_service_name || l.machinery_name || l.service_catalogue_name || l.description || '-'}</p>
                                </div>
                                <p className="shrink-0 font-bold text-slate-900 whitespace-nowrap">{fmtMoney(total, rfq.currency_symbol || activeQuote.currency)}</p>
                              </div>
                              <div className="grid grid-cols-3 gap-1 text-[10px]">
                                {!isLineHidden('quantity_offered') && <div><span className="text-slate-400">Qty:</span> <span className="text-slate-700">{qty || '-'} {!isLineHidden('uom') ? (l.uom || '') : ''}</span></div>}
                                {!isLineHidden('unit_price') && <div><span className="text-slate-400">Rate:</span> <span className="text-slate-700">{fmtMoney(rate, rfq.currency_symbol || activeQuote.currency)}</span></div>}
                                {!isLineHidden('gst') && <div><span className="text-slate-400">GST:</span> <span className="text-slate-700">{gst ? `${gst}%` : '-'}</span></div>}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Desktop table */}
                      <div className="hidden sm:block overflow-x-auto">
                        <table className="w-full text-[12px]">
                          <thead>
                            <tr className="border-b border-slate-100">
                              <th className={thCls}>#</th>
                              <th className={thCls}>Product</th>
                              {!isLineHidden('quantity_offered') && <th className={`${thCls} text-right`}>Qty</th>}
                              {activeLines.some(l => l.length || l.width || l.breadth || l.height) && (
                                <>
                                  <th className={`${thCls} text-right`}>Length</th>
                                  <th className={`${thCls} text-right`}>Width</th>
                                  <th className={`${thCls} text-right`}>Breadth</th>
                                  <th className={`${thCls} text-right`}>Height</th>
                                </>
                              )}
                              {!isLineHidden('uom') && <th className={thCls}>UOM</th>}
                              {!isLineHidden('unit_price') && <th className={`${thCls} text-right`}>Unit Price</th>}
                              {!isLineHidden('gst') && <th className={`${thCls} text-right`}>GST %</th>}
                              <th className={`${thCls} text-right`}>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(() => {
                              const showDims = activeLines.some(l => l.length || l.width || l.breadth || l.height);
                              return activeLines.map((l, idx) => {
                                const qty = parseFloat(l.quantity_offered || l.quantity) || 0;
                                const rate = parseFloat(l.unit_price || l.rate) || 0;
                                const gst = parseFloat(l.gst || l.tax || 0);
                                const base = qty * rate;
                                const total = base + (base * gst / 100);
                                const fmtDim = (v) => (v === null || v === undefined || v === '') ? '-' : v;
                                return (
                                  <tr key={l.id || idx} className="border-b border-slate-50 hover:bg-slate-50/50">
                                    <td className="px-2 py-1.5 text-slate-400">{idx + 1}</td>
                                    <td className="px-2 py-1.5 text-slate-800">
                                      {l.item_name || l.product_name || l.product_service_name || l.machinery_name || l.service_catalogue_name || l.description || '-'}
                                      {l.item_type && l.item_type !== 'PRODUCT' && (
                                        <span className={`ml-1 inline-block px-1 py-0.5 rounded text-[8px] font-medium align-middle ${
                                          l.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'
                                        }`}>
                                          {l.item_type === 'MACHINERY' ? 'Mach' : 'Svc'}
                                        </span>
                                      )}
                                      {!isLineHidden('specification') && l.specification && (
                                        <div className="text-[9px] text-slate-400">{l.specification}</div>
                                      )}
                                    </td>
                                    {!isLineHidden('quantity_offered') && <td className="px-2 py-1.5 text-right text-slate-700">{qty || '-'}</td>}
                                    {showDims && (
                                      <>
                                        <td className="px-2 py-1.5 text-right text-slate-700">{fmtDim(l.length)}</td>
                                        <td className="px-2 py-1.5 text-right text-slate-700">{fmtDim(l.width)}</td>
                                        <td className="px-2 py-1.5 text-right text-slate-700">{fmtDim(l.breadth)}</td>
                                        <td className="px-2 py-1.5 text-right text-slate-700">{fmtDim(l.height)}</td>
                                      </>
                                    )}
                                    {!isLineHidden('uom') && <td className="px-2 py-1.5 text-slate-700">{l.uom || '-'}</td>}
                                    {!isLineHidden('unit_price') && (
                                      <td className="px-2 py-1.5 text-right text-slate-700">
                                        {fmtMoney(rate, rfq.currency_symbol || activeQuote.currency)}
                                      </td>
                                    )}
                                    {!isLineHidden('gst') && (
                                      <td className="px-2 py-1.5 text-right text-slate-700">{gst ? `${gst}%` : '-'}</td>
                                    )}
                                    <td className="px-2 py-1.5 text-right font-semibold text-slate-900">
                                      {fmtMoney(total, rfq.currency_symbol || activeQuote.currency)}
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
                </div>

                {/* Open full quote link */}
                {canEdit('Quote') && (
                  <div className="border-t border-slate-100 px-3 py-1.5 flex justify-end">
                    <Link
                      to={`/purchase/quotes/${activeQuote.id}/edit`}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 text-[10px] font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Open full quote →
                    </Link>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </MainLayout>
  );
}
