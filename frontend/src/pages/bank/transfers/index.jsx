import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import { formatDate, formatCurrency } from '@/utils/formatters';

// A short, readable "ERP holding number" derived from the transfer's UUID.
// The full id is still what the detail page is fetched by.
const holdingShort = (id) => 'TRF-' + String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase();

export default function OwnAccountTransfers() {
  const navigate = useNavigate();
  const { options: companyOptions } = useLookup('/api/companies/', { labelField: 'company_code' });
  const { raw: accountsRaw } = useLookup('/api/bank/accounts/?real_bank=1&include_cash=1');

  // Filters live in the URL so opening a transfer and pressing Back (or a
  // refresh / shared link) restores the same filtered view.
  const [sp, setSp] = useSearchParams();
  const [company, setCompany] = useUrlState('company', '');    // '' = All (server-side)
  const [destFilter, setDestFilter] = useUrlState('dest', ''); // destination account id ('' = all), client-side
  const [resp, setResp] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  // Same Today / Week / Month / FY / Custom widget as the Analytics top bar.
  // Defaults to 'all' so a list page hides nothing until a period is chosen.
  const period = usePeriodFilter(sp.get('period') || 'all', {
    anchor: sp.get('anchor'), customFrom: sp.get('cfrom'), customTo: sp.get('cto'),
  });

  // Write the active period back to the URL (replace — a filter change isn't a
  // new history entry; only opening a transfer is). company / dest are already
  // URL-backed via useUrlState above.
  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, val, keep) => { if (keep) p.set(k, val); else p.delete(k); };
    const np = period.navProps;
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [period.navProps, sp, setSp]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = {};
      if (company) params.company = company;
      const { data } = await apiClient.get('/api/finance/bank-statements/transfers/', { params });
      setResp(data);
    } catch (err) {
      setError(err.response?.data || err.message);
    } finally {
      setIsLoading(false);
    }
  }, [company]);

  useEffect(() => { load(); }, [load]);

  const augmented = useMemo(() => (resp?.results || []).map((r) => ({
    ...r,
    to_id: r.to_account?.id || '',
  })), [resp]);

  // Period drives BOTH the cards and the table, so the card totals reflect the
  // chosen window. Clicking a destination card then narrows only the table
  // (cards stay visible so you can switch destinations).
  const periodFiltered = useMemo(
    () => augmented.filter((r) => period.match(r.txn_date)),
    [augmented, period],
  );

  const summary = useMemo(() => {
    const by = {};
    let total = 0;
    for (const r of periodFiltered) {
      const amt = Number(r.amount) || 0;
      total += amt;
      const id = r.to_id;
      if (!by[id]) by[id] = { id, label: r.to_account?.label, short: r.to_account?.alias || r.to_account?.code, total: 0, count: 0 };
      by[id].total += amt;
      by[id].count += 1;
    }
    return { total, count: periodFiltered.length, byDest: Object.values(by).sort((a, b) => (a.label || '').localeCompare(b.label || '')) };
  }, [periodFiltered]);

  const tableRows = useMemo(
    () => (destFilter ? periodFiltered.filter((r) => r.to_id === destFilter) : periodFiltered),
    [periodFiltered, destFilter],
  );

  // Destination dropdown options — scoped to the chosen company.
  const destOptions = useMemo(() => {
    const list = (accountsRaw || []).filter((a) => !company || a.company === company);
    return list.map((a) => ({
      value: a.id,
      label: (a.internal_alias ? `${a.internal_alias} · ` : '') + `${a.code} · ${a.account_number}`,
    }));
  }, [accountsRaw, company]);

  const cardCls = (active) => `text-left rounded-xl border p-4 transition ${active
    ? 'border-blue-500 ring-1 ring-blue-500 bg-blue-50/40'
    : 'border-slate-200 bg-white hover:border-slate-300'}`;

  const columns = [
    { key: 'txn_date', label: 'Date', sortable: true, render: (v) => (v ? formatDate(v) : '-') },
    { key: 'entry_date', label: 'Entry Date', sortable: true, render: (v) => (v ? formatDate(v) : '-') },
    {
      key: 'holding_no', label: 'ERP Holding No', sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/bank/transfers/${row.id}`); }}
          className="font-mono text-xs font-medium text-primary-600 hover:text-primary-800 hover:underline"
          title={row.id}
        >{holdingShort(row.id)}</button>
      ),
    },
    { key: 'auto_narration', label: 'Narration', sortable: false, render: (v) => (
      <span className="block max-w-[360px] truncate" title={v}>{v || '-'}</span>
    ) },
    {
      key: 'amount', label: 'Amount', sortable: true,
      render: (v) => <span className="font-medium tabular-nums">{formatCurrency(Number(v) || 0)}</span>,
    },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Own-Account Transfers"
        subtitle="Money swept between your own accounts (recorded from bank statements)"
        breadcrumbs={[{ label: 'Bank' }, { label: 'Transfers' }]}
      />

      {/* Analytics-style filter bar: period + company + destination */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <PeriodNavigator allowAll {...period.navProps} />
        <CustomSelect
          value={company}
          onChange={(e) => { setCompany(e.target.value); setDestFilter(''); }}
          className="border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm bg-white max-w-[180px] focus:ring-1 focus:ring-primary-500"
          title="Company"
        >
          <option value="">All Companies</option>
          {companyOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </CustomSelect>
        <CustomSelect
          value={destFilter}
          onChange={(e) => setDestFilter(e.target.value)}
          className="border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm bg-white max-w-[260px] focus:ring-1 focus:ring-primary-500"
          title="Destination account"
        >
          <option value="">All destinations</option>
          {destOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </CustomSelect>
      </div>

      <ListState error={error} onRetry={load}>
        {/* Summary cards — click one to drill the table into that destination. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <button type="button" onClick={() => setDestFilter('')} className={cardCls(destFilter === '')}>
            <div className="text-xs font-medium text-slate-500">Total transferred</div>
            <div className="mt-1 text-xl font-semibold text-slate-800 tabular-nums">{formatCurrency(summary.total)}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">{summary.count} transfer(s)</div>
          </button>
          {summary.byDest.map((b) => (
            <button type="button" key={b.id} onClick={() => setDestFilter((cur) => (cur === b.id ? '' : b.id))} className={cardCls(destFilter === b.id)}>
              <div className="text-xs font-medium text-emerald-700 truncate" title={b.label}>→ {b.short}</div>
              <div className="mt-1 text-lg font-semibold text-slate-800 tabular-nums">{formatCurrency(b.total)}</div>
              <div className="text-[11px] text-slate-400 mt-0.5">{b.count} transfer(s)</div>
            </button>
          ))}
        </div>

        <DataTable
          persistKey="bank-own-transfers"
          exportFileName="own-account-transfers"
          columns={columns}
          data={tableRows}
          isLoading={isLoading}
          emptyMessage="No own-account transfers in this period."
          onRowClick={(row) => navigate(`/bank/transfers/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
