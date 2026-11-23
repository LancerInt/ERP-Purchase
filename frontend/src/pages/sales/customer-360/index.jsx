/**
 * Customer 360 — list page with search, click through to detail.
 *
 * Route: /sales/customer-360
 * Fetches /api/customers/?has_sales=true and renders a searchable,
 * sortable table. Clicking a customer navigates to
 * /sales/customer-360/:id (the detail view).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search, Users, TrendingUp, AlertCircle, ChevronRight,
  ArrowUpDown, Loader2, Building2, X,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';

const num = (v) => Number(v) || 0;
const fmtINR = (v) => {
  const n = num(v);
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

const shortCompany = (label) => {
  const w = String(label || '').replace(/[.,]/g, ' ').split(/\s+/)
    .filter(x => x && !/^(pvt|private|ltd|limited|llp|inc|co|company|india|the|and|&)$/i.test(x));
  return (w.slice(0, 2).join(' ') || label || '').toUpperCase();
};

const SORT_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'outstanding', label: 'Outstanding' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'sales', label: 'Total Sales' },
];

export default function Customer360List() {
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const [search, setSearch] = useState(sp.get('q') || '');
  const [company, setCompany] = useState(sp.get('company') || '');
  const [sortBy, setSortBy] = useState('outstanding');
  const [sortDir, setSortDir] = useState('desc');
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);

  const { options: companyOptions } = useLookup('/api/companies/');
  const [sellerIds, setSellerIds] = useState(null);
  useEffect(() => {
    let cancel = false;
    apiClient.get('/api/sales/dashboard/?period=today')
      .then(r => { if (!cancel) setSellerIds((r.data?.sales_companies || []).map(String)); })
      .catch(() => { if (!cancel) setSellerIds([]); });
    return () => { cancel = true; };
  }, []);
  const sellerCompanies = sellerIds?.length
    ? companyOptions.filter(co => co.value && sellerIds.includes(String(co.value)))
    : companyOptions;

  // Default to SS Biochem when no company param is in the URL
  useEffect(() => {
    if (company || sp.get('company') || sellerIds === null || !companyOptions.length) return;
    const bio = companyOptions.find(c => /biochem/i.test(c.label));
    if (bio) setCompany(String(bio.value));
    else if (sellerCompanies.length) setCompany(String(sellerCompanies[0].value));
  }, [sellerIds, companyOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    const url = company
      ? `/api/customers/?company=${company}&has_sales=true`
      : '/api/customers/?has_sales=true';
    apiClient.get(url)
      .then(r => {
        if (cancel) return;
        const list = (r.data?.results || r.data || []).map(c => ({
          id: c.id || c.value,
          name: c.customer_name || c.label || c.name || '',
          gstin: c.gstin || '',
          city: c.city || c.billing_city || (c.billing_address && typeof c.billing_address === 'object' ? c.billing_address.district : '') || '',
          state: c.state || c.billing_state || (c.billing_address && typeof c.billing_address === 'object' ? c.billing_address.state : '') || '',
          credit_terms: c.credit_terms || '',
          contact_person: c.contact_person || '',
          phone: c.contact_phone || c.phone || '',
          outstanding: num(c.total_outstanding || c.outstanding),
          overdue: num(c.total_overdue || c.overdue),
          sales: num(c.total_sales || c.sales || c.turnover),
          company_name: c.company_name || '',
        }));
        setCustomers(list);
      })
      .catch(() => setCustomers([]))
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [company]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    let list = customers;
    if (q) {
      list = list.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.gstin.toLowerCase().includes(q) ||
        c.city.toLowerCase().includes(q) ||
        c.contact_person.toLowerCase().includes(q)
      );
    }
    list = [...list].sort((a, b) => {
      if (sortBy === 'name') return sortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      return sortDir === 'asc' ? a[sortBy] - b[sortBy] : b[sortBy] - a[sortBy];
    });
    return list;
  }, [customers, search, sortBy, sortDir]);

  const totals = useMemo(() => ({
    count: filtered.length,
    outstanding: filtered.reduce((s, c) => s + c.outstanding, 0),
    overdue: filtered.reduce((s, c) => s + c.overdue, 0),
    sales: filtered.reduce((s, c) => s + c.sales, 0),
  }), [filtered]);

  const toggleSort = (key) => {
    if (sortBy === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(key); setSortDir('desc'); }
  };

  const initials = (name) => {
    const parts = name.split(/\s+/).filter(Boolean);
    return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : (parts[0] || '?').slice(0, 2).toUpperCase();
  };

  return (
    <MainLayout>
      <PageHeader
        title="Customer 360"
        subtitle="Search and explore customer insights"
        icon={Users}
        breadcrumbs={[{ label: 'Sales', href: '/sales/dashboard' }, { label: 'Customer 360' }]}
        actions={{
          right: (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {sellerCompanies.map(co => {
                const active = String(company) === String(co.value);
                return (
                  <button key={co.value} type="button" onClick={() => setCompany(active ? '' : String(co.value))}
                    title={co.label}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm' : 'bg-white text-slate-700 border-slate-200 hover:border-emerald-300 hover:text-emerald-600'}`}>
                    {shortCompany(co.label)}
                  </button>
                );
              })}
            </div>
          ),
        }}
      />

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-white rounded-lg border border-slate-200 px-4 py-3">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Customers</div>
          <div className="text-xl font-bold text-slate-800 mt-1">{totals.count}</div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 px-4 py-3">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Total Sales</div>
          <div className="text-xl font-bold text-emerald-600 mt-1">{fmtINR(totals.sales)}</div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 px-4 py-3">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Outstanding</div>
          <div className="text-xl font-bold text-amber-600 mt-1">{fmtINR(totals.outstanding)}</div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 px-4 py-3">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Overdue</div>
          <div className="text-xl font-bold text-red-600 mt-1">{fmtINR(totals.overdue)}</div>
        </div>
      </div>

      {/* Search + sort bar */}
      <div className="bg-white rounded-lg border border-slate-200 px-3 py-2.5 mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, GSTIN, city or contact..."
            className="w-full pl-8 pr-8 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-100"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <ArrowUpDown size={13} />
          {SORT_FIELDS.map(sf => (
            <button key={sf.key} onClick={() => toggleSort(sf.key)}
              className={`px-2 py-1 rounded text-xs font-medium transition ${sortBy === sf.key ? 'bg-emerald-50 text-emerald-700 font-semibold' : 'hover:bg-slate-50'}`}>
              {sf.label} {sortBy === sf.key ? (sortDir === 'desc' ? '↓' : '↑') : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Customer list */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-slate-400">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading customers...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <Users size={32} className="mb-2 opacity-50" />
            <div className="text-sm font-medium">{search ? 'No customers match your search' : 'No customers found'}</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/60">
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Customer</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide hidden md:table-cell">GSTIN</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide hidden lg:table-cell">Location</th>
                <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Sales</th>
                <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Outstanding</th>
                <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide hidden sm:table-cell">Overdue</th>
                <th className="px-2 py-2.5 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/sales/customer-360/${c.id}`)}
                  className="border-b border-slate-100 hover:bg-emerald-50/40 cursor-pointer transition-colors group"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white flex items-center justify-center text-[11px] font-bold flex-shrink-0">
                        {initials(c.name)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-800 truncate group-hover:text-emerald-700 transition-colors">{c.name}</div>
                        {c.contact_person && <div className="text-[11px] text-slate-400 truncate">{c.contact_person}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-slate-500 text-xs font-mono hidden md:table-cell">{c.gstin || '—'}</td>
                  <td className="px-3 py-3 text-slate-500 text-xs hidden lg:table-cell">{[c.city, c.state].filter(Boolean).join(', ') || '—'}</td>
                  <td className="px-3 py-3 text-right font-semibold text-slate-700 tabular-nums">{c.sales ? fmtINR(c.sales) : '—'}</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {c.outstanding > 0 ? (
                      <span className="font-semibold text-amber-600">{fmtINR(c.outstanding)}</span>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums hidden sm:table-cell">
                    {c.overdue > 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600">
                        <AlertCircle size={12} /> {fmtINR(c.overdue)}
                      </span>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-2 py-3 text-slate-300 group-hover:text-emerald-500 transition-colors">
                    <ChevronRight size={16} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </MainLayout>
  );
}
