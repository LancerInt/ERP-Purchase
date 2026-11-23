import { forwardRef } from 'react';

/**
 * Polished checkbox. The native input is hidden visually but kept
 * accessible (focus, keyboard, form submission), and a styled box is
 * painted on top. Min 44px tap-target on mobile via the wrapping label.
 */
const Checkbox = forwardRef(function Checkbox(
  { label, hint, id, className = '', disabled, ...props },
  ref,
) {
  return (
    <label
      htmlFor={id}
      className={`inline-flex items-start gap-2.5 min-h-[44px] py-2 cursor-pointer select-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`}
    >
      <input
        ref={ref}
        id={id}
        type="checkbox"
        disabled={disabled}
        className="mt-[3px] h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
        {...props}
      />
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className="block text-[14px] text-slate-800">{label}</span>}
          {hint && <span className="block text-[12px] text-slate-500 mt-0.5">{hint}</span>}
        </span>
      )}
    </label>
  );
});

export default Checkbox;
