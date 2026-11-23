import { TrendingUp, TrendingDown } from 'lucide-react';

export default function StatsCard({
  icon: Icon,
  label,
  value,
  trend = null,
  trendLabel = null,
  onClick = null,
  isLoading = false,
}) {
  const handleClick = (e) => {
    // Don't navigate if user is selecting text
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    if (onClick) onClick(e);
  };

  // Long money strings (e.g. full crore balances) step down one font size so
  // the WHOLE amount shows on a single line — the `.money` token keeps it from
  // wrapping mid-number or being clipped to "…".
  const valueStr = value == null ? '' : String(value);
  const isLongValue = valueStr.length > 12;

  return (
    <div
      onClick={handleClick}
      className={`bg-white rounded-lg border border-slate-200 p-2.5 sm:p-3 ${
        onClick ? 'cursor-pointer hover:shadow-lg hover:border-slate-300 transition' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        {/* Left: Icon and label */}
        <div className="min-w-0">
          <p className="text-xs sm:text-sm text-slate-600 font-medium">{label}</p>
          {isLoading ? (
            <div className="mt-1.5 sm:mt-2 h-6 w-20 sm:h-8 sm:w-24 bg-slate-200 rounded animate-pulse" />
          ) : (
            <p className={`${isLongValue ? 'text-sm' : 'text-sm sm:text-base'} font-bold text-slate-900 mt-1 sm:mt-1.5 leading-tight money`}>{value}</p>
          )}

          {trend !== null && (
            <div className="flex items-center gap-1 mt-3">
              <div
                className={`flex items-center gap-1 text-sm font-medium ${
                  trend >= 0 ? 'text-emerald-600' : 'text-red-600'
                }`}
              >
                {trend >= 0 ? (
                  <TrendingUp size={16} />
                ) : (
                  <TrendingDown size={16} />
                )}
                <span>{Math.abs(trend)}%</span>
              </div>
              {trendLabel && (
                <span className="text-xs text-slate-600">{trendLabel}</span>
              )}
            </div>
          )}
        </div>

        {/* Right: Icon — hidden on mobile to keep the card compact */}
        {Icon && (
          <div className="hidden sm:block p-2 bg-blue-50 rounded-lg text-blue-600 shrink-0">
            <Icon size={18} />
          </div>
        )}
      </div>
    </div>
  );
}
