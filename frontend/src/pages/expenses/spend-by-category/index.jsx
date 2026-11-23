import { useEffect, useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import apiClient from '../../../utils/api.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import { formatCurrency } from '@/utils/formatters';
import toast from 'react-hot-toast';
import { PieChart, Loader2 } from 'lucide-react';

const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

export default function SpendByCategoryPage() {
  // Filters live in the URL so Back / refresh / sharing restore the range.
  const [from, setFrom] = useUrlState('from', monthStart());
  const [to, setTo] = useUrlState('to', today());
  const [pay, setPay] = useUrlState('pay', '');
  const [data, setData] = useState({ rows: [], grand_total: 0 });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = {};
    if (from) params.from = from;
    if (to) params.to = to;
    if (pay) params.payment_method = pay;
    apiClient.get('/api/expenses/register/spend-by-category/', { params })
      .then((res) => { if (!cancelled) setData(res.data || { rows: [], grand_total: 0 }); })
      .catch(() => { if (!cancelled) toast.error('Could not load the report.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to, pay]);

  const grand = Number(data.grand_total) || 0;
  const rows = data.rows || [];

  return (
    <MainLayout>
      <PageHeader
        title="Spend by Category"
        subtitle="Total expense spend grouped by category"
        breadcrumbs={[{ label: 'Expenses' }, { label: 'Spend by Category' }]}
      />

      {/* Filters */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end rounded-xl border border-slate-200 bg-white p-4">
        <div>
          <label className="block text-xs text-slate-500 mb-1">From</label>
          <CustomDatePicker value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">To</label>
          <CustomDatePicker value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="sm:w-40">
          <label className="block text-xs text-slate-500 mb-1">Paid by</label>
          <CustomSelect value={pay} onChange={(e) => setPay(e.target.value)}>
            <option value="">All</option>
            <option value="VOUCHER">Voucher</option>
            <option value="CREDIT">Credit</option>
          </CustomSelect>
        </div>
        <button
          type="button"
          onClick={() => { setFrom(monthStart()); setTo(today()); }}
          className="col-span-2 text-xs text-slate-500 hover:text-slate-700 sm:pb-2 self-start sm:self-end"
        >
          This month
        </button>
      </div>

      {/* Grand total */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-3 sm:p-6">
        <p className="text-xs sm:text-sm text-slate-500 font-medium">
          Total spend{(from || to) ? ` (${from || '…'} → ${to || '…'})` : ''}
        </p>
        <p className="text-xl sm:text-3xl font-bold text-slate-900 mt-1">{formatCurrency(grand)}</p>
      </div>

      {/* Breakdown */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center text-slate-500 text-sm">
            <PieChart className="w-8 h-8 mx-auto mb-2 text-slate-300" />
            No expenses in this range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="bg-slate-50 border-b text-left text-slate-500 text-xs uppercase tracking-wide">
                  <th className="px-4 py-2.5 font-semibold">Category</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Lines</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Amount</th>
                  <th className="px-4 py-2.5 font-semibold w-1/3">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const total = Number(r.total) || 0;
                  const pct = grand > 0 ? (total / grand) * 100 : 0;
                  const uncat = !r.category;
                  return (
                    <tr key={r.category || 'none'} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-800 whitespace-nowrap">
                        {r.category_name}
                        {uncat && <span className="ml-1.5 text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">no category</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{r.count}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(total)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                            <div className={`h-full rounded-full ${uncat ? 'bg-amber-400' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="w-9 text-right text-xs tabular-nums text-slate-500">{pct.toFixed(0)}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
