import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ProductsCell from '../../../components/common/ProductsCell';
import { Pencil, FileText, Trash2, Eye, Mail, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import UnifiedFilterPanel, { useUnifiedFilter } from '../components/UnifiedFilterPanel';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const FILTER_FIELDS = [
  { value: 'rfq_no', label: 'RFQ No', type: 'text' },
  { value: 'created_by_name', label: 'Created By', type: 'text' },
  { value: 'creation_date', label: 'Creation Date', type: 'date' },
  { value: 'rfq_mode', label: 'RFQ Mode', type: 'select', options: [
    { value: 'Email', label: 'Email' }, { value: 'Portal', label: 'Portal' }, { value: 'Phone', label: 'Phone' },
  ]},
  { value: 'rfq_status', label: 'RFQ Status', type: 'select', options: [
    { value: 'Open', label: 'Open' }, { value: 'Closed', label: 'Closed' }, { value: 'Cancelled', label: 'Cancelled' },
  ]},
];

export default function RFQList() {
  const navigate = useNavigate();
  const { canSendEmail, canCreate, canEdit, canDelete, canExport, canQuoteResponse } = usePermissions();
  const { isHidden } = useFieldPermissions('RFQ');
  // Quote Response button on each RFQ row is gated on the dedicated
  // `can_quote_response` flag (admin grid → RFQ row → Quote Response
  // column), NOT the broader Quote-create permission. That way an
  // admin can let a buyer record a vendor reply without also granting
  // them the ability to invent stand-alone quotes outside any RFQ.
  const canRecordQuoteResponse = canQuoteResponse('RFQ');
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/rfq/');
  const [showFilters, setShowFilters] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const filter = useUnifiedFilter(FILTER_FIELDS);

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Are you sure you want to delete ${row.rfq_no}? This action cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/rfq/${row.id}/`);
      toast.success(`${row.rfq_no} deleted successfully`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const columns = [
    { key: 'rfq_no', label: 'RFQ No', sortable: true },
    { key: 'linked_pr_numbers', label: 'Linked PRs', sortable: false, render: (value, row) => {
      if (!Array.isArray(value) || value.length === 0) return '-';
      const prIds = Array.isArray(row.linked_prs) ? row.linked_prs : [];
      return value.map((prNo, i) => (
        <span key={i}>{i > 0 && ', '}{prIds[i] ? (
          <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/requests/${prIds[i]}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{prNo}</button>
        ) : prNo}</span>
      ));
    }},
    { key: 'product_names', label: 'Products', sortable: false, render: (value) => <ProductsCell names={value} /> },
    { key: 'created_by_name', label: 'Created By', sortable: true, render: (v) => v || '—' },
    {
      key: 'creation_date', label: 'Creation Date', sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    { key: 'rfq_mode', label: 'RFQ Mode', sortable: true },
    {
      key: 'rfq_status', label: 'RFQ Status',
      render: (value) => <StatusBadge status={value} />,
    },
    { key: 'quote_count_expected', label: 'Expected Quotes', sortable: true },
    {
      key: 'actions', label: 'Actions', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
          {canEdit('RFQ') && (
            <button onClick={() => navigate(`/purchase/rfq/${row.id}`)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="Edit">
              <Pencil size={15} />
            </button>
          )}
          {canSendEmail('RFQ') && !row.email_sent && (
            <button onClick={() => navigate(`/purchase/rfq/${row.id}/send-email`)} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 transition" title="Send RFQ Email">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
              Email
            </button>
          )}
          {row.email_sent && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-lg">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              Email Sent
            </span>
          )}
          {canRecordQuoteResponse && row.email_sent && (
            <button
              onClick={() => { if (!row.is_evaluated) navigate(`/purchase/quotes/new?rfq=${row.id}`); }}
              disabled={!!row.is_evaluated}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg transition ${
                row.is_evaluated
                  ? 'text-slate-400 bg-slate-100 cursor-not-allowed'
                  : 'text-purple-700 bg-purple-50 hover:bg-purple-100'
              }`}
              title={row.is_evaluated
                ? 'Quotes for this RFQ have already been evaluated — new responses are locked'
                : 'Create Quote Response'}
            >
              <FileText size={13} />
              Quote Response
            </button>
          )}
          {canDelete('RFQ') && (
            <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // Remove columns whose underlying field is HIDDEN for this role. Never
  // drop the actions column or the primary identifier (rfq_no). Columns
  // not present in the field catalog stay visible.
  const visibleColumns = columns.filter((col) => {
    if (!col.key || col.key === 'actions' || col.key === 'rfq_no') return true;
    // Map list column keys to their catalog field key by meaning.
    const catalogKeyByColumn = {
      linked_pr_numbers: 'linked_prs',
      rfq_mode: 'rfq_mode',
      rfq_status: 'rfq_status',
      quote_count_expected: 'quote_count_expected',
    };
    const catalogKey = catalogKeyByColumn[col.key];
    return catalogKey ? !isHidden(catalogKey) : true;
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
        title="Request for Quotation"
        subtitle="Manage RFQs sent to vendors"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'RFQ' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('RFQ') ? { createLink: '/purchase/rfq/new', createLabel: 'New RFQ' } : {}),
        }}
      />
      <UnifiedFilterPanel filterFields={FILTER_FIELDS} filter={filter} showFilters={showFilters} onClose={() => setShowFilters(false)} />
      <ListState error={error} onRetry={refetch}>
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search RFQ no, status…"
        emptyMessage="No RFQs found"
        config={{
          title: (row) => row.rfq_no,
          subtitle: (row) => row.created_by_name || '—',
          badge: (row) => {
            const s = row.rfq_status;
            const map = {
              Open:      { label: 'Open',      cls: 'bg-blue-100 text-blue-800 border-blue-300' },
              Closed:    { label: 'Closed',    cls: 'bg-slate-200 text-slate-700 border-slate-300' },
              Cancelled: { label: 'Cancelled', cls: 'bg-red-100 text-red-700 border-red-300' },
            };
            return map[s] || { label: s || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
          },
          fields: (row) => [
            { label: 'Date',     value: formatDate(row.creation_date) },
            { label: 'Mode',     value: row.rfq_mode },
            { label: 'Quotes',   value: row.quote_count_expected },
            { label: 'PRs',      value: (row.linked_pr_numbers || []).join(', ') || null },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/rfq/${row.id}`) },
            { icon: Mail, label: 'Email', cls: 'text-primary-700 hover:bg-primary-50', hidden: !(canSendEmail('RFQ') && !row.email_sent), onClick: () => navigate(`/purchase/rfq/${row.id}/send-email`) },
            {
              icon: FileText,
              label: row.is_evaluated ? 'Evaluated' : 'Quote',
              cls: row.is_evaluated
                ? 'text-slate-400 bg-slate-100 cursor-not-allowed'
                : 'text-purple-700 hover:bg-purple-50',
              hidden: !(canRecordQuoteResponse && row.email_sent),
              disabled: !!row.is_evaluated,
              onClick: () => { if (!row.is_evaluated) navigate(`/purchase/quotes/new?rfq=${row.id}`); },
            },
          ],
        }}
        onRowClick={(row) => navigate(`/purchase/rfq/${row.id}`)}
      />
      <div className="hidden sm:block">
        <DataTable persistKey="purchase-rfq" exportFileName="rfq-list" canExport={canExport('RFQ')} columns={visibleColumns} data={filteredData} onRowClick={(row) => navigate(`/purchase/rfq/${row.id}`)} isLoading={isLoading} />
      </div>
      </ListState>
    </MainLayout>
  );
}
