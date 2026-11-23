import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Printer, Send, CheckCircle, XCircle, Loader2, Mail } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import ConsigneeBilling from '../../../components/common/ConsigneeBilling';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

export default function SalesQuoteDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canSendEmail } = usePermissions();
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const fetchQuote = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get(`/api/sales/quotations/${id}/`);
      setQuote(res.data);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally { setLoading(false); }
  }, [id]);
  useEffect(() => { fetchQuote(); }, [fetchQuote]);

  const act = async (path, body, okMsg) => {
    setBusy(path);
    try {
      const res = await apiClient.post(`/api/sales/quotations/${id}/${path}/`, body || {});
      toast.success(okMsg);
      if (path === 'convert-to-so' && res.data?.so_id) { navigate(`/sales/orders/${res.data.so_id}`); return; }
      fetchQuote();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally { setBusy(''); }
  };

  if (loading) return <MainLayout><div className="flex justify-center py-20"><Loader2 className="animate-spin text-slate-400" /></div></MainLayout>;
  if (!quote) return <MainLayout><div className="text-center py-20 text-slate-500">Quotation not found.</div></MainLayout>;

  const lines = quote.quotation_lines || [];
  const status = quote.status;
  const consignee = { name: quote.consignee_name, address: quote.consignee_address, gstin: quote.consignee_gstin };
  const billing = { address: quote.billing_address, gstin: quote.billing_gstin };

  return (
    <MainLayout>
      <div className="flex items-center gap-2 text-sm text-slate-500 mb-3 print:hidden">
        <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/quotes'))} className="p-1.5 -ml-1.5 rounded-lg hover:bg-slate-100"><ArrowLeft size={18} /></button>
        Sales / Quotes / {quote.quote_no}
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 print:hidden">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-slate-900">{quote.quote_no}</h1>
          <StatusBadge status={quote.status_display || status} />
          {quote.converted_so_no && <span className="text-xs text-emerald-700">→ {quote.converted_so_no}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => navigate(`/sales/quotes/${id}/document`)} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"><Printer size={15} /> Quote Document</button>
          {canSendEmail('Sales Quote') && (
            <button onClick={() => navigate(`/sales/quotes/${id}/send-email`)} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"><Mail size={15} /> Send Email</button>
          )}
          {/* No quote → Sales Order conversion here: Sales Orders are created
              from Customer POs. A second path from the quote would risk a
              duplicate SO for the same deal. (The backend convert-to-so
              endpoint still exists, guarded, but is intentionally not surfaced.) */}
        </div>
      </div>

      {/* Printable quote */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 space-y-5">
        <div className="flex items-start justify-between border-b pb-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Quotation</h2>
            <p className="text-sm text-slate-500">{quote.quote_no}</p>
          </div>
          <div className="text-right text-sm text-slate-600">
            <div>Date: {formatDate(quote.quote_date)}</div>
            {quote.valid_until && <div>Valid until: {formatDate(quote.valid_until)}</div>}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div><span className="text-slate-500">Customer:</span> <span className="font-medium text-slate-800">{quote.customer_name}</span></div>
          <div><span className="text-slate-500">Company:</span> <span className="font-medium text-slate-800">{quote.company_name}</span></div>
          {quote.warehouse_name && <div><span className="text-slate-500">Warehouse:</span> {quote.warehouse_name}</div>}
          {quote.payment_terms && <div><span className="text-slate-500">Payment:</span> {quote.payment_terms}</div>}
          {quote.delivery_terms && <div><span className="text-slate-500">Delivery:</span> {quote.delivery_terms}</div>}
          {quote.freight_terms && <div><span className="text-slate-500">Freight:</span> {quote.freight_terms}</div>}
          <div><span className="text-slate-500">Currency:</span> {quote.currency || 'INR'}</div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b text-left text-slate-600">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 font-medium text-right">Qty</th>
                <th className="px-3 py-2 font-medium">UOM</th>
                <th className="px-3 py-2 font-medium text-right">Unit Price</th>
                <th className="px-3 py-2 font-medium text-right">Disc</th>
                <th className="px-3 py-2 font-medium text-right">GST%</th>
                <th className="px-3 py-2 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id || i} className="border-b border-slate-100">
                  <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                  <td className="px-3 py-2 text-slate-800">{l.product_name}{l.product_code ? <span className="text-xs text-slate-400 ml-1">({l.product_code})</span> : ''}</td>
                  <td className="px-3 py-2 text-right">{l.quantity}</td>
                  <td className="px-3 py-2">{l.uom}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(l.unit_price)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.discount > 0 ? formatCurrency(l.discount) : '-'}</td>
                  <td className="px-3 py-2 text-right">{l.gst}%</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(l.line_total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td colSpan={7} className="px-3 py-2 text-right">Grand Total</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(quote.total_amount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {(consignee.name || consignee.address || billing.address) && (
          <ConsigneeBilling consignee={consignee} billing={billing} />
        )}
        {quote.remarks && <div className="text-sm text-slate-600"><span className="font-medium">Remarks:</span> {quote.remarks}</div>}
      </div>
    </MainLayout>
  );
}
