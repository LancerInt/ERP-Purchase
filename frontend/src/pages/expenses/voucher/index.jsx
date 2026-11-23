import { useEffect, useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatsCard from '../../../components/common/StatsCard';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { Wallet, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import toast from 'react-hot-toast';

export default function VoucherPage() {
  const [data, setData] = useState({ funds: [], totals: { balance: 0, total_in: 0, total_out: 0 }, ledger: [] });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get('/api/expenses/voucher/dashboard/');
        setData(res.data);
      } catch (e) {
        toast.error('Failed to load voucher dashboard');
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const ledgerColumns = [
    { key: 'date', label: 'Date', render: (v) => formatDate(v) },
    { key: 'fund', label: 'Fund' },
    { key: 'kind', label: 'Type', render: (v) => (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${v === 'Top-up' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>{v}</span>
    ) },
    { key: 'particulars', label: 'Particulars' },
    { key: 'credit', label: 'In', render: (v) => v != null ? <span className="text-emerald-700 font-medium">{formatCurrency(v)}</span> : '—' },
    { key: 'debit', label: 'Out', render: (v) => v != null ? <span className="text-red-600 font-medium">{formatCurrency(v)}</span> : '—' },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Voucher"
        subtitle="Fund balances and cash movement"
        breadcrumbs={[{ label: 'Expenses' }, { label: 'Voucher' }]}
      />

      <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-4">
        <StatsCard icon={Wallet} label="Total Balance" value={formatCurrency(data.totals?.balance)} isLoading={isLoading} />
        <StatsCard icon={ArrowDownCircle} label="Total Topped-up" value={formatCurrency(data.totals?.total_in)} isLoading={isLoading} />
        <StatsCard icon={ArrowUpCircle} label="Total Voucher Spend" value={formatCurrency(data.totals?.total_out)} isLoading={isLoading} />
      </div>

      {/* Per-fund balances */}
      <h3 className="text-sm font-semibold text-slate-700 mb-2">Funds</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        {(data.funds || []).map((f) => (
          <div key={f.id} className="bg-white rounded-lg border border-slate-200 p-4">
            <p className="font-semibold text-slate-800 truncate">{f.name}</p>
            <p className="text-xs text-slate-500 truncate">{[f.holder_name, f.department].filter(Boolean).join(' · ') || '—'}</p>
            <p className="text-2xl font-bold text-slate-900 mt-2">{formatCurrency(f.balance)}</p>
            <p className="text-xs text-slate-500 mt-1">In {formatCurrency(f.total_topups)} · Spent {formatCurrency(f.total_voucher_spent)}</p>
          </div>
        ))}
        {(!data.funds || data.funds.length === 0) && !isLoading && (
          <div className="text-sm text-slate-500 col-span-full">No funds yet. Add one under Imprest.</div>
        )}
      </div>

      <h3 className="text-sm font-semibold text-slate-700 mb-2">Ledger</h3>
      <DataTable persistKey="expenses-voucher" columns={ledgerColumns} data={data.ledger || []} isLoading={isLoading} exportFileName="voucher-ledger" />
    </MainLayout>
  );
}
