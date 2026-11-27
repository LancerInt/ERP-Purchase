import { useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Plus, Truck, IndianRupee, CheckCircle2, Clock, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
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
  // Company comes from the GLOBAL header filter. This list filters by company
  // NAME, so translate the global company id → its legal name. '' = All.
  const { company: globalCompany, companies: globalCompanies } = useGlobalCompany();
  const companyId = globalCompany || '';
  const companyName = globalCompany
    ? ((globalCompanies || []).find((c) => String(c.id) === String(globalCompany))?.legal_name
       || (globalCompanies || []).find((c) => String(c.id) === String(globalCompany))?.trade_name
       || '')
    : '';
  const [warehouse, setWarehouse] = useUrlState('warehouse', '');
  const { options: warehouseOptions } = useLookup(companyId ? `/api/warehouses/?company=${companyId}` : '/api/warehouses/');
  const [search, setSearch] = useState('');
  // Standard period navigator (All / Today / Week / Month / FY / Custom).
  const period = usePeriodFilter('all');

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
    if (!period.match(String(r.date || ''))) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${r.freight_no || ''} ${r.lorry_no || ''} ${r.transporter_name || ''} ${r.bill_no || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [all, companyName, warehouse, period, search]);

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
        <span className="inline-block px-1.5 py-0.5 rounded border border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 text-[10px] font-medium">DC</span>
        <div className="text-slate-600 mt-0.5">{[r.dc_from, r.dc_to].filter(Boolean).join(' → ') || '—'}</div>
        <div className="text-slate-400">{[r.dc_material, Number(r.dc_value) > 0 ? `goods ${formatCurrency(r.dc_value)}` : ''].filter(Boolean).join(' · ')}</div>
      </div>
    ) : <span className="text-slate-300">—</span>) },
  ];

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-4">
        <PageHeader
          title="Local Freight"
          subtitle="Standalone freight & charges bills"
          breadcrumbs={[{ label: 'Freight' }, { label: 'Local Freight' }]}
          actions={canCreate('Local Freight')
            ? { createLink: '/freight/local/new', createLabel: 'New Local Freight' }
            : {}}
        />

        {/* Filter row — period + Inward/Local kind dropdown (like the Bills
            "Category" picker) + warehouse. Single search is owned by DataTable. */}
        <div className={`${CTRL_ROW} mb-3`}>
          {/* Standard period navigator (All / Today / Week / Month / FY / Custom). */}
          <PeriodNavigator allowAll {...period.navProps} />
          <CustomSelect
            value={location.pathname.startsWith('/freight/local') ? 'local' : 'inward'}
            onChange={(e) => navigate(e.target.value === 'local' ? '/freight/local' : '/freight/inward')}
            title="Freight kind"
            className={`${CTRL_FIELD} max-w-[160px]`}>
            <option value="inward">Inward</option>
            <option value="local">Local</option>
          </CustomSelect>
          <CustomSelect value={warehouse} onChange={(e) => setWarehouse(e.target.value)} title="Warehouse" className={`${CTRL_FIELD} max-w-[180px] shrink-0`}>
            <option value="">All Warehouses</option>
            {warehouseOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </CustomSelect>
        </div>

        {/* Summary band — hairline-divided cells, like Purchase Bills. */}
        <div className="metric-band mb-3">
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Records</p><p className="text-sm font-bold text-slate-900 tabular-nums">{stats.records.toLocaleString('en-IN')}</p></div>
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Total value</p><p className="text-sm font-bold text-slate-900 money">{formatCurrency(stats.value)}</p></div>
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Paid</p><p className="text-sm font-bold text-emerald-700 money">{formatCurrency(stats.paid)}</p></div>
          <div className="px-3 py-2"><p className="text-[11px] text-slate-500">Pending</p><p className={`text-sm font-bold money ${stats.pending > 0 ? 'text-amber-600' : 'text-slate-900'}`}>{stats.pending.toLocaleString('en-IN')}</p></div>
        </div>

        <div className="[&_td]:!py-1.5 [&_th]:!py-1.5">
        <DataTable dense persistKey="freight-local"
          columns={columns}
          data={rows}
          isLoading={isLoading}
          pageSize={15}
          onSearch={setSearch}
          searchPlaceholder="Search freight no, lorry, bill no, transporter…"
          extraSearchFields={['freight_no', 'lorry_no', 'bill_no', 'transporter_name']}
          onRowClick={(row) => navigate(`/freight/local/${row.id}`)}
          emptyMessage="No local freight records yet."
          emptyIcon={Truck}
        />
        </div>
      </div>
    </MainLayout>
  );
}
