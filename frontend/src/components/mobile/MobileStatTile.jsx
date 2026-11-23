import { TrendingUp, TrendingDown } from 'lucide-react';

/**
 * MobileStatTile — compact metric card for dashboards.
 *
 * Zoho dashboards lead with these: label up top, big numeric value in
 * the middle, optional trend pill at the bottom. Our twist is the
 * gradient accent — solid color variants feel flat on mobile, gradients
 * give the screen a bit of life without crossing into "loud".
 *
 * Tile sizes auto-fit a 2-column grid; pass `cols={3}` on the parent if
 * you need three across on tablets.
 */
const VARIANT_STYLES = {
  blue:    { grad: 'from-blue-500 to-blue-700',       icon: 'bg-white/15' },
  emerald: { grad: 'from-emerald-500 to-emerald-700', icon: 'bg-white/15' },
  amber:   { grad: 'from-amber-500 to-orange-600',    icon: 'bg-white/15' },
  rose:    { grad: 'from-rose-500 to-rose-700',       icon: 'bg-white/15' },
  slate:   { grad: 'from-slate-700 to-slate-900',     icon: 'bg-white/15' },
};

export default function MobileStatTile({
  label,
  value,
  icon: Icon,
  trend,           // { direction: 'up'|'down', value: '12.5%' }
  variant = 'blue',
  onClick,
  className = '',
}) {
  const styles = VARIANT_STYLES[variant] || VARIANT_STYLES.blue;
  const TrendIcon = trend?.direction === 'down' ? TrendingDown : TrendingUp;

  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`relative overflow-hidden bg-gradient-to-br ${styles.grad} text-white rounded-2xl p-4 text-left shadow-sm active:scale-[0.98] transition-transform ${className}`}
    >
      {/* Decorative blob — adds depth without an image asset. */}
      <div className="absolute -right-6 -top-6 w-24 h-24 rounded-full bg-white/10" aria-hidden="true" />

      <div className="relative flex items-start justify-between mb-3">
        <span className="text-[12px] font-medium text-white/80 uppercase tracking-wide">{label}</span>
        {Icon && (
          <span className={`inline-flex items-center justify-center w-8 h-8 rounded-lg ${styles.icon}`}>
            <Icon size={16} />
          </span>
        )}
      </div>

      <div className="relative">
        <p className="text-2xl font-bold tracking-tight">{value}</p>
        {trend && (
          <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium bg-white/15 rounded-full px-2 py-0.5">
            <TrendIcon size={11} />
            <span>{trend.value}</span>
          </div>
        )}
      </div>
    </Tag>
  );
}
