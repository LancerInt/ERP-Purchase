import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, Loader2, Building2, Warehouse, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '@/components/layout/MainLayout';
import PageHeader from '@/components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import useLookup from '@/hooks/useLookup.js';
import usePermissions from '@/hooks/usePermissions.js';
import apiClient from '@/utils/api.js';
import { formatCurrency } from '@/utils/formatters.js';

const fmtQty = (v) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });

// Surface the first meaningful DRF error from any field, not just so_lines.
const extractError = (err) => {
  const d = err?.response?.data;
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (d.detail) return d.detail;
  if (Array.isArray(d.so_lines) && d.so_lines.length) {
    const f = d.so_lines[0];
    return typeof f === 'string' ? f : JSON.stringify(f);
  }
  const key = Object.keys(d)[0];
  if (!key) return '';
  const v = d[key];
  const text = Array.isArray(v) ? v[0] : (typeof v === 'object' ? JSON.stringify(v) : v);
  return `${key}: ${text}`;
};

export default function MultiPoSalesOrder() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const { raw: customersRaw, isLoading: custLoading } = useLookup('/api/customers/');
  const flagged = useMemo(
    () => (customersRaw || []).filter((c) => c.allow_multi_po_consolidation),
    [customersRaw],
  );

  const [customerId, setCustomerId] = useState('');
  const [pos, setPos] = useState([]);
  const [loadingPool, setLoadingPool] = useState(false);
  const [selected, setSelected] = useState({});   // parsedLineId -> {line, po, take}
  const [consignee, setConsignee] = useState({ name: '', address: '', gstin: '' });
  const [creating, setCreating] = useState(false);

  const loadPool = async (cid) => {
    setCustomerId(cid); setSelected({}); setPos([]); setConsignee({ name: '', address: '', gstin: '' });
    if (!cid) return;
    setLoadingPool(true);
    try {
      const { data } = await apiClient.get('/api/sales/multi-po/pending-lines/', { params: { customer_id: cid } });
      setPos(data.pos || []);
    } catch {
      toast.error('Could not load pending PO lines.');
    } finally {
      setLoadingPool(false);
    }
  };

  const selectedList = Object.values(selected);
  // The first picked line locks the SO's company; only same-company PO lines
  // can join (an SO has a single company). The fulfilling warehouse is NOT
  // chosen here — an executive assigns it on the SO after it's created.
  const lockedCtx = selectedList[0]?.po || null;

  const remainingOf = (line) => Number(line.remaining ?? line.quantity);

  const toggleLine = (po, line) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[line.id]) {
        delete next[line.id];
        return next;
      }
      if (lockedCtx && po.company_id !== lockedCtx.company_id) {
        toast.error('All clubbed lines must belong to the same company.');
        return prev;
      }
      if (Object.keys(prev).length === 0) {
        setConsignee({ name: po.consignee_name || '', address: po.consignee_address || '', gstin: po.consignee_gstin || '' });
      }
      next[line.id] = { line, po, take: remainingOf(line) };   // default: take all remaining
      return next;
    });
  };

  const setTake = (lineId, raw, remaining) => {
    const n = Math.max(0, Math.min(Number(raw) || 0, Number(remaining)));
    setSelected((prev) => (prev[lineId] ? { ...prev, [lineId]: { ...prev[lineId], take: n } } : prev));
  };

  const totalValue = selectedList.reduce((s, { line, take }) => s + Number(take || 0) * Number(line.price), 0);
  const totalQty = selectedList.reduce((s, { take }) => s + Number(take || 0), 0);
  const poCount = new Set(selectedList.map(({ po }) => po.id)).size;

  const create = async () => {
    if (!selectedList.length) { toast.error('Select at least one line.'); return; }
    if (selectedList.some((e) => Number(e.take) <= 0)) {
      toast.error('Enter a take quantity greater than 0 for every picked line.');
      return;
    }
    setCreating(true);
    try {
      const poIds = [...new Set(selectedList.map(({ po }) => po.id))];
      const so_lines = selectedList.map(({ line, take }, i) => ({
        line_no: i + 1,
        product: line.product_id,
        quantity_ordered: Number(take),
        uom: line.uom || 'PCS',
        unit_price: line.price,
        gst: line.gst,
        source_parsed_line: line.id,
      }));
      const payload = {
        customer: customerId,
        company: lockedCtx.company_id,
        // warehouse deliberately omitted — assigned on the SO afterward.
        price_list: lockedCtx.price_list_id || null,
        customer_po_ids: poIds,
        consignee_name: consignee.name,
        consignee_address: consignee.address,
        consignee_gstin: consignee.gstin,
        so_lines,
      };
      const { data } = await apiClient.post('/api/sales/orders/', payload);
      toast.success(`Sales order ${data.so_no || ''} created.`);
      navigate(`/sales/orders/${data.id}`);
    } catch (err) {
      toast.error(extractError(err) || 'Could not create the sales order.');
    } finally {
      setCreating(false);
    }
  };

  const disabledPo = (po) => lockedCtx && po.company_id !== lockedCtx.company_id;

  const statusChip = (line, entry) => {
    const remaining = remainingOf(line);
    const base = 'inline-block text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full';
    if (entry && Number(entry.take) >= remaining && remaining > 0) {
      return <span className={`${base} bg-slate-100 text-slate-500`}>Takes all</span>;
    }
    if (line.status === 'PARTIAL') {
      return <span className={`${base} bg-amber-50 text-amber-700`}>Partial</span>;
    }
    return <span className={`${base} bg-emerald-50 text-emerald-700`}>Open</span>;
  };

  return (
    <MainLayout>
      <PageHeader
        title="Sales Order from Multiple POs"
        subtitle="Club selected lines from several Customer POs into one SO. Take a full line or only part of it — the rest stays pending."
        breadcrumbs={[{ label: 'Sales', path: '/sales/orders' }, { label: 'Multi-PO SO' }]}
      />

      <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
        <label className="block text-xs text-slate-500 mb-1">Customer (multi-PO enabled)</label>
        <div className="max-w-sm">
          <CustomSelect value={customerId} onChange={(e) => loadPool(e.target.value)}>
            <option value="">{custLoading ? 'Loading…' : 'Select customer…'}</option>
            {flagged.map((c) => (
              <option key={c.id} value={c.id}>{c.customer_name}</option>
            ))}
          </CustomSelect>
        </div>
        {!custLoading && flagged.length === 0 && (
          <p className="text-xs text-amber-600 mt-2">
            No customer has multi-PO clubbing enabled yet. Turn on “Allow multi-PO consolidation” on a customer first.
          </p>
        )}
      </div>

      {customerId && (
        <div className="grid lg:grid-cols-3 gap-5">
          {/* pool */}
          <div className="lg:col-span-2 space-y-4">
            {loadingPool ? (
              <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : pos.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500 text-sm">No pending PO lines for this customer.</div>
            ) : pos.map((po) => {
              const dis = disabledPo(po);
              return (
                <div key={po.id} className={`rounded-xl border bg-white overflow-hidden ${dis ? 'opacity-50 border-slate-200' : 'border-slate-200'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-100 bg-slate-50">
                    <div className="text-sm font-semibold text-slate-800">
                      {po.po_number || po.upload_id} <span className="text-xs font-normal text-slate-400">· {po.po_date || '—'}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1"><Building2 size={12} />{po.company_name}</span>
                      {po.warehouse_name && <span className="inline-flex items-center gap-1"><Warehouse size={12} />{po.warehouse_name}</span>}
                    </div>
                  </div>
                  {dis && <div className="px-4 py-1.5 text-[11px] text-amber-600 bg-amber-50">Different company than your current selection — finish or clear that SO first.</div>}
                  {/* desktop / tablet: table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm min-w-[640px]">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                          <th className="pl-4 py-2 w-8 text-left"></th>
                          <th className="py-2 text-left font-semibold">Product</th>
                          <th className="py-2 text-right font-semibold">Ordered</th>
                          <th className="py-2 text-right font-semibold">Taken&nbsp;before</th>
                          <th className="py-2 text-right font-semibold">Remaining</th>
                          <th className="py-2 text-right font-semibold text-blue-600">Take&nbsp;now</th>
                          <th className="py-2 text-right font-semibold">Rate</th>
                          <th className="py-2 text-right font-semibold">Line&nbsp;total</th>
                          <th className="py-2 pr-4 text-right font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {po.lines.map((line) => {
                          const entry = selected[line.id];
                          const checked = !!entry;
                          const remaining = remainingOf(line);
                          const take = checked ? entry.take : remaining;
                          const lineTotal = Number(take || 0) * Number(line.price);
                          return (
                            <tr key={line.id} className={`${checked ? 'bg-blue-50/50' : ''} ${dis ? '' : 'hover:bg-primary-50/40 transition-colors cursor-pointer'}`}
                              onClick={() => !dis && toggleLine(po, line)}>
                              <td className="pl-4 py-2 w-8">
                                <span className={`inline-flex items-center justify-center w-4 h-4 rounded border ${checked ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300'}`}>
                                  {checked && <Check size={12} />}
                                </span>
                              </td>
                              <td className="py-2 font-medium text-slate-800">{line.product_name}<div className="text-xs text-slate-400 font-normal">{line.hsn_code ? `HSN ${line.hsn_code}` : ''}</div></td>
                              <td className="py-2 text-right text-slate-600 tabular-nums whitespace-nowrap">{fmtQty(line.ordered ?? line.quantity)}</td>
                              <td className="py-2 text-right text-slate-500 tabular-nums whitespace-nowrap">{fmtQty(line.consumed)}</td>
                              <td className="py-2 text-right font-semibold text-emerald-700 tabular-nums whitespace-nowrap">{fmtQty(remaining)}</td>
                              <td className="py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="number" min="0" max={remaining} step="any"
                                  disabled={!checked || dis}
                                  value={checked ? entry.take : ''}
                                  placeholder={fmtQty(remaining)}
                                  onChange={(e) => setTake(line.id, e.target.value, remaining)}
                                  className={`w-24 text-right tabular-nums font-semibold rounded-lg px-2 py-1 text-sm ${checked ? 'border-2 border-blue-500 text-slate-800 bg-white' : 'border border-slate-200 text-slate-400 bg-slate-50'}`}
                                />
                                <div className="text-[10px] text-slate-400 mt-0.5">{line.uom}</div>
                              </td>
                              <td className="py-2 text-right text-slate-600 tabular-nums whitespace-nowrap">{formatCurrency(line.price)}</td>
                              <td className="py-2 text-right font-medium text-slate-800 tabular-nums whitespace-nowrap">{checked ? formatCurrency(lineTotal) : '—'}</td>
                              <td className="py-2 pr-4 text-right whitespace-nowrap">{statusChip(line, entry)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* mobile: each line as a stacked card */}
                  <div className="md:hidden divide-y divide-slate-100">
                    {po.lines.map((line) => {
                      const entry = selected[line.id];
                      const checked = !!entry;
                      const remaining = remainingOf(line);
                      const take = checked ? entry.take : remaining;
                      const lineTotal = Number(take || 0) * Number(line.price);
                      return (
                        <div key={line.id} className={`p-3 ${checked ? 'bg-blue-50/50' : ''} ${dis ? 'opacity-60' : ''}`}>
                          <div className={`flex items-start gap-2.5 ${dis ? '' : 'cursor-pointer'}`} onClick={() => !dis && toggleLine(po, line)}>
                            <span className={`mt-0.5 inline-flex items-center justify-center w-4 h-4 rounded border shrink-0 ${checked ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300'}`}>
                              {checked && <Check size={12} />}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-slate-800 text-sm leading-snug">{line.product_name}</div>
                              {line.hsn_code && <div className="text-xs text-slate-400">HSN {line.hsn_code}</div>}
                            </div>
                            {statusChip(line, entry)}
                          </div>
                          <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                            <div className="rounded-lg bg-slate-50 py-1.5">
                              <div className="text-[10px] uppercase tracking-wide text-slate-400">Ordered</div>
                              <div className="text-sm font-medium tabular-nums text-slate-700">{fmtQty(line.ordered ?? line.quantity)}</div>
                            </div>
                            <div className="rounded-lg bg-slate-50 py-1.5">
                              <div className="text-[10px] uppercase tracking-wide text-slate-400">Taken</div>
                              <div className="text-sm text-slate-500 tabular-nums">{fmtQty(line.consumed)}</div>
                            </div>
                            <div className="rounded-lg bg-emerald-50 py-1.5">
                              <div className="text-[10px] uppercase tracking-wide text-emerald-600">Remaining</div>
                              <div className="text-sm font-semibold text-emerald-700 tabular-nums">{fmtQty(remaining)}</div>
                            </div>
                          </div>
                          <div className="mt-2.5 flex items-end justify-between gap-3">
                            <div className="flex-1">
                              <label className="block text-[10px] uppercase tracking-wide text-blue-600 mb-1">Take now ({line.uom})</label>
                              <input
                                type="number" min="0" max={remaining} step="any"
                                disabled={!checked || dis}
                                value={checked ? entry.take : ''}
                                placeholder={fmtQty(remaining)}
                                onChange={(e) => setTake(line.id, e.target.value, remaining)}
                                className={`w-full text-right tabular-nums font-semibold rounded-lg px-3 py-2 text-sm ${checked ? 'border-2 border-blue-500 text-slate-800 bg-white' : 'border border-slate-200 text-slate-400 bg-slate-50'}`}
                              />
                            </div>
                            <div className="text-right shrink-0 pb-0.5">
                              <div className="text-xs text-slate-400">@ {formatCurrency(line.price)}</div>
                              <div className="text-sm font-semibold text-slate-800">{checked ? formatCurrency(lineTotal) : '—'}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* summary / create */}
          <div className="lg:col-span-1">
            <div className="rounded-xl border border-slate-200 bg-white p-4 lg:sticky lg:top-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800 mb-3"><GitBranch size={16} className="text-blue-600" /> New SO</h3>
              <div className="space-y-1.5 text-sm mb-3">
                <div className="flex justify-between"><span className="text-slate-500">Lines</span><span className="font-medium">{selectedList.length}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">From POs</span><span className="font-medium">{poCount}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Total qty taken</span><span className="font-medium tabular-nums">{fmtQty(totalQty)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Value</span><span className="font-semibold text-slate-900">{formatCurrency(totalValue)}</span></div>
                {lockedCtx && (
                  <div className="pt-1 text-xs text-slate-400">{lockedCtx.company_name}</div>
                )}
              </div>
              <p className="mb-3 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                Warehouse isn’t set here — an executive assigns the fulfilling warehouse on the Sales Order before it’s approved.
              </p>
              <div className="space-y-2 mb-4">
                <input value={consignee.name} onChange={(e) => setConsignee((c) => ({ ...c, name: e.target.value }))} placeholder="Consignee name" className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
                <input value={consignee.gstin} onChange={(e) => setConsignee((c) => ({ ...c, gstin: e.target.value }))} placeholder="Consignee GSTIN" className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
                <textarea value={consignee.address} onChange={(e) => setConsignee((c) => ({ ...c, address: e.target.value }))} placeholder="Consignee address" rows={2} className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
              </div>
              <button
                onClick={create}
                disabled={creating || !selectedList.length || !canCreate('Sales Order')}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? <Loader2 size={16} className="animate-spin" /> : <GitBranch size={16} />} Create Sales Order
              </button>
              {selectedList.length > 0 && (
                <button onClick={() => { setSelected({}); }} className="w-full mt-2 text-xs text-slate-500 hover:text-slate-700">Clear selection</button>
              )}
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
