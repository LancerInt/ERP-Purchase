import { confirm } from '@/components/common/confirm';
import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Plus, Eye, Pencil, Trash2, Filter, Settings2, GitBranch, RefreshCw, Upload, Paperclip, Loader2 } from 'lucide-react';
import useLookup from '../../../hooks/useLookup.js';
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

export default function OutwardFreightList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canView } = usePermissions();
  // Flow header button — reuses Sales Flow Dashboard view permission.
  const canSeeFlow = canView('Sales Flow Dashboard');
  const { data, isLoading, error, refetch } = useApiData('/api/sales/freight/');
  const [sortBy, setSortBy] = useState('created_date');
  const [sortOrder, setSortOrder] = useState('desc');
  const [searchTerm, setSearchTerm] = useState('');
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    company_name: '', status: '', customer_name: '', transporter_name: '',
  });
  const [page, setPage] = useUrlPage([searchTerm, filterValues]);
  const [showFilters, setShowFilters] = useState(false);
  const [advRules, setAdvRules] = useState([]);
  const [advLogic, setAdvLogic] = useState('AND');
  const { openFlow, FlowPopup } = useFlowDashboard();
  const { attachmentMap } = useListAttachments('FREIGHT');
  // Upload Register (Excel/CSV) + per-row slip attach
  const { options: companyOptions } = useLookup('/api/companies/');
  const [showUpload, setShowUpload] = useState(false);
  const [uploadCompany, setUploadCompany] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const attachInputRef = useRef(null);
  const [attachRow, setAttachRow] = useState(null);

  const filterColumns = [
    { field: 'advice_no', header: 'Freight No', type: 'text' },
    { field: 'freight_date', header: 'Date', type: 'date' },
    { field: 'customer_name', header: 'Customer', type: 'text' },
    { field: 'company_name', header: 'Company', type: 'text' },
    { field: 'transporter_name', header: 'Transporter', type: 'text' },
    { field: 'lorry_no', header: 'Lorry No', type: 'text' },
    { field: 'destination', header: 'Destination', type: 'text' },
    { field: 'base_amount', header: 'Base Amount', type: 'number' },
    { field: 'payable_amount', header: 'Payable', type: 'number' },
    { field: 'total_paid', header: 'Paid', type: 'number' },
    { field: 'balance', header: 'Balance', type: 'number' },
    { field: 'status', header: 'Status', type: 'select', filterOptions: [
      { value: 'PENDING', label: 'Pending' }, { value: 'PARTIALLY_PAID', label: 'Partially Paid' },
      { value: 'PAID', label: 'Paid' }, { value: 'CANCELLED', label: 'Cancelled' },
    ]},
  ];

  const handleDelete = async (id, adviceNo) => {
    if (!(await confirm({ message: `Delete Freight ${adviceNo}?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/freight/${id}/`);
      toast.success(`Freight ${adviceNo} deleted`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const doUpload = async () => {
    if (!uploadCompany) { toast.error('Pick a company first.'); return; }
    if (!uploadFile) { toast.error('Choose an Excel / CSV file.'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      fd.append('company', uploadCompany);
      const r = await apiClient.post('/api/sales/freight/import-register/', fd,
        { headers: { 'Content-Type': 'multipart/form-data' } });
      const s = r.data || {};
      toast.success(`Loaded ${s.freights} freight(s)${s.rebuilt ? ` (${s.rebuilt} updated)` : ''}, ${s.payments} payment(s), ${s.new_transporters} new transporter(s).`);
      setShowUpload(false); setUploadFile(null); refetch();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed — check the file.');
    } finally { setUploading(false); }
  };

  const onAttachPick = (row) => { setAttachRow(row); attachInputRef.current?.click(); };
  const onAttachFile = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file || !attachRow) return;
    try {
      const fd = new FormData();
      fd.append('module', 'FREIGHT'); fd.append('record_id', attachRow.id); fd.append('file', file);
      await apiClient.post('/api/sales/attachments/', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`Slip attached to ${attachRow.advice_no}.`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Could not attach the slip.');
    } finally { setAttachRow(null); }
  };

  const fmt = (v) => formatCurrency(v);

  const fmtDate = (v) => v ? formatDate(v) : '-';
  const Link = ({ to, children }) => <button onClick={(e) => { e.stopPropagation(); navigate(to); }} className="text-blue-700 hover:text-blue-900 hover:underline font-medium text-xs whitespace-nowrap">{children}</button>;

  const columns = [
    { field: 'advice_no', header: 'Freight No', sortable: true, width: '150px', render: (v, row) => <Link to={`/sales/freight/${row.id}`}>{v}</Link> },
    { field: 'freight_date', header: 'Date', sortable: true, width: '100px', render: (v) => fmtDate(v) },
    { field: 'customer_name', header: 'Customer', sortable: true, width: '140px' },
    { field: 'company_name', header: 'Company', sortable: true, width: '140px' },
    { field: 'transporter_name', header: 'Transporter', sortable: true, width: '130px' },
    { field: 'lorry_no', header: 'Lorry No', sortable: true, width: '100px' },
    { field: 'destination', header: 'Destination', sortable: true, width: '120px' },
    // Costs
    { field: 'base_amount', header: 'Base Amount', sortable: true, width: '110px', render: (v) => fmt(v) },
    { field: 'invoice_date', header: 'Invoice Date', sortable: true, width: '100px', render: (v) => fmtDate(v) },
    { field: 'remarks', header: 'Remarks', sortable: false, width: '150px' },
    // Totals
    { field: 'payable_amount', header: 'Payable', sortable: true, width: '110px', render: (v) => <span className="font-semibold">{fmt(v)}</span> },
    { field: 'total_paid', header: 'Paid', sortable: true, width: '100px', render: (v) => <span className="text-emerald-700 font-medium">{fmt(v)}</span> },
    { field: 'balance', header: 'Balance', sortable: true, width: '100px', render: (v) => <span className={`font-medium ${Number(v) > 0 ? 'text-orange-600' : 'text-slate-400'}`}>{fmt(v)}</span> },
    { field: 'dc_count', header: 'DCs', sortable: true, width: '50px' },
    { field: 'status', header: 'Status', sortable: true, width: '120px', render: (v) => <StatusBadge status={v} /> },
    { field: 'attachments', header: 'Photo Attachments', sortable: false, width: '140px',
      render: (_, row) => <ListAttachments attachments={attachmentMap[row.id]} /> },
    { field: 'actions', header: 'Actions', sortable: false, width: '140px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/freight/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View"><Eye size={15} /></button>
          <button onClick={(e) => { e.stopPropagation(); onAttachPick(row); }}
            className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded" title="Attach slip (img/PDF)"><Paperclip size={15} /></button>
          {/* Row-level Flow shortcut — deep-links to the freight's
              parent SO when one is set. Replaces the generic header
              "Flow" button that was removed. */}
          {canSeeFlow && row.linked_so_id && (
            <button onClick={(e) => { e.stopPropagation(); openFlow(row.linked_so_id); }}
              className="p-1.5 text-purple-600 hover:bg-purple-50 rounded" title="Flow"><GitBranch size={15} /></button>
          )}
          {/* Edit/Delete only while the freight is still PENDING — once
              a payment lands (PARTIALLY_PAID / PAID) or the row is
              CANCELLED, it is locked (sales-module post-approval rule). */}
          {canEdit('Freight Advice') && row.status === 'PENDING' && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/freight/${row.id}/edit`); }}
              className="p-1.5 text-amber-600 hover:bg-amber-50 rounded" title="Edit"><Pencil size={15} /></button>
          )}
          {canDelete('Freight Advice') && row.status === 'PENDING' && (
            <button onClick={(e) => { e.stopPropagation(); handleDelete(row.id, row.advice_no); }}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete"><Trash2 size={15} /></button>
          )}
        </div>
      ),
    },
  ];

  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'outward_freight_fields', data);

  const companyFilterOptions = [...new Set((data || []).map(i => i.company_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));
  // Customer options cascade to the selected Company filter.
  const customerFilterOptions = [...new Set((filterValues.company_name
    ? (data || []).filter(i => (i.company_name || '') === filterValues.company_name)
    : (data || [])).map(i => i.customer_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));
  const transporterFilterOptions = [...new Set((data || []).map(i => i.transporter_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));

  const filterOptions = [
    { key: 'company_name', label: 'Company', type: 'select', single: true, options: companyFilterOptions },
    { key: 'status', label: 'Status', options: [
      { value: 'PENDING', label: 'Pending' },
      { value: 'PARTIALLY_PAID', label: 'Partially Paid' },
      { value: 'PAID', label: 'Paid' },
      { value: 'CANCELLED', label: 'Cancelled' },
    ]},
    { key: 'customer_name',    label: 'Customer',    type: 'select', options: customerFilterOptions },
    { key: 'transporter_name', label: 'Transporter', type: 'select', options: transporterFilterOptions },
  ];

  const filteredData = (() => {
    let result = (data || []).filter((item) => {
      const term = searchTerm.toLowerCase();
      const matchesSearch = !term || [
        item.advice_no, item.advice_date, item.customer_name, item.company_name,
        item.transporter_name, item.lorry_no, item.dc_no, item.so_no,
        item.total_amount, item.total_paid, item.balance, item.status,
      ].some(v => v != null && String(v).toLowerCase().includes(term));
      const matchesCompany = !filterValues.company_name
        || (item.company_name || '') === filterValues.company_name;
      const matchesStatus = matchesSelect(item.status, filterValues.status);
      const matchesCustomer = matchesSelect(item.customer_name, filterValues.customer_name);
      const matchesTransporter = matchesSelect(item.transporter_name, filterValues.transporter_name);
      return matchesSearch && matchesCompany && matchesStatus && matchesCustomer && matchesTransporter;
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
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900 truncate lg:whitespace-normal lg:overflow-visible">Outward Freight</h1>
              <p className="hidden sm:block text-slate-600 mt-1 text-sm sm:text-base">Manage outward freight and payments</p>
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
              <button onClick={() => setShowUpload(true)} title="Upload a freight register (Excel/CSV)" className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border border-emerald-300 text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100 transition text-sm font-medium"><Upload size={18} /> <span className="hidden sm:inline">Upload Register</span></button>
            )}
            {canCreate('Freight Advice') && (
              <button onClick={() => navigate('/sales/freight/new')} className="flex items-center gap-2 px-3 sm:px-6 py-2 sm:py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm sm:text-base font-medium"><Plus size={18} /> <span className="hidden xs:inline">New </span>Outward Freight</button>
            )}
          </div>
        </div>

        {/* Hidden input for the per-row slip attach */}
        <input ref={attachInputRef} type="file" accept="image/*,.pdf" className="hidden" onChange={onAttachFile} />

        {/* Upload Register (Excel / CSV) modal */}
        {showUpload && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !uploading && setShowUpload(false)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-slate-800 mb-1">Upload Freight Register</h3>
              <p className="text-xs text-slate-500 mb-4">Excel or CSV — one freight per <b>Freight No</b>, payment rows merge, transporters matched/created. Re-uploading updates (no duplicates).</p>
              <label className="block text-xs font-medium text-slate-500 mb-1">Company</label>
              <select value={uploadCompany} onChange={(e) => setUploadCompany(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3">
                <option value="">— select —</option>
                {(companyOptions || []).map((co) => <option key={co.value} value={co.value}>{co.label}</option>)}
              </select>
              <label className="block text-xs font-medium text-slate-500 mb-1">Register file (.xlsx / .csv)</label>
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} className="w-full text-sm mb-4" />
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowUpload(false)} disabled={uploading} className="px-3 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
                <button onClick={doUpload} disabled={uploading} className="px-4 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-2">{uploading && <Loader2 size={14} className="animate-spin" />}Upload</button>
              </div>
            </div>
          </div>
        )}

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
            onRowClick={(row) => navigate(`/sales/freight/${row.id}`)}
            emptyMessage="No outward freight records found"
            config={{
              title: (row) => row.advice_no || row.freight_no || `Freight #${row.id}`,
              subtitle: (row) => row.customer_name || row.transporter_name,
              badge: (row) => ({ label: row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' }),
              fields: (row) => [
                { label: 'Date',       value: fmtDate(row.freight_date) },
                { label: 'Transporter',value: row.transporter_name },
                { label: 'Lorry',      value: row.lorry_no },
              ],
              actions: (row) => [
                { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/sales/freight/${row.id}`) },
              ],
            }}
          />

          <div className="hidden sm:block bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <DataTable columns={visibleColumns} data={filteredData} isLoading={isLoading} page={page} pageSize={10}
              totalRecords={filteredData.length} onPageChange={setPage}
              onSort={(f, o) => { setSortBy(f); setSortOrder(o); }} sortBy={sortBy} sortOrder={sortOrder}
              onSearch={setSearchTerm} searchPlaceholder="Search freight no, customer, transporter, lorry..."
              onRowClick={(row) => navigate(`/sales/freight/${row.id}`)}
              exportFileName="outward-freight" emptyMessage="No outward freight records found" />
          </div>
        </ListState>
      </div>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="outward_freight_fields" />}
      {FlowPopup}
    </MainLayout>
  );
}
