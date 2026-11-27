import CustomSelect from "@/components/ui/CustomSelect";
import React, { useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { AlertTriangle, TrendingDown, CheckCircle, Clock, IndianRupee, Eye } from 'lucide-react';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { formatDate as fmtDate } from '@/utils/formatters';

const formatCurrency = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const formatDate = (d) => d ? fmtDate(d) : '-';

function getDueStatus(bill) {
  const balance = Number(bill.balance_due) || (Number(bill.total_amount) || 0) - (Number(bill.amount_paid) || 0);
  const paid = Number(bill.amount_paid) || 0;
  if (bill.status === 'CANCELLED') return 'Cancelled';
  if (balance <= 0) return 'Paid';
  if (bill.due_date && new Date(bill.due_date) < new Date() && balance > 0) return 'Overdue';
  if (paid > 0 && balance > 0) return 'Partially Paid';
  return 'Unpaid';
}

export default function VendorDuesPage() {
  const navigate = useNavigate();
  // ?slim=list -> the Bills list columns. This page reads bill_no, dates,
  // vendor, total_amount, amount_paid and status; the six fields slim drops
  // (tds_amount, rm_category, purchase_category_display, category_source and
  // the audit stamps) are not referenced here. It was pulling the FULL list -
  // 3,168 rows and 3.1 MB on production, the heaviest load on the page.
  // Scope to the global company filter (SS default; '' = All). The bills
  // endpoint supports ?company=<id>.
  const { company: globalCompany } = useGlobalCompany();
  const { data: billsData, isLoading, error, refetch } = useApiData(
    `/api/purchase/bills/?slim=list${globalCompany ? `&company=${globalCompany}` : ''}`,
  );
  // ?slim=1 -> id + vendor_name only. This is a dropdown; the full vendor
  // record is ~1.2 MB and the page uses the name. Opt-in, so every other
  // caller of /api/vendors/ is untouched, and useLookup caches per endpoint
  // string so this cannot contaminate their cache.
  const { options: vendorOptions } = useLookup('/api/vendors/?slim=1');
  const { canExport } = usePermissions();

  // Deep-link from the Reports page: ?vendor_name=<name> seeds the search box
  // (which already matches on vendor_name), so a Reports row lands pre-filtered
  // to that vendor. Reports carries the vendor NAME, not its id, so we seed
  // search rather than the id-based vendorFilter.
  const [sp] = useSearchParams();
  const [vendorFilter, setVendorFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // Standard period navigator (All / Today / Week / Month / FY / Custom).
  const period = usePeriodFilter('all');
  const [search, setSearch] = useState(sp.get('vendor_name') || '');
  const [expandedVendor, setExpandedVendor] = useState(null);

  const bills = useMemo(() => {
    return (billsData || [])
      .filter(b => b.status !== 'DRAFT' && b.status !== 'PAID' && b.status !== 'CANCELLED')
      .filter(b => ((Number(b.total_amount) || 0) - (Number(b.amount_paid) || 0)) > 0)
      .map(b => ({
        ...b,
        due_amount: (Number(b.total_amount) || 0) - (Number(b.amount_paid) || 0),
        due_status: getDueStatus(b),
      }));
  }, [billsData]);

  // Apply filters
  const filtered = useMemo(() => {
    let result = bills;
    if (vendorFilter) result = result.filter(b => b.vendor === vendorFilter);
    if (statusFilter) result = result.filter(b => b.due_status === statusFilter);
    result = result.filter(b => period.match(b.bill_date));
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(b =>
        (b.bill_no || '').toLowerCase().includes(s) ||
        (b.vendor_name || '').toLowerCase().includes(s) ||
        (b.vendor_invoice_no || '').toLowerCase().includes(s) ||
        (b.po_no || '').toLowerCase().includes(s)
      );
    }
    return result;
  }, [bills, vendorFilter, statusFilter, period, search]);

  // Vendor-wise summary
  const vendorSummary = useMemo(() => {
    const map = {};
    filtered.forEach(b => {
      const vid = b.vendor || 'unknown';
      if (!map[vid]) map[vid] = { vendor_id: vid, vendor_name: b.vendor_name || '-', total: 0, paid: 0, due: 0, overdue: 0, count: 0, bills: [] };
      map[vid].total += Number(b.total_amount) || 0;
      map[vid].paid += Number(b.amount_paid) || 0;
      map[vid].due += b.due_amount;
      map[vid].count++;
      map[vid].bills.push(b);
      if (b.due_status === 'Overdue') map[vid].overdue += b.due_amount;
    });
    return Object.values(map).sort((a, b) => b.due - a.due);
  }, [filtered]);

  // Global summary
  const summary = useMemo(() => {
    const totalBilled = filtered.reduce((s, b) => s + (Number(b.total_amount) || 0), 0);
    const totalPaid = filtered.reduce((s, b) => s + (Number(b.amount_paid) || 0), 0);
    const totalDue = filtered.reduce((s, b) => s + b.due_amount, 0);
    const overdueAmt = filtered.filter(b => b.due_status === 'Overdue').reduce((s, b) => s + b.due_amount, 0);
    const unpaidCount = filtered.filter(b => b.due_status === 'Unpaid').length;
    const partialCount = filtered.filter(b => b.due_status === 'Partially Paid').length;
    const overdueCount = filtered.filter(b => b.due_status === 'Overdue').length;
    const paidCount = filtered.filter(b => b.due_status === 'Paid').length;
    return { totalBilled, totalPaid, totalDue, overdueAmt, unpaidCount, partialCount, overdueCount, paidCount };
  }, [filtered]);

  const columns = [
    { key: 'bill_no', label: 'Bill No', sortable: true, render: (v, row) => (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/bills/${row.id}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{v}</button>
    )},
    { key: 'vendor_name', label: 'Vendor', sortable: true },
    { key: 'vendor_invoice_no', label: 'Invoice No', sortable: true, render: v => v || '-' },
    { key: 'po_no', label: 'PO No', sortable: true, render: (v, row) => v ? (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/orders/${row.purchase_order}`); }} className="text-primary-600 hover:underline text-xs">{v}</button>
    ) : '-' },
    { key: 'bill_date', label: 'Bill Date', sortable: true, render: v => formatDate(v) },
    { key: 'due_date', label: 'Due Date', sortable: true, render: (v, row) => {
      const isOverdue = v && new Date(v) < new Date() && row.due_amount > 0;
      return <span className={isOverdue ? 'text-red-600 font-medium' : ''}>{formatDate(v)}</span>;
    }},
    { key: 'total_amount', label: 'Total', sortable: true, render: v => formatCurrency(v) },
    { key: 'amount_paid', label: 'Paid', sortable: true, render: v => (
      <span className="text-green-600">{formatCurrency(v)}</span>
    )},
    { key: 'due_amount', label: 'Due', sortable: true, render: (v) => (
      <span className={v > 0 ? 'text-red-600 font-semibold' : 'text-green-600'}>{formatCurrency(v)}</span>
    )},
    { key: 'due_status', label: 'Status', sortable: true, render: v => {
      const colors = {
        'Paid': 'bg-green-100 text-green-700',
        'Unpaid': 'bg-red-100 text-red-700',
        'Partially Paid': 'bg-amber-100 text-amber-700',
        'Overdue': 'bg-red-200 text-red-800',
        'Cancelled': 'bg-slate-100 text-slate-500',
      };
      return <span className={`px-2 py-1 rounded text-xs font-semibold ${colors[v] || 'bg-slate-100 text-slate-600'}`}>{v}</span>;
    }},
  ];

  const inputClass = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

  return (
    <MainLayout>
      <PageHeader
        title="Vendor Dues"
        subtitle="Track pending payments and outstanding balances"
        breadcrumbs={[{ label: 'Purchase', href: '/purchase/dashboard' }, { label: 'Vendor Dues' }]}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 sm:mb-6">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500 uppercase font-medium">Total Billed</p>
              <p className="text-xl font-bold text-slate-900 mt-1">{formatCurrency(summary.totalBilled)}</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <IndianRupee size={20} className="text-blue-600" />
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500 uppercase font-medium">Total Paid</p>
              <p className="text-xl font-bold text-green-700 mt-1">{formatCurrency(summary.totalPaid)}</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
              <CheckCircle size={20} className="text-green-600" />
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500 uppercase font-medium">Total Pending</p>
              <p className="text-xl font-bold text-amber-700 mt-1">{formatCurrency(summary.totalDue)}</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <Clock size={20} className="text-amber-600" />
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-2">{summary.unpaidCount} unpaid, {summary.partialCount} partial</p>
        </div>
        <div className="bg-white rounded-lg border border-red-200 p-4 border-l-4 border-l-red-500">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-red-600 uppercase font-medium">Overdue</p>
              <p className="text-xl font-bold text-red-700 mt-1">{formatCurrency(summary.overdueAmt)}</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
              <AlertTriangle size={20} className="text-red-600" />
            </div>
          </div>
          <p className="text-xs text-red-400 mt-2">{summary.overdueCount} overdue bill(s)</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
        <div className="mb-3">
          <PeriodNavigator allowAll {...period.navProps} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Vendor</label>
            <CustomSelect value={vendorFilter} onChange={e => setVendorFilter(e.target.value)} className={inputClass + ' w-full'}>
              <option value="">All Vendors</option>
              {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
            <CustomSelect value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={inputClass + ' w-full'}>
              <option value="">All Status</option>
              <option value="Unpaid">Unpaid</option>
              <option value="Partially Paid">Partially Paid</option>
              <option value="Overdue">Overdue</option>
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Search</label>
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Bill, vendor, PO..." className={inputClass + ' w-full'} />
          </div>
        </div>
      </div>

      {/* Vendor-wise Summary (expandable) */}
      {vendorSummary.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">Vendor-wise Summary</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase w-6"></th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase">Vendor</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 uppercase">Bills</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 uppercase">Total Amount</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 uppercase">Paid</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 uppercase">Pending Due</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-slate-500 uppercase">Overdue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {vendorSummary.filter(v => v.due > 0 || v.overdue > 0).map((v, i) => (
                  <React.Fragment key={i}>
                    <tr className="hover:bg-primary-50/40 transition-colors cursor-pointer" onClick={() => setExpandedVendor(expandedVendor === v.vendor_id ? null : v.vendor_id)}>
                      <td className="py-2 px-3 text-slate-400">{expandedVendor === v.vendor_id ? '▾' : '▸'}</td>
                      <td className="py-2 px-3 font-medium text-slate-800">{v.vendor_name}</td>
                      <td className="py-2 px-3 text-right text-slate-600">{v.count}</td>
                      <td className="py-2 px-3 text-right">{formatCurrency(v.total)}</td>
                      <td className="py-2 px-3 text-right text-green-600">{formatCurrency(v.paid)}</td>
                      <td className="py-2 px-3 text-right font-semibold text-amber-700">{formatCurrency(v.due)}</td>
                      <td className="py-2 px-3 text-right">
                        {v.overdue > 0 ? <span className="text-red-600 font-semibold">{formatCurrency(v.overdue)}</span> : <span className="text-slate-300">-</span>}
                      </td>
                    </tr>
                    {expandedVendor === v.vendor_id && v.bills.map((b, bi) => (
                      <tr key={bi} className="bg-slate-50">
                        <td className="py-1.5 px-3"></td>
                        <td className="py-1.5 px-3 text-xs">
                          <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/bills/${b.id}`); }} className="text-primary-600 hover:underline">{b.bill_no}</button>
                          {b.po_no && <span className="text-slate-400 ml-2">PO: {b.po_no}</span>}
                        </td>
                        <td className="py-1.5 px-3 text-right text-xs text-slate-500">{formatDate(b.bill_date)}</td>
                        <td className="py-1.5 px-3 text-right text-xs">{formatCurrency(b.total_amount)}</td>
                        <td className="py-1.5 px-3 text-right text-xs text-green-600">{formatCurrency(b.amount_paid)}</td>
                        <td className="py-1.5 px-3 text-right text-xs font-medium text-amber-700">{formatCurrency(b.due_amount)}</td>
                        <td className="py-1.5 px-3 text-right">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${b.due_status === 'Overdue' ? 'bg-red-100 text-red-700' : b.due_status === 'Unpaid' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>{b.due_status}</span>
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Due Records Table */}
      <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={filtered}
          isLoading={isLoading}
          emptyMessage="No vendor dues found"
          config={{
            title: (row) => row.bill_no || row.invoice_no,
            subtitle: (row) => row.vendor_name,
            badge: (row) => {
              const overdue = row.is_overdue;
              return overdue
                ? { label: 'Overdue', cls: 'bg-red-100 text-red-700 border-red-300' }
                : { label: row.status_display || row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' };
            },
            fields: (row) => [
              { label: 'Due',     value: row.due_date ? formatDate(row.due_date) : null },
              { label: 'Balance', value: row.balance_due != null ? formatCurrency(row.balance_due) : null, cls: Number(row.balance_due) > 0 ? 'text-red-600 font-medium' : 'text-emerald-700 font-medium' },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View Bill', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/bills/${row.id}`) },
            ],
          }}
          onRowClick={(row) => navigate(`/purchase/bills/${row.id}`)}
        />
        <div className="hidden sm:block">
          <DataTable persistKey="purchase-vendor-dues"
            exportFileName="vendor-dues"
            canExport={canExport('Vendor Dues')}
            columns={columns}
            data={filtered}
            isLoading={isLoading}
            onRowClick={(row) => navigate(`/purchase/bills/${row.id}`)}
            searchable
            exportable={canExport('Vendor Dues')}
            pagination
          />
        </div>
      </ListState>
    </MainLayout>
  );
}
