import { useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import MobileListCards from '../components/MobileListCards';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import UnifiedFilterPanel, { useUnifiedFilter } from '../components/UnifiedFilterPanel';
import { formatDate, formatCurrency } from '@/utils/formatters';
import ListState from '@/components/common/ListState.jsx';
import { FilterBar, ImportButton, useZohoFilters } from '../zoho/shared.jsx';

const FILTER_FIELDS = [
  { value: 'bill_no', label: 'SRA No', type: 'text' },
  { value: 'vendor_name', label: 'Vendor', type: 'text' },
  { value: 'vendor_invoice_no', label: 'Bill No', type: 'text' },
  { value: 'entry_date', label: 'Entry Date', type: 'date' },
  { value: 'bill_date', label: 'Bill Date', type: 'date' },
  { value: 'due_date', label: 'Due Date', type: 'date' },
  { value: 'status', label: 'Status', type: 'text' },
];

/**
 * Bills (Zoho) — imported SRA bills from Zoho Creator (backend
 * apps/purchase/zoho_views.py, table ZohoPurchaseBill). Data is imported by the
 * "Import from Zoho" button (not auto-pulled). Same columns as ERP Bills.
 */
export default function ZohoBillsList() {
  const f = useZohoFilters();
  const endpoint = `/api/purchase/zoho/bills/${f.query ? `?${f.query}` : ''}`;
  const { data, isLoading, error, refetch } = useApiData(endpoint);
  const { canExport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const filter = useUnifiedFilter(FILTER_FIELDS);

  const columns = [
    { key: 'bill_no', label: 'SRA No', sortable: true },
    { key: 'vendor_name', label: 'Vendor', sortable: true, render: (v) => v || '-' },
    { key: 'vendor_invoice_no', label: 'Bill No', sortable: true, render: (v) => v || '-' },
    { key: 'entry_date', label: 'Entry Date', sortable: true, render: (v) => (v ? formatDate(v) : '-') },
    { key: 'bill_date', label: 'Bill Date', sortable: true, render: (v) => (v ? formatDate(v) : '-') },
    { key: 'due_date', label: 'Due Date', sortable: true, render: (v) => (v ? formatDate(v) : '-') },
    { key: 'total_amount', label: 'Total', sortable: true, render: (v) => (v ? formatCurrency(v) : '-') },
    { key: 'amount_paid', label: 'Paid', sortable: true, render: (v) => (v != null ? formatCurrency(v) : '-') },
    {
      key: 'balance_due', label: 'Balance', sortable: true,
      render: (v) => {
        if (v == null || v === '') return '-';
        const bal = Number(v) || 0;
        return <span className={bal > 0 ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>{'₹'}{bal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>;
      },
    },
    { key: 'company', label: 'Company', sortable: true, render: (v) => v || '-' },
    { key: 'status_display', label: 'Status', render: (value, row) => (value || row.status ? <StatusBadge status={value || row.status} /> : '-') },
  ];

  const filteredData = (() => {
    let result = filter.filterData(data || []);
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter((row) =>
        Object.values(row).some((v) => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    result = [...result].sort((a, b) => new Date(a.entry_date || 0) - new Date(b.entry_date || 0));
    return result;
  })();

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Bills (Zoho)"
        subtitle="SRA bills imported from Zoho Creator"
        breadcrumbs={[{ label: 'Purchase' }, { label: 'Bills (Zoho)' }]}
        actions={{
          right: (
            <div className="flex flex-wrap items-center gap-2">
              <FilterBar f={f} />
              <ImportButton what="bills" label="Import bills" f={f} onDone={refetch} />
            </div>
          ),
          onFilter: () => setShowFilters(!showFilters),
        }}
      />
      <UnifiedFilterPanel filterFields={FILTER_FIELDS} filter={filter} showFilters={showFilters} onClose={() => setShowFilters(false)} />
      <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={filteredData}
          isLoading={isLoading}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder="Search SRA no, vendor, bill no…"
          emptyMessage="No Zoho bills yet — click “Import bills”."
          config={{
            title: (row) => row.bill_no || row.vendor_invoice_no,
            subtitle: (row) => row.vendor_name,
            badge: (row) => ({ label: row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' }),
            fields: (row) => [
              { label: 'Date', value: formatDate(row.bill_date) },
              { label: 'Total', value: row.total_amount ? formatCurrency(row.total_amount) : null, cls: 'font-medium' },
              { label: 'Balance', value: row.balance_due != null ? formatCurrency(row.balance_due) : null },
            ],
          }}
        />
        <div className="hidden sm:block">
          <DataTable persistKey="purchase-zoho-bills" exportFileName="zoho-bills" canExport={canExport('Vendor Bill')} columns={columns} data={filteredData} isLoading={isLoading} />
        </div>
      </ListState>
    </MainLayout>
  );
}
