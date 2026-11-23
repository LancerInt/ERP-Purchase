import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatsCard from '../../../components/common/StatsCard';
import { Landmark, Wallet, Star, CircleDot } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import BankImports from '../BankImports.jsx';
import BankFilterBar from '../BankFilterBar.jsx';
import BankCompanyChips from '../BankCompanyChips.jsx';

const fmtINR = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const TYPE_LABEL = { CURRENT: 'Current', SAVINGS: 'Savings', CC_OD: 'CC / OD' };
const CAT_LABEL = { PRIMARY: 'Primary', SECONDARY: 'Secondary' };

export default function BankAccountsList() {
  const { canCreate } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/bank/accounts/');
  const navigate = useNavigate();
  const accounts = data || [];

  const [showFilters, setShowFilters] = useState(false);
  const [f, setF] = useState({ company: '', category: '', account_type: '', status: '' });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const reset = () => setF({ company: '', category: '', account_type: '', status: '' });

  const companyOptions = useMemo(() => {
    const seen = new Map();
    accounts.forEach((a) => { if (a.company && !seen.has(a.company)) seen.set(a.company, a.company_name || a.company); });
    return [...seen].map(([value, label]) => ({ value: String(value), label }));
  }, [accounts]);

  const filtered = useMemo(() => accounts.filter((a) => (
    (!f.company || String(a.company) === f.company)
    && (!f.category || a.category === f.category)
    && (!f.account_type || a.account_type === f.account_type)
    && (!f.status || a.status === f.status)
  )), [accounts, f]);

  const totalBalance = filtered.reduce((s, a) => s + Number(a.current_balance || 0), 0);
  const primary = filtered.filter((a) => a.category === 'PRIMARY').length;
  const secondary = filtered.filter((a) => a.category === 'SECONDARY').length;

  const columns = [
    { field: 'code', header: 'A/C Code', render: (v) => <span className="font-medium text-slate-900">{v}</span> },
    { field: 'company_name', header: 'Company', render: (v) => <span className="text-xs text-slate-500">{v || '—'}</span> },
    { field: 'bank_name', header: 'Bank / Branch', render: (v, r) => `${v}${r.branch ? ' · ' + r.branch : ''}` },
    { field: 'account_number', header: 'Account No.' },
    {
      field: 'category', header: 'Category',
      render: (v) => (
        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${v === 'PRIMARY' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'}`}>
          {v === 'PRIMARY' ? 'Primary' : 'Secondary'}
        </span>
      ),
    },
    { field: 'account_type', header: 'Type', render: (v) => TYPE_LABEL[v] || v },
    { field: 'ifsc_code', header: 'IFSC' },
    { field: 'current_balance', header: 'Balance', render: (v) => <span className="tabular-nums font-medium text-slate-900">{fmtINR(v)}</span> },
    {
      field: 'status', header: 'Status',
      render: (v) => (
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${v === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-800'}`}>
          {v === 'ACTIVE' ? 'Active' : 'Inactive'}
        </span>
      ),
    },
  ];

  const breadcrumbs = [{ label: 'Bank', href: '/bank/dashboard' }, { label: 'Bank Accounts' }];

  const exportRows = () => [
    ['Code', 'Bank Name', 'Branch', 'Account Number', 'Category', 'Type', 'IFSC', 'Opening Balance', 'Balance', 'Status'],
    ...filtered.map((a) => [a.code, a.bank_name, a.branch, a.account_number, CAT_LABEL[a.category] || a.category, TYPE_LABEL[a.account_type] || a.account_type, a.ifsc_code, a.opening_balance, a.current_balance, a.status === 'ACTIVE' ? 'Active' : 'Inactive']),
  ];

  return (
    <MainLayout>
      <div className="space-y-4 sm:space-y-5">
        <PageHeader
          title="Bank Accounts"
          breadcrumbs={breadcrumbs}
          actions={{
            right: <BankImports entity="accounts" exportRows={exportRows} exportName="bank-accounts.csv" onImported={refetch} />,
            onFilter: () => setShowFilters((v) => !v),
            ...(canCreate('Bank Account') ? { createLink: '/bank/accounts/new', createLabel: 'New Account' } : {}),
          }}
        />
        {companyOptions.length > 0 && (
          <BankCompanyChips options={companyOptions} value={f.company} onChange={(v) => set('company', v)} />
        )}
        {showFilters && (
          <BankFilterBar
            values={f} set={set} reset={reset} showSearch={false} dateKeys={null}
            selects={[
              { key: 'category', label: 'Category', options: [{ value: 'PRIMARY', label: 'Primary' }, { value: 'SECONDARY', label: 'Secondary' }] },
              { key: 'account_type', label: 'Type', options: [{ value: 'CURRENT', label: 'Current' }, { value: 'SAVINGS', label: 'Savings' }, { value: 'CC_OD', label: 'CC / OD' }] },
              { key: 'status', label: 'Status', options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }] },
            ]}
          />
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatsCard icon={Landmark} label="Total Accounts" value={filtered.length} />
          <StatsCard icon={Wallet} label="Total Balance" value={fmtINR(totalBalance)} />
          <StatsCard icon={Star} label="Primary" value={primary} />
          <StatsCard icon={CircleDot} label="Secondary" value={secondary} />
        </div>
        {error && <div className="text-center py-8 text-red-500">Failed to load bank accounts</div>}
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <DataTable
            columns={columns}
            data={filtered}
            isLoading={isLoading}
            exportFileName="bank-accounts"
            searchPlaceholder="Search accounts..."
            emptyMessage="No bank accounts yet"
          />
        </div>
      </div>
    </MainLayout>
  );
}
