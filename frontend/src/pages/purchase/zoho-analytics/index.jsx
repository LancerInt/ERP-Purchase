import { useEffect, useMemo, useState } from 'react';
import { Package, Users, Loader2, Search } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { FilterBar, useZohoFilters, fmtINR, fmtInt, fmtQty, ImportButton } from '../zoho/shared.jsx';

const PAGE = 15;

function ProductTable({ rows }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? rows.filter((r) => r.product.toLowerCase().includes(s)) : rows;
  }, [rows, q]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const cur = Math.min(page, pages);
  const slice = filtered.slice((cur - 1) * PAGE, cur * PAGE);
  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="text-sm font-semibold text-gray-700 flex items-center gap-1.5"><Package size={15} /> Product-wise ({fmtInt(filtered.length)})</div>
        <div className="relative">
          <Search size={13} className="absolute left-2 top-2.5 text-gray-400" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search product…" className="pl-7 pr-2 py-1.5 text-sm border rounded-lg w-52" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase text-gray-400 border-b">
            <th className="px-4 py-2">Product</th><th className="px-3 py-2 text-right">Quantity</th>
            <th className="px-3 py-2 text-right">Bills</th><th className="px-3 py-2 text-right">Vendors</th>
            <th className="px-3 py-2 text-right">Value <span className="text-gray-300">(approx)</span></th>
          </tr></thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i} className="border-b last:border-0 hover:bg-primary-50/40 transition-colors">
                <td className="px-4 py-2 font-medium text-gray-800">{r.product}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtQty(r.qty)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.bills)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.vendors)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmtINR(r.approx_value)}</td>
              </tr>
            ))}
            {slice.length === 0 && <tr><td colSpan={5} className="px-4 py-4 sm:py-5 text-center text-gray-400">No products.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 text-xs text-gray-500">
          <span>Page {cur} of {pages}</span>
          <div className="flex gap-1">
            <button disabled={cur <= 1} onClick={() => setPage(cur - 1)} className="px-2 py-1 border rounded disabled:opacity-40">Prev</button>
            <button disabled={cur >= pages} onClick={() => setPage(cur + 1)} className="px-2 py-1 border rounded disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

function VendorTable({ rows }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? rows.filter((r) => r.vendor.toLowerCase().includes(s)) : rows;
  }, [rows, q]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const cur = Math.min(page, pages);
  const slice = filtered.slice((cur - 1) * PAGE, cur * PAGE);
  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="text-sm font-semibold text-gray-700 flex items-center gap-1.5"><Users size={15} /> Vendor-wise ({fmtInt(filtered.length)})</div>
        <div className="relative">
          <Search size={13} className="absolute left-2 top-2.5 text-gray-400" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search vendor…" className="pl-7 pr-2 py-1.5 text-sm border rounded-lg w-52" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase text-gray-400 border-b">
            <th className="px-4 py-2">Vendor</th><th className="px-3 py-2 text-right">Bills</th>
            <th className="px-3 py-2 text-right">Purchase Value</th><th className="px-3 py-2 text-right">GST</th>
            <th className="px-3 py-2 text-right">Balance</th>
          </tr></thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i} className="border-b last:border-0 hover:bg-primary-50/40 transition-colors">
                <td className="px-4 py-2 font-medium text-gray-800">{r.vendor}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.bills)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtINR(r.value)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmtINR(r.gst)}</td>
                <td className="px-3 py-2 text-right tabular-nums"><span className={Number(r.balance) > 0 ? 'text-red-600' : 'text-emerald-700'}>{fmtINR(r.balance)}</span></td>
              </tr>
            ))}
            {slice.length === 0 && <tr><td colSpan={5} className="px-4 py-4 sm:py-5 text-center text-gray-400">No vendors.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 text-xs text-gray-500">
          <span>Page {cur} of {pages}</span>
          <div className="flex gap-1">
            <button disabled={cur <= 1} onClick={() => setPage(cur - 1)} className="px-2 py-1 border rounded disabled:opacity-40">Prev</button>
            <button disabled={cur >= pages} onClick={() => setPage(cur + 1)} className="px-2 py-1 border rounded disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ZohoPurchaseAnalytics() {
  const f = useZohoFilters();
  const [a, setA] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    setLoading(true);
    apiClient.get('/api/purchase/zoho/analytics/', { params: f.params })
      .then((r) => setA(r.data)).catch(() => setA(null)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.company, f.factory, f.from, f.to, reloadTick]);

  const products = (a?.products || []);
  const pv = (a?.product_vendor || []).slice(0, 100);

  return (
    <MainLayout>
      <PageHeader
        title="Purchase Analytics"
        subtitle="Vendor-wise & product-wise tracking (quantity exact, value approximate)"
        breadcrumbs={[{ label: 'Purchase' }, { label: 'Analytics' }]}
        actions={{
          right: (
            <div className="flex flex-wrap items-center gap-2">
              <FilterBar f={f} />
              <ImportButton what="bills" label="Import bills" f={f} onDone={() => setReloadTick((t) => t + 1)} />
              <ImportButton what="freight" label="Import freight" f={f} onDone={() => setReloadTick((t) => t + 1)} />
            </div>
          ),
        }}
      />
      {loading ? (
        <div className="py-16 text-center text-gray-400"><Loader2 className="animate-spin inline" /> Loading…</div>
      ) : !a ? (
        <div className="py-16 text-center text-gray-400">No data. Import from the Bills (Zoho) page first.</div>
      ) : (
        <div className="space-y-4">
          <VendorTable rows={a?.vendors || []} />
          <ProductTable rows={products} />

          <div className="bg-white rounded-xl border border-gray-200">
            <div className="px-4 py-3 border-b text-sm font-semibold text-gray-700 flex items-center gap-1.5"><Users size={15} /> Product × Vendor (top 100 by value)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase text-gray-400 border-b">
                  <th className="px-4 py-2">Product</th><th className="px-3 py-2">Vendor</th>
                  <th className="px-3 py-2 text-right">Quantity</th><th className="px-3 py-2 text-right">Bills</th>
                  <th className="px-3 py-2 text-right">Value <span className="text-gray-300">(approx)</span></th>
                </tr></thead>
                <tbody>
                  {pv.map((r, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-primary-50/40 transition-colors">
                      <td className="px-4 py-2 text-gray-800">{r.product}</td>
                      <td className="px-3 py-2 text-gray-600">{r.vendor}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtQty(r.qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.bills)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmtINR(r.approx_value)}</td>
                    </tr>
                  ))}
                  {pv.length === 0 && <tr><td colSpan={5} className="px-4 py-4 sm:py-5 text-center text-gray-400">No rows.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-[11px] text-gray-400">Quantities are exact (Zoho item lines). “Value (approx)” splits each bill's total across its products by quantity — Zoho stores no per-product price, so treat value as an estimate.</p>
        </div>
      )}
    </MainLayout>
  );
}
