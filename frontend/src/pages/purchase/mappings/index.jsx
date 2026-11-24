/**
 * Tally Mappings — view / edit / delete the saved "name → ERP master" links
 * (TallyPartyMap) used by Scan Invoices and the Tally import. Deleting a wrong
 * mapping lets the name be matched fresh next time.
 */
import { useCallback, useEffect, useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import { Button } from '../../../components/ui';
import CustomSelect from '../../../components/ui/CustomSelect';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import { Trash2, Search, X, Check } from 'lucide-react';

export default function Mappings() {
  // ?slim=1 -> id + vendor_name only. This is a dropdown; the full vendor
  // record is ~1.2 MB and the page uses the name. Opt-in, so every other
  // caller of /api/vendors/ is untouched, and useLookup caches per endpoint
  // string so this cannot contaminate their cache.
  const { options: vendorOptions } = useLookup('/api/vendors/?slim=1', { labelField: 'vendor_name', valueField: 'id' });
  // Company comes from the GLOBAL header filter (SS default; '' = All).
  const { company: globalCompany } = useGlobalCompany();
  const company = globalCompany || '';
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);   // row id being remapped

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (company) params.company = company;
    if (q.trim()) params.q = q.trim();
    apiClient.get('/api/purchase/mappings/', { params })
      .then((r) => setRows(r.data || []))
      .catch(() => toast.error('Failed to load mappings.'))
      .finally(() => setLoading(false));
  }, [company, q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const del = async (id) => {
    if (!window.confirm('Delete this mapping? The name will be matched fresh next time.')) return;
    try {
      await apiClient.delete(`/api/purchase/mappings/${id}/`);
      setRows((rs) => rs.filter((r) => r.id !== id));
      toast.success('Mapping deleted.');
    } catch { toast.error('Delete failed.'); }
  };

  const patchRow = async (id, body) => {
    try {
      const r = await apiClient.patch(`/api/purchase/mappings/${id}/`, body);
      setRows((rs) => rs.map((x) => (x.id === id ? r.data : x)));
      setEditing(null);
      toast.success('Remapped.');
    } catch { toast.error('Remap failed.'); }
  };

  const typeOf = (r) => (r.vendor ? 'Vendor' : r.product ? 'Product' : r.customer_name ? 'Customer' : r.skip ? 'Skip' : '—');
  const mappedTo = (r) => r.vendor_name || r.product_name || r.customer_name || (r.skip ? '(skipped)' : '—');

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Tally Mappings"
        subtitle="Saved name → ERP-master links used by Scan Invoices & Tally import. Edit or delete to fix a wrong match — Tally itself is never changed."
        breadcrumbs={[{ label: 'Purchase' }, { label: 'Mappings' }]}
      />

      <div className="bg-white rounded-xl border border-gray-200 p-3 mb-4 grid gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Search name</label>
          <div className="relative">
            <Search size={14} className="absolute left-2 top-2.5 text-gray-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a Tally / invoice name…"
              className="w-full border rounded pl-7 pr-2 py-1.5 text-sm" />
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200">
        <div className="px-4 py-3 border-b text-sm font-semibold text-gray-700">
          {loading ? 'Loading…' : `${rows.length} mapping(s)`}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 border-b">
                <th className="px-4 py-2.5">Name (as on invoice / Tally)</th>
                <th className="px-3 py-2.5">Type</th>
                <th className="px-3 py-2.5">Mapped to (ERP master)</th>
                <th className="px-3 py-2.5">Company</th>
                <th className="px-3 py-2.5 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-primary-50/40 transition-colors align-top">
                  <td className="px-4 py-2.5 font-medium text-gray-800">{r.tally_name}</td>
                  <td className="px-3 py-2.5 text-gray-500">{typeOf(r)}</td>
                  <td className="px-3 py-2.5 text-gray-700">
                    {editing === r.id ? (
                      <RowEditor row={r} vendorOptions={vendorOptions} company={company}
                        onPick={(body) => patchRow(r.id, body)} onCancel={() => setEditing(null)} />
                    ) : (
                      <span className="text-emerald-700">{mappedTo(r)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-gray-500">{r.company_name || '—'}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    {editing !== r.id && (
                      <button onClick={() => setEditing(r.id)} className="text-indigo-600 text-xs hover:underline mr-3">Change</button>
                    )}
                    <button onClick={() => del(r.id)} title="Delete mapping" className="text-gray-400 hover:text-red-500"><Trash2 size={14} className="inline" /></button>
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">No mappings yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </MainLayout>
  );
}

/** Inline remap editor — vendor dropdown for vendor maps, product search for product maps. */
function RowEditor({ row, vendorOptions, company, onPick, onCancel }) {
  const isProduct = !!row.product && !row.vendor;
  const [psug, setPsug] = useState([]);
  const [pq, setPq] = useState(row.tally_name || '');

  const findProducts = async () => {
    const r = await apiClient.get('/api/purchase/scan/suggest/', { params: { kind: 'product', q: pq, company } });
    setPsug(r.data || []);
  };

  if (isProduct) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <input value={pq} onChange={(e) => setPq(e.target.value)} className="border rounded px-2 py-1 text-xs w-48" />
          <button onClick={findProducts} className="text-indigo-600 text-xs hover:underline">Find</button>
          <button onClick={onCancel} className="text-gray-400" aria-label="Close"><X size={12} /></button>
        </div>
        {psug.map((s) => (
          <button key={s.id} onClick={() => onPick({ product: s.id })}
            className="text-left text-xs text-gray-700 hover:text-indigo-600 truncate max-w-[220px]">→ {s.name}</button>
        ))}
      </div>
    );
  }
  // vendor (default)
  return (
    <div className="flex items-center gap-1">
      <CustomSelect value={row.vendor || ''} onChange={(e) => e.target.value && onPick({ vendor: e.target.value })} title="Vendor">
        <option value="">— pick vendor —</option>
        {vendorOptions.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
      </CustomSelect>
      <button onClick={onCancel} className="text-gray-400" aria-label="Close"><X size={14} /></button>
    </div>
  );
}
