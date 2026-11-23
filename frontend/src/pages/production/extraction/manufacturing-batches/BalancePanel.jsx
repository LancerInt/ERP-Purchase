import { useEffect, useState } from 'react';
import apiClient from '../../../../utils/api.js';

const num = (v, digits = 4) => v == null ? '—' : Number(v).toFixed(digits);
const int = (v) => v == null ? '—' : Number(v).toLocaleString();

function Stat({ label, value, unit, bold, positive }) {
  const cls =
    bold ? 'text-lg font-bold text-slate-900' :
    positive ? 'text-slate-800 font-semibold text-emerald-700' :
    'text-slate-800 font-mono';
  return (
    <div>
      <div className="text-xs text-slate-500 mb-0.5">{label}</div>
      <div className={cls}>{value} {unit && <span className="text-xs text-slate-500 font-normal">{unit}</span>}</div>
    </div>
  );
}

/**
 * BalancePanel — compute-on-read summary of a batch. Hits the
 * /balance/ endpoint which live-computes from current stage data,
 * so a late lab result correction flows through on the next open.
 */
export default function BalancePanel({ batchId, refreshKey }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!batchId) return;
    setLoading(true);
    apiClient.get(`/api/production/manufacturing-batches/${batchId}/balance/`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err?.response?.data?.detail || 'Failed to load balance.'))
      .finally(() => setLoading(false));
  }, [batchId, refreshKey]);

  if (loading) return <div className="text-sm text-slate-500 p-4">Computing balance…</div>;
  if (error) return <div className="text-sm text-red-600 p-4">{error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Kernel input */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-slate-700 mb-3">Kernel Input</h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Gross kernel" value={int(data.kernel.gross_kg)} unit="kg" />
          <Stat label="Adjusted kernel" value={num(data.kernel.adjusted_kg, 3)} unit="kg" />
          <Stat label="Initial Azadirachtin" value={num(data.kernel.initial_aza_kg)} unit="kg" bold />
          <Stat label="Aza status" value={data.kernel.aza_status || '—'} />
        </div>
      </div>

      {/* SLE + Spent Kernel */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-slate-700 mb-3">SLE Stage</h4>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Wash count" value={data.sle.wash_count} />
            <Stat label="Total weight" value={int(data.sle.total_weight_kg)} unit="kg" />
            <Stat label="Total aza" value={num(data.sle.total_aza_kg)} unit="kg" />
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-slate-700 mb-3">Spent Kernel</h4>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Quantity" value={int(data.spent_kernel.qty_kg)} unit="kg" />
            <Stat label="Residual aza" value={num(data.spent_kernel.aza_kg, 6)} unit="kg" />
            <Stat label="Aza status" value={data.spent_kernel.aza_status || '—'} />
          </div>
        </div>
      </div>

      {/* LLE */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-slate-700 mb-3">LLE Stage</h4>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Wash count" value={data.lle.wash_count} />
          <Stat label="Total weight" value={int(data.lle.total_weight_kg)} unit="kg" />
          <Stat label="Total aza" value={num(data.lle.total_aza_kg)} unit="kg" bold />
        </div>
      </div>

      {/* Summary */}
      <div className="bg-primary-50 border border-primary-200 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-primary-800 mb-3">Yield &amp; Recovery</h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat
            label="Yield: kernel → LLE"
            value={data.summary.yield_kernel_to_lle_pct != null
              ? `${Number(data.summary.yield_kernel_to_lle_pct).toFixed(2)}`
              : '—'}
            unit="%"
            bold
          />
          <Stat
            label="Aza / MT kernel"
            value={data.summary.aza_per_mt_kernel != null
              ? Number(data.summary.aza_per_mt_kernel).toFixed(3)
              : '—'}
            unit="kg/MT"
            bold
          />
          <Stat label="Unaccounted material" value={num(data.summary.unaccounted_material_kg, 3)} unit="kg" />
          <Stat label="Unaccounted aza" value={num(data.summary.unaccounted_aza_kg, 4)} unit="kg" />
        </div>
        <p className="text-xs text-primary-700 mt-3">
          Values are computed live from the current stage data — a late lab result correction flows through on next open (per Section 18.4). FFE / ATFE / Final Product live at the warehouse level (independent numbering), so their aza contribution isn't rolled up here.
        </p>
      </div>
    </div>
  );
}
