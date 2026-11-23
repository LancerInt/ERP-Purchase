import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Trash2, Eye, BarChart3, RefreshCw } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import ProductsCell from '../../../components/common/ProductsCell';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import apiClient from '../../../utils/api.js';
import UnifiedFilterPanel, { useUnifiedFilter } from '../components/UnifiedFilterPanel';
import MobileListCards from '../components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import { formatDate, formatCurrency } from '@/utils/formatters';

const FILTER_FIELDS = [
  { value: 'rfq_no', label: 'RFQ No', type: 'text' },
  { value: 'quote_date', label: 'RFQ Date', type: 'date' },
  { value: 'price_valid_till', label: 'Valid Till', type: 'date' },
  { value: 'currency', label: 'Currency', type: 'text' },
  { value: 'chosen_vendor_name', label: 'Chosen Vendor', type: 'text' },
  { value: 'evaluation_status', label: 'Evaluation Status', type: 'select', options: [
    { value: 'Evaluated', label: 'Evaluated' }, { value: 'Pending', label: 'Pending' },
  ]},
];

export default function QuoteResponseList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/quotes/');
  const [showFilters, setShowFilters] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const filter = useUnifiedFilter(FILTER_FIELDS);
  const { canCreate, canDelete, canEvaluate, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Quote');
  // The row-level "Evaluate" button is gated on the dedicated
  // `can_evaluate` flag on the Quote module (admin grid → Quote row →
  // Evaluate column), NOT the broader Quote Evaluation can_create flag.
  // That way an admin can let a buyer evaluate an existing quote
  // without also granting them the ability to invent stand-alone
  // evaluations not tied to any quote.
  const canEvaluateQuote = canEvaluate('Quote');

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
      // Union of product names across every vendor quote for this RFQ.
      (q.product_names || []).forEach((n) => { if (n && !g.product_names.includes(n)) g.product_names.push(n); });
      // Vendors the RFQ was emailed to = quotes expected (same for every
      // quote in the group; take the max in case of stale rows).
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

  const filteredData = (() => {
    let result = filter.filterData(rfqRows);
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    return result;
  })();

  const columns = [
    { key: 'rfq_no', label: 'RFQ No', sortable: true, render: (value, row) => {
      if (!row.rfq_id) return value || '-';
      return (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/purchase/rfq/${row.rfq_id}`); }}
          className="text-primary-600 hover:text-primary-800 hover:underline font-medium"
        >
          {value}
        </button>
      );
    }},
    { key: 'pr_numbers', label: 'PR No', sortable: true, render: (value, row) => {
      if (!Array.isArray(value) || value.length === 0) return '-';
      const prIds = Array.isArray(row.pr_ids) ? row.pr_ids : [];
      return value.map((prNo, i) => (
        <span key={i}>
          {i > 0 && ', '}
          {prIds[i] ? (
            <button
              onClick={(e) => { e.stopPropagation(); navigate(`/purchase/requests/${prIds[i]}`); }}
              className="text-primary-600 hover:text-primary-800 hover:underline font-medium"
            >
              {prNo}
            </button>
          ) : prNo}
        </span>
      ));
    }},
    { key: 'product_names', label: 'Products', sortable: false, render: (value) => <ProductsCell names={value} /> },
    { key: 'quote_date', label: 'RFQ Date', sortable: true, render: (v) => v ? formatDate(v) : '-' },
    { key: 'price_valid_till', label: 'Valid Till', sortable: true, render: (v) => v ? formatDate(v) : '-' },
    { key: 'currency', label: 'Currency', sortable: true },
    { key: 'invited_count', label: 'Quotes Received', sortable: true, render: (v) => (
      <span className="inline-flex items-center justify-center min-w-[32px] px-2.5 py-0.5 bg-slate-50 text-slate-600 text-xs font-semibold rounded-full border border-slate-200">{v || 0}</span>
    )},
    { key: 'quote_count', label: 'Quotes Recorded', sortable: true, render: (v, row) => {
      const invited = Number(row?.invited_count) || 0;
      const complete = invited > 0 && Number(v) >= invited;
      return (
        <span className={`inline-flex items-center justify-center min-w-[32px] px-2.5 py-0.5 text-xs font-semibold rounded-full border ${complete ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>{v}{invited > 0 ? ` / ${invited}` : ''}</span>
      );
    }},
    { key: 'chosen_vendor_name', label: 'Chosen Vendor', sortable: true, render: (v) => v
      ? <span className="text-emerald-700 font-medium">{v}</span>
      : <span className="text-slate-400">-</span> },
    { key: 'lowest_total', label: 'Lowest Quote', sortable: true, render: (v) => v ? formatCurrency(v) : '-' },
    { key: 'evaluation_status', label: 'Status', sortable: true, render: (v) => v === 'Evaluated' ? (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 text-emerald-700 text-xs font-semibold rounded-full border border-emerald-200">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5"/></svg>
        Evaluated
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 text-xs font-semibold rounded-full border border-amber-200">Pending</span>
    )},
    {
      key: 'evaluate', label: '', sortable: false,
      render: (_, row) => {
        if (row.evaluation_status === 'Evaluated') {
          return (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-400 text-xs font-medium rounded-lg cursor-not-allowed">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5"/></svg>
              Evaluated
            </span>
          );
        }
        if (!canEvaluateQuote) return null;
        // Evaluate only once ALL expected quotes (invited vendors) are
        // recorded — comparing a partial set would pick a winner early.
        const invited = Number(row.invited_count) || 0;
        const pending = invited > 0 && Number(row.quote_count) < invited;
        const prId = Array.isArray(row.pr_ids) && row.pr_ids.length > 0 ? row.pr_ids[0] : '';
        const evalUrl = prId
          ? `/purchase/evaluations?pr_id=${prId}`
          : row.rfq_id ? `/purchase/evaluations?rfq_id=${row.rfq_id}` : '/purchase/evaluations';
        return (
          <button
            onClick={(e) => { e.stopPropagation(); if (!pending) navigate(evalUrl); }}
            disabled={pending}
            title={pending ? `Waiting for ${invited - Number(row.quote_count)} more quote(s) before evaluation` : undefined}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-white text-xs font-medium rounded-lg transition ${pending ? 'bg-slate-300 cursor-not-allowed' : 'bg-violet-600 hover:bg-violet-700'}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>
            {pending ? `Evaluate (${row.quote_count}/${invited})` : 'Evaluate'}
          </button>
        );
      },
    },
    ...(canDelete('Quote') ? [{
      key: 'delete', label: '', sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => handleDeleteRfqQuotes(e, row)}
          className="p-1.5 text-red-500 hover:bg-red-50 rounded transition"
          title="Delete all quotes for this RFQ"
        >
          <Trash2 size={15} />
        </button>
      ),
    }] : []),
  ];

  // Catalog keys for the 'Quote' module. A column is dropped when its
  // derived key resolves to one of these AND it's HIDDEN for this user.
  // The RFQ No link column (rfq_no → quote_id meaning) and action
  // columns are never dropped.
  const QUOTE_FIELD_KEYS = new Set([
    'quote_id', 'rfq', 'vendor', 'quote_date', 'price_valid_till',
    'currency', 'payment_terms', 'freight_terms', 'delivery_terms',
    'lead_time_days', 'chosen_flag', 'remarks',
  ]);
  const NEVER_DROP = new Set(['rfq_no', 'evaluate', 'delete', 'actions']);
  const visibleColumns = columns.filter((col) => {
    if (!col.key || NEVER_DROP.has(col.key)) return true;
    // Derive the catalog key: strip a trailing _name/_code/_display
    // suffix only if doing so yields a real catalog key; otherwise use
    // the raw key. Non-catalog keys are always kept.
    let key = col.key;
    const stripped = key.replace(/_(name|code|display)$/, '');
    if (stripped !== key && QUOTE_FIELD_KEYS.has(stripped)) key = stripped;
    if (!QUOTE_FIELD_KEYS.has(key)) return true;
    return !isHidden(key);
  });

  const handleRowClick = (row) => {
    // Clicking the row opens the Quote Response detail page (lists every
    // vendor quote received for this RFQ with attachments + line items).
    // The "Evaluate" button at the row level still routes to the
    // evaluation page — that's the side-by-side compare-and-choose flow.
    if (row.rfq_id) {
      navigate(`/purchase/quotes/rfq/${row.rfq_id}`);
      return;
    }
    // Fallback for the rare "no RFQ" case: open the first quote in edit mode.
    const firstQuote = Array.isArray(row.quotes) && row.quotes.length > 0 ? row.quotes[0] : null;
    if (firstQuote?.id) navigate(`/purchase/quotes/${firstQuote.id}/edit`);
  };

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Quote Responses"
        subtitle="RFQ-wise summary of vendor quote responses"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Quote Responses' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Quote')
            ? { createLink: '/purchase/quotes/new', createLabel: 'New Quote' }
            : {}),
        }}
      />
      <UnifiedFilterPanel filterFields={FILTER_FIELDS} filter={filter} showFilters={showFilters} onClose={() => setShowFilters(false)} />
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
          badge: (row) => row.evaluation_status === 'Evaluated'
            ? { label: 'Evaluated', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' }
            : { label: 'Pending',   cls: 'bg-amber-100 text-amber-700 border-amber-300' },
          fields: (row) => [
            { label: 'Date',    value: row.quote_date ? formatDate(row.quote_date) : null },
            { label: 'Valid',   value: row.price_valid_till ? formatDate(row.price_valid_till) : null },
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
      <div className="hidden sm:block">
        <DataTable persistKey="purchase-quotes"
          exportFileName="quote-responses-rfq"
          canExport={canExport('Quote')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={handleRowClick}
        />
      </div>
      </ListState>
    </MainLayout>
  );
}
