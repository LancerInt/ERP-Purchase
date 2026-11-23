/**
 * Premium text input with optional leading icon + trailing slot.
 * Consistent height, border, focus ring across the app.
 *
 *   <Input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search…" icon={Search} />
 *   <Input type="email" invalid={!!err} />
 *
 * For a search box, pass icon={Search}; for a clearable field pass a
 * `trailing` node (e.g. an X button).
 */
import { forwardRef } from 'react';

const Input = forwardRef(function Input(
  { icon: Icon, trailing, invalid = false, size = 'md', className = '', containerClassName = '', ...rest },
  ref,
) {
  const h = size === 'sm' ? 'h-9 text-sm' : 'h-10 sm:h-11 text-sm';
  const pl = Icon ? 'pl-9' : 'pl-3.5';
  const pr = trailing ? 'pr-9' : 'pr-3.5';
  const border = invalid
    ? 'border-red-400 focus:ring-red-400'
    : 'border-slate-300 focus:ring-primary-500 focus:border-primary-500';
  return (
    <div className={`relative ${containerClassName}`}>
      {Icon && (
        <Icon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
      )}
      <input
        ref={ref}
        className={`w-full ${h} ${pl} ${pr} bg-white border rounded-lg outline-none transition focus:ring-2 placeholder:text-slate-400 disabled:bg-slate-50 disabled:text-slate-400 ${border} ${className}`}
        {...rest}
      />
      {trailing && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">{trailing}</div>
      )}
    </div>
  );
});

export default Input;
