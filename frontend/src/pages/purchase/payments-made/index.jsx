import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import { Pencil, Trash2, Eye, RefreshCw, Upload, Link2, Wallet } from 'lucide-react';
import TallyImportButton from '../../../components/common/TallyImportButton';
import MobileListCards from '../components/MobileListCards';
import toast from 'react-hot-toast';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import apiClient from '../../../utils/api.js';
import UnifiedFilterPanel, { useUnifiedFilter } from '../components/UnifiedFilterPanel';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { formatDate, formatCurrency } from '@/utils/formatters';
import CustomSelect from '@/components/ui/CustomSelect';

const FILTER_FIELDS = [
  { value: 'payment_no', label: 'Payment No', type: 'text' },
  { value: 'vendor_name', label: 'Vendor', type: 'text' },
  { value: 'bill_no', label: 'Bill No', type: 'text' },
  { value: 'payment_date', label: 'Payment Date', type: 'date' },
  { value: 'reference_no', label: 'Reference', type: 'text' },
  { value: 'status', label: 'Status', type: 'select', options: [
    { value: 'DRAFT', label: 'Draft' }, { value: 'APPROVED', label: 'Approved' },
    { value: 'SENT', label: 'Email Sent' }, { value: 'CANCELLED', label: 'Cancelled' },
  ]},
];

// Classify each payment so the list makes sense at a glance. A "–" (no bill) is
// not a failure — most are expenses, freight, or bank transfers that have no
// creditor bill by nature. Split by vendor name + bill link:
//   linked      -> tied to a bill (a real creditor payment, settled)
//   freight     -> transporter / lorry / courier -> freight module, no bill
//   bank        -> a bank/CC ledger -> contra transfer, never a bill
//   onaccount   -> everything else with no bill (expenses + creditor advances)
const FREIGHT_RE = /lorr|roadway|roadline|transport|logistic|cargo|courier|carrier|tempo|container|packer|\bmover|petroleum|\bfuel\b|\btravels?\b/i;
const BANK_RE = /\bbank\b|a\/?c\s*no|cc a\/?c|credit\s*card|\bod\b|overdraft/i;

export function classifyPayment(row) {
  if (row.bill) return { key: 'linked', label: 'Linked', cls: 'bg-green-100 text-green-700 border-green-200' };
  const v = row.vendor_name || '';
  if (BANK_RE.test(v)) return { key: 'bank', label: 'Bank / contra', cls: 'bg-slate-200 text-slate-700 border-slate-300' };
  if (FREIGHT_RE.test(v)) return { key: 'freight', label: 'Freight', cls: 'bg-orange-100 text-orange-700 border-orange-200' };
  return { key: 'onaccount', label: 'Expense / advance', cls: 'bg-indigo-100 text-indigo-700 border-indigo-200' };
}

const TYPE_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'linked', label: 'Linked' },
  { key: 'onaccount', label: 'Expense / advance' },
  { key: 'freight', label: 'Freight' },
  { key: 'bank', label: 'Bank / contra' },
];

// Short, friendly company name (mirrors the Purchase dashboard's SS Biochem /
// United Agro toggle) from whatever the row carries (code or trade name).
function niceCompany(code, raw) {
  const s = `${code || ''} ${raw || ''}`.toLowerCase();
  if (/ssb|biochem|ss\s*bio/.test(s)) return 'SS Biochem';
  if (/uai|united|agro/.test(s)) return 'United Agro';
  return raw || code || '';
}

export default function PaymentsMadeList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Payment Made');
  const [showFilters, setShowFilters] = useState(false);
  // Pre-seed the search when another page links here (e.g. a Local Freight record
  // opening "Payments Made" for its transporter: /purchase/payments-made?search=KALAMANI).
  const [searchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');
  const [typeFilter, setTypeFilter] = useState('all');
  const [company, setCompany] = useState('');       // selected company_code
  const [bankFilter, setBankFilter] = useState('');  // '' none · 'all' whole company · else bank_account id
  const filter = useUnifiedFilter(FILTER_FIELDS);

  // Our bank accounts (a handful of rows) drive the drill-down: company → account.
  const { data: bankAccounts } = useApiData('/api/bank/accounts/');
  const companies = (() => {
    const m = new Map();
    for (const a of (bankAccounts || [])) {
      const code = a.company_code || '';
      if (!code) continue;
      if (!m.has(code)) m.set(code, { code, name: niceCompany(code, a.company_name), accounts: [] });
      m.get(code).accounts.push(a);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  })();
  const currentCompany = companies.find((c) => c.code === company) || null;

  // Payments load ONLY after an account (or "All") is chosen, so the page never
  // pulls every payment at once. A null endpoint => useApiData doesn't fetch.
  const payEndpoint = (!company || bankFilter === '')
    ? null
    : bankFilter === 'all'
      ? `/api/purchase/payments-made/?slim=1&company=${encodeURIComponent(company)}`
      : `/api/purchase/payments-made/?slim=1&bank_account=${encodeURIComponent(bankFilter)}`;
  const { data, isLoading, error, refetch } = useApiData(payEndpoint);
  const showList = !!payEndpoint;
  // Quick Today/Week/Month/FY/Custom range on the LIST — same widget used
  // across Bills, Vendor Insights, Reconcile Statement, etc. Replaces the
  // per-payment "1 Week / 1 Month / ..." pills that used to live on each
  // individual payment's own detail page, which filtered a whole vendor
  // ledger from there instead of the list of payments itself.
  const period = usePeriodFilter();

  const columns = [
    { key: 'payment_no', label: 'Payment No', sortable: true },
    { key: 'vendor_name', label: 'Vendor', sortable: true },
    { key: 'bill_no', label: 'Bill No', sortable: true, render: (value, row) => row.bill ? (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/bills/${row.bill}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{value || '-'}</button>
    ) : (value || '-') },
    { key: '_type', label: 'Type', sortable: false, render: (_, row) => {
      const c = classifyPayment(row);
      return <span className={`px-2 py-0.5 text-xs font-semibold rounded border ${c.cls}`}>{c.label}</span>;
    } },
    { key: '_billpaid', label: 'Bill paid', sortable: false, render: (_, row) => {
      if (!row.bill) return <span className="text-slate-300">—</span>;
      const tot = Number(row.bill_total || 0), paid = Number(row.bill_paid || 0);
      const p = tot > 0 ? Math.min(100, Math.round((paid / tot) * 100)) : 0;
      const st = row.bill_status;
      const [chipCls, chipTxt] = st === 'PAID' ? ['bg-green-100 text-green-700', 'PAID']
        : st === 'PARTIALLY_PAID' ? ['bg-amber-100 text-amber-700', 'PARTIAL']
        : ['bg-rose-100 text-rose-700', 'OPEN'];
      const bar = p >= 100 ? 'bg-green-500' : p > 0 ? 'bg-amber-500' : 'bg-rose-500';
      return (
        <div className="min-w-[132px]">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded ${chipCls}`}>{chipTxt}</span>
            <span className="text-[10px] text-slate-400 tabular-nums">{p}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div className={bar} style={{ width: `${p}%`, height: '100%' }} />
          </div>
        </div>
      );
    } },
    {
      key: 'payment_date', label: 'Payment Date', sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'amount', label: 'Amount', sortable: true,
      render: (value) => formatCurrency(value),
    },
    {
      key: 'payment_mode_display', label: 'Mode',
      render: (value, row) => {
        const mode = row.payment_mode;
        if (mode === 'ADVANCE') return <span className="px-2 py-1 text-xs font-semibold bg-amber-100 text-amber-700 rounded">Advance</span>;
        if (mode === 'CREDIT') return <span className="px-2 py-1 text-xs font-semibold bg-purple-100 text-purple-700 rounded">Credit</span>;
        return value || mode || '-';
      },
    },
    { key: 'reference_no', label: 'Reference', render: (v) => v || '-' },
    {
      key: 'status_display', label: 'Status',
      render: (value, row) => <StatusBadge status={value || row.status} />,
    },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canEdit('Payment Made') && row.status === 'DRAFT' && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/payments-made/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="Edit">
              <Pencil size={15} />
            </button>
          )}
          {/* No longer DRAFT-only: the server now unwinds bill.amount_paid on
              delete (PaymentMadeViewSet.perform_destroy -> reverse_payment),
              which is the only reason approved payments were locked. An
              approved payment booked against the wrong bill — the routine
              mistake once statements are entered daily — can be corrected. */}
          {canDelete('Payment Made') && (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                if (!(await confirm({ message: `Delete this payment of ${row.amount}? The bill's paid amount and status will be put back.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
                apiClient.delete(`/api/purchase/payments-made/${row.id}/`)
                  .then(() => { toast.success('Payment deleted'); window.location.reload(); })
                  .catch(err => toast.error(err.response?.data?.detail || 'Failed to delete'));
              }}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const visibleColumns = columns.filter((col) => {
    if (!col.key || col.key === 'actions' || col.key === 'payment_no' || col.key === '_type' || col.key === '_billpaid') return true;
    let key = col.key;
    if (key === 'vendor_name') key = 'vendor';
    else if (key === 'bill_no') key = 'bill';
    else if (key === 'payment_mode_display') key = 'payment_mode';
    else if (key === 'status_display') key = 'status';
    return !isHidden(key);
  });

  // `data` is already scoped server-side to the chosen account/company; apply the
  // period + text + field filters, then the Type chips split within that.
  const baseData = (() => {
    let result = filter.filterData(data || []);
    result = result.filter((row) => period.match(row.payment_date));
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    return result;
  })();

  const typeCounts = baseData.reduce((acc, row) => {
    const k = classifyPayment(row).key;
    acc[k] = (acc[k] || 0) + 1;
    acc.all = (acc.all || 0) + 1;
    return acc;
  }, {});

  const filteredData = typeFilter === 'all'
    ? baseData
    : baseData.filter((row) => classifyPayment(row).key === typeFilter);

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Payments Made"
        subtitle="Track payments made to vendors"
        breadcrumbs={[{ label: 'Finance' }, { label: 'Payments Made' }]}
        actions={{
          // Standalone (no Tally): Overview, Reconcile from Tally, Upload Bank
          // Statement, the Tally revert, and the Filter toggle removed.
          ...(canCreate('Payment Made') ? { createLink: '/purchase/payments-made/new', createLabel: 'New Payment' } : {}),
        }}
      />
      {/* Company toggle + bank-account dropdown on ONE compact row (replaces the
          old wall of bank cards). Pick a company, then pick an account to "open"
          its payments — lazy-loaded, so nothing fetches until a bank is chosen. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-700">Company:</span>
          {companies.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={() => { setCompany(c.code); setBankFilter(''); setTypeFilter('all'); }}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold border transition ${company === c.code ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-white text-slate-700 border-slate-300 hover:border-indigo-300 hover:text-indigo-600'}`}
            >
              {c.name}
            </button>
          ))}
          {!companies.length && <span className="text-xs text-slate-400">Loading companies…</span>}
        </div>
        {currentCompany && (
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-700">Bank:</span>
            <CustomSelect
              value={bankFilter}
              onChange={(e) => { setBankFilter(e.target.value); setTypeFilter('all'); }}
              className="min-w-[250px]"
            >
              <option value="">Pick a bank account…</option>
              <option value="all">All {currentCompany.name} accounts</option>
              {currentCompany.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {(a.nickname || a.code)} · {(a.bank_name || 'Bank')} ···{(a.account_number || '').slice(-4)}
                </option>
              ))}
            </CustomSelect>
          </div>
        )}
      </div>

      {/* STEP 3 — the list, only once an account (or "All") is chosen. */}
      {showList ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <PeriodNavigator allowAll {...period.navProps} />
            {TYPE_CHIPS.map((c) => {
              const n = typeCounts[c.key] || 0;
              const active = typeFilter === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setTypeFilter(c.key)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${active ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                >
                  {c.label} <span className={active ? 'text-primary-100' : 'text-slate-400'}>({n})</span>
                </button>
              );
            })}
          </div>
          {/* Standalone: filter panel removed. */}
          {/* Summary: total payments + sales receipts for linked vendors */}
          {filteredData.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-x-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2">
              <div>
                <span className="text-[11px] text-slate-500">Payments</span>
                <p className="text-sm font-bold text-slate-900 tabular-nums">{filteredData.length}</p>
              </div>
              <div>
                <span className="text-[11px] text-slate-500">Total Paid</span>
                <p className="text-sm font-bold text-slate-900 tabular-nums">{formatCurrency(filteredData.reduce((s, r) => s + (Number(r.amount) || 0), 0))}</p>
              </div>
            </div>
          )}
          <ListState error={error} onRetry={refetch}>
            <MobileListCards
              rows={filteredData}
              isLoading={isLoading}
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
              searchPlaceholder="Search payment, vendor, bill…"
              emptyMessage="No payments found"
              config={{
                title: (row) => row.payment_no || row.reference_no || `Payment #${row.id?.toString().slice(0, 8)}`,
                subtitle: (row) => row.vendor_name,
                badge: (row) => ({ label: row.status_display || row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' }),
                fields: (row) => [
                  { label: 'Type',   value: classifyPayment(row).label },
                  { label: 'Date',   value: row.payment_date ? formatDate(row.payment_date) : null },
                  { label: 'Mode',   value: row.payment_mode_display || row.payment_mode },
                  { label: 'Amount', value: row.amount ? formatCurrency(row.amount) : null, cls: 'font-medium' },
                ],
                actions: (row) => [
                  { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/payments-made/${row.id}`) },
                ],
              }}
              onRowClick={(row) => navigate(`/purchase/payments-made/${row.id}`)}
            />
            <div className="hidden sm:block">
              <DataTable persistKey="purchase-payments-made" exportFileName="payments-made" canExport={canExport('Payment Made')} columns={visibleColumns} data={filteredData} isLoading={isLoading} onRowClick={(row) => navigate(`/purchase/payments-made/${row.id}`)} />
            </div>
          </ListState>
        </>
      ) : (
        <div className="py-16 text-center text-slate-500 text-sm border border-dashed border-slate-300 rounded-lg">
          {!company
            ? 'Select a company above to see its bank accounts.'
            : 'Select a bank account (or "All") to load its payments.'}
        </div>
      )}
    </MainLayout>
  );
}
