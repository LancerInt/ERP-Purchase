import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { RefreshCw, Printer, Loader2, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '../../../utils/formatters.js';
import useLookup from '../../../hooks/useLookup.js';

// Unified Daily Production Report — one screen replacing the paper DPR.
// Aggregates gate register + shift labor + work orders + packing runs +
// material issues + damage into a single (warehouse, date, shift) view.
// The layout is deliberately print-friendly (browser Print or Ctrl+P).

const isoToday = () => new Date().toISOString().slice(0, 10);

const SHIFT_OPTIONS = [
  { value: '', label: 'Both shifts' },
  { value: 'DAY', label: 'Day' },
  { value: 'NIGHT', label: 'Night' },
];

const labelClass = 'block text-xs font-medium text-slate-600 mb-1';

function Section({ title, count, children }) {
  return (
    <section className="mb-4 avoid-break">
      <h2 className="text-sm font-semibold text-slate-800 mb-2 border-b border-slate-200 pb-1">
        {title} {typeof count === 'number' && <span className="text-slate-400 font-normal">({count})</span>}
      </h2>
      {children}
    </section>
  );
}

function EmptyRow({ colSpan, label }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-3 text-center text-slate-400 italic text-xs">{label || 'No entries.'}</td>
    </tr>
  );
}

export default function DprPage() {
  const [date, setDate] = useState(isoToday());
  const [warehouseId, setWarehouseId] = useState('');
  const [shift, setShift] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  const warehouses = useMemo(() => {
    const seen = new Set();
    const out = [{ value: '', label: 'All Warehouses' }];
    (warehousesRaw || []).forEach((w) => {
      const k = (w.name || '').trim().toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ value: w.id, label: w.name });
    });
    return out;
  }, [warehousesRaw]);

  const load = async () => {
    if (!date) return;
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ date });
      if (warehouseId) params.set('warehouse', warehouseId);
      if (shift) params.set('shift', shift);
      const res = await apiClient.get(`/api/production/dpr-summary/?${params.toString()}`);
      setData(res.data || null);
    } catch (err) {
      setError(getApiErrorMessage(err));
      toast.error(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date, warehouseId, shift]);

  const warehouseLabel = data?.warehouse?.name || 'All Warehouses';
  const shiftLabel = shift ? (shift === 'DAY' ? 'Day Shift' : 'Night Shift') : 'Full Day (Day + Night)';

  return (
    <MainLayout>
      <PageHeader
        title="Daily Production Report"
        subtitle="One-screen digital replacement for the paper DPR — gate, labor, work orders, packing, issues, damage for one shift-day"
        breadcrumbs={[{ label: 'Production' }, { label: 'DPR' }]}
      />

      {/* Filter bar — hidden in print */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 flex flex-wrap items-end gap-3 print:hidden">
        <div className="min-w-[160px]">
          <label className={labelClass}>Date</label>
          <CustomDatePicker value={date} onChange={setDate} />
        </div>
        <div className="min-w-[220px]">
          <label className={labelClass}>Warehouse</label>
          <CustomSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
          </CustomSelect>
        </div>
        <div className="min-w-[160px]">
          <label className={labelClass}>Shift</label>
          <CustomSelect value={shift} onChange={(e) => setShift(e.target.value)}>
            {SHIFT_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
          </CustomSelect>
        </div>
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          {loading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />} Refresh
        </button>
        <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700">
          <Printer size={14} /> Print
        </button>
      </div>

      {/* Print-visible header */}
      <div className="hidden print:block mb-4">
        <h1 className="text-lg font-semibold">Daily Production Report</h1>
        <p className="text-sm text-slate-600">
          {formatDate(date)} · {shiftLabel} · {warehouseLabel}
        </p>
      </div>

      {loading ? (
        <div className="text-center py-16 text-slate-500"><Loader2 className="inline animate-spin mr-2" size={18} /> Loading DPR…</div>
      ) : error ? (
        <div className="text-center py-8 text-red-500">{error}</div>
      ) : !data ? null : (
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 dpr-sheet">
          {/* Header (screen) */}
          <div className="mb-4 pb-3 border-b border-slate-200 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <div className="text-lg font-semibold text-slate-800">{warehouseLabel}</div>
            <div className="text-sm text-slate-500">{formatDate(date)}</div>
            <div className="text-xs uppercase tracking-wide text-slate-500">{shiftLabel}</div>
          </div>

          {/* Shift Labor */}
          <Section title="Shift Labor" count={data.shift_labor.length}>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50">
                  <tr className="text-left">
                    <th className="px-3 py-1.5">Warehouse</th>
                    <th className="px-3 py-1.5">Shift</th>
                    <th className="px-3 py-1.5 text-right">Tamil</th>
                    <th className="px-3 py-1.5 text-right">Hindi</th>
                    <th className="px-3 py-1.5 text-right">Ladies</th>
                    <th className="px-3 py-1.5 text-right">T.L</th>
                    <th className="px-3 py-1.5 text-right">Total</th>
                    <th className="px-3 py-1.5">Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {data.shift_labor.length === 0
                    ? <EmptyRow colSpan={8} label="No shift-labor entry — supervisor hasn't recorded today's headcount yet." />
                    : data.shift_labor.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100">
                        <td className="px-3 py-1.5">{r.warehouse_name}</td>
                        <td className="px-3 py-1.5">{r.shift_display}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.tamil_labor}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.hindi_labor}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.ladies}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.supervisor}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{r.total_labor}</td>
                        <td className="px-3 py-1.5 text-slate-600">{r.remarks || '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Gate Entries: Inward */}
          <Section title={<><ArrowDownRight className="inline mr-1" size={14} /> Inward (Unloading)</>} count={data.gate_entries.inward.length}>
            <GateTable rows={data.gate_entries.inward} />
          </Section>

          {/* Gate Entries: Outward */}
          <Section title={<><ArrowUpRight className="inline mr-1" size={14} /> Outward (Loading)</>} count={data.gate_entries.outward.length}>
            <GateTable rows={data.gate_entries.outward} />
          </Section>

          {/* Work Orders */}
          <Section title="Production / Work Orders" count={data.work_orders.length}>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50"><tr className="text-left">
                  <th className="px-3 py-1.5">WO No / Batch</th>
                  <th className="px-3 py-1.5">Warehouse</th>
                  <th className="px-3 py-1.5">Process</th>
                  <th className="px-3 py-1.5">Finished Product</th>
                  <th className="px-3 py-1.5">Stage</th>
                  <th className="px-3 py-1.5">Approval</th>
                </tr></thead>
                <tbody>
                  {data.work_orders.length === 0
                    ? <EmptyRow colSpan={6} />
                    : data.work_orders.map((w) => (
                      <tr key={w.id} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 font-medium">{w.work_order_no}</td>
                        <td className="px-3 py-1.5">{w.warehouse_name}</td>
                        <td className="px-3 py-1.5">{w.process_name || '—'}</td>
                        <td className="px-3 py-1.5">{w.finished_product_name || '—'}</td>
                        <td className="px-3 py-1.5">{w.stage_status || '—'}</td>
                        <td className="px-3 py-1.5">{w.approval_status || '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Packing */}
          <Section title="Packing Runs" count={data.packing_processes.length}>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50"><tr className="text-left">
                  <th className="px-3 py-1.5">Packing No</th>
                  <th className="px-3 py-1.5">Warehouse</th>
                  <th className="px-3 py-1.5">Process</th>
                  <th className="px-3 py-1.5">Source WO</th>
                  <th className="px-3 py-1.5">Approval</th>
                </tr></thead>
                <tbody>
                  {data.packing_processes.length === 0
                    ? <EmptyRow colSpan={5} />
                    : data.packing_processes.map((p) => (
                      <tr key={p.id} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 font-medium">{p.packing_no}</td>
                        <td className="px-3 py-1.5">{p.warehouse_name}</td>
                        <td className="px-3 py-1.5">{p.process_name || '—'}</td>
                        <td className="px-3 py-1.5">{p.source_wo || '—'}</td>
                        <td className="px-3 py-1.5">{p.approval_status || '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Material Issues */}
          <Section title="Material Issues (store movements)" count={data.material_issues.length}>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50"><tr className="text-left">
                  <th className="px-3 py-1.5">Issue No</th>
                  <th className="px-3 py-1.5">Warehouse</th>
                  <th className="px-3 py-1.5">Linked WO</th>
                  <th className="px-3 py-1.5">Type</th>
                  <th className="px-3 py-1.5">Remarks</th>
                </tr></thead>
                <tbody>
                  {data.material_issues.length === 0
                    ? <EmptyRow colSpan={5} />
                    : data.material_issues.map((m) => (
                      <tr key={m.id} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 font-medium">{m.issue_no}</td>
                        <td className="px-3 py-1.5">{m.warehouse_name}</td>
                        <td className="px-3 py-1.5">{m.work_order_no || '—'}</td>
                        <td className="px-3 py-1.5">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${m.is_adhoc ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>
                            {m.is_adhoc ? 'Store (ad-hoc)' : 'WO-linked'}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-slate-600">{m.remarks || '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Damage */}
          <Section title="Production Damage" count={data.damages.length}>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50"><tr className="text-left">
                  <th className="px-3 py-1.5">Document No</th>
                  <th className="px-3 py-1.5">Warehouse</th>
                  <th className="px-3 py-1.5">Status</th>
                  <th className="px-3 py-1.5">Remarks</th>
                </tr></thead>
                <tbody>
                  {data.damages.length === 0
                    ? <EmptyRow colSpan={4} />
                    : data.damages.map((d) => (
                      <tr key={d.id} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 font-medium">{d.document_no}</td>
                        <td className="px-3 py-1.5">{d.warehouse_name}</td>
                        <td className="px-3 py-1.5">{d.status_display}</td>
                        <td className="px-3 py-1.5 text-slate-600">{d.remarks || '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Footer (print) */}
          <div className="hidden print:block mt-8 pt-4 border-t border-slate-200 text-[10px] text-slate-500">
            Auto-generated by Lancer ERP · {new Date().toLocaleString('en-IN')}
          </div>
        </div>
      )}

      <style>{`
        @media print {
          .avoid-break { page-break-inside: avoid; }
          .dpr-sheet { border: none !important; padding: 0 !important; }
          body { background: white; }
        }
      `}</style>
    </MainLayout>
  );
}

function GateTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead className="bg-slate-50"><tr className="text-left">
          <th className="px-3 py-1.5">Entry No</th>
          <th className="px-3 py-1.5">Shift</th>
          <th className="px-3 py-1.5">Warehouse</th>
          <th className="px-3 py-1.5">Vehicle</th>
          <th className="px-3 py-1.5">Party</th>
          <th className="px-3 py-1.5">Item</th>
          <th className="px-3 py-1.5 text-right">Qty</th>
          <th className="px-3 py-1.5">Remarks</th>
        </tr></thead>
        <tbody>
          {rows.length === 0
            ? <EmptyRow colSpan={8} />
            : rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-1.5 font-medium">{r.entry_no}</td>
                <td className="px-3 py-1.5">{r.shift_display}</td>
                <td className="px-3 py-1.5">{r.warehouse_name}</td>
                <td className="px-3 py-1.5">{r.vehicle_number}</td>
                <td className="px-3 py-1.5">{r.party_name}</td>
                <td className="px-3 py-1.5">{r.product_description}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {Number(r.quantity || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })} {r.uom || ''}
                </td>
                <td className="px-3 py-1.5 text-slate-600">{r.remarks || '—'}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
