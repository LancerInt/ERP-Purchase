import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  RefreshCw, Loader2, Wallet, CheckCircle2, XCircle, Download,
  Table as TableIcon, CalendarDays,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '../../../utils/formatters.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';

// Wages Ledger — unified view over three wage sources:
//   1. inventory.ProductionEntry.labor_rows (entry_type=PRODUCTION)
//   2. inventory.ProductionEntry.labor_rows (entry_type=PACKING)
//   3. production.AdditionalWageEntry
// Matches the weekly Budjet sheet the accountant already keeps by
// hand. Payment tracking is uniform across sources — the row id
// carries a source-type prefix so mark-paid can dispatch to the
// right table server-side without the frontend needing to know.

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const fmt2 = (v) =>
  Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

const SOURCE_LABEL = {
  PRODUCTION: { label: 'Production',   cls: 'bg-blue-100 text-blue-800' },
  PACKING:    { label: 'Packing',      cls: 'bg-purple-100 text-purple-800' },
  ADDITIONAL: { label: 'Additional',   cls: 'bg-amber-100 text-amber-800' },
};

export default function WagesLedgerPage() {
  const navigate = useNavigate();
  const { canEdit } = usePermissions();
  const canMarkPaid = canEdit('Additional Wages');

  // Filters — start on the past 7 days (matches the accountant's
  // weekly Budjet horizon; adjust with the date pickers).
  const [dateFrom, setDateFrom] = useState(() => isoDaysAgo(7));
  const [dateTo, setDateTo] = useState(isoToday());
  const [warehouseId, setWarehouseId] = useState('');
  const [contractorId, setContractorId] = useState('');
  const [source, setSource] = useState('ALL');   // ALL | PRODUCTION | PACKING | ADDITIONAL
  const [paymentStatus, setPaymentStatus] = useState('ALL');
  const [viewMode, setViewMode] = useState('LEDGER');  // LEDGER | WEEKLY

  const [data, setData] = useState({ summary: {}, rows: [] });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const [selected, setSelected] = useState(new Set());
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [markPaidRef, setMarkPaidRef] = useState('');
  const [markPaidDate, setMarkPaidDate] = useState(isoToday());
  const [saving, setSaving] = useState(false);

  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  const warehouses = useMemo(() => {
    const seen = new Set();
    const out = [];
    (warehousesRaw || []).forEach((w) => {
      const k = (w.name || '').trim().toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ value: w.id, label: w.name });
    });
    return out;
  }, [warehousesRaw]);

  const { raw: vendorsRaw } = useLookup('/api/vendors/');
  const contractors = useMemo(() =>
    (vendorsRaw || [])
      .map((v) => ({ value: v.id, label: v.vendor_name || v.name || v.legal_name || '' }))
      .filter((o) => o.label)
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())),
  [vendorsRaw]);

  const load = async () => {
    setIsLoading(true); setError(null); setSelected(new Set());
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (warehouseId) params.set('warehouse', warehouseId);
      if (contractorId) params.set('contractor', contractorId);
      if (source && source !== 'ALL') params.set('source', source);
      if (paymentStatus && paymentStatus !== 'ALL') params.set('payment_status', paymentStatus);
      const res = await apiClient.get(`/api/production/wages-ledger/?${params.toString()}`);
      setData(res.data || { summary: {}, rows: [] });
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [
    dateFrom, dateTo, warehouseId, contractorId, source, paymentStatus,
  ]);

  const toggleRow = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    const unpaidIds = (data.rows || []).filter((r) => r.payment_status === 'UNPAID').map((r) => r.id);
    if (selected.size >= unpaidIds.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(unpaidIds));
    }
  };

  const doMarkPaid = async () => {
    if (!selected.size) return;
    setSaving(true);
    try {
      const res = await apiClient.post('/api/production/wages-ledger/mark-paid/', {
        ids: Array.from(selected),
        paid_at: markPaidDate,
        paid_reference: markPaidRef.trim(),
      });
      const n = (res.data?.updated_additional || 0) + (res.data?.updated_production_rows || 0);
      toast.success(`Marked ${n} wage row${n === 1 ? '' : 's'} as PAID.`);
      setMarkPaidOpen(false);
      setMarkPaidRef('');
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const doMarkUnpaid = async (rowIds) => {
    if (!rowIds.length) return;
    try {
      const res = await apiClient.post('/api/production/wages-ledger/mark-unpaid/', {
        ids: rowIds,
      });
      const n = (res.data?.updated_additional || 0) + (res.data?.updated_production_rows || 0);
      toast.success(`Reverted ${n} wage row${n === 1 ? '' : 's'} to UNPAID.`);
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  };

  const exportCsv = () => {
    const cols = ['Date', 'Source', 'Ref', 'Warehouse', 'Contractor', 'Label', 'Mode', 'Count', 'Rate', 'Total', 'Payment', 'Paid At', 'Paid Ref'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.map(q).join(',')];
    (data.rows || []).forEach((r) => {
      lines.push([
        r.date, r.source_type, r.source_entry_no, r.warehouse_name, r.contractor_name,
        r.label, r.mode, r.count, r.rate, r.total_amount, r.payment_status,
        r.paid_at, r.paid_reference,
      ].map(q).join(','));
    });
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wages-ledger-${dateFrom}-to-${dateTo}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const openSourceEntry = (row) => {
    if (row.source_type === 'ADDITIONAL') {
      // Additional wages list — no per-row page, just the list page
      navigate(`/production/additional-wages`);
    } else {
      navigate(`/inventory/production-entries/${row.source_entry_id}`);
    }
  };

  const totalRows = data.rows?.length || 0;
  const selectedTotal = useMemo(() => {
    let t = 0;
    (data.rows || []).forEach((r) => { if (selected.has(r.id)) t += Number(r.total_amount || 0); });
    return t;
  }, [selected, data.rows]);

  return (
    <MainLayout>
      <PageHeader
        title="Wages Ledger"
        subtitle="Unified wage report across Production, Packing, and Additional Wages — mirror of the weekly Budjet sheet"
        breadcrumbs={[{ label: 'Production' }, { label: 'Wages Ledger' }]}
      />

      {/* Filter bar — 2-column grid on phones (each control full-half
          width), 3-col on small tablets, unlimited flex-wrap on
          desktop so every filter fits on one row when it can. */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">From</label>
            <CustomDatePicker value={dateFrom} onChange={(e) => setDateFrom(e?.target?.value ?? '')} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">To</label>
            <CustomDatePicker value={dateTo} onChange={(e) => setDateTo(e?.target?.value ?? '')} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Warehouse</label>
            <CustomSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">All Warehouses</option>
              {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Contractor</label>
            <CustomSelect value={contractorId} onChange={(e) => setContractorId(e.target.value)}>
              <option value="">All contractors</option>
              {contractors.map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Source</label>
            <CustomSelect value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="ALL">All Sources</option>
              <option value="PRODUCTION">Production only</option>
              <option value="PACKING">Packing only</option>
              <option value="ADDITIONAL">Additional wages only</option>
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Payment</label>
            <CustomSelect value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)}>
              <option value="ALL">All</option>
              <option value="UNPAID">Unpaid only</option>
              <option value="PAID">Paid only</option>
            </CustomSelect>
          </div>
        </div>
        {/* View toggle + action buttons — stack below filters, wrap
            on small screens. Buttons grow to full width on phones so
            the tap target isn't a tiny corner. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex p-0.5 rounded-lg bg-slate-100 gap-0.5 w-full sm:w-auto">
            {[
              { v: 'LEDGER', label: 'Ledger', short: 'Ledger', Icon: TableIcon },
              { v: 'WEEKLY', label: 'Weekly (Budjet-style)', short: 'Weekly', Icon: CalendarDays },
            ].map(({ v, label, short, Icon }) => (
              <button
                key={v}
                type="button"
                onClick={() => setViewMode(v)}
                className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md ${
                  viewMode === v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-600 hover:text-slate-800'
                }`}
              >
                <Icon size={12} />
                <span className="sm:hidden">{short}</span>
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
          <div className="flex-1 hidden sm:block" />
          <button
            onClick={exportCsv}
            disabled={!totalRows}
            className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 disabled:opacity-60"
            title="Export the current ledger view as CSV"
          >
            <Download size={14} /> Export
          </button>
          <button
            onClick={load}
            disabled={isLoading}
            className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
          >
            {isLoading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
      </div>

      {/* Summary strip — mirrors the Budjet sheet totals. */}
      <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Total wages" value={fmt2(data.summary?.total_amount)} sub={`${data.summary?.row_count || 0} rows`} tone="slate" Icon={Wallet} />
        <SummaryCard label="Paid" value={fmt2(data.summary?.total_paid)} sub="cleared" tone="emerald" Icon={CheckCircle2} />
        <SummaryCard label="Unpaid" value={fmt2(data.summary?.total_unpaid)} sub="pending" tone="amber" Icon={XCircle} />
        <SummaryCard label="Contractors" value={String(data.summary?.contractor_count || 0)} sub="distinct" tone="blue" Icon={Wallet} />
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-slate-500">
          <Loader2 className="inline animate-spin mr-2" size={18} /> Loading wages ledger…
        </div>
      ) : error ? (
        <div className="text-center py-8 text-red-500">{error}</div>
      ) : !totalRows ? (
        <div className="text-center py-16 text-slate-500 bg-white rounded-lg border border-slate-200">
          <Wallet size={36} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm">No wage rows in this window.</p>
          <p className="text-xs mt-1 text-slate-400">Widen the date range or clear filters.</p>
        </div>
      ) : viewMode === 'LEDGER' ? (
        <LedgerTable
          rows={data.rows}
          selected={selected}
          toggleRow={toggleRow}
          toggleAll={toggleAll}
          canMarkPaid={canMarkPaid}
          onOpenPaidModal={() => setMarkPaidOpen(true)}
          onMarkUnpaid={doMarkUnpaid}
          selectedTotal={selectedTotal}
          openSourceEntry={openSourceEntry}
        />
      ) : (
        <WeeklyView rows={data.rows} />
      )}

      {/* Mark-paid modal */}
      {markPaidOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => !saving && setMarkPaidOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-800 mb-3">
              Mark {selected.size} wage row{selected.size === 1 ? '' : 's'} as PAID
            </h3>
            <div className="text-xs text-slate-500 mb-3">
              Total: <span className="font-semibold text-slate-800">₹{fmt2(selectedTotal)}</span>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Paid on</label>
                <CustomDatePicker value={markPaidDate} onChange={(e) => setMarkPaidDate(e?.target?.value ?? isoToday())} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Reference (UTR / voucher / cheque)</label>
                <input
                  type="text"
                  value={markPaidRef}
                  onChange={(e) => setMarkPaidRef(e.target.value)}
                  placeholder="e.g. UTR-2026081234"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setMarkPaidOpen(false)}
                disabled={saving}
                className="px-3 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={doMarkPaid}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-60"
              >
                {saving ? <Loader2 className="animate-spin" size={14} /> : <CheckCircle2 size={14} />}
                Mark as paid
              </button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}

function SummaryCard({ label, value, sub, tone, Icon }) {
  const toneCls = {
    slate:   'bg-slate-50 text-slate-700 border-slate-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber:   'bg-amber-50 text-amber-700 border-amber-200',
    blue:    'bg-blue-50 text-blue-700 border-blue-200',
  }[tone] || 'bg-slate-50 text-slate-700 border-slate-200';
  return (
    <div className={`rounded-lg border p-3 ${toneCls}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wide font-semibold opacity-80">{label}</span>
        <Icon size={14} />
      </div>
      <div className="text-lg font-semibold tabular-nums">₹{value}</div>
      <div className="text-[10px] opacity-70">{sub}</div>
    </div>
  );
}

function LedgerTable({ rows, selected, toggleRow, toggleAll, canMarkPaid, onOpenPaidModal, onMarkUnpaid, selectedTotal, openSourceEntry }) {
  const unpaidRows = rows.filter((r) => r.payment_status === 'UNPAID');
  const allUnpaidSelected = unpaidRows.length > 0 && selected.size >= unpaidRows.length;

  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
      {selected.size > 0 && (
        <div className="px-3 py-2 border-b border-slate-200 bg-emerald-50 text-xs flex items-center gap-3">
          <span className="font-medium text-emerald-800">
            {selected.size} selected · ₹{fmt2(selectedTotal)}
          </span>
          <div className="flex-1" />
          {canMarkPaid && (
            <button
              onClick={onOpenPaidModal}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-emerald-600 text-white rounded-md hover:bg-emerald-700"
            >
              <CheckCircle2 size={12} /> Mark as paid
            </button>
          )}
        </div>
      )}
      {/* Desktop: compact 14-column table (lg+). Mobile / tablet:
          stacked cards below — every field visible without horizontal
          scroll, tap-friendly. Two layouts of the same data so the
          accountant on a laptop gets density and the shop-floor
          operator on a phone gets legibility. */}
      <div className="hidden lg:block overflow-x-auto">
        <table className="min-w-full text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-2 py-2.5 w-8">
                {canMarkPaid && unpaidRows.length > 0 && (
                  <input
                    type="checkbox"
                    checked={allUnpaidSelected}
                    onChange={toggleAll}
                    title="Select all UNPAID rows"
                  />
                )}
              </th>
              <th className="px-2 py-2.5">Date</th>
              <th className="px-2 py-2.5">Source</th>
              <th className="px-2 py-2.5">Entry no</th>
              <th className="px-2 py-2.5">Warehouse</th>
              <th className="px-2 py-2.5">Contractor</th>
              <th className="px-2 py-2.5">Label</th>
              <th className="px-2 py-2.5 text-right">Mode</th>
              <th className="px-2 py-2.5 text-right">Count</th>
              <th className="px-2 py-2 text-right">Rate</th>
              <th className="px-2 py-2 text-right">Total</th>
              <th className="px-2 py-2.5">Payment</th>
              <th className="px-2 py-2.5">Paid ref</th>
              <th className="px-2 py-2.5 w-16"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = SOURCE_LABEL[r.source_type] || { label: r.source_type, cls: 'bg-slate-100 text-slate-700' };
              const isPaid = r.payment_status === 'PAID';
              return (
                <tr key={r.id} className={`border-b border-slate-100 hover:bg-slate-50 ${selected.has(r.id) ? 'bg-emerald-50/40' : ''}`}>
                  <td className="px-2 py-1.5">
                    {canMarkPaid && !isPaid && (
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleRow(r.id)}
                      />
                    )}
                  </td>
                  <td className="px-2 py-1.5">{r.date ? formatDate(r.date) : '—'}</td>
                  <td className="px-2 py-1.5">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${s.cls}`}>{s.label}</span>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[10px]">
                    <button
                      type="button"
                      onClick={() => openSourceEntry(r)}
                      className="text-primary-700 hover:underline"
                    >
                      {r.source_entry_no || '—'}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 text-slate-700">{r.warehouse_name || '—'}</td>
                  <td className="px-2 py-1.5 text-slate-700">{r.contractor_name || <span className="text-slate-300">—</span>}</td>
                  <td className="px-2 py-1.5">
                    <span className="font-medium text-slate-800">{r.label}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right text-[10px] text-slate-500">
                    {r.mode}
                    {r.mode === 'PIECE' && r.qty_uom && (
                      <span className="ml-0.5 opacity-70">·{r.qty_uom}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {r.mode === 'PIECE'
                      ? <span>{fmt2(r.qty)}<span className="text-[9px] text-slate-400 ml-0.5">{r.qty_uom || ''}</span></span>
                      : r.count}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {r.mode === 'GROUP'
                      ? '—'
                      : r.mode === 'PIECE'
                        ? <span>₹{fmt2(r.rate)}<span className="text-[9px] text-slate-400 ml-0.5">/{r.qty_uom || 'MT'}</span></span>
                        : `₹${fmt2(r.rate)}`}
                  </td>
                  <td className="px-2 py-1.5 text-right font-semibold text-slate-800">₹{fmt2(r.total_amount)}</td>
                  <td className="px-2 py-1.5">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      isPaid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                    }`}>
                      {r.payment_status}
                      {isPaid && r.paid_at && <span className="ml-1 opacity-80">· {r.paid_at}</span>}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-[10px] text-slate-500">{r.paid_reference || '—'}</td>
                  <td className="px-2 py-1.5 text-right">
                    {canMarkPaid && isPaid && (
                      <button
                        onClick={() => onMarkUnpaid([r.id])}
                        className="text-[10px] text-slate-500 hover:text-red-600 hover:underline"
                        title="Revert to UNPAID"
                      >
                        Unpay
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile / tablet — one card per row. Tap-friendly targets,
          the amount is the visual anchor (large + right-aligned). */}
      <div className="lg:hidden divide-y divide-slate-100">
        {rows.map((r) => {
          const s = SOURCE_LABEL[r.source_type] || { label: r.source_type, cls: 'bg-slate-100 text-slate-700' };
          const isPaid = r.payment_status === 'PAID';
          return (
            <div key={r.id} className={`p-3 ${selected.has(r.id) ? 'bg-emerald-50/40' : ''}`}>
              <div className="flex items-start gap-2 mb-1.5">
                {canMarkPaid && !isPaid && (
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggleRow(r.id)}
                    className="mt-1 shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${s.cls}`}>{s.label}</span>
                    <button
                      type="button"
                      onClick={() => openSourceEntry(r)}
                      className="font-mono text-[10px] text-primary-700 hover:underline"
                    >
                      {r.source_entry_no || '—'}
                    </button>
                    <span className="text-[10px] text-slate-500">· {r.date ? formatDate(r.date) : '—'}</span>
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      isPaid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                    }`}>
                      {isPaid ? 'PAID' : 'UNPAID'}
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-medium text-slate-800 leading-tight">{r.label}</div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {r.contractor_name || 'No contractor'}
                    {r.warehouse_name && <> · {r.warehouse_name}</>}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-600 tabular-nums">
                    {r.mode === 'PIECE'
                      ? <>Piece · {fmt2(r.qty)} {r.qty_uom} × ₹{fmt2(r.rate)}/{r.qty_uom || 'MT'}</>
                      : r.mode === 'GROUP'
                        ? <>Group · {r.count} persons</>
                        : <>Per head · {r.count} × ₹{fmt2(r.rate)}</>}
                  </div>
                  {isPaid && r.paid_at && (
                    <div className="mt-0.5 text-[10px] text-emerald-700">
                      Paid {r.paid_at}{r.paid_reference && <> · Ref: {r.paid_reference}</>}
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-base font-semibold text-slate-900 tabular-nums">₹{fmt2(r.total_amount)}</div>
                  {canMarkPaid && isPaid && (
                    <button
                      onClick={() => onMarkUnpaid([r.id])}
                      className="mt-1 text-[10px] text-slate-500 hover:text-red-600 hover:underline"
                    >
                      Unpay
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Weekly Budjet-style pivot — contractor rows × day columns +
// paid/unpaid totals. Matches the shape the accountant already uses.
function WeeklyView({ rows }) {
  const { contractors, days, cell, rowTotals, colTotals, grand } = useMemo(() => {
    const contractorsMap = new Map();  // name → true
    const daysMap = new Map();          // date → true
    const cellMap = new Map();          // key(contractor|date) → total
    (rows || []).forEach((r) => {
      const c = r.contractor_name || r.label || 'Direct labour';
      contractorsMap.set(c, true);
      daysMap.set(r.date, true);
      const key = `${c}||${r.date}`;
      cellMap.set(key, (cellMap.get(key) || 0) + Number(r.total_amount || 0));
    });
    const contractors = Array.from(contractorsMap.keys()).sort();
    const days = Array.from(daysMap.keys()).sort();
    const rowTotals = new Map();
    const colTotals = new Map();
    let grand = 0;
    contractors.forEach((c) => {
      let rt = 0;
      days.forEach((d) => {
        const v = cellMap.get(`${c}||${d}`) || 0;
        rt += v;
        colTotals.set(d, (colTotals.get(d) || 0) + v);
      });
      rowTotals.set(c, rt);
      grand += rt;
    });
    return { contractors, days, cell: cellMap, rowTotals, colTotals, grand };
  }, [rows]);

  if (!contractors.length) {
    return (
      <div className="text-center py-16 text-slate-500 bg-white rounded-lg border border-slate-200">
        <CalendarDays size={36} className="mx-auto mb-3 text-slate-300" />
        <p className="text-sm">No wages to summarise for the picked window.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
      {/* Scroll hint — the weekly pivot has up to 7 day columns
          plus contractor + total, forcing horizontal scroll on
          phones. Sticky contractor column stays pinned. */}
      <div className="md:hidden px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
        <span>Contractor stays pinned — swipe to scroll days →</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-slate-500 sticky left-0 bg-slate-50">Contractor / labour</th>
              {days.map((d) => (
                <th key={d} className="px-2 py-2 text-right text-[10px] uppercase tracking-wide text-slate-500 whitespace-nowrap">
                  {formatDate(d)}
                </th>
              ))}
              <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wide text-slate-500 bg-slate-100">Total</th>
            </tr>
          </thead>
          <tbody>
            {contractors.map((c) => (
              <tr key={c} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-1.5 font-medium text-slate-800 sticky left-0 bg-white">{c}</td>
                {days.map((d) => {
                  const v = cell.get(`${c}||${d}`) || 0;
                  return (
                    <td key={d} className={`px-2 py-1.5 text-right ${v > 0 ? 'text-slate-800' : 'text-slate-300'}`}>
                      {v > 0 ? `₹${fmt2(v)}` : '—'}
                    </td>
                  );
                })}
                <td className="px-3 py-1.5 text-right font-semibold text-slate-900 bg-slate-100/60">
                  ₹{fmt2(rowTotals.get(c))}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-300 bg-slate-100">
              <td className="px-3 py-2 font-semibold text-slate-800 sticky left-0 bg-slate-100">Column total</td>
              {days.map((d) => (
                <td key={d} className="px-2 py-2 text-right font-semibold text-slate-800">
                  ₹{fmt2(colTotals.get(d) || 0)}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-bold text-slate-900 bg-slate-200">₹{fmt2(grand)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
