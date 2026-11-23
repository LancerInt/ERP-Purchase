/**
 * Semantic pill badge. Subtle tinted background + matching text/border,
 * consistent across the app.
 *
 *   <Badge color="green">Approved</Badge>
 *   <Badge color="amber" size="sm">Pending</Badge>
 *   <Badge color="blue" dot>Open</Badge>
 */
const COLORS = {
  slate:   'bg-slate-100 text-slate-700 border-slate-200',
  blue:    'bg-blue-50 text-blue-700 border-blue-200',
  primary: 'bg-primary-50 text-primary-700 border-primary-200',
  green:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber:   'bg-amber-50 text-amber-700 border-amber-200',
  red:     'bg-red-50 text-red-700 border-red-200',
  violet:  'bg-violet-50 text-violet-700 border-violet-200',
  teal:    'bg-teal-50 text-teal-700 border-teal-200',
};

const DOT = {
  slate: 'bg-slate-400', blue: 'bg-blue-500', primary: 'bg-primary-500',
  green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500',
  violet: 'bg-violet-500', teal: 'bg-teal-500',
};

export default function Badge({ color = 'slate', size = 'md', dot = false, className = '', children }) {
  const sz = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap ${sz} ${COLORS[color] || COLORS.slate} ${className}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${DOT[color] || DOT.slate}`} />}
      {children}
    </span>
  );
}

export { COLORS as BADGE_COLORS };
