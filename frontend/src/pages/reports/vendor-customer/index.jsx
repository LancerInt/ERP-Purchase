/**
 * Vendor-Customer report — one row per party that is BOTH a vendor and a
 * customer (an ERP vendor with a `linked_customer`). It sets the purchase side
 * (bills / outstanding) beside the sales side (invoices / received / sales
 * offset) and the net position, so the sales-offset figures that used to crowd
 * the Bills list live here, where they apply to exactly these few parties.
 *
 * Backend: GET /api/purchase/bills/vendor-customer-report/?company=<id>
 */
import { useState, useMemo, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Handshake, Download, Loader2, ExternalLink } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import ListState from '@/components/common/ListState.jsx';
import { formatCurrency } from '@/utils/formatters';
import exportToExcel from '../../../utils/exportExcel.js';

const fmtMoney0 = (v) => `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;

export default function VendorCustomerReport() {
  const { options: companies } = useLookup('/api/companies/', { labelField: 'legal_name' });
  // Company filter in the URL so a drill-out to a bill/invoice and Back keeps it.
  const [sp, setSp] = useSearchParams();
  const [company, setCompany] = useState(sp.get('company') || '');
  useEffect(() => {
    const p = new URLSearchParams(sp);
    if (company) p.set('company', company); else p.delete('company');
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [company, sp, setSp]);
  const endpoint = `/api/purchase/bills/vendor-customer-report/${company ? `?company=${encodeURIComponent(company)}` : ''}`;
  const { data, isLoading, error, refetch } = useApiData(endpoint);

  const rows = data?.rows || [];
  const totals = data?.totals || {};

  const exportRows = useMemo(() => rows.map((r) => ({
    party: r.vendor_name, company: r.company_code,
    purchase_total: Number(r.purchase_total).toFixed(2),
    purchase_outstanding: Number(r.purchase_outstanding).toFixed(2),
    sales_invoices: Number(r.sales_invoices).toFixed(2),
    sales_received: Number(r.sales_received).toFixed(2),
    sales_offset: Number(r.sales_offset).toFixed(2),
    net: Number(r.net).toFixed(2),
  })), [rows]);

  const doExport = () => {
    if (!rows.length) return;
    exportToExcel(exportRows, [
      { field: 'party', header: 'Party' }, { field: 'company', header: 'Company' },
      { field: 'purchase_total', header: 'Purchase Total' },
      { field: 'purchase_outstanding', header: 'Purchase Outstanding' },
      { field: 'sales_invoices', header: 'Sales Invoices' },
      { field: 'sales_received', header: 'Sales Received' },
      { field: 'sales_offset', header: 'Sales Offset' },
      { field: 'net', header: 'Net Position' },
    ], `vendor-customer-${new Date().toISOString().slice(0, 10)}`);
  };

  const Tile = ({ label, value, tone }) => (
    <div className="px-3 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`text-sm font-bold money ${tone || 'text-slate-900'}`}>{value}</p>
    </div>
  );

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-4">
        <PageHeader
          compact
          title="Vendor-Customer"
          subtitle="Parties that are both a vendor and a customer — purchase vs sales, netted"
          breadcrumbs={[{ label: 'Reports' }, { label: 'Vendor-Customer' }]}
          icon={Handshake}
        />

        <div className="bg-white rounded-lg border border-slate-200 shadow-sm px-3 py-2.5 flex flex-wrap items-center gap-2">
          <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)}
            className="border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[200px] h-9">
            <option value="">All Companies</option>
            {companies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>
          <span className="text-xs text-slate-400">
            A vendor is linked to a customer on the vendor master; only linked parties appear here.
          </span>
          <button type="button" onClick={doExport} disabled={!rows.length}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
            <Download size={14} /> Export
          </button>
        </div>

        {/* Summary band */}
        <div className="metric-band">
          <Tile label="Parties" value={(data?.count || 0).toLocaleString('en-IN')} tone="text-slate-900 tabular-nums" />
          <Tile label="Purchase outstanding" value={fmtMoney0(totals.purchase_outstanding)} tone="text-rose-600" />
          <Tile label="Sales offset" value={fmtMoney0(totals.sales_offset)} tone="text-blue-600" />
          <Tile label="Net position" value={fmtMoney0(totals.net)} tone={(totals.net || 0) > 0 ? 'text-rose-600' : 'text-emerald-600'} />
        </div>

        <ListState error={error} onRetry={refetch}>
          <div className="hidden sm:block overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2 text-left font-semibold">Party</th>
                  <th className="px-3 py-2 text-left font-semibold">Co.</th>
                  <th className="px-3 py-2 text-right font-semibold">Purchase total</th>
                  <th className="px-3 py-2 text-right font-semibold">Purchase outstanding</th>
                  <th className="px-3 py-2 text-right font-semibold">Sales invoices</th>
                  <th className="px-3 py-2 text-right font-semibold">Sales received</th>
                  <th className="px-3 py-2 text-right font-semibold">Sales offset</th>
                  <th className="px-3 py-2 text-right font-semibold">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading && (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-slate-400">
                    <Loader2 className="inline animate-spin mr-2" size={16} /> Loading…</td></tr>
                )}
                {!isLoading && rows.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-sm text-slate-400">
                    No linked vendor-customers{company ? ' for this company' : ''}. Link a vendor to a customer on the vendor master to see it here.</td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.vendor_id} className="hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <Link to={`/purchase/bills?vend=${encodeURIComponent(r.vendor_name)}`}
                        className="font-medium text-indigo-600 hover:underline inline-flex items-center gap-1">
                        {r.vendor_name}<ExternalLink size={11} />
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-slate-500">{r.company_code}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.purchase_total)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600 font-medium">{formatCurrency(r.purchase_outstanding)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <Link to={`/sales/invoices?customer=${encodeURIComponent(r.customer_name)}`}
                        className="text-indigo-600 hover:underline">{formatCurrency(r.sales_invoices)}</Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{formatCurrency(r.sales_received)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-blue-600 font-medium">{formatCurrency(r.sales_offset)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-bold ${Number(r.net) > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{formatCurrency(r.net)}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="bg-slate-50 font-bold text-slate-800 border-t border-slate-200">
                    <td className="px-3 py-2" colSpan={2}>Total · {rows.length} parties</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totals.purchase_total)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600">{formatCurrency(totals.purchase_outstanding)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totals.sales_invoices)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{formatCurrency(totals.sales_received)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-blue-600">{formatCurrency(totals.sales_offset)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${Number(totals.net) > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{formatCurrency(totals.net)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}
