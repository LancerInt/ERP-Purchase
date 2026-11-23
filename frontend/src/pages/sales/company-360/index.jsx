/**
 * Company 360 — list page. Pick a seller company to open its detail view.
 *
 * Route: /sales/company-360
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Building2, ChevronRight, Loader2, X } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';

export default function Company360List() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    Promise.all([
      apiClient.get('/api/companies/').then(r => r.data?.results || r.data || []).catch(() => []),
      apiClient.get('/api/sales/dashboard/?period=today').then(r => r.data).catch(() => null),
    ]).then(([cos, dash]) => {
      if (cancel) return;
      const sellerIds = (dash?.sales_companies || []).map(String);
      const list = (Array.isArray(cos) ? cos : []).map(c => {
        const ra = c.registered_address && typeof c.registered_address === 'object' ? c.registered_address : {};
        return {
          id: c.id || c.value,
          code: c.company_code || '',
          name: c.legal_name || c.label || c.name || '',
          trade_name: c.trade_name || '',
          gstin: c.gstin || '',
          pan: c.pan || '',
          cin: c.cin || '',
          email: c.contact_email || '',
          phone: c.contact_phone || '',
          district: ra.district || '',
          state: ra.state || '',
          hasSales: sellerIds.includes(String(c.id || c.value)),
        };
      });
      list.sort((a, b) => {
        if (a.hasSales !== b.hasSales) return a.hasSales ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setCompanies(list);
    }).finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return companies;
    return companies.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.trade_name.toLowerCase().includes(q) ||
      c.gstin.toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q) ||
      c.state.toLowerCase().includes(q) ||
      c.district.toLowerCase().includes(q)
    );
  }, [companies, search]);

  const initials = (name) => {
    const parts = name.split(/\s+/).filter(Boolean);
    return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : (parts[0] || '?').slice(0, 2).toUpperCase();
  };

  return (
    <MainLayout>
      <PageHeader
        title="Company 360"
        subtitle="Company-wide sales analytics and receivables"
        icon={Building2}
        breadcrumbs={[{ label: 'Sales', href: '/sales/dashboard' }, { label: 'Company 360' }]}
      />

      {/* Search bar */}
      <div className="bg-white rounded-lg border border-slate-200 px-3 py-2.5 mb-4 flex items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, GSTIN, code or location..."
            className="w-full pl-8 pr-8 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-100"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Company list */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-slate-400">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading companies...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <Building2 size={32} className="mb-2 opacity-50" />
            <div className="text-sm font-medium">{search ? 'No companies match your search' : 'No companies found'}</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/60">
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Company</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide hidden md:table-cell">GSTIN</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide hidden lg:table-cell">PAN</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide hidden lg:table-cell">Location</th>
                <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide hidden sm:table-cell">Contact</th>
                <th className="px-2 py-2.5 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/sales/company-360/${c.id}`)}
                  className="border-b border-slate-100 hover:bg-emerald-50/40 cursor-pointer transition-colors group"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white flex items-center justify-center text-[11px] font-bold flex-shrink-0">
                        {initials(c.name)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-800 truncate group-hover:text-emerald-700 transition-colors">{c.name}</div>
                        <div className="text-[11px] text-slate-400 truncate">{c.code}{c.trade_name && c.trade_name !== c.name ? ` · ${c.trade_name}` : ''}</div>
                      </div>
                      {!c.hasSales && <span className="text-[9px] font-semibold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">NO SALES</span>}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-slate-500 text-xs font-mono hidden md:table-cell">{c.gstin || '—'}</td>
                  <td className="px-3 py-3 text-slate-500 text-xs font-mono hidden lg:table-cell">{c.pan || '—'}</td>
                  <td className="px-3 py-3 text-slate-500 text-xs hidden lg:table-cell">{[c.district, c.state].filter(Boolean).join(', ') || '—'}</td>
                  <td className="px-3 py-3 text-slate-500 text-xs hidden sm:table-cell truncate max-w-[180px]">{c.email || c.phone || '—'}</td>
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
