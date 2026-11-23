import { useState, useEffect } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';

// Receivables where WE are the MSME supplier (A8). Our customers owe us within
// 45 days (MSMED Act §15); past the "appointed day" we can claim interest.
// This view ages our open receivables against that limit, per company, and
// estimates the compound-monthly interest. Only companies flagged MSME on the
// Company master return rows.
const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export default function MsmeReceivables() {
  const { options: companies } = useLookup('/api/companies/', { labelField: 'legal_name' });
  const [company, setCompany] = useState('');
  const [rate, setRate] = useState('18');
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [notMsme, setNotMsme] = useState(false);

  useEffect(() => {
    if (!company) { setData(null); setNotMsme(false); return undefined; }
    let cancelled = false;
    setIsLoading(true);
    apiClient.get(`/api/companies/${company}/msme-receivables/`, { params: { rate } })
      .then((res) => {
        if (cancelled) return;
        setNotMsme(res.data?.is_msme === false);
        setData(res.data?.is_msme ? res.data : null);
      })
      .catch(() => { if (!cancelled) { setData(null); setNotMsme(false); } })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [company, rate]);

  const s = data?.summary || {};

  return (
    <MainLayout>
      <PageHeader
        title="MSME Receivables"
        subtitle="Overdue receivables where we are the MSME supplier (MSMED Act §15)"
        breadcrumbs={[{ label: 'Sales', href: '/sales' }, { label: 'Receivables', href: '/sales/receivables' }, { label: 'MSME' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
            <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
              <option value="">Select a company…</option>
              {companies.filter(c => c.value).map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
          </div>
          <div className="w-40">
            <label className="block text-sm font-medium text-slate-700 mb-1">Interest rate (% p.a.)</label>
            <input type="number" step="any" value={rate} onChange={(e) => setRate(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          </div>
        </div>

        {notMsme && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
            This company is not flagged as an MSME supplier. Set it on the Company master (MSME registered) to track MSME receivables here.
          </div>
        )}

        {isLoading && <div className="text-sm text-slate-500">Loading…</div>}

        {data && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-lg border border-slate-200 p-3">
                <div className="text-xs text-slate-500">Overdue invoices (&gt;45 days)</div>
                <div className="text-xl font-semibold text-slate-900">{s.count || 0}</div>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <div className="text-xs text-slate-500">Overdue balance</div>
                <div className="text-xl font-semibold text-slate-900">{inr(s.total_balance)}</div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="text-xs text-amber-700">Est. interest claimable @ {data.rate_used}%</div>
                <div className="text-xl font-semibold text-amber-800">{inr(s.total_interest_estimate)}</div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b">
                    <th className="py-2 pr-4">Invoice</th>
                    <th className="py-2 pr-4">Customer</th>
                    <th className="py-2 pr-4">Invoice date</th>
                    <th className="py-2 pr-4">Appointed day</th>
                    <th className="py-2 pr-4 text-right">Days overdue</th>
                    <th className="py-2 pr-4 text-right">Balance</th>
                    <th className="py-2 pr-4 text-right">Est. interest</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={`${r.invoice_no}-${i}`} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium text-slate-800">{r.invoice_no}</td>
                      <td className="py-2 pr-4">{r.customer || '—'}</td>
                      <td className="py-2 pr-4">{r.invoice_date}</td>
                      <td className="py-2 pr-4">{r.appointed_day}</td>
                      <td className="py-2 pr-4 text-right">{r.days_overdue}</td>
                      <td className="py-2 pr-4 text-right">{inr(r.balance)}</td>
                      <td className="py-2 pr-4 text-right text-amber-700">{inr(r.interest_estimate)}</td>
                    </tr>
                  ))}
                  {data.rows.length === 0 && (
                    <tr><td colSpan={7} className="py-4 text-center text-slate-400">No receivables overdue beyond 45 days.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-400">Interest is an estimate (compound monthly at the chosen rate from the appointed day). The statutory rate is 3× the RBI-notified bank rate over the delay period.</p>
          </>
        )}
      </div>
    </MainLayout>
  );
}
