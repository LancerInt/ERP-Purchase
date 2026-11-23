const TONE = {
  // Debit/credit stay neutral — a debit isn't "bad" and the colors were
  // inconsistent across ledgers. Only genuinely meaningful states are tinted.
  debit: 'text-slate-900',
  credit: 'text-slate-900',
  paid: 'text-emerald-600',
  outstanding: 'text-amber-600',
  balance: 'text-slate-900',
  default: 'text-slate-900',
};

const COLS = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4' };

/**
 * A row of total/summary cells (e.g. ledger totals + closing balance).
 *   <SummaryBar items={[{ label: 'Total Debit', value: '₹1,200', tone: 'debit' }]} />
 */
export default function SummaryBar({ items = [] }) {
  if (!items.length) return null;
  return (
    <div className={`grid grid-cols-2 ${COLS[Math.min(items.length, 4)] || 'sm:grid-cols-4'} gap-3 mb-3`}>
      {items.map((it, i) => (
        <div key={i} className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm">
          <p className="text-xs text-slate-500">{it.label}</p>
          <p className={`text-base font-semibold tabular-nums ${TONE[it.tone] || TONE.default}`}>{it.value}</p>
        </div>
      ))}
    </div>
  );
}
