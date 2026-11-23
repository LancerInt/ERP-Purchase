import { forwardRef } from 'react';

/**
 * Polished text input. Mobile-first sizing:
 * - 44px minimum tap height (iOS HIG)
 * - 14px / 16px-on-iOS font (16px stops iOS Safari from zooming on focus —
 *   globals.css already covers that via a media query; the explicit
 *   text-[14px] here applies on every other platform)
 * - Soft inset ring instead of a hard border for a cleaner look
 * - Distinct error / disabled / read-only states
 *
 * Spreads any extra props down to the native <input> so things like
 * `type`, `pattern`, `maxLength`, `inputMode`, etc. all just work.
 */
const Input = forwardRef(function Input(
  { error, leftIcon, rightIcon, className = '', ...props },
  ref,
) {
  const base =
    'block w-full rounded-lg border-0 py-2.5 text-[14px] text-slate-900 ' +
    'ring-1 ring-inset placeholder:text-slate-400 ' +
    'focus:ring-2 focus:ring-inset focus:outline-none transition-shadow duration-150 ' +
    'min-h-[44px] disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed ' +
    'read-only:bg-slate-50 read-only:text-slate-600';

  const ring = error
    ? 'ring-red-300 focus:ring-red-500'
    : 'ring-slate-200 focus:ring-blue-500';

  // Pad to make room for leading/trailing icons when present. Numeric
  // padding values are used so the icon sits at a predictable offset.
  const padX = `${leftIcon ? 'pl-10' : 'pl-3.5'} ${rightIcon ? 'pr-10' : 'pr-3.5'}`;

  if (!leftIcon && !rightIcon) {
    return <input ref={ref} className={`${base} ${ring} px-3.5 ${className}`} {...props} />;
  }

  return (
    <div className="relative">
      {leftIcon && (
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
          {leftIcon}
        </span>
      )}
      <input ref={ref} className={`${base} ${ring} ${padX} ${className}`} {...props} />
      {rightIcon && (
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400">
          {rightIcon}
        </span>
      )}
    </div>
  );
});

export default Input;
