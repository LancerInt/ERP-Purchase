import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck, Search, Loader2, Building2, FileText, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '@/components/layout/MainLayout';
import PageHeader from '@/components/common/PageHeader';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import apiClient from '@/utils/api.js';
import { formatCurrency } from '@/utils/formatters.js';

export default function LorryFreightReview() {
  const navigate = useNavigate();
  const [date, setDate] = useState('');
  const [lorry, setLorry] = useState('');
  const [soNo, setSoNo] = useState('');
  const [dcNo, setDcNo] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    const params = {};
    if (date) params.date = date;
    if (lorry.trim()) params.lorry_no = lorry.trim();
    if (soNo.trim()) params.so_no = soNo.trim();
    if (dcNo.trim()) params.dc_no = dcNo.trim();
    if (invoiceNo.trim()) params.invoice_no = invoiceNo.trim();
    if (Object.keys(params).length === 0) { toast.error('Enter at least one filter.'); return; }
    setLoading(true);
    try {
      const res = await apiClient.get('/api/sales/freight/lorry-review/', { params });
      setData(res.data);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not load freight review.');
    } finally {
      setLoading(false);
    }
  };

  const Link = ({ to, children }) => (
    <button onClick={() => navigate(to)} className="text-blue-700 hover:underline font-medium inline-flex items-center gap-0.5">
      {children}<ExternalLink size={11} />
    </button>
  );

  return (
    <MainLayout>
      <PageHeader
        title="Lorry Freight Review"
        subtitle="All DCs on a lorry with SO & Invoice references, separated by company — review before approving freight"
        breadcrumbs={[{ label: 'Freight', path: '/freight/outward' }, { label: 'Lorry Review' }]}
      />

      {/* lookup bar */}
      <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Dispatch date</label>
          <CustomDatePicker value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Lorry number</label>
          <input value={lorry} onChange={(e) => setLorry(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="e.g. TN01AB1234"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm w-40" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">SO no</label>
          <input value={soNo} onChange={(e) => setSoNo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="SO number" className="rounded-lg border border-slate-300 px-3 py-2 text-sm w-36" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">DC no</label>
          <input value={dcNo} onChange={(e) => setDcNo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="DC number" className="rounded-lg border border-slate-300 px-3 py-2 text-sm w-36" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Invoice no</label>
          <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="Invoice number" className="rounded-lg border border-slate-300 px-3 py-2 text-sm w-36" />
        </div>
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />} Load
        </button>
      </div>

      {!data ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-slate-400">
          <Truck size={36} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm">Enter any filter — date, lorry, SO, DC or invoice number — to review the trip.</p>
        </div>
      ) : data.dc_count === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-slate-500">
          No dispatch challans match those filters.
        </div>
      ) : (
        <>
          {/* summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              ['DCs on trip', data.dc_count],
              ['Total value', formatCurrency(data.grand_value)],
              ['Total freight', formatCurrency(data.total_freight)],
              ['Companies', data.companies.length],
            ].map(([label, val]) => (
              <div key={label} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="text-xs text-slate-500">{label}</div>
                <div className="text-lg font-semibold text-slate-900">{val}</div>
              </div>
            ))}
          </div>

          {/* freight advices */}
          {data.freight_advices.length > 0 && (
            <div className="mb-5 flex flex-wrap gap-2">
              {data.freight_advices.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 text-sm text-slate-700">
                  <Truck size={14} className="text-slate-400" />
                  {a.advice_no} · {formatCurrency(a.payable_amount)}
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${a.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700' : a.status === 'PAID' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>{a.status}</span>
                </span>
              ))}
            </div>
          )}

          {/* per-company sections */}
          <div className="space-y-5">
            {data.companies.map((co) => (
              <div key={co.company_id || 'none'} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <Building2 size={16} className="text-slate-400" /> {co.company_name}
                    <span className="text-xs font-normal text-slate-400">({co.dc_count} DC{co.dc_count !== 1 ? 's' : ''})</span>
                  </h3>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-slate-500">Value: <span className="font-medium text-slate-800">{formatCurrency(co.value)}</span></span>
                    <span className="text-slate-500">Freight share: <span className="font-semibold text-blue-700">{formatCurrency(co.freight_share)}</span></span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                        <th className="px-4 py-2 font-medium">DC</th>
                        <th className="px-4 py-2 font-medium">SO</th>
                        <th className="px-4 py-2 font-medium">Invoice</th>
                        <th className="px-4 py-2 font-medium text-right">Qty</th>
                        <th className="px-4 py-2 font-medium text-right">Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {co.dcs.map((dc) => (
                        <tr key={dc.dc_id} className="hover:bg-slate-50 align-top">
                          <td className="px-4 py-2">
                            <Link to={`/sales/dc/${dc.dc_id}`}>{dc.dc_no}</Link>
                            {dc.mixed_company && <span className="ml-1 text-[10px] text-amber-600" title="This DC has lines from more than one company">mixed</span>}
                          </td>
                          <td className="px-4 py-2 space-y-0.5">
                            {dc.sos.length ? dc.sos.map((s) => <div key={s.id}><Link to={`/sales/orders/${s.id}`}>{s.so_no}</Link></div>) : <span className="text-slate-400">—</span>}
                          </td>
                          <td className="px-4 py-2 space-y-0.5">
                            {dc.invoices.length ? dc.invoices.map((i) => <div key={i.id}><Link to={`/sales/invoices/${i.id}`}><FileText size={11} className="inline mr-0.5" />{i.invoice_no}</Link></div>) : <span className="text-slate-400">not invoiced</span>}
                          </td>
                          <td className="px-4 py-2 text-right text-slate-600">{dc.quantity}</td>
                          <td className="px-4 py-2 text-right font-medium text-slate-800">{formatCurrency(dc.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </MainLayout>
  );
}
