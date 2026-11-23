import CustomSelect from "@/components/ui/CustomSelect";
import { formatCurrency, formatDate } from '@/utils/formatters';
/**
 * Customer Advances — list page.
 *
 * Pre-invoice money received from customers. Each advance has a
 * `balance_unused` that gets drawn down when applied to an invoice
 * (creates a ReceivablePayment on the target ReceivableLedger row).
 * Closing an advance is the manual terminal state used for refunds /
 * write-offs.
 *
 * Layout is mobile-first: summary chips stack on phones, the table
 * scrolls horizontally inside an overflow wrapper, the filter row
 * collapses to a single column.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Filter, IndianRupee, Wallet, AlertCircle, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import usePermissions from '../../../hooks/usePermissions.js';
import MobileListCards from '../components/MobileListCards';

const fmt = (v) => formatCurrency(v);
const fmtDate = (d) => d
  ? formatDate(d)
  : '-';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export default function CustomerAdvancesList() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const { raw: customerRaw } = useLookup('/api/customers/');
  const { options: companyOptions } = useLookup('/api/companies/');

  const [data, setData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Domain filters live in the URL so Back / refresh / sharing restore them.
  const [statusFilter, setStatusFilter] = useUrlState('status', '');
  const [customerFilter, setCustomerFilter] = useUrlState('customer', '');
  const [companyFilter, setCompanyFilter] = useUrlState('company', '');
  const [search, setSearch] = useState('');

  useEffect(() => {
    setIsLoading(true);
    apiClient.get('/api/sales/advances/', { params: { page_size: 500 } })
      .then(r => setData(r.data?.results || r.data || []))
      .catch(() => toast.error('Failed to load advances'))
      .finally(() => setIsLoading(false));
  }, []);

  // Customer filter options scoped to the selected Company filter — pick a
  // company and the customer dropdown narrows to that company's customers.
  const scopedCustomerOptions = useMemo(() => {
    const base = customerRaw || [];
    const inScope = companyFilter
      ? base.filter(c => String(c.company || '') === String(companyFilter))
      : base;
    return inScope.map(c => ({ value: c.id, label: c.customer_name || c.name || c.id }));
  }, [customerRaw, companyFilter]);

  const filtered = useMemo(() => {
    let result = data;
    if (statusFilter) result = result.filter(r => r.status === statusFilter);
    if (customerFilter) result = result.filter(r => String(r.customer) === String(customerFilter));
    if (companyFilter) result = result.filter(r => String(r.company || '') === String(companyFilter));
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(r => [
        r.advance_no, r.customer_name, r.company_name, r.reference_no,
        r.amount, r.amount_applied, r.balance, r.status,
        r.payment_mode, r.payment_date,
      ].some(v => v != null && String(v).toLowerCase().includes(s)));
    }
    return result;
  }, [data, statusFilter, customerFilter, companyFilter, search]);

  // Summary chips drive at-a-glance "how much customer money are we
  // holding" — sums the open + partially-applied balances. Fully
  // applied / closed rows don't carry obligations any more.
  const summary = useMemo(() => {
    const open = filtered.filter(r => r.status === 'OPEN' || r.status === 'PARTIALLY_APPLIED');
    return {
      count: filtered.length,
      openCount: open.length,
      totalReceived: filtered.reduce((s, r) => s + (Number(r.amount) || 0), 0),
      openBalance: open.reduce((s, r) => s + (Number(r.balance_unused) || 0), 0),
      appliedCount: filtered.filter(r => r.status === 'FULLY_APPLIED').length,
    };
  }, [filtered]);

  return (
    <MainLayout>
      <PageHeader
        title="Customer Advances"
        subtitle="Pre-invoice money received from customers — apply to invoices as they're raised"
        breadcrumbs={[{ label: 'Sales' }, { label: 'Customer Advances' }]}
        actions={{
          ...(canCreate('Receivable')
            ? { createLink: '/sales/advances/new', createLabel: 'New Advance' }
            : {}),
        }}
      />

      {/* Summary chips. 2 columns on phones, 4 from md upward. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs text-slate-500 uppercase font-medium">Total Records</p>
              <p className="text-lg sm:text-2xl font-bold text-slate-900 mt-0.5 tabular-nums">{summary.count}</p>
            </div>
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
              <Wallet size={18} className="text-slate-600" />
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs text-slate-500 uppercase font-medium">Total Received</p>
              <p className="text-base sm:text-xl font-bold text-slate-900 mt-0.5 tabular-nums truncate">{fmt(summary.totalReceived)}</p>
            </div>
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
              <IndianRupee size={18} className="text-emerald-600" />
            </div>
          </div>
        </div>
        <div className="bg-amber-50/60 rounded-lg border border-amber-200 p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs text-amber-700 uppercase font-medium">Open Balance</p>
              <p className="text-base sm:text-xl font-bold text-amber-900 mt-0.5 tabular-nums truncate">{fmt(summary.openBalance)}</p>
              <p className="text-[10px] sm:text-xs text-amber-600 mt-0.5">{summary.openCount} advance(s)</p>
            </div>
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
              <AlertCircle size={18} className="text-amber-700" />
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs text-slate-500 uppercase font-medium">Fully Applied</p>
              <p className="text-lg sm:text-2xl font-bold text-emerald-700 mt-0.5 tabular-nums">{summary.appliedCount}</p>
            </div>
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
              <CheckCircle2 size={18} className="text-emerald-600" />
            </div>
          </div>
        </div>
      </div>

      {/* Filters. Single column on phones, 4-col grid on md+. */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Filter size={14} className="text-slate-500" />
          <p className="text-xs font-semibold text-slate-600 uppercase">Filters</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Status</label>
            <CustomSelect value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={inputClass}>
              <option value="">All Status</option>
              <option value="OPEN">Open</option>
              <option value="PARTIALLY_APPLIED">Partially Applied</option>
              <option value="FULLY_APPLIED">Fully Applied</option>
              <option value="CLOSED">Closed</option>
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Customer</label>
            <CustomSelect value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} className={inputClass}>
              <option value="">All Customers</option>
              {scopedCustomerOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Company</label>
            <CustomSelect value={companyFilter} onChange={e => { setCompanyFilter(e.target.value); setCustomerFilter(''); }} className={inputClass}>
              <option value="">All Companies</option>
              {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Search</label>
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} className={inputClass} placeholder="ADV no, customer, ref…" />
          </div>
        </div>
      </div>

      {/* Mobile card list — replaces the wide table on phones. */}
      <MobileListCards
        rows={filtered}
        isLoading={isLoading}
        emptyMessage="No advances yet."
        onRowClick={(row) => navigate(`/sales/advances/${row.id}`)}
        config={{
          title: (row) => row.advance_no || `Advance #${row.id}`,
          subtitle: (row) => row.customer_name,
          badge: (row) => {
            const s = row.status;
            const map = {
              OPEN:              { label: 'Open',     cls: 'bg-amber-100 text-amber-800 border-amber-300' },
              PARTIALLY_APPLIED: { label: 'Partial',  cls: 'bg-blue-100 text-blue-800 border-blue-300' },
              FULLY_APPLIED:     { label: 'Applied',  cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
              CLOSED:            { label: 'Closed',   cls: 'bg-slate-200 text-slate-700 border-slate-300' },
            };
            return map[s] || { label: row.status_display || s || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
          },
          fields: (row) => [
            { label: 'Date',    value: fmtDate(row.received_date) },
            { label: 'Company', value: row.company_name },
            { label: 'Amount',  value: fmt(row.amount), cls: 'text-slate-800 font-medium' },
            { label: 'Balance', value: fmt(row.balance_unused), cls: Number(row.balance_unused) > 0 ? 'text-amber-700 font-medium' : 'text-emerald-700 font-medium' },
            { label: 'Mode',    value: row.payment_mode_display || row.payment_mode },
          ],
        }}
      />

      {/* Data table — desktop only. Original markup preserved. */}
      <div className="hidden sm:block bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
              <tr className="text-left text-slate-500 text-[11px] uppercase tracking-wide">
                <th className="px-3 sm:px-4 py-2.5 font-semibold whitespace-nowrap">Advance No</th>
                <th className="px-3 sm:px-4 py-2.5 font-semibold whitespace-nowrap">Date</th>
                <th className="px-3 sm:px-4 py-2.5 font-semibold whitespace-nowrap">Customer</th>
                <th className="px-3 sm:px-4 py-2.5 font-semibold whitespace-nowrap">Company</th>
                <th className="px-3 sm:px-4 py-2.5 font-semibold text-right whitespace-nowrap">Amount</th>
                <th className="px-3 sm:px-4 py-2.5 font-semibold text-right whitespace-nowrap">Balance</th>
                <th className="px-3 sm:px-4 py-2.5 font-semibold whitespace-nowrap">Mode</th>
                <th className="px-3 sm:px-4 py-2.5 font-semibold whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={8} className="text-center py-12 text-slate-400">Loading…</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={8} className="text-center py-12 text-slate-400">No advances yet.</td></tr>
              )}
              {!isLoading && filtered.map(r => (
                <tr
                  key={r.id}
                  className="border-b last:border-b-0 hover:bg-slate-50 cursor-pointer"
                  onClick={() => navigate(`/sales/advances/${r.id}`)}
                >
                  <td className="px-3 sm:px-4 py-2.5 font-medium text-indigo-700 whitespace-nowrap">{r.advance_no}</td>
                  <td className="px-3 sm:px-4 py-2.5 text-slate-600 whitespace-nowrap">{fmtDate(r.received_date)}</td>
                  <td className="px-3 sm:px-4 py-2.5 text-slate-800">{r.customer_name || '-'}</td>
                  <td className="px-3 sm:px-4 py-2.5 text-slate-600 whitespace-nowrap">{r.company_name || '-'}</td>
                  <td className="px-3 sm:px-4 py-2.5 text-right tabular-nums font-medium whitespace-nowrap">{fmt(r.amount)}</td>
                  <td className={`px-3 sm:px-4 py-2.5 text-right tabular-nums font-semibold whitespace-nowrap ${Number(r.balance_unused) > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                    {fmt(r.balance_unused)}
                  </td>
                  <td className="px-3 sm:px-4 py-2.5 text-slate-600 whitespace-nowrap text-sm">{r.payment_mode_display || r.payment_mode}</td>
                  <td className="px-3 sm:px-4 py-2.5 whitespace-nowrap"><StatusBadge status={r.status_display || r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </MainLayout>
  );
}
