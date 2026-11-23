import { useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Plus, Truck, IndianRupee, CheckCircle2, Clock, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import DataTable from '../../../components/common/DataTable';
import CustomSelect from '@/components/ui/CustomSelect';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import CompanyToggle from '../../../components/common/CompanyToggle.jsx';
import { CTRL_SEG, CTRL_SEG_ITEM, CTRL_FIELD, CTRL_ROW } from '@/components/common/controls';
import { formatCurrency, formatDate } from '@/utils/formatters';

const TYPE_LABEL = {
  LOCAL_FREIGHT: 'Local Freight', STOCK_TRANSFER: 'Stock Transfer',
  UNLOADING_CHARGES: 'Unloading Charges', INWARD_CHARGES: 'Inward Charges',
  OUTWARD_CHARGES: 'Outward Charges',
};

// Local wall-clock date (IST etc.) as YYYY-MM-DD — toISOString alone would roll
// back a day for +05:30, putting "today" on the wrong side of the filter.
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export default function LocalFreightList() {
  const navigate = useNavigate();
  const location = useLocation();
  const { canCreate } = usePermissions();
  const { data, isLoading } = useApiData('/api/purchase/local-freight/');
  const { options: companyOptions } = useLookup('/api/companies/');
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  const [companyName, setCompanyName] = useUrlState('company', '');
  const companyId = (companyOptions.find((o) => String(o.label) === String(companyName))?.value) || '';
  const [warehouse, setWarehouse] = useUrlState('warehouse', '');
  const { options: warehouseOptions } = useLookup(companyId ? `/api/warehouses/?company=${companyId}` : '/api/warehouses/');
  const [search, setSearch] = useState('');
  const [datePreset, setDatePreset] = useState('all');
  const [dateFrom, setDateFrom] = useUrlState('from', '');
  const [dateTo, setDateTo] = useUrlState('to', '');

  // Same presets as Inward / Outward Freight, so the three pages behave alike.
  const applyDatePreset = (k) => {
    setDatePreset(k);
    const now = new Date();
    if (k === 'all') { setDateFrom(''); setDateTo(''); return; }
    if (k === 'today') { const t = iso(now); setDateFrom(t); setDateTo(t); return; }
    if (k === 'week') {
      const m = new Date(now); m.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      setDateFrom(iso(m)); setDateTo(iso(now)); return;
    }
    if (k === 'month') {
      setDateFrom(iso(new Date(now.getFullYear(), now.getMonth(), 1))); setDateTo(iso(now)); return;
    }
    if (k === 'fy') {
      const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      setDateFrom(iso(new Date(y, 3, 1))); setDateTo(iso(now));
    }
  };

  // Tolerant company match — see Inward/Outward Freight: match on the distinctive
  // token so legal_name / trade_name / casing differences never filter out rows.
  const companyToken = /biochem/i.test(companyName) ? 'biochem' : (/united\s*agro/i.test(companyName) ? 'united agro' : null);
  const all = Array.isArray(data) ? data : (data?.results || []);
  const rows = useMemo(() => all.filter((r) => {
    if (companyName) {
      const rn = (r.company_name || '').toLowerCase();
      if (!rn) return false;
      if (companyToken ? !rn.includes(companyToken) : !(rn === companyName.toLowerCase() || rn.includes(companyName.toLowerCase()))) return false;
    }
    if (warehouse && String(r.factory) !== String(warehouse)) return false;
    if (dateFrom && String(r.date || '') < dateFrom) return false;
    if (dateTo && String(r.date || '') > dateTo) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${r.freight_no || ''} ${r.lorry_no || ''} ${r.transporter_name || ''} ${r.bill_no || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [all, companyName, warehouse, dateFrom, dateTo, search]);

  const stats = useMemo(() => {
    const value = rows.reduce((s, r) => s + (Number(r.payable_amount ?? r.freight_amount) || 0), 0);
    const paid = rows.reduce((s, r) => s + (Number(r.total_paid) || 0), 0);
    const pending = rows.filter((r) => (Number(r.balance ?? ((Number(r.payable_amount ?? r.freight_amount) || 0) - (Number(r.total_paid) || 0))) || 0) > 0).length;
    return { records: rows.length, value, paid, pending };
  }, [rows]);

  const columns = [
    { field: 'freight_no', header: 'Freight No', sortable: true, width: '140px', render: (v) => <span className="font-medium text-primary-600">{v}</span> },
    { field: 'date', header: 'Date', sortable: true, width: '110px', render: (v) => (v ? formatDate(v) : '-') },
    { field: 'company_name', header: 'Company', sortable: true, width: '160px' },
    { field: 'factory_name', header: 'Factory', sortable: true, width: '120px', render: (v) => v || '-' },
    { field: 'freight_type', header: 'Type', sortable: true, width: '130px', render: (v) => TYPE_LABEL[v] || v },
    { field: 'transporter_name', header: 'Transporter', sortable: true, width: '150px', render: (v) => v || '-' },
    { field: 'lorry_no', header: 'Lorry No', width: '120px' },
    { field: 'freight_amount', header: 'Freight Amt', sortable: true, width: '120px', render: (v) => formatCurrency(v) },
    { field: 'amount_pay', header: 'Amount Pay', sortable: true, width: '120px', render: (v) => <span className="font-semibold">{formatCurrency(v)}</span> },
    // DC / branch-transfer info — reference only. The goods value is shown here
    // tagged "goods" and is deliberately NOT part of any freight money total.
    { field: 'is_dc', header: 'DC / Branch Transfer', sortable: false, width: '240px', render: (v, r) => (v ? (
      <div className="text-xs leading-tight">
        <span className="inline-block px-1.5 py-0.5 rounded bg-fuchsia-100 text-fuchsia-700 font-semibold">DC</span>
        <div className="text-slate-600 mt-0.5">{[r.dc_from, r.dc_to].filter(Boolean).join(' → ') || '—'}</div>
        <div className="text-slate-400">{[r.dc_material, Number(r.dc_value) > 0 ? `goods ${formatCurrency(r.dc_value)}` : ''].filter(Boolean).join(' · ')}</div>
      </div>
    ) : <span className="text-slate-300">—</span>) },
  ];

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-4">
        {/* Header — title left, company pills + create on the right (wraps on phones) */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-3xl font-bold text-slate-900 truncate">Local Freight</h1>
            <p className="hidden sm:block text-slate-600 mt-1 text-sm sm:text-base">Standalone freight &amp; charges bills</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <CompanyToggle value={companyName} onChange={setCompanyName} />
            {canCreate('Local Freight') && (
              <button onClick={() => navigate('/freight/local/new')} className="flex items-center gap-2 px-3 sm:px-5 py-2 sm:py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-medium shrink-0">
                <Plus size={18} /> <span className="hidden xs:inline">New </span>Local Freight
              </button>
            )}
          </div>
        </div>

        {/* Freight kind tabs — shared switcher (Inward · Outward · Local). */}
        <div className="flex items-center gap-1 border-b border-slate-200">
          {[
            { key: 'inward',  label: 'Inward',  to: '/freight/inward',  Icon: ArrowDownLeft },
            { key: 'outward', label: 'Outward', to: '/freight/outward', Icon: ArrowUpRight },
            { key: 'local',   label: 'Local',   to: '/freight/local',   Icon: Truck },
          ].map(({ key, label, to, Icon }) => {
            const active = location.pathname.startsWith(to);
            return (
              <button key={key} type="button" onClick={() => navigate(to)}
                className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition
                  ${active
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'}`}>
                <Icon size={15} /> {label}
              </button>
            );
          })}
        </div>

        {/* Filter bar — outer tile directly under the header, like Purchase
            Analytics. Period presets + warehouse + search, built from the shared
            toolbar vocabulary so it reflows on phones and keeps touch-sized taps. */}
        <div className="bg-white rounded-lg border border-slate-200 px-2.5 py-2.5">
          <div className={CTRL_ROW}>
            <div className={`${CTRL_SEG} shrink-0`}>
              {[{ k: 'today', label: 'Today' }, { k: 'week', label: 'Week' }, { k: 'month', label: 'Month' }, { k: 'fy', label: 'FY' }, { k: 'all', label: 'All' }].map((p, i) => (
                <button key={p.k} type="button" onClick={() => applyDatePreset(p.k)} className={CTRL_SEG_ITEM(datePreset === p.k, i === 0)}>{p.label}</button>
              ))}
            </div>
            <CustomSelect value={warehouse} onChange={(e) => setWarehouse(e.target.value)} className={`${CTRL_FIELD} max-w-[180px] shrink-0`}>
              <option value="">All Warehouses</option>
              {warehouseOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search freight no, lorry, transporter…" className={`${CTRL_FIELD} flex-1 min-w-[160px]`} />
          </div>
        </div>

        {/* Summary cards — same four as Inward / Outward Freight */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
          <div className="bg-white rounded-lg border border-slate-200 p-4 flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Total Records</p><p className="text-xl font-bold text-slate-900 mt-1">{stats.records}</p></div>
            <div className="p-2 bg-slate-100 rounded-lg"><Truck size={18} className="text-slate-500" /></div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4 flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Total Freight Value</p><p className="text-xl font-bold text-slate-900 mt-1">{formatCurrency(stats.value)}</p></div>
            <div className="p-2 bg-blue-50 rounded-lg"><IndianRupee size={18} className="text-blue-500" /></div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4 flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Total Paid</p><p className="text-xl font-bold text-emerald-600 mt-1">{formatCurrency(stats.paid)}</p></div>
            <div className="p-2 bg-emerald-50 rounded-lg"><CheckCircle2 size={18} className="text-emerald-500" /></div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4 flex items-center justify-between">
            <div><p className="text-xs text-slate-500 uppercase font-medium">Pending / Active</p><p className="text-xl font-bold text-amber-600 mt-1">{stats.pending}</p></div>
            <div className="p-2 bg-amber-50 rounded-lg"><Clock size={18} className="text-amber-500" /></div>
          </div>
        </div>

        <DataTable persistKey="freight-local"
          columns={columns}
          data={rows}
          isLoading={isLoading}
          pageSize={15}
          searchPlaceholder="Search freight no, lorry, bill no, transporter…"
          extraSearchFields={['freight_no', 'lorry_no', 'bill_no', 'transporter_name']}
          onRowClick={(row) => navigate(`/freight/local/${row.id}`)}
          emptyMessage="No local freight records yet."
          emptyIcon={Truck}
        />
      </div>
    </MainLayout>
  );
}
