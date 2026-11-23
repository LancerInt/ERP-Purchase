/**
 * Skeleton placeholders — shown in place of spinners while a list or
 * card is loading. Skeletons are friendlier than a spinner because the
 * eye gets a sense of the layout before the data lands; on slow
 * mobile networks that perceived speed boost is meaningful.
 *
 * Two helpers:
 *   - <MobileCardSkeleton count={3} /> — stack of card-shaped placeholders
 *   - <SkeletonLine width="60%" />     — single pulsing bar
 */
export function SkeletonLine({ width = '100%', className = '' }) {
  return (
    <div
      className={`h-3 rounded bg-slate-200 animate-pulse ${className}`}
      style={{ width }}
    />
  );
}

export function MobileCardSkeleton({ count = 3 }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-slate-200 animate-pulse shrink-0" />
            <div className="flex-1 space-y-2 min-w-0">
              <SkeletonLine width="60%" />
              <SkeletonLine width="40%" />
            </div>
            <div className="w-14 h-5 rounded-full bg-slate-200 animate-pulse shrink-0" />
          </div>
          <div className="space-y-2 pt-2 border-t border-slate-100">
            <SkeletonLine width="80%" />
            <SkeletonLine width="50%" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default MobileCardSkeleton;
