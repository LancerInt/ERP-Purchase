/**
 * Ranked bar list — the small-screen form of a horizontal "Top N" bar chart.
 *
 * A recharts bar chart squeezed into a 375px viewport has nowhere to put long
 * party names: the axis gutter truncates them ("SPAC Starch Products In…") and
 * the hover tooltip covers the neighbouring bars, so the rows underneath can't
 * be tapped. This renders the same data as a ranked list — the name gets the
 * FULL row width, the bar sits under it, and every value is already on screen.
 * No tooltip, so nothing can overlap the next row.
 *
 * Numbering is used because the list genuinely is a sequence (ranked by value).
 */
export default function RankedBarList({
  items = [],
  color = '#6366f1',
  formatValue = (v) => v,
  onSelect,
  emptyText = 'No data in this period.',
}) {
  if (!items.length) {
    return <p className="px-4 py-10 text-sm text-slate-400 text-center">{emptyText}</p>;
  }
  const max = Math.max(...items.map((i) => Number(i.value) || 0), 0) || 1;

  return (
    <ol className="divide-y divide-slate-100">
      {items.map((it, i) => {
        const v = Number(it.value) || 0;
        // Floor at 2% so a tiny-but-nonzero value still reads as a bar.
        const pct = v > 0 ? Math.max(2, (v / max) * 100) : 0;
        const Row = onSelect ? 'button' : 'div';
        return (
          <li key={it.id ?? `${it.name}-${i}`}>
            <Row
              {...(onSelect
                ? { type: 'button', onClick: () => onSelect(it) }
                : {})}
              className={`block w-full text-left px-4 py-3 min-h-[44px] ${
                onSelect
                  ? 'hover:bg-slate-50 active:bg-slate-100 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400'
                  : ''
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex gap-2 min-w-0">
                  <span className="text-[11px] font-semibold text-slate-400 tabular-nums mt-0.5 shrink-0">
                    {i + 1}
                  </span>
                  {/* Full name, wrapped — never truncated. */}
                  <span className="text-[13px] font-medium text-slate-800 leading-snug break-words">
                    {it.name}
                  </span>
                </span>
                <span className="text-[13px] font-semibold tabular-nums shrink-0" style={{ color }}>
                  {formatValue(v)}
                </span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500"
                  style={{ width: `${pct}%`, background: color }}
                />
              </div>
              {it.meta && <p className="mt-1.5 text-[11px] text-slate-500">{it.meta}</p>}
            </Row>
          </li>
        );
      })}
    </ol>
  );
}
