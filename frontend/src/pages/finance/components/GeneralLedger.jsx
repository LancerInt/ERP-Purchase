import { useState } from 'react';
import { Link } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import useApiData from '../../../hooks/useApiData.js';
import useUrlPage from '../../../hooks/useUrlPage.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatDate, formatCurrency } from '@/utils/formatters';
import SummaryBar from '@/components/common/SummaryBar.jsx';
import exportToExcel from '@/utils/exportExcel.js';

// Default date window for the initial load — without this, every open of any
// ledger page re-fetched and re-transmitted the company's ENTIRE transaction
// history, forever, growing every month as more data piles up (confirmed via
// Render's metrics: repeated 100-300MB response spikes and rising p90 latency
// tracking data growth, not traffic). Balances are still computed from the
// party's FULL history server-side either way — only which rows get shipped
// to the browser is bounded. Widen or clear the Date From/To filters (or hit
// Reset) to see further back; nothing is permanently hidden.
const DEFAULT_WINDOW_DAYS = 180;
const _isoDaysAgo = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

/**
 * Reusable general-ledger table for the Finance module. Renders the standard
 * ledger columns (#, Date, Type, Reference, Party, Particulars, Debit,
 * Credit, running Balance, Status) from an aggregation endpoint that returns
 * { results: [...rows with precomputed balance], totals }.
 *
 * Props:
 *   endpoint      — API path (e.g. '/api/finance/vendor-ledger-entries/')
 *   title, subtitle, breadcrumbLabel
 *   partyLabel    — column header for the party ('Vendor' | 'Customer' | 'Transporter')
 *   moduleName    — permission module for the export gate
 *   exportName    — export file name
 *   showDirection — add an Inbound/Outbound column (freight)
 */
export default function GeneralLedger({
  endpoint,
  title,
  subtitle,
  breadcrumbLabel,
  partyLabel = 'Party',
  statusLabel = 'Status',
  moduleName,
  exportName = 'ledger',
  showDirection = false,
  showBank = false,
  // Optional per-row action rendered in a trailing column. `(row) => ReactNode
  // | null` — return null to render nothing for that row. Used by the Freight
  // Ledger for its inline "Import to Tally" button; other ledgers omit it.
  rowAction,
}) {
  const { canExport } = usePermissions();
  const [sortBy, setSortBy] = useState('sno');
  const [sortOrder, setSortOrder] = useState('asc');
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  // Dropdown filters live in the URL so Back / refresh / sharing restore them —
  // and a `?party=<name>` deep link from another page (e.g. a payment detail)
  // lands pre-filtered to that party automatically (same `party` param), instead
  // of making the operator re-pick from the dropdown.
  const { values: urlFilters, setValue: setUrlFilter, reset: resetUrlFilters } = useUrlFilters({
    party: '', entry: '', status: '', doc_type: '', direction: '',
  });
  // date_from/date_to stay in local state: the FIRST load is seeded with a
  // default bounded window (see DEFAULT_WINDOW_DAYS) and Reset clears it to
  // all-time — a "fresh default vs explicitly cleared" distinction the URL
  // (where both read as absent) can't carry.
  const [dateRange, setDateRange] = useState(() => ({ date_from: _isoDaysAgo(DEFAULT_WINDOW_DAYS) }));
  const filterValues = { ...urlFilters, ...dateRange };
  const setFilterValue = (k, v) => {
    if (k === 'date_from' || k === 'date_to') setDateRange((p) => ({ ...p, [k]: v }));
    else setUrlFilter(k, v);
  };
  // Advanced (rule-builder) filter state, applied on top of the simple filters.
  const [advRules, setAdvRules] = useState([]);
  const [advLogic, setAdvLogic] = useState('AND');
  // URL-backed page number; declared after its filter deps to avoid a temporal
  // dead zone (referencing searchTerm/filterValues before they exist crashes).
  const [page, setPage] = useUrlPage([searchTerm, filterValues]);

  // date_from/date_to are sent to the SERVER (which still computes each
  // party's balance from their full history — only the response is trimmed);
  // every other filter stays client-side over whatever that returns.
  const dateQuery = new URLSearchParams();
  if (filterValues.date_from) dateQuery.set('date_from', filterValues.date_from);
  if (filterValues.date_to) dateQuery.set('date_to', filterValues.date_to);
  const fetchEndpoint = dateQuery.toString() ? `${endpoint}?${dateQuery.toString()}` : endpoint;
  const { data, isLoading, error, refetch } = useApiData(fetchEndpoint);

  const rows = data || [];
  // Distinct parties + statuses actually present in the ledger, so the
  // dropdown filters only offer real values.
  const uniq = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort();
  const partyOptions = uniq('party').map((v) => ({ value: v, label: v }));
  const statusOptions = uniq('status').map((v) => ({ value: v, label: v }));

  const money = (v) => (Number(v) ? formatCurrency(v) : '-');

  // When the ledger is already filtered to a single party, the party column is
  // redundant — hide it so the table focuses on that vendor/customer's entries.
  const hideParty = !!filterValues.party;

  const columns = [
    { field: 'sno', header: '#', sortable: true, width: '56px' },
    { field: 'date', header: 'Date', sortable: true, width: '110px', render: (v) => formatDate(v) },
    { field: 'doc_type', header: 'Type', sortable: true, width: '110px' },
    {
      field: 'reference', header: 'Reference', sortable: true, width: '170px',
      // Reference No links to the source record (bill / invoice / payment /
      // freight / voucher) when the backend provides a row.link.
      render: (v, row) => (row?.link
        ? <Link to={row.link} onClick={(e) => e.stopPropagation()} className="text-primary-600 hover:text-primary-700 hover:underline font-medium">{v || '-'}</Link>
        : (v || '-')),
    },
    ...(showDirection ? [{ field: 'direction', header: 'Direction', sortable: true, width: '110px' }] : []),
    ...(hideParty ? [] : [{ field: 'party', header: partyLabel, sortable: true, width: '200px' }]),
    { field: 'particulars', header: 'Particulars', sortable: false, width: '240px' },
    {
      field: 'debit', header: 'Debit', sortable: true, width: '120px',
      render: (v) => <span className="text-rose-700 font-medium">{money(v)}</span>,
    },
    {
      field: 'credit', header: 'Credit', sortable: true, width: '120px',
      render: (v) => <span className="text-emerald-700 font-medium">{money(v)}</span>,
    },
    {
      field: 'balance', header: 'Balance', sortable: true, width: '130px',
      render: (v) => <span className="font-semibold text-slate-800">{formatCurrency(v)}</span>,
    },
    { field: 'status', header: 'Status', sortable: true, width: '120px', render: (v) => (v ? <StatusBadge status={v} /> : '-') },
    // Beneficiary bank details (freight ledger only) — where the transporter
    // is paid. Shown after Status so the money columns stay together.
    ...(showBank ? [
      { field: 'beneficiary_name', header: 'Beneficiary', sortable: true, width: '170px', render: (v) => v || '-' },
      { field: 'bank_name', header: 'Bank', sortable: true, width: '150px', render: (v) => v || '-' },
      { field: 'account_no', header: 'A/C No', sortable: true, width: '150px', render: (v) => v || '-' },
      { field: 'ifsc_code', header: 'IFSC', sortable: true, width: '120px', render: (v) => v || '-' },
    ] : []),
    ...(rowAction ? [{
      field: '_action', header: '', sortable: false, width: '160px',
      render: (_, row) => rowAction(row),
    }] : []),
  ];

  // Derived from the rows actually loaded so every doc_type present (Bill,
  // Invoice, Wage Voucher, Expense, Opening, Top-up, Voucher, …) is filterable.
  // A hardcoded list drifted as new ledger sources were added and silently
  // dropped those types from the dropdown.
  const typeOptions = uniq('doc_type').map((v) => ({ value: v, label: v }));
  const directionOptions = [{ value: 'Inbound', label: 'Inbound' }, { value: 'Outbound', label: 'Outbound' }];

  const entryOptions = [{ value: 'credit', label: 'Credit' }, { value: 'debit', label: 'Debit' }];

  // Simple-mode filters (dropdowns + a date range via date_from/date_to).
  const filterConfig = [
    // Single-select: `hideParty` reads this value as a scalar to drop the party
    // column once the ledger is narrowed to one party — a multi-value list can't
    // drive that "single party" behaviour.
    { key: 'party', label: partyLabel, type: 'select', options: partyOptions, single: true },
    // Single-select: the value is read as a scalar ('credit' | 'debit') to test
    // the row's credit/debit amount, not compared against a row field.
    { key: 'entry', label: 'Credit / Debit', type: 'select', options: entryOptions, single: true },
    { key: 'status', label: statusLabel, type: 'select', options: statusOptions },
    { key: 'doc_type', label: 'Type', type: 'select', options: typeOptions },
    ...(showDirection ? [{ key: 'direction', label: 'Direction', type: 'select', options: directionOptions }] : []),
    { key: 'date_from', label: 'Date From', type: 'date' },
    { key: 'date_to', label: 'Date To', type: 'date' },
  ];

  // Advanced-mode (rule-builder) fields. Each maps to a REAL row field so the
  // rules actually filter the ledger data — unlike the simple-mode synthetic
  // date_from/date_to range keys, which have no matching row property.
  const advancedFields = [
    { field: 'date', header: 'Date', type: 'date' },
    { field: 'doc_type', header: 'Type', type: 'select', options: typeOptions },
    { field: 'reference', header: 'Reference', type: 'text' },
    ...(showDirection ? [{ field: 'direction', header: 'Direction', type: 'select', options: directionOptions }] : []),
    { field: 'party', header: partyLabel, type: 'select', options: partyOptions },
    { field: 'particulars', header: 'Particulars', type: 'text' },
    { field: 'debit', header: 'Debit', type: 'number' },
    { field: 'credit', header: 'Credit', type: 'number' },
    { field: 'balance', header: 'Balance', type: 'number' },
    { field: 'status', header: statusLabel, type: 'select', options: statusOptions },
  ];

  const simpleFiltered = rows.filter((r) => {
    const s = searchTerm.toLowerCase();
    const matchesSearch = !s
      || (r.party || '').toLowerCase().includes(s)
      || (r.reference || '').toLowerCase().includes(s)
      || (r.particulars || '').toLowerCase().includes(s);
    const matchesParty = matchesSelect(r.party, filterValues.party);
    const matchesStatus = matchesSelect(r.status, filterValues.status);
    const matchesType = matchesSelect(r.doc_type, filterValues.doc_type);
    const matchesDir = matchesSelect(r.direction, filterValues.direction);
    // Credit / Debit filter: a row is a "credit" entry when its credit amount
    // is non-zero, a "debit" entry when its debit amount is non-zero.
    const matchesEntry = !filterValues.entry
      || (filterValues.entry === 'credit' ? Number(r.credit) > 0 : Number(r.debit) > 0);
    const matchesFrom = !filterValues.date_from || (r.date || '') >= filterValues.date_from;
    const matchesTo = !filterValues.date_to || (r.date || '') <= filterValues.date_to;
    return matchesSearch && matchesParty && matchesStatus && matchesType && matchesDir && matchesEntry && matchesFrom && matchesTo;
  });
  // Layer the Advanced rule-builder result on top of the simple filters.
  const filtered = applyAdvancedFilters(simpleFiltered, advRules, advLogic);

  const totalDebit = filtered.reduce((s, r) => s + Number(r.debit || 0), 0);
  const totalCredit = filtered.reduce((s, r) => s + Number(r.credit || 0), 0);
  // Closing balance = the sum of each visible party's own latest balance
  // among the FILTERED rows (so it respects every active filter — date
  // range, party, status, type, credit/debit, search — instead of always
  // showing today's whole-book figure). `balance` on each row is already
  // that party's own running total (see backend _finalise), so summing each
  // party's most recent one here still equals the old single running total
  // when nothing is filtered — this is strictly more correct, not a
  // different number for the unfiltered/all-parties view.
  const closing = (() => {
    if (!filtered.length) return 0;
    const latestByParty = new Map();
    for (const r of filtered) {
      const prev = latestByParty.get(r.party);
      if (!prev || Number(r.sno) > Number(prev.sno)) latestByParty.set(r.party, r);
    }
    let sum = 0;
    for (const r of latestByParty.values()) sum += Number(r.balance || 0);
    return sum;
  })();
  const ledgerTotals = [
    { label: 'Total Debit', value: formatCurrency(totalDebit), tone: 'debit' },
    { label: 'Total Credit', value: formatCurrency(totalCredit), tone: 'credit' },
    { label: 'Closing Balance', value: formatCurrency(closing), tone: 'balance' },
  ];

  // Custom Excel export so the file ends with a TOTAL row (Total Debit /
  // Total Credit / Closing Balance), matching the on-screen summary. Numbers
  // are exported as real numbers so the cells sum/format correctly in Excel.
  const handleExport = () => {
    const exportColumns = [
      { field: 'sno', header: '#' },
      { field: 'date', header: 'Date' },
      { field: 'doc_type', header: 'Type' },
      { field: 'reference', header: 'Reference' },
      ...(showDirection ? [{ field: 'direction', header: 'Direction' }] : []),
      { field: 'party', header: partyLabel },
      { field: 'particulars', header: 'Particulars' },
      { field: 'debit', header: 'Debit' },
      { field: 'credit', header: 'Credit' },
      { field: 'balance', header: 'Balance' },
      { field: 'status', header: 'Status' },
      ...(showBank ? [
        { field: 'beneficiary_name', header: 'Beneficiary' },
        { field: 'bank_name', header: 'Bank' },
        { field: 'account_no', header: 'A/C No' },
        { field: 'ifsc_code', header: 'IFSC' },
      ] : []),
    ];
    const exportRows = filtered.map((r) => ({
      sno: r.sno,
      date: r.date,
      doc_type: r.doc_type,
      reference: r.reference,
      direction: r.direction || '',
      party: r.party,
      particulars: r.particulars,
      ...(showBank ? {
        beneficiary_name: r.beneficiary_name || '',
        bank_name: r.bank_name || '',
        account_no: r.account_no || '',
        ifsc_code: r.ifsc_code || '',
      } : {}),
      debit: Number(r.debit || 0),
      credit: Number(r.credit || 0),
      balance: Number(r.balance || 0),
      status: r.status,
    }));
    exportRows.push({
      sno: '', date: '', doc_type: '', reference: '', direction: '',
      party: '', particulars: 'TOTAL',
      debit: Number(totalDebit.toFixed(2)),
      credit: Number(totalCredit.toFixed(2)),
      balance: Number(closing.toFixed(2)),
      status: '',
    });
    exportToExcel(exportRows, exportColumns, exportName, title);
  };

  const breadcrumbs = [{ label: 'Finance', href: '/finance' }, { label: breadcrumbLabel }];

  return (
    <MainLayout>
      <div className="space-y-4 sm:space-y-5">
        <PageHeader
          title={title}
          subtitle={subtitle}
          breadcrumbs={breadcrumbs}
          actions={{ onFilter: () => setShowFilters(!showFilters) }}
        />
        {showFilters && (
          <FilterPanel
            filters={filterConfig}
            columns={advancedFields}
            values={filterValues}
            onChange={(k, v) => setFilterValue(k, v)}
            onReset={() => { resetUrlFilters(); setDateRange({}); setAdvRules([]); setAdvLogic('AND'); }}
            onAdvancedFilter={(rules, logic) => { setAdvRules(rules); setAdvLogic(logic); }}
            onClose={() => setShowFilters(false)}
          />
        )}
        <p className="text-xs text-slate-500 -mt-2">
          {filterValues.date_from || filterValues.date_to
            ? <>Showing {filterValues.date_from ? `from ${filterValues.date_from}` : 'from the start'}
              {' '}{filterValues.date_to ? `to ${filterValues.date_to}` : 'onward'}.{' '}</>
            : 'Showing all-time. '}
          Use Filters to change the date range{filterValues.date_from || filterValues.date_to ? ', or Reset to see everything' : ''}.
        </p>
        <ListState error={error} onRetry={refetch}>
          <SummaryBar items={ledgerTotals} />
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <DataTable
              exportFileName={exportName}
              canExport={canExport(moduleName)}
              onExport={handleExport}
              columns={columns}
              data={filtered}
              isLoading={isLoading}
              page={page}
              pageSize={15}
              totalRecords={filtered.length}
              onPageChange={setPage}
              onSort={(f, o) => { setSortBy(f); setSortOrder(o); }}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSearch={setSearchTerm}
              searchPlaceholder={`Search by ${partyLabel.toLowerCase()}, reference or particulars...`}
              emptyMessage="No ledger entries found"
            />
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}
