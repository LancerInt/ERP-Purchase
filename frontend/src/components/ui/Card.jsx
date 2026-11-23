/**
 * Premium surface container. Clean/modern: white, soft border, subtle
 * shadow, rounded-xl. Use for every panel/section so surfaces are
 * consistent.
 *
 *   <Card>...</Card>
 *   <Card padding="none"><Card.Header title="Vendors" actions={<Button/>} /> ...</Card>
 *   <Card as="section" interactive onClick={...}>...</Card>
 */
const PAD = {
  none: '',
  sm: 'p-3 sm:p-4',
  default: 'p-4 sm:p-5',
  lg: 'p-5 sm:p-6',
};

export default function Card({
  as: Comp = 'div',
  padding = 'default',
  interactive = false,
  className = '',
  children,
  ...rest
}) {
  const cls =
    'bg-white border border-slate-200 rounded-xl shadow-sm ' +
    (interactive
      ? 'transition hover:shadow-md hover:border-slate-300 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 '
      : '') +
    (PAD[padding] ?? PAD.default) +
    ' ' +
    className;
  return (
    <Comp className={cls} {...rest}>
      {children}
    </Comp>
  );
}

/** Optional header row for a Card with padding="none". */
Card.Header = function CardHeader({ title, subtitle, actions, className = '' }) {
  return (
    <div className={`flex items-start justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-slate-100 ${className}`}>
      <div className="min-w-0">
        {title && <h3 className="text-sm font-semibold text-slate-900 truncate">{title}</h3>}
        {subtitle && <p className="text-xs text-slate-500 mt-0.5 truncate">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
};

/** Body padding helper for Card padding="none". */
Card.Body = function CardBody({ className = '', children }) {
  return <div className={`p-4 sm:p-5 ${className}`}>{children}</div>;
};
