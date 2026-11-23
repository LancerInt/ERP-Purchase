import { confirm } from '@/components/common/confirm';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Plus, Eye, Pencil, Trash2, Filter, Settings2, GitBranch, FileText, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import BackToModule from '../../../components/common/BackToModule';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import FilterPanel, { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import useApiData from '../../../hooks/useApiData.js';
import useUrlPage from '../../../hooks/useUrlPage.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import MobileListCards from '../components/MobileListCards';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { useFlowDashboard } from '../../../components/common/FlowDashboardPopup';
import ListAttachments, { useListAttachments } from '../components/ListAttachments';
import { formatCurrency, formatDate } from '@/utils/formatters';
import ListState from '@/components/common/ListState.jsx';

export default function FreightPaymentsList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canView } = usePermissions();
  // Flow header button — reuses Sales Flow Dashboard view permission.
  const canSeeFlow = canView('Sales Flow Dashboard');
  const { data, isLoading, error, refetch } = useApiData('/api/sales/freight-payments/');
  const [sortBy, setSortBy] = useState('payment_date');
  const [sortOrder, setSortOrder] = useState('desc');
  const [searchTerm, setSearchTerm] = useState('');
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    payment_mode: '', customer_name: '', company_name: '', transporter_name: '',
  });
  const [page, setPage] = useUrlPage([searchTerm, filterValues]);
  const [showFilters, setShowFilters] = useState(false);
  const [advRules, setAdvRules] = useState([]);
  const [advLogic, setAdvLogic] = useState('AND');
  const { openFlow, FlowPopup } = useFlowDashboard();
  const { attachmentMap } = useListAttachments('FREIGHT_PAYMENT');

  const filterColumns = [
    { field: 'advice_no', header: 'Freight No', type: 'text' },
    { field: 'customer_name', header: 'Customer', type: 'text' },
    { field: 'payment_date', header: 'Payment Date', type: 'date' },
    { field: 'amount_paid', header: 'Amount', type: 'number' },
    { field: 'payment_mode', header: 'Mode', type: 'select', filterOptions: [
      { value: 'CASH', label: 'Cash' }, { value: 'BANK', label: 'Bank Transfer' },
      { value: 'UPI', label: 'UPI' }, { value: 'CHEQUE', label: 'Cheque' },
      { value: 'NEFT', label: 'NEFT' }, { value: 'RTGS', label: 'RTGS' },
    ]},
    { field: 'reference_no', header: 'Reference No', type: 'text' },
  ];

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Delete this payment?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/freight-payments/${id}/`);
      toast.success('Payment deleted');
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const fmt = (v) => formatCurrency(v);
  const fmtDate = (v) => v ? formatDate(v) : '-';
  const Link = ({ to, children }) => (
    <button onClick={(e) => { e.stopPropagation(); navigate(to); }} className="text-blue-700 hover:text-blue-900 hover:underline font-medium text-xs whitespace-nowrap">{children}</button>
  );

  const PAYMENT_MODE_MAP = { CASH: 'Cash', BANK: 'Bank Transfer', UPI: 'UPI', CHEQUE: 'Cheque', NEFT: 'NEFT', RTGS: 'RTGS', OTHER: 'Other' };

  const columns = [
    { field: 'advice_no', header: 'Freight No', sortable: true, width: '160px', render: (v, row) => <Link to={`/sales/freight/${row.freight_id}`}>{v}</Link> },
    { field: 'transporter_name', header: 'Transporter', sortable: true, width: '150px' },
    { field: 'customer_name', header: 'Customer', sortable: true, width: '150px' },
    { field: 'company_name', header: 'Company', sortable: true, width: '140px',
      render: (v) => v || <span className="text-xs text-slate-400">-</span> },
    { field: 'payment_date', header: 'Payment Date', sortable: true, width: '120px', render: (v) => fmtDate(v) },
    { field: 'amount_paid', header: 'Amount', sortable: true, width: '120px', render: (v) => <span className="font-semibold text-emerald-700">{fmt(v)}</span> },
    { field: 'payment_mode', header: 'Mode', sortable: true, width: '120px', render: (v) => PAYMENT_MODE_MAP[v] || v },
    { field: 'reference_no', header: 'Reference No', sortable: true, width: '140px', render: (v) => v || '-' },
    { field: 'remarks', header: 'Remarks', sortable: false, width: '160px', render: (v) => v || '-' },
    { field: 'attachments', header: 'Photo Attachments', sortable: false, width: '140px',
      render: (_, row) => <ListAttachments attachments={attachmentMap[row.id]} /> },
    { field: 'actions', header: 'Actions', sortable: false, width: '120px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/freight-payments/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View"><Eye size={15} /></button>
          {canEdit('Freight Advice') && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/freight-payments/${row.id}/edit`); }}
              className="p-1.5 text-amber-600 hover:bg-amber-50 rounded" title="Edit"><Pencil size={15} /></button>
          )}
          {canDelete('Freight Advice') && (
            <button onClick={(e) => { e.stopPropagation(); handleDelete(row.id); }}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete"><Trash2 size={15} /></button>
          )}
        </div>
      ),
    },
  ];

  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'freight_payments_fields', data);

  // Dynamic filter dropdowns built from values that already exist on
  // loaded rows — no dead options.
  const customerFilterOptions = [...new Set((data || []).map(i => i.customer_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));
  const companyFilterOptions = [...new Set((data || []).map(i => i.company_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));
  const transporterFilterOptions = [...new Set((data || []).map(i => i.transporter_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));

  const filterOptions = [
    { key: 'payment_mode', label: 'Payment Mode', type: 'select', options: [
      { value: 'CASH', label: 'Cash' }, { value: 'BANK', label: 'Bank Transfer' },
      { value: 'UPI', label: 'UPI' }, { value: 'CHEQUE', label: 'Cheque' },
      { value: 'NEFT', label: 'NEFT' }, { value: 'RTGS', label: 'RTGS' },
    ]},
    { key: 'customer_name',    label: 'Customer',    type: 'select', options: customerFilterOptions },
    { key: 'company_name',     label: 'Company',     type: 'select', options: companyFilterOptions },
    { key: 'transporter_name', label: 'Transporter', type: 'select', options: transporterFilterOptions },
  ];

  const filteredData = (() => {
    let result = (data || []).filter((item) => {
      const term = searchTerm.toLowerCase();
      // Search now sweeps every user-visible field so typing any value
      // on the page (customer, company, transporter, amount, payment
      // mode, etc.) filters the rows.
      const matchesSearch = !term || [
        item.advice_no, item.customer_name, item.company_name, item.transporter_name,
        item.reference_no, item.payment_mode, item.payment_date,
        item.amount_paid, item.remarks,
      ].some(v => v != null && String(v).toLowerCase().includes(term));
      const matchesMode = matchesSelect(item.payment_mode, filterValues.payment_mode);
      const matchesCustomer = matchesSelect(item.customer_name, filterValues.customer_name);
      const matchesCompany = matchesSelect(item.company_name, filterValues.company_name);
      const matchesTransporter = matchesSelect(item.transporter_name, filterValues.transporter_name);
      return matchesSearch && matchesMode && matchesCustomer && matchesCompany && matchesTransporter;
    });
    if (advRules.length > 0) result = applyAdvancedFilters(result, advRules, advLogic);
    return result;
  })();

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-x-2 sm:gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 sm:min-w-[15rem] flex items-center gap-1.5">
            <BackToModule />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900 truncate lg:whitespace-normal lg:overflow-visible">Freight Payments</h1>
              <p className="hidden sm:block text-slate-600 mt-1 text-sm sm:text-base">Track payments made against outward freight</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 shrink-0">
            <button onClick={() => setShowFilters(!showFilters)} title="Filters" aria-label="Filters"
              className={`flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border rounded-lg text-sm font-medium transition ${showFilters ? 'bg-primary-50 text-primary-700 border-primary-300' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
              <Filter size={18} /> <span className="hidden sm:inline">Filters</span> {advRules.length > 0 && <span className="px-1.5 py-0.5 bg-primary-600 text-white rounded-full text-xs">{advRules.length}</span>}
            </button>
            <button onClick={() => setShowConfig(true)} title="Configure fields" aria-label="Configure fields" className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition"><Settings2 size={18} /> <span className="hidden sm:inline">Fields</span></button>
            {/* Generic "Flow" header button removed — see receivables/index.jsx for rationale. */}
            <button onClick={() => navigate('/sales/freight-payments/statement')} title="Statement" aria-label="Statement" className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border border-emerald-300 rounded-lg text-sm font-medium text-emerald-700 hover:bg-emerald-50 transition"><FileText size={18} /> <span className="hidden sm:inline">Statement</span></button>
            {canCreate('Freight Advice') && (
              <button onClick={() => navigate('/sales/freight-payments/new')} className="flex items-center gap-2 px-3 sm:px-6 py-2 sm:py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm sm:text-base font-medium"><Plus size={18} /> Record Payment</button>
            )}
          </div>
        </div>
        {showFilters && (
          <FilterPanel columns={filterColumns} filters={filterOptions} values={filterValues}
            onChange={(k, v) => setFilterValue(k, v)}
            onReset={() => { clearFilters(); setAdvRules([]); }} onClose={() => setShowFilters(false)}
            onAdvancedFilter={(rules, logic) => { setAdvRules(rules); setAdvLogic(logic); }} />
        )}
        <ListState error={error} onRetry={refetch}>
          <MobileListCards
            rows={filteredData}
            isLoading={isLoading}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            searchPlaceholder="Search freight, customer, ref…"
            onRowClick={(row) => navigate(`/sales/freight-payments/${row.id}`)}
            emptyMessage="No payment records found"
            config={{
              title: (row) => row.payment_id || row.reference_no || `Payment #${row.id}`,
              subtitle: (row) => row.customer_name || row.freight_no,
              fields: (row) => [
                { label: 'Date',   value: fmtDate(row.payment_date) },
                { label: 'Freight',value: row.freight_no },
                { label: 'Amount', value: row.amount_paid != null ? formatCurrency(row.amount_paid) : null, cls: 'text-slate-800 font-medium' },
                { label: 'Ref',    value: row.reference_no },
              ],
              actions: (row) => [
                { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/sales/freight-payments/${row.id}`) },
              ],
            }}
          />

          <div className="hidden sm:block bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <DataTable columns={visibleColumns} data={filteredData} page={page} pageSize={10}
              isLoading={isLoading}
              totalRecords={filteredData.length} onPageChange={setPage}
              onSort={(f, o) => { setSortBy(f); setSortOrder(o); }} sortBy={sortBy} sortOrder={sortOrder}
              onSearch={setSearchTerm} searchPlaceholder="Search freight no, customer, reference..."
              onRowClick={(row) => navigate(`/sales/freight-payments/${row.id}`)}
              exportFileName="freight-payments" emptyMessage="No payment records found" />
          </div>
        </ListState>
      </div>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="freight_payments_fields" />}
      {FlowPopup}
    </MainLayout>
  );
}
