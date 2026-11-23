/**
 * Sales -> Receipts — money RECEIVED from customers.
 *
 * The mirror of Purchase -> Payments Made, and the page that was missing:
 * Receivables lists what is OWED, which is what the word means, so there was
 * nowhere to see what had actually come in. Both sides now read the same way —
 * one page for the obligation, one for the settlement.
 *
 * Read-only by design. A receipt is created either by settling a receivable or
 * by importing a bank statement, and BOTH also move
 * ReceivableLedger.amount_paid. Editing one here without unwinding the invoice
 * would leave it part-paid for money that no longer exists, so corrections go
 * through those flows instead.
 *
 * The statement import is on this page for the same reason it is on Payments
 * Made: this is where you are standing when you think about receipts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, Eye } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import ImportStatementModal from '@/components/common/ImportStatementModal.jsx';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

export default function SalesReceipts() {
  const navigate = useNavigate();
  // This endpoint answers with ONE ROW PER TALLY RECEIPT VOUCHER, under `rows`
  // -- not a paginated `results` list. useApiData only unwraps `results` (or a
  // bare array), so it handed this page an empty list every time and the table
  // said "No receipts yet" on a company with thousands of them, while
  // Receivables > Receipts read the very same endpoint correctly.
  const [data, setData] = useState(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [search, setSearch] = useState('');

  const refetch = useCallback(() => {
    setLoading(true);
    apiClient.get('/api/sales/receivables/receipts/')
      .then((r) => { setData(r.data); setError(null); })
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { refetch(); }, [refetch]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = data?.rows || [];
    if (!q) return all;
    return all.filter((r) => [r.customer_name, r.label, r.company_name]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }, [data, search]);

  const total = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.total) || 0), 0), [rows]);

  // The fields this endpoint actually emits. The old list named payment_date /
  // invoice_no / amount / reference_no / bank_account_name, none of which exist
  // on a row here, so every cell would have been blank and the footer zero even
  // once the rows arrived.
  const columns = [
    { field: 'date', header: 'Date', width: '110px', render: (v) => formatDate(v) },
    // One clear link per receipt — the voucher opens its invoice breakdown
    // (which bills the money settled). Previously the only link went to the
    // customer, so there was no way to see a receipt's own invoices (item 11).
    {
      field: 'label', header: 'Voucher', width: '150px',
      render: (v, row) => (row.id
        ? <button
            onClick={() => navigate(
              `/sales/receivables/receipt/${encodeURIComponent(row.id)}${row.customer_id ? `?customer=${encodeURIComponent(row.customer_id)}` : ''}`)}
            className="text-blue-700 hover:underline font-medium text-left">
            {v || 'Receipt'}
          </button>
        : (v || '—')),
    },
    { field: 'customer_name', header: 'Customer', width: '220px' },
    { field: 'company_name', header: 'Company', width: '150px', render: (v) => v || '—' },
    {
      field: 'applied', header: 'Against bills', width: '130px',
      render: (v) => <span className="tabular-nums">{formatCurrency(v)}</span>,
    },
    {
      // Money banked that no bill has taken yet — a real and expected state,
      // not missing data.
      field: 'unapplied', header: 'On account', width: '120px',
      render: (v) => (Number(v) ? <span className="tabular-nums text-amber-700">{formatCurrency(v)}</span>
        : <span className="text-slate-400">—</span>),
    },
    {
      field: 'total', header: 'Received', width: '130px',
      render: (v) => <span className="tabular-nums text-green-700 font-medium">{formatCurrency(v)}</span>,
    },
    { field: 'invoice_count', header: 'Bills', width: '70px',
      render: (v) => <span className="tabular-nums">{v || 0}</span> },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Receipts"
        subtitle="Money received from customers"
        breadcrumbs={[{ label: 'Sales', href: '/sales/dashboard' }, { label: 'Receipts' }]}
        actions={{
          right: (
            <button
              type="button"
              onClick={() => setShowImport(true)}
              title="Import a bank statement (CSV/Excel/PDF) and record the receipts in it"
              className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <Upload size={14} />
              Import Bank Statement
            </button>
          ),
        }}
      />

      <div className="bg-white rounded-lg border border-slate-200 mb-3 px-3 py-2 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer, voucher, company…"
          className="h-8 flex-1 min-w-[200px] rounded-lg border border-slate-300 px-2 text-xs"
        />
        <span className="text-[11px] text-slate-400 tabular-nums">
          {rows.length} receipt(s) · {formatCurrency(total)}
        </span>
      </div>

      <ListState error={error} onRetry={refetch}>
        <DataTable
          persistKey="sales-receipts"
          exportFileName="receipts"
          columns={columns}
          data={rows}
          isLoading={isLoading}
          emptyMessage="No receipts yet — import a bank statement to record what has come in."
          actions={(row) => [
            {
              icon: Eye, label: 'Open customer', cls: 'text-blue-700 hover:bg-blue-50',
              onClick: () => row.customer_id
                && navigate(`/sales/customer-insights?customer=${row.customer_id}`),
            },
          ]}
        />
      </ListState>

      {showImport && (
        <ImportStatementModal
          side="credit"
          onClose={() => setShowImport(false)}
          onRecorded={refetch}
        />
      )}
    </MainLayout>
  );
}
