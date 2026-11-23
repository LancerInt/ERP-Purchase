/**
 * Freight Bills — every freight record as a payable bill, modelled on the
 * Purchase Bills list: the same filter row, metric band, dense table and
 * Export. Inward (purchase) and outward (sales) freight are pulled from their
 * own endpoints and shown together, each row a bill to the transporter.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import CustomSelect from '@/components/ui/CustomSelect';
import { CTRL_ROW, CTRL_FIELD } from '@/components/common/controls';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

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

const normalize = (f, direction) => {
  const amt = Number(f.total_freight_cost) || Number(f.payable_amount) || 0;
  const paid = Number(f.total_paid) || 0;
  return {
    id: `${direction}-${f.id}`, _id: f.id, direction,
    freight_no: f.advice_no || '—',
    date: f.freight_date || f.created_date || '',
    transporter: f.transporter_name || '—',
    party: f.vendor_name || f.customer_name || '—',
    company: f.company_name || '',
    amount: amt, paid, balance: amt - paid,
  };
};

export default function FreightBills() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Filters in the URL so opening a freight record and pressing Back restores
  // the same filtered view.
  const [sp, setSp] = useSearchParams();
  const [dir, setDir] = useState(sp.get('dir') || '');       // '' | Inward | Outward
  const [pay, setPay] = useState(sp.get('pay') || '');       // '' | Paid | Partial | Unpaid
  const [company, setCompany] = useState(sp.get('company') || '');
  const [search, setSearch] = useState(sp.get('q') || '');
  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    put('dir', dir, !!dir); put('pay', pay, !!pay);
    put('company', company, !!company); put('q', search, !!search.trim());
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [dir, pay, company, search, sp, setSp]);

  const load = () => {
    setLoading(true); setError(null);
    Promise.all([fetchAll('/api/purchase/freight/'), fetchAll('/api/sales/freight/')])
      .then(([p, s]) => setRows([
        ...p.map((f) => normalize(f, 'Inward')),
        ...s.map((f) => normalize(f, 'Outward')),
      ]))
      .catch(() => setError('Could not load freight.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const companies = useMemo(() => [...new Set(rows.map((r) => r.company).filter(Boolean))].sort(), [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (dir && r.direction !== dir) return false;
    if (pay && payStatus(r.amount, r.paid) !== pay) return false;
    if (company && r.company !== company) return false;
    if (search) {
      const s = search.toLowerCase();
      if (![r.freight_no, r.transporter, r.party].some((v) => (v || '').toLowerCase().includes(s))) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)), [rows, dir, pay, company, search]);

  const summary = useMemo(() => filtered.reduce((a, r) => {
    a.count += 1; a.total += r.amount; a.paid += r.paid; a.balance += r.balance; return a;
  }, { count: 0, total: 0, paid: 0, balance: 0 }), [filtered]);

  const columns = [
    { field: 'date', header: 'Date', sortable: true, width: '100px', render: (v) => v ? formatDate(v, 'dd-MMM-yy') : '-' },
    { field: 'freight_no', header: 'Freight No', sortable: true, width: '130px',
      render: (v, row) => <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/${row.direction === 'Inward' ? 'purchase' : 'sales'}/${row._id}`); }} className="text-blue-700 hover:underline font-medium text-xs">{v}</button> },
    { field: 'direction', header: 'Type', sortable: true, width: '90px',
      render: (v) => <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded border ${v === 'Inward' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-violet-50 text-violet-700 border-violet-200'}`}>{v}</span> },
    { field: 'transporter', header: 'Transporter', sortable: true, width: '200px' },
    { field: 'party', header: 'Party', sortable: true, width: '180px' },
    { field: 'amount', header: 'Amount', sortable: true, width: '110px', render: (v) => formatCurrency(v) },
    { field: 'paid', header: 'Paid', sortable: true, width: '110px', render: (v) => <span className="text-emerald-700">{formatCurrency(v)}</span> },
    { field: 'balance', header: 'Balance', sortable: true, width: '110px',
      render: (v) => <span className={Number(v) > 0 ? 'text-rose-600 font-medium' : 'text-emerald-700 font-medium'}>{formatCurrency(v)}</span> },
    { field: 'status', header: 'Status', sortable: false, width: '90px',
      render: (_v, row) => { const s = payStatus(row.amount, row.paid); return <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${PAY_CLS[s]}`}>{s}</span>; } },
  ];

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-4">
        <PageHeader compact title="Freight Bills" subtitle="Freight as payable bills — inward and outward"
          breadcrumbs={[{ label: 'Freight' }, { label: 'Freight Bills' }]} />

        <div className={CTRL_ROW}>
          <CustomSelect value={dir} onChange={(e) => setDir(e.target.value)} title="Direction" className={`${CTRL_FIELD} max-w-[150px]`}>
            <option value="">All Types</option><option value="Inward">Inward</option><option value="Outward">Outward</option>
          </CustomSelect>
          <CustomSelect value={pay} onChange={(e) => setPay(e.target.value)} title="Payment status" className={`${CTRL_FIELD} max-w-[150px]`}>
            <option value="">All Payments</option><option value="Paid">Paid</option><option value="Partial">Partial</option><option value="Unpaid">Unpaid</option>
          </CustomSelect>
          {companies.length > 1 && (
            <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)} title="Company" className={`${CTRL_FIELD} max-w-[230px]`}>
              <option value="">All Companies</option>
              {companies.map((c) => <option key={c} value={c}>{c}</option>)}
            </CustomSelect>
          )}
          {(dir || pay || company || search) && (
            <button type="button" onClick={() => { setDir(''); setPay(''); setCompany(''); setSearch(''); }}
              className="text-xs text-slate-500 hover:text-slate-800 underline">Clear</button>
          )}
        </div>

        <div className="metric-band">
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Freight bills</p><p className="text-sm font-bold text-slate-900 tabular-nums">{summary.count.toLocaleString('en-IN')}</p></div>
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Total</p><p className="text-sm font-bold text-slate-900 money">{fmtMoney0(summary.total)}</p></div>
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Paid</p><p className="text-sm font-bold text-emerald-700 money">{fmtMoney0(summary.paid)}</p></div>
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Outstanding</p><p className={`text-sm font-bold money ${summary.balance > 0 ? 'text-rose-600' : 'text-slate-900'}`}>{fmtMoney0(summary.balance)}</p></div>
        </div>

        <ListState error={error} onRetry={load}>
          <div className="hidden sm:block">
            <DataTable dense columns={columns} data={filtered} isLoading={loading} pageSize={15}
              onSearch={setSearch} searchPlaceholder="Search freight no, transporter, party…" />
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}
