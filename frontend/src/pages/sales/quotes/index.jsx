import { useNavigate } from 'react-router-dom';
import { Plus, MessageSquare } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

export default function SalesQuotesList() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const { data, isLoading } = useApiData('/api/sales/quotations/');

  const all = Array.isArray(data) ? data : (data?.results || []);

  const columns = [
    { field: 'quote_no', header: 'Quote No', sortable: true, width: '150px', render: (v) => <span className="font-medium text-primary-600">{v}</span> },
    { field: 'customer_name', header: 'Customer', sortable: true, width: '180px' },
    { field: 'quote_date', header: 'Date', sortable: true, width: '110px', render: (v) => (v ? formatDate(v) : '-') },
    { field: 'valid_until', header: 'Valid Until', sortable: true, width: '110px', render: (v) => (v ? formatDate(v) : '-') },
    { field: 'total_amount', header: 'Total', sortable: true, width: '130px', render: (v) => <span className="font-semibold">{formatCurrency(v)}</span> },
    { field: 'status', header: 'Status', sortable: true, width: '120px', render: (v, row) => <StatusBadge status={row.status_display || v} /> },
    { field: 'converted_so_no', header: 'Sales Order', sortable: false, width: '130px', render: (v) => v || '-' },
  ];

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-3xl font-bold text-slate-900 truncate">Sales Quotations</h1>
            <p className="hidden sm:block text-slate-600 mt-1 text-sm sm:text-base">Price quotes sent to customers</p>
          </div>
          {canCreate('Sales Quote') && (
            <button onClick={() => navigate('/sales/quotes/new')}
              className="flex items-center gap-2 px-3 sm:px-6 py-2 sm:py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm sm:text-base font-medium shrink-0">
              <Plus size={18} /> <span className="hidden xs:inline">New </span>Quote
            </button>
          )}
        </div>

        <DataTable persistKey="sales-quotes"
          columns={columns}
          data={all}
          isLoading={isLoading}
          pageSize={15}
          searchPlaceholder="Search by quote no or customer…"
          extraSearchFields={['quote_no', 'customer_name']}
          onRowClick={(row) => navigate(`/sales/quotes/${row.id}`)}
          emptyMessage="No quotations yet."
          emptyIcon={MessageSquare}
        />
      </div>
    </MainLayout>
  );
}
