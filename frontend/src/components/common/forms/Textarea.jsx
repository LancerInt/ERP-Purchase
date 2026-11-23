import { forwardRef } from 'react';

/**
 * Polished textarea. Matches Input's visual language so a form mixing
 * single-line and multi-line fields stays cohesive. Defaults to 3 rows
 * and resizes vertically only — horizontal resize breaks responsive
 * grids on phones.
 */
const Textarea = forwardRef(function Textarea(
  { error, className = '', rows = 3, ...props },
  ref,
) {
  const base =
    'block w-full rounded-lg border-0 px-3.5 py-2.5 text-[14px] text-slate-900 ' +
    'ring-1 ring-inset placeholder:text-slate-400 ' +
    'focus:ring-2 focus:ring-inset focus:outline-none transition-shadow duration-150 ' +
    'resize-y disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed ' +
    'read-only:bg-slate-50 read-only:text-slate-600';

  const ring = error
    ? 'ring-red-300 focus:ring-red-500'
    : 'ring-slate-200 focus:ring-blue-500';

  return <textarea ref={ref} rows={rows} className={`${base} ${ring} ${className}`} {...props} />;
});

export default Textarea;
