import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Trash2, Eye, BarChart3, X, Loader2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import ProductsCell from '../../../components/common/ProductsCell';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import apiClient from '../../../utils/api.js';
import MobileListCards from '../components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import { formatDate, formatCurrency } from '@/utils/formatters';
import exportToExcel from '../../../utils/exportExcel.js';

export default function QuoteResponseList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/quotes/');
  const [searchTerm, setSearchTerm] = useState('');
  const { canCreate, canDelete, canEvaluate, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Quote');
  const canEvaluateQuote = canEvaluate('Quote');

  const [datePeriod, setDatePeriod] = useState('All');
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 17;

  const handleDeleteRfqQuotes = async (e, row) => {
    e.stopPropagation();
    const label = row.rfq_no || 'this RFQ';
    if (!(await confirm({ message: `Delete all ${row.quote_count} quote(s) for ${label}? This cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      const ids = (row.quotes || []).map(q => q.id).filter(Boolean);
      await Promise.all(ids.map(id => apiClient.delete(`/api/purchase/quotes/${id}/`)));
      toast.success(`Deleted ${ids.length} quote(s) for ${label}`);
      refetch?.();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  // Group quotes by RFQ → one row per RFQ
  const rfqRows = useMemo(() => {
    const all = data || [];
    const groups = new Map();

    all.forEach((q) => {
      const key = q.rfq || `no-rfq-${q.id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          id: q.rfq || q.id,
          rfq_id: q.rfq || null,
          rfq_no: q.rfq_no || (q.rfq ? '-' : 'No RFQ'),
          pr_numbers: q.pr_numbers || [],
          pr_ids: q.pr_ids || [],
          quote_date: q.quote_date || '',
          price_valid_till: q.price_valid_till || '',
          currency: q.currency || '',
          quotes: [],
          product_names: [],
          chosen_vendor_name: '',
          chosen_quote_id: null,
          quote_count: 0,
          invited_count: 0,
          lowest_total: null,
          evaluation_status: 'Pending',
        });
      }
      const g = groups.get(key);
      g.quotes.push(q);
      g.quote_count = g.quotes.length;
      (q.product_names || []).forEach((n) => { if (n && !g.product_names.includes(n)) g.product_names.push(n); });
      g.invited_count = Math.max(g.invited_count || 0, Number(q.rfq_invited_count) || 0);

      if (q.quote_date && (!g.quote_date || q.quote_date < g.quote_date)) g.quote_date = q.quote_date;
      if (q.price_valid_till && (!g.price_valid_till || q.price_valid_till < g.price_valid_till)) g.price_valid_till = q.price_valid_till;
      const total = parseFloat(q.total_cost) || 0;
      if (total > 0 && (g.lowest_total === null || total < g.lowest_total)) g.lowest_total = total;
      if (q.chosen_flag) {
        g.chosen_vendor_name = q.vendor_name || '';
        g.chosen_quote_id = q.id;
        g.evaluation_status = 'Evaluated';
      }
      if ((q.pr_numbers || []).length > (g.pr_numbers || []).length) {
        g.pr_numbers = q.pr_numbers || [];
        g.pr_ids = q.pr_ids || [];
      }
    });

    return Array.from(groups.values());
  }, [data]);

  const filteredData = useMemo(() => {
    let result = rfqRows;

    if (datePeriod !== 'All') {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let from = null, to = null;
      if (datePeriod === 'Today') { from = today; to = today; }
      else if (datePeriod === 'Week') { from = new Date(today); from.setDate(today.getDate() - today.getDay()); to = today; }
      else if (datePeriod === 'Month') { from = new Date(today.getFullYear(), today.getMonth(), 1); to = today; }
      else if (datePeriod === 'FY') {
        const fyStart = today.getMonth() >= 3 ? new Date(today.getFullYear(), 3, 1) : new Date(today.getFullYear() - 1, 3, 1);
        from = fyStart; to = today;
      } else if (datePeriod === 'Custom') {
        if (customRange.from) from = new Date(customRange.from);
        if (customRange.to) to = new Date(customRange.to);
      }
      if (from || to) {
        result = result.filter(row => {
          if (!row.quote_date) return false;
          const d = new Date(row.quote_date);
          if (from && d < from) return false;
          if (to) { const end = new Date(to); end.setDate(end.getDate() + 1); if (d >= end) return false; }
          return true;
        });
      }
    }

    if (statusFilter !== 'ALL') {
      result = result.filter(row => row.evaluation_status === statusFilter);
    }

    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    return result;
  }, [rfqRows, datePeriod, customRange, statusFilter, searchTerm]);

  const totalPages = Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE));
  const pagedData = filteredData.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filteredData.length]);

  const handleExport = useCallback(() => {
    const rows = filteredData.map(r => ({
      'RFQ No': r.rfq_no,
      'PR No': (r.pr_numbers || []).join(', '),
      'Quote Date': r.quote_date ? formatDate(r.quote_date) : '',
      'Valid Till': r.price_valid_till ? formatDate(r.price_valid_till) : '',
      'Currency': r.currency,
      'Quotes': r.quote_count,
      'Chosen Vendor': r.chosen_vendor_name || '',
      'Lowest Quote': r.lowest_total || '',
      'Status': r.evaluation_status,
    }));
    exportToExcel(rows, null, 'quote-responses');
  }, [filteredData]);

  const handleRowClick = (row) => {
    if (row.rfq_id) {
      navigate(`/purchase/quotes/rfq/${row.rfq_id}`);
      return;
    }
    const firstQuote = Array.isArray(row.quotes) && row.quotes.length > 0 ? row.quotes[0] : null;
    if (firstQuote?.id) navigate(`/purchase/quotes/${firstQuote.id}/edit`);
  };

  // Field-visibility helpers
  const QUOTE_FIELD_KEYS = new Set([
    'quote_id', 'rfq', 'vendor', 'quote_date', 'price_valid_till',
    'currency', 'payment_terms', 'freight_terms', 'delivery_terms',
    'lead_time_days', 'chosen_flag', 'remarks',
  ]);

  const isColVisible = (colKey) => {
    let key = colKey;
    const stripped = key.replace(/_(name|code|display)$/, '');
    if (stripped !== key && QUOTE_FIELD_KEYS.has(stripped)) key = stripped;
    if (!QUOTE_FIELD_KEYS.has(key)) return true;
    return !isHidden(key);
  };

  const thCls = "text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap";

  return (
    <MainLayout>
      <PageHeader
        title="Quote Responses"
        subtitle="RFQ-wise summary of vendor quote responses"
        breadcrumbs={[{ label: 'Sourcing' }, { label: 'Quotes' }]}
        actions={{
          ...(canCreate('Quote')
            ? { createLink: '/purchase/quotes/new', createLabel: 'New Quote' }
            : {}),
        }}
      />

      {/* Toolbar */}
      <div className="hidden sm:flex items-center gap-2 px-1 py-1.5">
        {['All', 'Today', 'Week', 'Month', 'FY', 'Custom'].map((p) => (
          <button
            key={p}
            onClick={() => setDatePeriod(p)}
            className={`px-3 py-1 text-[12px] font-medium rounded-md border transition ${
              datePeriod === p
                ? 'bg-primary-600 text-white border-primary-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {p}
          </button>
        ))}
        {datePeriod === 'Custom' && (
          <>
            <input type="date" value={customRange.from} onChange={(e) => setCustomRange(r => ({ ...r, from: e.target.value }))} className="h-[30px] text-[11px] border border-slate-200 rounded-md px-2 bg-white" />
            <span className="text-[10px] text-slate-400">to</span>
            <input type="date" value={customRange.to} onChange={(e) => setCustomRange(r => ({ ...r, to: e.target.value }))} className="h-[30px] text-[11px] border border-slate-200 rounded-md px-2 bg-white" />
          </>
        )}
        <div className="flex-1" />
        <div className="relative">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search quotes…"
            className="h-[30px] w-[160px] text-[12px] border border-slate-200 rounded-md pl-3 pr-7 bg-white focus:ring-1 focus:ring-primary-400 focus:border-primary-400 placeholder-slate-400"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600">
              <X size={10} />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-[30px] text-[12px] font-medium text-slate-700 border border-slate-200 rounded-md bg-white cursor-pointer pl-3 pr-8 leading-none appearance-none bg-no-repeat focus:ring-1 focus:ring-primary-400 focus:border-primary-400"
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2360594a' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")", backgroundPosition: 'right 8px center', backgroundSize: '12px' }}
        >
          <option value="ALL">Status</option>
          <option value="Evaluated">Evaluated</option>
          <option value="Pending">Pending</option>
        </select>
        {canExport('Quote') && (
          <button onClick={handleExport} className="h-[30px] px-3 text-[11px] font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50">
            Export
          </button>
        )}
      </div>

      <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={filteredData}
          isLoading={isLoading}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder="Search quote no, RFQ, vendor…"
          emptyMessage="No quote responses found"
          config={{
            title: (row) => row.rfq_no || '(no RFQ)',
            subtitle: (row) => row.chosen_vendor_name || (Array.isArray(row.pr_numbers) ? row.pr_numbers.join(', ') : null),
            meta: (row) => row.quote_date ? formatDate(row.quote_date) : null,
            badge: (row) => row.evaluation_status === 'Evaluated'
              ? { label: 'Evaluated', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' }
              : { label: 'Pending',   cls: 'bg-amber-100 text-amber-700 border-amber-300' },
            fields: (row) => [
              { label: 'Quotes',  value: row.quote_count },
              { label: 'Lowest',  value: row.lowest_total ? formatCurrency(row.lowest_total) : null, cls: 'text-emerald-700 font-medium' },
            ],
            actions: (row) => {
              const prId = Array.isArray(row.pr_ids) && row.pr_ids.length > 0 ? row.pr_ids[0] : '';
              const evalUrl = prId
                ? `/purchase/evaluations?pr_id=${prId}`
                : row.rfq_id ? `/purchase/evaluations?rfq_id=${row.rfq_id}` : '/purchase/evaluations';
              return [
                { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => handleRowClick(row) },
                { icon: BarChart3, label: 'Evaluate', cls: 'text-violet-700 hover:bg-violet-50', hidden: row.evaluation_status === 'Evaluated' || !canEvaluateQuote, onClick: () => navigate(evalUrl) },
              ];
            },
          }}
          onRowClick={handleRowClick}
        />

        {/* Desktop table */}
        <div className="hidden sm:block">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-primary-500" />
            </div>
          ) : pagedData.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-[12px]">No quote responses found</div>
          ) : (
            <>
              <div className="border border-slate-200 rounded-md overflow-x-auto bg-white">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className={thCls}>RFQ No</th>
                      {isColVisible('pr_numbers') && <th className={thCls}>PR No</th>}
                      <th className={thCls} style={{ width: 160 }}>Products</th>
                      {isColVisible('quote_date') && <th className={thCls}>RFQ Date</th>}
                      {isColVisible('price_valid_till') && <th className={thCls}>Valid Till</th>}
                      {isColVisible('currency') && <th className={thCls}>Currency</th>}
                      <th className={thCls}>Received</th>
                      <th className={thCls}>Recorded</th>
                      {isColVisible('chosen_vendor_name') && <th className={thCls}>Chosen Vendor</th>}
                      <th className={thCls}>Lowest Quote</th>
                      <th className={thCls}>Status</th>
                      <th className={thCls}>Evaluate</th>
                      {canDelete('Quote') && <th className={thCls}></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedData.map((row) => {
                      const prId = Array.isArray(row.pr_ids) && row.pr_ids.length > 0 ? row.pr_ids[0] : '';
                      const evalUrl = prId
                        ? `/purchase/evaluations?pr_id=${prId}`
                        : row.rfq_id ? `/purchase/evaluations?rfq_id=${row.rfq_id}` : '/purchase/evaluations';
                      const invited = Number(row.invited_count) || 0;
                      const pending = invited > 0 && Number(row.quote_count) < invited;
                      const complete = invited > 0 && Number(row.quote_count) >= invited;

                      return (
                        <tr
                          key={row.id}
                          onClick={() => handleRowClick(row)}
                          className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                        >
                          {/* RFQ No */}
                          <td className="px-2 py-2">
                            {row.rfq_id ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); navigate(`/purchase/rfq/${row.rfq_id}`); }}
                                className="text-primary-600 hover:text-primary-800 hover:underline font-semibold"
                              >
                                {row.rfq_no}
                              </button>
                            ) : (
                              <span className="font-semibold text-slate-800">{row.rfq_no || '-'}</span>
                            )}
                          </td>

                          {/* PR No */}
                          {isColVisible('pr_numbers') && (
                            <td className="px-2 py-2 text-slate-600">
                              {Array.isArray(row.pr_numbers) && row.pr_numbers.length > 0
                                ? row.pr_numbers.map((prNo, i) => (
                                    <span key={i}>
                                      {i > 0 && ', '}
                                      {(row.pr_ids || [])[i] ? (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); navigate(`/purchase/requests/${row.pr_ids[i]}`); }}
                                          className="text-primary-600 hover:text-primary-800 hover:underline font-medium"
                                        >
                                          {prNo}
                                        </button>
                                      ) : prNo}
                                    </span>
                                  ))
                                : '-'}
                            </td>
                          )}

                          {/* Products */}
                          <td className="px-2 py-2 text-slate-600 truncate" style={{ maxWidth: 160 }}>
                            <ProductsCell names={row.product_names} />
                          </td>

                          {/* RFQ Date */}
                          {isColVisible('quote_date') && (
                            <td className="px-2 py-2 text-slate-500">{row.quote_date ? formatDate(row.quote_date) : '-'}</td>
                          )}

                          {/* Valid Till */}
                          {isColVisible('price_valid_till') && (
                            <td className="px-2 py-2 text-slate-500">{row.price_valid_till ? formatDate(row.price_valid_till) : '-'}</td>
                          )}

                          {/* Currency */}
                          {isColVisible('currency') && (
                            <td className="px-2 py-2 text-slate-600">{row.currency || '-'}</td>
                          )}

                          {/* Quotes Received */}
                          <td className="px-2 py-2">
                            <span className="inline-flex items-center justify-center min-w-[28px] px-2 py-0.5 bg-slate-50 text-slate-600 text-[11px] font-semibold rounded-full border border-slate-200">
                              {row.invited_count || 0}
                            </span>
                          </td>

                          {/* Quotes Recorded */}
                          <td className="px-2 py-2">
                            <span className={`inline-flex items-center justify-center min-w-[28px] px-2 py-0.5 text-[11px] font-semibold rounded-full border ${
                              complete ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-blue-50 text-blue-700 border-blue-200'
                            }`}>
                              {row.quote_count}{invited > 0 ? ` / ${invited}` : ''}
                            </span>
                          </td>

                          {/* Chosen Vendor */}
                          {isColVisible('chosen_vendor_name') && (
                            <td className="px-2 py-2">
                              {row.chosen_vendor_name
                                ? <span className="text-emerald-700 font-medium">{row.chosen_vendor_name}</span>
                                : <span className="text-slate-400">-</span>}
                            </td>
                          )}

                          {/* Lowest Quote */}
                          <td className="px-2 py-2 text-slate-700">{row.lowest_total ? formatCurrency(row.lowest_total) : '-'}</td>

                          {/* Status */}
                          <td className="px-2 py-2">
                            {row.evaluation_status === 'Evaluated' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-semibold rounded-full border border-emerald-200">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5"/></svg>
                                Eval
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 text-[10px] font-semibold rounded-full border border-amber-200">Pending</span>
                            )}
                          </td>

                          {/* Evaluate button */}
                          <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                            {row.evaluation_status === 'Evaluated' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-1 bg-slate-100 text-slate-400 text-[10px] font-medium rounded-md cursor-not-allowed">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5"/></svg>
                                Done
                              </span>
                            ) : canEvaluateQuote ? (
                              <button
                                onClick={() => { if (!pending) navigate(evalUrl); }}
                                disabled={pending}
                                title={pending ? `Waiting for ${invited - Number(row.quote_count)} more quote(s)` : undefined}
                                className={`inline-flex items-center gap-1 px-2 py-1 text-white text-[10px] font-medium rounded-md transition ${
                                  pending ? 'bg-slate-300 cursor-not-allowed' : 'bg-violet-600 hover:bg-violet-700'
                                }`}
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>
                                {pending ? `${row.quote_count}/${invited}` : 'Evaluate'}
                              </button>
                            ) : null}
                          </td>

                          {/* Delete */}
                          {canDelete('Quote') && (
                            <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={(e) => handleDeleteRfqQuotes(e, row)}
                                className="p-1 text-red-500 hover:bg-red-50 rounded transition"
                                title="Delete all quotes for this RFQ"
                              >
                                <Trash2 size={13} />
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between px-1 py-2 text-[11px] text-slate-500">
                <span>{(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, filteredData.length)} of {filteredData.length}</span>
                <div className="flex items-center gap-1">
                  {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                    const p = totalPages <= 5 ? i + 1 : page <= 3 ? i + 1 : page >= totalPages - 2 ? totalPages - 4 + i : page - 2 + i;
                    return (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        className={`w-7 h-7 rounded text-[11px] font-medium ${p === page ? 'bg-primary-600 text-white' : 'hover:bg-slate-100 text-slate-600'}`}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </ListState>
    </MainLayout>
  );
}
