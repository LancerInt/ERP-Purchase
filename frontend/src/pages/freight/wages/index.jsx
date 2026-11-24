import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import apiClient from '../../../utils/api.js';
import toast from 'react-hot-toast';
import { Trash2, Eye, IndianRupee, Clock, Users, RefreshCw } from 'lucide-react';
import MobileListCards from '../components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import { formatDate, formatCurrency } from '@/utils/formatters';

const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? formatDate(d) : '-';

export default function WageEntryList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/wage-entries/');
  const { canCreate, canDelete, canExport } = usePermissions();
  // Field-level column visibility for the Wage Entry list.
  const { isHidden } = useFieldPermissions('Wage Entry');

  // Domain filters live in the URL so Back / refresh / sharing restore them.
  const [statusFilter, setStatusFilter] = useUrlState('status', '');
  // Standard period navigator (All / Today / Week / Month / FY / Custom).
  const period = usePeriodFilter('all');
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const entries = useMemo(() => data || [], [data]);

  const filtered = useMemo(() => {
    let result = entries;
    if (statusFilter) result = result.filter(e => e.status === statusFilter);
    result = result.filter(e => period.match(e.date));
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(e =>
        (e.entry_no || '').toLowerCase().includes(s) ||
        (e.receipt_no || '').toLowerCase().includes(s) ||
        (e.vendor_name || '').toLowerCase().includes(s) ||
        (e.po_numbers || []).join(', ').toLowerCase().includes(s)
      );
    }
    return result;
  }, [entries, statusFilter, period, search]);

  const summary = useMemo(() => {
    const totalAmt = filtered.reduce((s, e) => s + (Number(e.total_amount) || 0), 0);
    const totalAdv = filtered.reduce((s, e) => s + (Number(e.total_advance) || 0), 0);
    const totalBal = filtered.reduce((s, e) => s + (Number(e.total_balance) || 0), 0);
    return { count: filtered.length, totalAmt, totalAdv, totalBal };
  }, [filtered]);

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Delete ${row.entry_no}?`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/purchase/wage-entries/${row.id}/`);
      toast.success(`${row.entry_no} deleted`);
      refetch();
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to delete'); }
  };

  const columns = [
    { key: 'entry_no', label: 'Entry No', sortable: true, render: (v, row) => (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/wages/${row.id}`); }} className="text-primary-600 hover:underline font-medium">{v}</button>
    )},
    { key: 'date', label: 'Date', sortable: true, render: v => fmtDate(v) },
    { key: 'receipt_no', label: 'Receipt No', sortable: true, render: (v, row) => row.receipt ? (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/receipts/${row.receipt}`); }} className="text-primary-600 hover:underline text-xs">{v}</button>
    ) : '-' },
    { key: 'po_numbers', label: 'PO No', sortable: false, render: v => (v || []).join(', ') || '-' },
    { key: 'vendor_name', label: 'Vendor', sortable: true },
    { key: 'line_count', label: 'Rows', sortable: true },
    { key: 'total_amount', label: 'Total Amount', sortable: true, render: v => <span className="font-semibold">{fmt(v)}</span> },
    { key: 'total_advance', label: 'Advance', sortable: true, render: v => <span className="text-emerald-700">{fmt(v)}</span> },
    { key: 'total_balance', label: 'Balance', sortable: true, render: v => <span className={Number(v) > 0 ? 'text-orange-600 font-semibold' : 'text-slate-400'}>{fmt(v)}</span> },
    { key: 'status_display', label: 'Status', sortable: true, render: (v, row) => <StatusBadge status={v || row.status} /> },
    { key: 'actions', label: '', sortable: false, render: (_, row) => (
      <div className="flex items-center gap-1">
        <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/wages/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View"><Eye size={15} /></button>
        {canDelete('Wage Entry') && (
          <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete"><Trash2 size={15} /></button>
        )}
      </div>
    )},
  ];

  // Hide columns the 'Wage Entry' field-permission map marks HIDDEN.
  // Entry No (identifier/link) and row actions always stay.
  const NEVER_HIDE = new Set(['entry_no', 'po_numbers', 'vendor_name', 'line_count', 'total_amount', 'total_advance', 'total_balance', 'actions']);
  const COLUMN_KEY_ALIAS = { receipt_no: 'receipt' };
  const keyFor = (col) => COLUMN_KEY_ALIAS[col.key] || col.key.replace(/_(name|code|display)$/, '');
  const visibleColumns = columns.filter(c => NEVER_HIDE.has(c.key) || !isHidden(keyFor(c)));

  const inputClass = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

  return (
    <MainLayout>
      <PageHeader
        title="Loading / Unloading Wages"
        subtitle="Manage contractor wage entries for purchase receipts"
        breadcrumbs={[{ label: 'Freight & Billing', href: '/freight/inward' }, { label: 'Wages' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Wage Entry') ? { createLink: '/freight/wages/new', createLabel: 'New Wage Entry' } : {}),
        }}
      />

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Total Entries</p><p className="text-xl font-bold text-slate-900 mt-1">{summary.count}</p></div>
            <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center"><Users size={20} className="text-slate-600" /></div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Total Wages</p><p className="text-xl font-bold text-slate-900 mt-1">{fmt(summary.totalAmt)}</p></div>
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center"><IndianRupee size={20} className="text-blue-600" /></div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Advance Paid</p><p className="text-xl font-bold text-emerald-700 mt-1">{fmt(summary.totalAdv)}</p></div>
            <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center"><IndianRupee size={20} className="text-emerald-600" /></div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Balance Pending</p><p className="text-xl font-bold text-orange-600 mt-1">{fmt(summary.totalBal)}</p></div>
            <div className="w-10 h-10 rounded-lg bg-orange-50 flex items-center justify-center"><Clock size={20} className="text-orange-600" /></div>
          </div>
        </div>
      </div>

      {/* Period + search — always visible. */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4 mb-3 sm:mb-4 flex flex-wrap items-center gap-3">
        <PeriodNavigator allowAll {...period.navProps} />
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Entry no, receipt, vendor..." className={`${inputClass} flex-1 min-w-[180px]`} />
      </div>

      {/* Filters — toggled by header Filters button. */}
      {showFilters && (
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4 mb-3 sm:mb-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 sm:gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
              <CustomSelect value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={inputClass + ' w-full'}>
                <option value="">All Status</option>
                <option value="DRAFT">Draft</option>
                <option value="CONFIRMED">Confirmed</option>
                <option value="CLOSED">Closed</option>
                <option value="CANCELLED">Cancelled</option>
              </CustomSelect>
            </div>
          </div>
        </div>
      )}

      <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={filtered}
          isLoading={isLoading}
          emptyMessage="No wage entries found"
          config={{
            title: (row) => row.entry_no || row.id,
            subtitle: (row) => row.contractor_name || row.worker_name,
            badge: (row) => ({ label: row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' }),
            fields: (row) => [
              { label: 'Date',   value: row.entry_date ? formatDate(row.entry_date) : null },
              { label: 'Type',   value: row.wage_type || row.activity_type },
              { label: 'Amount', value: row.amount ? formatCurrency(row.amount) : null, cls: 'font-medium' },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/freight/wages/${row.id}`) },
            ],
          }}
          onRowClick={(row) => navigate(`/freight/wages/${row.id}`)}
        />
        <div className="hidden sm:block">
          <DataTable persistKey="freight-wages"
            exportFileName="loading-unloading-wages"
            canExport={canExport('Wage Entry')}
            columns={visibleColumns}
            data={filtered}
            isLoading={isLoading}
            onRowClick={(row) => navigate(`/freight/wages/${row.id}`)}
            searchable exportable pagination
          />
        </div>
      </ListState>
    </MainLayout>
  );
}
