import { confirm } from '@/components/common/confirm';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Plus, Eye, Pencil, Trash2, Filter, Settings2, GitBranch, RefreshCw } from 'lucide-react';
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
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import apiClient from '../../../utils/api.js';
import { useFlowDashboard } from '../../../components/common/FlowDashboardPopup';
import ListAttachments, { useListAttachments } from '../components/ListAttachments';
import { formatCurrency, formatDate } from '@/utils/formatters';
import ListState from '@/components/common/ListState.jsx';

export default function FreightDetailsList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canView } = usePermissions();
  const { isHidden } = useFieldPermissions('Sales Freight');
  // Flow header button — reuses Sales Flow Dashboard view permission.
  const canSeeFlow = canView('Sales Flow Dashboard');
  const { data, isLoading, error, refetch } = useApiData('/api/sales/freight-details/');
  const [searchTerm, setSearchTerm] = useState('');
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    company_name: '', status: '', customer_name: '',
  });
  const [page, setPage] = useUrlPage([searchTerm, filterValues]);
  const [showFilters, setShowFilters] = useState(false);
  const [advRules, setAdvRules] = useState([]);
  const [advLogic, setAdvLogic] = useState('AND');
  const { openFlow, FlowPopup } = useFlowDashboard();
  const { attachmentMap } = useListAttachments('FREIGHT_DETAIL');

  const filterColumns = [
    { field: 'freight_no', header: 'Freight No', type: 'text' },
    { field: 'freight_date', header: 'Date', type: 'date' },
    { field: 'company_name', header: 'Company', type: 'text' },
    { field: 'customer_name', header: 'Customer', type: 'text' },
    { field: 'transporter_name', header: 'Transporter', type: 'text' },
    { field: 'lorry_no', header: 'Lorry No', type: 'text' },
    { field: 'total_quantity', header: 'Total Qty', type: 'number' },
    { field: 'total_freight', header: 'Total Freight', type: 'number' },
    { field: 'balance_freight', header: 'Balance', type: 'number' },
    { field: 'destination', header: 'Destination', type: 'text' },
    { field: 'status', header: 'Status', type: 'select', filterOptions: [
      { value: 'PENDING', label: 'Pending' }, { value: 'IN_PROGRESS', label: 'In Progress' },
      { value: 'COMPLETED', label: 'Completed' }, { value: 'CANCELLED', label: 'Cancelled' },
    ]},
  ];

  const handleDelete = async (id, no) => {
    if (!(await confirm({ message: `Delete Freight Detail ${no}?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try { await apiClient.delete(`/api/sales/freight-details/${id}/`); toast.success('Deleted'); refetch(); }
    catch (err) { toast.error(err.response?.data?.detail || 'Failed'); }
  };

  const fmt = (v) => formatCurrency(v);

  const fmtDate = (v) => v ? formatDate(v) : '-';
  const Link = ({ to, children }) => <button onClick={(e) => { e.stopPropagation(); navigate(to); }} className="text-blue-700 hover:text-blue-900 hover:underline font-medium text-xs whitespace-nowrap">{children}</button>;

  const columns = [
    { field: 'freight_no', header: 'Freight No', sortable: true, width: '150px', render: (v, row) => <Link to={`/sales/freight-details/${row.id}`}>{v}</Link> },
    { field: 'freight_date', header: 'Date', sortable: true, width: '100px', render: (v) => fmtDate(v) },
    { field: 'company_name', header: 'Company', sortable: true, width: '140px' },
    { field: 'factory_name', header: 'Factory', sortable: true, width: '100px' },
    { field: 'customer_name', header: 'Customer', sortable: true, width: '140px' },
    { field: 'transporter_name', header: 'Transporter', sortable: true, width: '130px' },
    { field: 'lorry_no', header: 'Lorry No', sortable: true, width: '100px' },
    { field: 'total_quantity', header: 'Total Qty', sortable: true, width: '90px' },
    { field: 'freight_per_ton', header: 'Per Ton', sortable: true, width: '90px', render: (v) => fmt(v) },
    { field: 'total_freight', header: 'Total Freight', sortable: true, width: '110px', render: (v) => fmt(v) },
    { field: 'freight_paid', header: 'Paid', sortable: true, width: '100px', render: (v) => <span className="text-green-700">{fmt(v)}</span> },
    { field: 'balance_freight', header: 'Balance', sortable: true, width: '100px', render: (v) => <span className={Number(v) > 0 ? 'text-orange-600 font-medium' : 'text-slate-400'}>{fmt(v)}</span> },
    { field: 'destination', header: 'Destination', sortable: true, width: '120px' },
    { field: 'freight_type', header: 'Freight Type', sortable: true, width: '90px' },
    { field: 'destination_state', header: 'State', sortable: true, width: '80px' },
    { field: 'remarks', header: 'Remarks', sortable: false, width: '150px' },
    { field: 'dc_count', header: 'DCs', sortable: true, width: '50px' },
    { field: 'status', header: 'Status', sortable: true, width: '100px', render: (v) => <StatusBadge status={v} /> },
    { field: 'attachments', header: 'Photo Attachments', sortable: false, width: '140px',
      render: (_, row) => <ListAttachments attachments={attachmentMap[row.id]} /> },
    { field: 'actions', header: 'Actions', sortable: false, width: '110px', render: (_, row) => (
      <div className="flex items-center gap-1">
        <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/freight-details/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View"><Eye size={15} /></button>
        {/* Edit/Delete only while the freight detail is still PENDING —
            once it moves to IN_PROGRESS / COMPLETED / CANCELLED the
            row is locked (sales-module post-approval rule). */}
        {canEdit('Freight Advice') && row.status === 'PENDING' && (
          <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/freight-details/${row.id}/edit`); }} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded" title="Edit"><Pencil size={15} /></button>
        )}
        {canDelete('Freight Advice') && row.status === 'PENDING' && (
          <button onClick={(e) => { e.stopPropagation(); handleDelete(row.id, row.freight_no); }} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete"><Trash2 size={15} /></button>
        )}
      </div>
    )},
  ];

  // Strip columns the user's role HIDES via field permissions ('Sales
  // Freight'). The catalog keys here already carry the *_name suffix
  // (customer_name, transporter_name, company_name, factory_name), so the
  // column field is matched directly — no suffix stripping. `freight_no`
  // is the API name for the catalog's identifier (advice_no); it's the
  // primary link, so it's never dropped regardless. Never drop actions.
  const fieldGatedColumns = columns.filter((c) => {
    if (c.field === 'actions' || c.field === 'freight_no') return true;
    return !isHidden(c.field);
  });

  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(fieldGatedColumns, 'freight_details_fields', data);

  const companyFilterOptions = [...new Set((data || []).map(i => i.company_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));
  // Customer options cascade to the selected Company filter.
  const customerFilterOptions = [...new Set((filterValues.company_name
    ? (data || []).filter(i => (i.company_name || '') === filterValues.company_name)
    : (data || [])).map(i => i.customer_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));

  const filterOptions = [
    { key: 'company_name', label: 'Company', type: 'select', single: true, options: companyFilterOptions },
    { key: 'status', label: 'Status', options: [
      { value: 'PENDING', label: 'Pending' }, { value: 'IN_PROGRESS', label: 'In Progress' },
      { value: 'COMPLETED', label: 'Completed' }, { value: 'CANCELLED', label: 'Cancelled' },
    ]},
    { key: 'customer_name', label: 'Customer', type: 'select', options: customerFilterOptions },
  ];

  const filteredData = (() => {
    let result = (data || []).filter((item) => {
      const t = searchTerm.toLowerCase();
      const s = !t || [
        item.freight_no, item.customer_name, item.company_name, item.transporter_name,
        item.lorry_no, item.destination, item.total_freight, item.balance_freight,
        item.status,
      ].some(v => v != null && String(v).toLowerCase().includes(t));
      const f = matchesSelect(item.status, filterValues.status);
      const c = matchesSelect(item.customer_name, filterValues.customer_name);
      const co = !filterValues.company_name
        || (item.company_name || '') === filterValues.company_name;
      return s && f && c && co;
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
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900 truncate lg:whitespace-normal lg:overflow-visible">Freight Details</h1>
              <p className="hidden sm:block text-slate-600 mt-1 text-sm sm:text-base">Manage freight details entries</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 shrink-0">
            <button onClick={() => setShowFilters(!showFilters)} title="Filters" aria-label="Filters"
              className={`flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border rounded-lg text-sm font-medium transition ${showFilters ? 'bg-primary-50 text-primary-700 border-primary-300' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
              <Filter size={18} /> <span className="hidden sm:inline">Filters</span> {advRules.length > 0 && <span className="px-1.5 py-0.5 bg-primary-600 text-white rounded-full text-xs">{advRules.length}</span>}
            </button>
            <button onClick={() => setShowConfig(true)} title="Configure fields" aria-label="Configure fields" className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition"><Settings2 size={18} /> <span className="hidden sm:inline">Fields</span></button>
            {/* Generic "Flow" header button removed — see receivables/index.jsx for rationale. */}
            {canCreate('Freight Advice') && (
              <button onClick={() => navigate('/sales/freight-details/new')} className="flex items-center gap-2 px-3 sm:px-6 py-2 sm:py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm sm:text-base font-medium"><Plus size={18} /> <span className="hidden xs:inline">New </span>Freight Detail</button>
            )}
          </div>
        </div>
        {showFilters && (
          <FilterPanel columns={filterColumns} filters={filterOptions} values={filterValues}
            onChange={(k, v) => { if (k === 'company_name') { setFilterValue('company_name', v); setFilterValue('customer_name', ''); } else setFilterValue(k, v); }}
            onReset={() => { clearFilters(); setAdvRules([]); }} onClose={() => setShowFilters(false)}
            onAdvancedFilter={(rules, logic) => { setAdvRules(rules); setAdvLogic(logic); }} />
        )}
        <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={filteredData}
          isLoading={isLoading}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder="Search freight, customer, lorry…"
          onRowClick={(row) => navigate(`/sales/freight-details/${row.id}`)}
          emptyMessage="No freight details found"
          config={{
            title: (row) => row.freight_no || `FD #${row.id}`,
            subtitle: (row) => row.customer_name || row.transporter_name,
            badge: (row) => ({ label: row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' }),
            fields: (row) => [
              { label: 'Date',       value: fmtDate(row.freight_date) },
              { label: 'Transporter',value: row.transporter_name },
              { label: 'Lorry',      value: row.lorry_no },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/sales/freight-details/${row.id}`) },
            ],
          }}
        />

        <div className="hidden sm:block bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <DataTable columns={visibleColumns} data={filteredData} isLoading={isLoading} page={page} pageSize={10} totalRecords={filteredData.length}
            onPageChange={setPage} onSort={() => {}} onSearch={setSearchTerm} searchPlaceholder="Search freight no, customer, lorry..."
            onRowClick={(row) => navigate(`/sales/freight-details/${row.id}`)}
            exportFileName="freight-details" emptyMessage="No freight details found" />
        </div>
        </ListState>
      </div>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="freight_details_fields" />}
      {FlowPopup}
    </MainLayout>
  );
}
