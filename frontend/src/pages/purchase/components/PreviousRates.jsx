import { useState } from 'react';
import { History, Loader2, X } from 'lucide-react';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

/**
 * A small "previous rates" affordance for a line item: a history icon that
 * opens a modal listing the unit prices this VENDOR previously quoted / was
 * ordered at for this PRODUCT. Renders nothing until both vendor + product
 * are chosen. Uses a centered modal (not a popover) so it can't be clipped by
 * the line-items table's horizontal scroll container.
 */
export default function PreviousRates({ vendor, product }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);

  if (!vendor || !product) return null;

  const openModal = async () => {
    setOpen(true);
    if (data) return;
    setLoading(true);
    try {
      const res = await apiClient.get('/api/purchase/vendor-product-rates/', { params: { vendor, product } });
      setData(res.data);
    } catch {
      setData({ quotes: [], orders: [] });
    } finally {
      setLoading(false);
    }
  };

  const rows = [
    ...((data?.quotes) || []).map((r) => ({ ...r, kind: 'Quote' })),
    ...((data?.orders) || []).map((r) => ({ ...r, kind: 'PO' })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        title="Previous rates from this vendor"
        className="p-1 rounded text-slate-400 hover:bg-slate-100 hover:text-primary-600"
      >
        <History size={14} />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h4 className="text-sm font-semibold text-slate-800">Previous rates from this vendor</h4>
              <button type="button" onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            <div className="p-3">
              {loading ? (
                <div className="flex justify-center py-4 sm:py-5"><Loader2 size={18} className="animate-spin text-slate-400" /></div>
              ) : rows.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4 sm:py-5">No previous quotes or orders for this product from this vendor.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
                  {rows.map((r, i) => (
                    <div key={i} className="flex items-center justify-between py-2 px-1">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800 tabular-nums">
                          {formatCurrency(r.rate)}
                          <span className="ml-1.5 text-xs font-normal text-slate-400">/ {r.uom}{r.gst ? ` · ${r.gst}% GST` : ''}</span>
                        </div>
                        <div className="text-xs text-slate-400 truncate">{r.doc} · {formatDate(r.date)} · Qty {r.qty}</div>
                      </div>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${r.kind === 'PO' ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'}`}>{r.kind}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
