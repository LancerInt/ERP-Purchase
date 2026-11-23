import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, Trash2, IndianRupee, CheckCircle2, Clock, Users, RefreshCw } from 'lucide-react';
import MainLayout from '../../../../components/layout/MainLayout';
import PageHeader from '../../../../components/common/PageHeader';
import DataTable from '../../../../components/common/DataTable';
import StatusBadge from '../../../../components/common/StatusBadge';
import useApiData from '../../../../hooks/useApiData.js';
import usePermissions from '../../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../../hooks/useFieldPermissions.js';
import { useUrlState } from '../../../../hooks/useUrlState.js';
import apiClient from '../../../../utils/api.js';
import toast from 'react-hot-toast';
import MobileListCards from '../../components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import { formatDate } from '@/utils/formatters';

const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? formatDate(d) : '-';

const CYCLE_LABEL = { WEEKLY: 'Weekly', FOURTEEN_DAYS: '14 Days', CUSTOM: 'Custom' };

export default function WagePaymentList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/wage-payments/');
  const { canCreate, canDelete, canExport } = usePermissions();
  // Field-level column visibility for the Wage Payment list.
  const { isHidden } = useFieldPermissions('Wage Payment');

  // Domain filters live in the URL so Back / refresh / sharing restore them.
  const [statusFilter, setStatusFilter] = useUrlState('status', '');
  const [cycleFilter, setCycleFilter] = useUrlState('cycle', '');
  const [dateFrom, setDateFrom] = useUrlState('from', '');
  const [dateTo, setDateTo] = useUrlState('to', '');
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const payments = useMemo(() => data || [], [data]);

  const filtered = useMemo(() => {
    let r = payments;
    if (statusFilter) r = r.filter(p => p.status === statusFilter);
    if (cycleFilter)  r = r.filter(p => p.cycle_type === cycleFilter);
    if (dateFrom)     r = r.filter(p => p.payment_date >= dateFrom);
    if (dateTo)       r = r.filter(p => p.payment_date <= dateTo);
    if (search) {
      const s = search.toLowerCase();
      r = r.filter(p =>
        (p.payment_no || '').toLowerCase().includes(s) ||
        (p.contractor_name || '').toLowerCase().includes(s) ||
        (p.reference_no || '').toLowerCase().includes(s),
      );
    }
    return r;
  }, [payments, statusFilter, cycleFilter, dateFrom, dateTo, search]);

  const summary = useMemo(() => {
    const live = filtered.filter(p => p.status !== 'CANCELLED');
    return {
      count: live.length,
      gross: live.reduce((s, p) => s + (Number(p.gross_wages) || 0), 0),
      paid:  live.reduce((s, p) => s + (Number(p.paid_amount) || 0), 0),
      balance: live.reduce((s, p) => s + (Number(p.balance_amount) || 0), 0),
    };
  }, [filtered]);

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Cancel payment ${row.payment_no}? Selected wage lines will be released back to UNPAID.`, isDangerous: true }))) return;
    try {
      await apiClient.post(`/api/purchase/wage-payments/${row.id}/cancel/`);
      toast.success(`${row.payment_no} cancelled — lines released`);
      refetch();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to cancel'); }
  };

  const columns = [
    { key: 'payment_no', label: 'Payment No', sortable: true, render: (v, row) => (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/wages/payments/${row.id}`); }} className="text-primary-600 hover:underline font-medium">{v}</button>
    )},
    { key: 'payment_date', label: 'Payment Date', sortable: true, render: v => fmtDate(v) },
    { key: 'contractor_name', label: 'Contractor / Vendor', sortable: true },
    { key: 'cycle_type', label: 'Cycle', sortable: true, render: v => CYCLE_LABEL[v] || v },
    { key: 'from_date', label: 'From', sortable: true, render: v => fmtDate(v) },
    { key: 'to_date', label: 'To', sortable: true, render: v => fmtDate(v) },
    { key: 'line_count', label: 'Lines', sortable: true },
    { key: 'gross_wages', label: 'Gross', sortable: true, render: v => fmt(v) },
    { key: 'total_advance', label: 'Advance', sortable: true, render: v => <span className="text-amber-700">{fmt(v)}</span> },
    { key: 'net_payable', label: 'Net Payable', sortable: true, render: v => <span className="font-semibold">{fmt(v)}</span> },
    { key: 'paid_amount', label: 'Paid', sortable: true, render: v => <span className="text-emerald-700 font-semibold">{fmt(v)}</span> },
    { key: 'payment_mode', label: 'Mode', sortable: true },
    { key: 'status_display', label: 'Status', sortable: true, render: (v, row) => <StatusBadge status={v || row.status} /> },
    { key: 'actions', label: '', sortable: false, render: (_, row) => (
      <div className="flex items-center gap-1">
        <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/wages/payments/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View"><Eye size={15} /></button>
        {canDelete('Wage Payment') && row.status !== 'CANCELLED' && (
          <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Cancel"><Trash2 size={15} /></button>
        )}
      </div>
    )},
  ];

  // Hide columns the 'Wage Payment' field-permission map marks HIDDEN.
  // Payment No (identifier/link) and row actions always stay.
  const NEVER_HIDE = new Set(['payment_no', 'actions']);
  const keyFor = (col) => col.key.replace(/_(name|code|display)$/, '');
  const visibleColumns = columns.filter(c => NEVER_HIDE.has(c.key) || !isHidden(keyFor(c)));

  const inputClass = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

  return (
    <MainLayout>
      <PageHeader
        title="Wage Payments"
        subtitle="Periodic settlements against contractor wage entries"
        breadcrumbs={[{ label: 'Freight & Billing', href: '/freight/inward' }, { label: 'Wages', href: '/freight/wages' }, { label: 'Payments' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Wage Payment') ? { createLink: '/freight/wages/payments/new', createLabel: 'New Wage Payment' } : {}),
        }}
      />

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4 mb-3 sm:mb-6">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Total Payments</p><p className="text-xl font-bold text-slate-900 mt-1">{summary.count}</p></div>
            <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center"><Users size={20} className="text-slate-600" /></div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Gross Wages</p><p className="text-xl font-bold text-slate-900 mt-1">{fmt(summary.gross)}</p></div>
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center"><IndianRupee size={20} className="text-blue-600" /></div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Paid</p><p className="text-xl font-bold text-emerald-700 mt-1">{fmt(summary.paid)}</p></div>
            <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center"><CheckCircle2 size={20} className="text-emerald-600" /></div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Balance</p><p className="text-xl font-bold text-orange-600 mt-1">{fmt(summary.balance)}</p></div>
            <div className="w-10 h-10 rounded-lg bg-orange-50 flex items-center justify-center"><Clock size={20} className="text-orange-600" /></div>
          </div>
        </div>
      </div>

      {/* Search bar — always visible. */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4 mb-3 sm:mb-4">
        <label className="block text-xs font-medium text-slate-500 mb-1">Search</label>
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Payment no, contractor, ref..." className={inputClass + ' w-full'} />
      </div>

      {/* Filters — toggled by header Filters button. */}
      {showFilters && (
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4 mb-3 sm:mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
            <CustomSelect value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={inputClass + ' w-full'}>
              <option value="">All</option>
              <option value="DRAFT">Draft</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELLED">Cancelled</option>
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Cycle</label>
            <CustomSelect value={cycleFilter} onChange={e => setCycleFilter(e.target.value)} className={inputClass + ' w-full'}>
              <option value="">All</option>
              <option value="WEEKLY">Weekly</option>
              <option value="FOURTEEN_DAYS">14 Days</option>
              <option value="CUSTOM">Custom</option>
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">From Date</label>
            <CustomDatePicker value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={inputClass + ' w-full'} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">To Date</label>
            <CustomDatePicker value={dateTo} onChange={e => setDateTo(e.target.value)} className={inputClass + ' w-full'} />
          </div>
        </div>
      </div>
      )}

      <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={filtered}
          isLoading={isLoading}
          emptyMessage="No wage payments yet"
          config={{
            title: (row) => row.payment_no || row.id,
            subtitle: (row) => row.contractor_name,
            badge: (row) => ({ label: row.status_display || row.status || '-', cls: row.status === 'CANCELLED' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200' }),
            fields: (row) => [
              { label: 'Date',  value: fmtDate(row.payment_date) },
              { label: 'Cycle', value: CYCLE_LABEL[row.cycle_type] || row.cycle_type },
              { label: 'Lines', value: row.line_count },
              { label: 'Paid',  value: fmt(row.paid_amount), cls: 'font-semibold text-emerald-700' },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/freight/wages/payments/${row.id}`) },
            ],
          }}
          onRowClick={(row) => navigate(`/freight/wages/payments/${row.id}`)}
        />
        <div className="hidden sm:block">
          <DataTable persistKey="freight-wages-payments"
            exportFileName="wage-payments"
            canExport={canExport('Wage Payment')}
            columns={visibleColumns}
            data={filtered}
            isLoading={isLoading}
            onRowClick={(row) => navigate(`/freight/wages/payments/${row.id}`)}
            searchable exportable pagination
          />
        </div>
      </ListState>
    </MainLayout>
  );
}
