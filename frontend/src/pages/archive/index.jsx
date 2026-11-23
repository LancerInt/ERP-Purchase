import { useEffect, useMemo, useState } from 'react';
import {
  Archive as ArchiveIcon, RotateCcw, Trash2, Search, Loader2, Users, User,
} from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '@/components/layout/MainLayout';
import PageHeader from '@/components/common/PageHeader';
import { confirm } from '@/components/common/confirm';
import apiClient from '@/utils/api.js';
import { formatDate } from '@/utils/formatters.js';

export default function ArchivePage() {
  const [items, setItems] = useState([]);
  const [scope, setScope] = useState('mine');
  const [retention, setRetention] = useState(30);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);     // id being acted on
  const [q, setQ] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await apiClient.get('/api/archive/');
      setItems(data.results || []);
      setScope(data.scope || 'mine');
      setRetention(data.retention_days || 30);
    } catch {
      toast.error('Could not load the archive.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const restore = async (item) => {
    setBusy(item.id);
    try {
      await apiClient.post(`/api/archive/${item.id}/restore/`);
      setItems((xs) => xs.filter((x) => x.id !== item.id));
      toast.success('Restored.');
    } catch {
      toast.error('Could not restore this item.');
    } finally {
      setBusy(null);
    }
  };

  const purge = async (item) => {
    const ok = await confirm({
      title: 'Delete permanently',
      message: `Permanently delete "${item.label || item.module_name}"? This cannot be undone.`,
      isDangerous: true,
      confirmLabel: 'Delete permanently',
    });
    if (!ok) return;
    setBusy(item.id);
    try {
      await apiClient.post(`/api/archive/${item.id}/delete-permanent/`);
      setItems((xs) => xs.filter((x) => x.id !== item.id));
      toast.success('Permanently deleted.');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not delete this item.');
    } finally {
      setBusy(null);
    }
  };

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter((x) =>
      (x.label || '').toLowerCase().includes(term)
      || (x.module_name || '').toLowerCase().includes(term)
      || (x.deleted_by_name || '').toLowerCase().includes(term));
  }, [items, q]);

  return (
    <MainLayout>
      <PageHeader
        title="Archive"
        subtitle={`Deleted items are kept ${retention} days, then permanently removed`}
        breadcrumbs={[{ label: 'Archive' }]}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">
          {scope === 'all' ? <Users size={13} /> : <User size={13} />}
          {scope === 'all' ? "Showing everyone's deleted items" : 'Showing items you deleted'}
        </span>
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search archive…"
            className="pl-8 pr-3 py-1.5 text-sm rounded-lg border border-slate-300 w-56"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg border border-slate-200 p-12 text-center">
          <ArchiveIcon size={36} className="mx-auto text-slate-300 mb-3" />
          <p className="text-slate-500 text-sm">The archive is empty.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-100">
                  <th className="px-4 py-2.5 font-medium">Item</th>
                  <th className="px-4 py-2.5 font-medium">Module</th>
                  {scope === 'all' && <th className="px-4 py-2.5 font-medium">Deleted by</th>}
                  <th className="px-4 py-2.5 font-medium">Deleted on</th>
                  <th className="px-4 py-2.5 font-medium">Days left</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((it) => (
                  <tr key={it.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium text-slate-800 max-w-xs truncate">{it.label || '—'}</td>
                    <td className="px-4 py-2.5 text-slate-600">{it.module_name}</td>
                    {scope === 'all' && <td className="px-4 py-2.5 text-slate-600">{it.deleted_by_name || '—'}</td>}
                    <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{formatDate(it.deleted_at)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${it.days_left <= 5 ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                        {it.days_left}d
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => restore(it)}
                          disabled={busy === it.id || !it.exists}
                          title={it.exists ? 'Restore' : 'Original record no longer exists'}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          {busy === it.id ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Restore
                        </button>
                        <button
                          onClick={() => purge(it)}
                          disabled={busy === it.id}
                          title="Delete permanently"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
                        >
                          <Trash2 size={13} /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
