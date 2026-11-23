import { useState, useEffect } from 'react';
import { Edit3, Loader2, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import { formatCurrency } from '@/utils/formatters';

/**
 * PO amendment workflow UI for the PO detail page.
 *
 * - Coordinator (canRequest): "Request Amendment" → propose new line
 *   prices / quantities + a reason.
 * - Manager/Admin (canApprove): sees a "pending amendment" banner →
 *   reviews the before→after (and may tweak), then Approve & apply (bumps
 *   the PO revision) or Reject.
 *
 * Only shown on APPROVED / ISSUED POs.
 */
export default function POAmendment({ po, canRequest, canApprove, onApplied }) {
  const [pending, setPending] = useState(null);
  const [mode, setMode] = useState(null);  // 'request' | 'review' | null
  const [reason, setReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);

  const amendable = !!po && (po.status === 'APPROVED' || po.status === 'ISSUED');

  const loadPending = async () => {
    if (!po?.id || !amendable) { setPending(null); return; }
    try {
      const res = await apiClient.get('/api/purchase/po-amendments/', { params: { po: po.id, status: 'PENDING' } });
      const list = res.data?.results || res.data || [];
      setPending(list[0] || null);
    } catch { setPending(null); }
  };
  useEffect(() => { loadPending(); /* eslint-disable-next-line */ }, [po?.id, po?.status]);

  // Show qty / price to 3 decimals (the DecimalFields serialize as 4, e.g.
  // "1500.0000") — trailing 4th zero looked wrong on the amendment form.
  const to3 = (v) => (v === '' || v == null || !Number.isFinite(+v)) ? (v ?? '') : (+v).toFixed(3);
  const seedLines = (proposedById = {}) => (po.po_lines || []).map((l) => {
    const p = proposedById[l.id] || {};
    return {
      id: l.id,
      name: l.item_name || l.product_name || '-',
      unit_price: to3(p.unit_price ?? (l.unit_price ?? '')),
      quantity_ordered: to3(p.quantity_ordered ?? (l.quantity_ordered ?? '')),
      _orig_price: l.unit_price,
      _orig_qty: l.quantity_ordered,
      _changed: l.id in proposedById,
    };
  });

  const startRequest = () => {
    setReason('');
    setLines(seedLines());
    setMode('request');
  };

  const startReview = () => {
    const byId = {};
    (pending?.proposed_changes?.lines || []).forEach((l) => { byId[l.id] = l; });
    setLines(seedLines(byId));
    setRemarks('');
    setMode('review');
  };

  const setLine = (idx, field, value) =>
    setLines((prev) => prev.map((x, i) => (i === idx ? { ...x, [field]: value } : x)));

  const submitRequest = async () => {
    if (!reason.trim()) { toast.error('Please add a reason for the amendment.'); return; }
    const changed = lines.filter((l) =>
      String(l.unit_price) !== String(l._orig_price) || String(l.quantity_ordered) !== String(l._orig_qty));
    if (changed.length === 0) { toast.error('Change at least one price or quantity to amend.'); return; }
    setBusy(true);
    try {
      await apiClient.post('/api/purchase/po-amendments/', {
        po: po.id,
        reason,
        proposed_changes: {
          lines: changed.map((l) => ({ id: l.id, unit_price: l.unit_price, quantity_ordered: l.quantity_ordered })),
        },
      });
      toast.success('Amendment requested — a manager will review it.');
      setMode(null);
      loadPending();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to request amendment.');
    } finally { setBusy(false); }
  };

  const approve = async () => {
    setBusy(true);
    try {
      await apiClient.post(`/api/purchase/po-amendments/${pending.id}/approve/`, {
        proposed_changes: {
          lines: lines.map((l) => ({ id: l.id, unit_price: l.unit_price, quantity_ordered: l.quantity_ordered })),
        },
        review_remarks: remarks,
      });
      toast.success('Amendment approved and applied to the PO.');
      setMode(null); setPending(null);
      onApplied?.();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to approve amendment.');
    } finally { setBusy(false); }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await apiClient.post(`/api/purchase/po-amendments/${pending.id}/reject/`, { review_remarks: remarks });
      toast.success('Amendment rejected.');
      setMode(null); setPending(null);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to reject amendment.');
    } finally { setBusy(false); }
  };

  if (!amendable) return null;

  return (
    <>
      {pending ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-3 mb-4">
          <Edit3 size={18} className="text-amber-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800">
              Amendment requested{pending.requested_by_name ? ` by ${pending.requested_by_name}` : ''}
            </p>
            <p className="text-xs text-amber-700 mt-0.5 whitespace-pre-wrap">{pending.reason}</p>
          </div>
          {canApprove && (
            <button type="button" onClick={startReview} className="shrink-0 px-3 py-1.5 text-sm font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700">Review</button>
          )}
        </div>
      ) : canRequest ? (
        <button type="button" onClick={startRequest} className="inline-flex items-center gap-2 px-4 py-2 mb-4 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium">
          <Edit3 size={16} /> Request Amendment
        </button>
      ) : null}

      {(mode === 'request' || mode === 'review') && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !busy && setMode(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85dvh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="text-base font-semibold text-slate-800">{mode === 'request' ? 'Request PO Amendment' : 'Review Amendment'}</h3>
              <button type="button" onClick={() => !busy && setMode(null)} className="p-1 text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="p-4 overflow-y-auto">
              {mode === 'review' && (
                <div className="mb-3 text-xs text-slate-500">
                  Requested by {pending.requested_by_name || '—'}: <span className="text-slate-700">{pending.reason}</span>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b text-left text-xs text-slate-500">
                      <th className="px-2 py-1.5">Product</th>
                      <th className="px-2 py-1.5 text-right w-32">Qty</th>
                      <th className="px-2 py-1.5 text-right w-36">Unit Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, idx) => (
                      <tr key={l.id} className={`border-b ${l._changed ? 'bg-amber-50/40' : ''}`}>
                        <td className="px-2 py-1.5 text-slate-700">{l.name}</td>
                        <td className="px-2 py-1.5">
                          <input type="number" min="0" step="any" value={l.quantity_ordered} onChange={(e) => setLine(idx, 'quantity_ordered', e.target.value)} className="w-24 px-2 py-1 border border-slate-300 rounded text-sm text-right ml-auto block" />
                          {String(l.quantity_ordered) !== String(l._orig_qty) && <div className="text-[10px] text-slate-400 text-right">was {l._orig_qty}</div>}
                        </td>
                        <td className="px-2 py-1.5">
                          <input type="number" min="0" step="any" value={l.unit_price} onChange={(e) => setLine(idx, 'unit_price', e.target.value)} className="w-28 px-2 py-1 border border-slate-300 rounded text-sm text-right ml-auto block" />
                          {String(l.unit_price) !== String(l._orig_price) && <div className="text-[10px] text-slate-400 text-right">was {formatCurrency(l._orig_price)}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mode === 'request' ? (
                <div className="mt-3">
                  <label className="block text-xs font-medium text-slate-600 mb-1">Reason <span className="text-red-500">*</span></label>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="Why is this amendment needed?" />
                </div>
              ) : (
                <div className="mt-3">
                  <label className="block text-xs font-medium text-slate-600 mb-1">Review remarks</label>
                  <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="Optional note to the requester" />
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t">
              <button type="button" onClick={() => setMode(null)} disabled={busy} className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
              {mode === 'request' ? (
                <button type="button" onClick={submitRequest} disabled={busy} className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-1.5">
                  {busy && <Loader2 size={14} className="animate-spin" />} Submit request
                </button>
              ) : (
                <>
                  <button type="button" onClick={reject} disabled={busy} className="px-4 py-2 text-sm font-medium border border-rose-300 text-rose-700 rounded-lg hover:bg-rose-50 disabled:opacity-50">Reject</button>
                  <button type="button" onClick={approve} disabled={busy} className="px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5">
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve &amp; apply
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
