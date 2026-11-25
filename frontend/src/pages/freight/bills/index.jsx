/**
 * Freight Bills — every freight record as a payable bill, with full visual
 * parity to the Purchase Bills list: the same compact PageHeader, one filter
 * row (PeriodNavigator → pickers → "X of Y records" → Clear), the hairline
 * metric band, the mobile card list + dense desktop DataTable, and Export.
 *
 * Freight's own data and columns are kept — there is no TDS / GST / sync /
 * category chrome here because freight carries none. Inbound transporter
 * slips (/api/purchase/freight/) and standalone local freight
 * (/api/purchase/local-freight/) are shown together, each row a bill to the
 * transporter. (Outward / sales freight has no backend in this standalone,
 * so only inbound + local freight appear.)
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import MobileListCards from '../../purchase/components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { CTRL_ROW, CTRL_FIELD } from '@/components/common/controls';
import usePermissions from '@/hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { Eye } from 'lucide-react';
import { formatCurrency, formatDate } from '@/utils/formatters';

// Whole-rupee money for the summary band — grouped Indian digits, no paise,
// so the headline figures read clean (₹1,31,42,698), the same as Bills.
const fmtMoney0 = (v) => `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;

async function fetchAll(url) {
  const out = [];
  let next = `${url}?page_size=500`;
  for (let i = 0; i < 40 && next; i++) {
    const { data } = await apiClient.get(next);
    const rows = Array.isArray(data) ? data : (data?.results || []);
    out.push(...rows);
    next = (!Array.isArray(data) && data?.next) ? data.next : null;
  }
  return out;
}

// Payment status read off the amount / paid — shared by the Status column,
// the status filter and the mobile card so the three can never drift apart.
// Unpaid = nothing paid; Paid = fully covered; Partial = something in between.
const payStatus = (amt, paid) => {
  const a = Number(amt) || 0, p = Number(paid) || 0;
  if (p <= 0) return 'Unpaid';
  if (p >= a) return 'Paid';
  return 'Partial';
};
const PAY_CLS = {
  Paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Partial: 'bg-amber-50 text-amber-700 border-amber-200',
  Unpaid: 'bg-rose-50 text-rose-700 border-rose-200',
};

// Normalize an inbound slip or a local-freight row into one bill shape, tagged
// with its direction. amount prefers the inbound cost, then payable, then the
// local amount; balance is always amount − paid so the Balance column agrees
// with the metric band no matter which endpoint the row came from.
const normalize = (f, direction) => {
  const amt = Number(f.total_freight_cost) || Number(f.payable_amount) || Number(f.freight_amount) || 0;
  const paid = Number(f.total_paid) || 0;
  return {
    id: `${direction}-${f.id}`, _id: f.id, direction,
    freight_no: f.advice_no || f.freight_no || '—',
    date: f.freight_date || f.date || f.created_date || '',
    transporter_name: f.transporter_name || '—',
    vendor_name: f.vendor_name || f.customer_name || '—',
    company_name: f.company_name || '',
    amount: amt, paid, balance: amt - paid,
  };
};

export default function FreightBills() {
  const navigate = useNavigate();
  const { canExport } = usePermissions();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Every filter lives in the ADDRESS, not only in memory — opening a freight
  // record and pressing Back restores the SAME filtered view (same contract as
  // the Purchase Bills page).
  const [searchParams, setSearchParams] = useSearchParams();
  const [dir, setDir] = useState(searchParams.get('dir') || '');          // '' | Inward | Local
  const [transporterPick, setTransporterPick] = useState(searchParams.get('transporter') || '');
  const [pay, setPay] = useState(searchParams.get('pay') || '');          // '' | Paid | Partial | Unpaid
  const [searchTerm, setSearchTerm] = useState(searchParams.get('q') || '');

  // Same period chip as Purchase Analytics / Bills, so a window picked on one
  // page carries to this one. Starts on 'All' — a list must not hide rows
  // before anyone asks it to.
  const period = usePeriodFilter(searchParams.get('period') || 'all', {
    anchor: searchParams.get('anchor'),
    customFrom: searchParams.get('cfrom'),
    customTo: searchParams.get('cto'),
  });

  // Company comes from the GLOBAL header filter (no per-page company dropdown).
  // This list filters by company NAME, so translate the global company id → its
  // legal (or trade) name. '' = All companies.
  const { company: globalCompany, companies: globalCompanies } = useGlobalCompany();
  const company = globalCompany
    ? ((globalCompanies || []).find((c) => String(c.id) === String(globalCompany))?.legal_name
       || (globalCompanies || []).find((c) => String(c.id) === String(globalCompany))?.trade_name
       || '')
    : '';

  // Keep the address in step with the controls. replace: true on purpose —
  // picking a filter is not a destination. Only meaningful values are written,
  // so an untouched list keeps a clean URL.
  useEffect(() => {
    const p = new URLSearchParams(searchParams);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    const np = period.navProps;
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    put('dir', dir, !!dir);
    put('transporter', transporterPick, !!transporterPick);
    put('pay', pay, !!pay);
    put('q', searchTerm, !!searchTerm.trim());
    if (p.toString() !== searchParams.toString()) setSearchParams(p, { replace: true });
  }, [period.navProps, dir, transporterPick, pay, searchTerm, searchParams, setSearchParams]);

  const load = () => {
    setLoading(true); setError(null);
    Promise.all([fetchAll('/api/purchase/freight/'), fetchAll('/api/purchase/local-freight/')])
      .then(([inbound, local]) => setRows([
        ...inbound.map((f) => normalize(f, 'Inward')),
        ...local.map((f) => normalize(f, 'Local')),
      ]))
      .catch(() => setError('Could not load freight.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Transporter options — distinct names from the loaded rows (sorted), so the
  // picker always matches the data on screen.
  const transporterOptions = useMemo(
    () => [...new Set(rows.map((r) => r.transporter_name).filter((v) => v && v !== '—'))].sort(),
    [rows]);

  const filteredData = useMemo(() => rows
    .filter((r) => {
      // Freight date drives the period, matching Bills' bill_date behaviour.
      if (!period.match(r.date)) return false;
      if (dir && r.direction !== dir) return false;
      if (transporterPick && r.transporter_name !== transporterPick) return false;
      if (pay && payStatus(r.amount, r.paid) !== pay) return false;
      if (company && r.company_name !== company) return false;
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        if (![r.freight_no, r.transporter_name, r.vendor_name].some((v) => (v || '').toLowerCase().includes(s))) return false;
      }
      return true;
    })
    // Newest first, matching the Bills list default.
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)),
    [rows, period, dir, transporterPick, pay, company, searchTerm]);

  // Summary band — computed over the SAME filtered rows the table shows, so it
  // moves with every period / direction / status filter above.
  const summary = useMemo(() => filteredData.reduce((a, r) => {
    a.count += 1; a.total += r.amount; a.paid += r.paid; a.balance += r.balance; return a;
  }, { count: 0, total: 0, paid: 0, balance: 0 }), [filteredData]);

  const detailRoute = (row) => (row.direction === 'Local' ? `/freight/local/${row._id}` : `/freight/purchase/${row._id}`);

  const columns = [
    {
      key: 'date', label: 'Date', sortable: true,
      render: (value) => value ? formatDate(value, 'dd-MMM-yy') : '-',
      footer: (_rows, all) => <span className="text-[11px] font-semibold text-slate-500">Total · {all.length} bills</span>,
    },
    {
      key: 'freight_no', label: 'Freight No', sortable: true,
      render: (value, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(detailRoute(row)); }}
          className="text-blue-700 hover:underline font-medium">{value}</button>
      ),
    },
    {
      key: 'direction', label: 'Type', sortable: true,
      render: (value) => (
        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap ${value === 'Inward'
          ? 'bg-blue-50 text-blue-700 border-blue-200'
          : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{value}</span>
      ),
    },
    { key: 'transporter_name', label: 'Transporter', sortable: true },
    { key: 'vendor_name', label: 'Party', sortable: true },
    {
      key: 'amount', label: 'Amount', sortable: true,
      render: (value) => formatCurrency(value),
      footer: (_rows, all) => formatCurrency(all.reduce((s, r) => s + (Number(r.amount) || 0), 0)),
    },
    {
      key: 'paid', label: 'Paid', sortable: true,
      render: (value) => <span className="text-emerald-700">{formatCurrency(value)}</span>,
      footer: (_rows, all) => formatCurrency(all.reduce((s, r) => s + (Number(r.paid) || 0), 0)),
    },
    {
      key: 'balance', label: 'Balance', sortable: true,
      render: (value) => (
        <span className={Number(value) > 0 ? 'text-rose-600 font-medium' : 'text-emerald-700 font-medium'}>{formatCurrency(value)}</span>
      ),
      footer: (_rows, all) => formatCurrency(all.reduce((s, r) => s + (Number(r.balance) || 0), 0)),
    },
    {
      key: 'status', label: 'Status', sortable: false,
      render: (_value, row) => {
        const s = payStatus(row.amount, row.paid);
        return <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 whitespace-nowrap ${PAY_CLS[s]}`}>{s}</span>;
      },
    },
  ];

  const hasFilters = period.range || dir || transporterPick || pay || searchTerm;
  const clearAll = () => {
    period.navProps.setPeriod('all');
    setDir(''); setTransporterPick(''); setPay(''); setSearchTerm('');
  };

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Freight Bills"
        subtitle="Freight as payable bills — inward and local"
        breadcrumbs={[{ label: 'Freight' }, { label: 'Freight Bills' }]}
      />
      {/* One filter row: when → direction → transporter → payment status,
          then an inline "X of Y records" count and Clear — same shape as the
          Purchase Bills page. Company filtering comes from the global header
          company filter (useGlobalCompany), so there is no company control here. */}
      <div className={`${CTRL_ROW} mb-3`}>
        <PeriodNavigator allowAll {...period.navProps} />
        <CustomSelect value={dir} onChange={(e) => setDir(e.target.value)} title="Direction — inward or local freight"
          className={`${CTRL_FIELD} max-w-[160px]`}>
          <option value="">All Types</option>
          <option value="Inward">Inward</option>
          <option value="Local">Local</option>
        </CustomSelect>
        <CustomSelect value={transporterPick} onChange={(e) => setTransporterPick(e.target.value)} title="Transporter"
          className={`${CTRL_FIELD} max-w-[230px]`}>
          <option value="">All Transporters</option>
          {transporterOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </CustomSelect>
        <CustomSelect value={pay} onChange={(e) => setPay(e.target.value)} title="Payment status"
          className={`${CTRL_FIELD} max-w-[160px]`}>
          <option value="">All Status</option>
          <option value="Paid">Paid</option>
          <option value="Partial">Partial</option>
          <option value="Unpaid">Unpaid</option>
        </CustomSelect>
        {hasFilters && (
          <>
            <span className="text-xs text-slate-500 tabular-nums">
              {filteredData.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} records
            </span>
            <button type="button" onClick={clearAll}
              className="text-xs text-slate-500 hover:text-slate-800 underline">Clear</button>
          </>
        )}
      </div>
      {/* Summary band — Freight bills · Total · Paid · Outstanding, over the
          filtered rows. Hairline-divided cells (metric-band) that pack onto one
          strip and reflow on phones, so the headline money is always in view. */}
      <div className="metric-band mb-3">
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Freight bills</p>
          <p className="text-sm font-bold text-slate-900 tabular-nums">{summary.count.toLocaleString('en-IN')}</p>
        </div>
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Total</p>
          <p className="text-sm font-bold text-slate-900 money">{fmtMoney0(summary.total)}</p>
        </div>
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Paid</p>
          <p className="text-sm font-bold text-emerald-700 money">{fmtMoney0(summary.paid)}</p>
        </div>
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Outstanding</p>
          <p className={`text-sm font-bold money ${summary.balance > 0 ? 'text-rose-600' : 'text-slate-900'}`}>{fmtMoney0(summary.balance)}</p>
        </div>
      </div>
      <ListState error={error} onRetry={load}>
        <MobileListCards
          rows={filteredData}
          isLoading={loading}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder="Search freight no, transporter, party…"
          emptyMessage="No freight bills found"
          config={{
            title: (row) => row.freight_no,
            subtitle: (row) => row.transporter_name,
            badge: (row) => {
              const s = payStatus(row.amount, row.paid);
              return { label: s, cls: PAY_CLS[s] };
            },
            fields: (row) => [
              { label: 'Type',    value: row.direction },
              { label: 'Date',    value: formatDate(row.date) },
              { label: 'Party',   value: row.vendor_name },
              { label: 'Amount',  value: formatCurrency(row.amount), cls: 'font-medium' },
              { label: 'Balance', value: formatCurrency(row.balance), cls: Number(row.balance) > 0 ? 'text-rose-600 font-medium' : 'text-emerald-700 font-medium' },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(detailRoute(row)) },
            ],
          }}
        />
        <div className="hidden sm:block">
          <DataTable
            dense
            persistKey="freight-bills"
            exportFileName="freight-bills"
            canExport={canExport('Freight Advice')}
            columns={columns}
            data={filteredData}
            isLoading={loading}
            pageSize={15}
            onRowClick={(row) => navigate(detailRoute(row))}
          />
        </div>
      </ListState>
    </MainLayout>
  );
}
