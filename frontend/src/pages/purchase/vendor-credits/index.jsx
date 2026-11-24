import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import { Pencil, Trash2, Eye, RefreshCw } from 'lucide-react';
import MobileListCards from '../components/MobileListCards';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import UnifiedFilterPanel, { useUnifiedFilter } from '../components/UnifiedFilterPanel';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import { formatDate, formatCurrency } from '@/utils/formatters';

const FILTER_FIELDS = [
  { value: 'credit_no', label: 'Credit No', type: 'text' },
  { value: 'vendor_name', label: 'Vendor', type: 'text' },
  { value: 'credit_type', label: 'Type', type: 'select', options: [
    { value: 'CREDIT', label: 'Credit Note' }, { value: 'DEBIT', label: 'Debit Note' },
  ]},
  { value: 'credit_date', label: 'Date', type: 'date' },
  { value: 'status', label: 'Status', type: 'select', options: [
    { value: 'DRAFT', label: 'Draft' }, { value: 'OPEN', label: 'Open' },
    { value: 'APPLIED', label: 'Applied' }, { value: 'CLOSED', label: 'Closed' },
    { value: 'CANCELLED', label: 'Cancelled' },
  ]},
];

export default function VendorCreditList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/vendor-credits/');
  const { canCreate, canEdit, canDelete, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Vendor Credit');
  const [showFilters, setShowFilters] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const filter = useUnifiedFilter(FILTER_FIELDS);

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Are you sure you want to delete ${row.credit_no}? This action cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/vendor-credits/${row.id}/`);
      toast.success(`${row.credit_no} deleted successfully`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const columns = [
    { key: 'credit_no', label: 'Credit No', sortable: true },
    { key: 'vendor_name', label: 'Vendor', sortable: true },
    {
      key: 'credit_type_display', label: 'Type',
      render: (value, row) => (
        <span className={`px-2 py-1 rounded text-xs font-medium ${row.credit_type === 'CREDIT' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
          {value || row.credit_type}
        </span>
      ),
    },
    {
      key: 'credit_date', label: 'Date', sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'total_amount', label: 'Total', sortable: true,
      render: (value) => `\u20B9${(Number(value) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
    },
    {
      key: 'amount_applied', label: 'Applied',
      render: (value) => `\u20B9${(Number(value) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
    },
    {
      key: 'balance', label: 'Balance',
      render: (value) => {
        const bal = Number(value) || 0;
        return (
          <span className={bal > 0 ? 'text-blue-600 font-medium' : 'text-slate-500'}>
            {'\u20B9'}{bal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </span>
        );
      },
    },
    {
      key: 'status_display', label: 'Status',
      render: (value, row) => <StatusBadge status={value || row.status} />,
    },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canEdit('Vendor Credit') && row.status === 'DRAFT' && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/vendor-credits/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="Edit">
              <Pencil size={15} />
            </button>
          )}
          {canDelete('Vendor Credit') && row.status === 'DRAFT' && (
            <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // Gate hidden purchase columns. Never drop the primary identifier (credit_no)
  // or the actions column. Map column keys to catalog keys by stripping the
  // trailing _name/_code/_display suffix when that yields a catalog key.
  const CATALOG_KEYS = ['credit_no', 'vendor', 'bill', 'credit_type', 'credit_date', 'reason', 'subtotal', 'tax_amount', 'total_amount', 'amount_applied', 'status', 'notes'];
  const visibleColumns = columns.filter((col) => {
    if (!col.key || col.key === 'actions' || col.key === 'credit_no') return true;
    let catalogKey = col.key;
    const stripped = col.key.replace(/_(name|code|display)$/, '');
    if (stripped !== col.key && CATALOG_KEYS.includes(stripped)) catalogKey = stripped;
    return !isHidden(catalogKey);
  });

  const filteredData = (() => {
    let result = filter.filterData(data || []);
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    return result;
  })();

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Vendor Notes & Advances"
        subtitle="Manage vendor credit notes, debit notes and advance payments"
        breadcrumbs={[{ label: 'Purchase', href: '/purchase/dashboard' }, { label: 'Vendor Notes & Advances' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Vendor Credit') ? { createLink: '/purchase/vendor-credits/new', createLabel: 'New Credit Note' } : {}),
        }}
      />
      <UnifiedFilterPanel filterFields={FILTER_FIELDS} filter={filter} showFilters={showFilters} onClose={() => setShowFilters(false)} />
      <ListState error={error} onRetry={refetch}>
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search credit no, vendor, bill…"
        emptyMessage="No vendor credits found"
        config={{
          title: (row) => row.credit_no,
          subtitle: (row) => row.vendor_name,
          badge: (row) => ({ label: row.status_display || row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' }),
          fields: (row) => [
            { label: 'Date',   value: row.credit_date ? formatDate(row.credit_date) : null },
            { label: 'Amount', value: row.amount ? formatCurrency(row.amount) : null, cls: 'font-medium' },
            { label: 'Bill',   value: row.bill_no },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/vendor-credits/${row.id}`) },
          ],
        }}
        onRowClick={(row) => navigate(`/purchase/vendor-credits/${row.id}`)}
      />
      <div className="hidden sm:block">
        <DataTable persistKey="purchase-vendor-credits" exportFileName="vendor-credits" canExport={canExport('Vendor Credit')} columns={visibleColumns} data={filteredData} isLoading={isLoading} onRowClick={(row) => navigate(`/purchase/vendor-credits/${row.id}`)} />
      </div>
      </ListState>
    </MainLayout>
  );
}
