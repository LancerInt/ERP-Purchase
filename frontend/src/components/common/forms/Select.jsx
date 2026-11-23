import CustomSelect from "@/components/ui/CustomSelect";
import { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Polished native <CustomSelect>. The arrow indicator is rendered as a
 * decorative chevron so it looks consistent across Chrome / Safari /
 * Firefox (the platform-native arrows look very different from each
 * other and tend to clash with the rest of the form). We hide the
 * browser arrow with `appearance-none` and pad the right side to
 * leave room for ours.
 */
const Select = forwardRef(function Select(
  { error, children, placeholder, value, className = '', ...props },
  ref,
) {
  const base =
    'block w-full appearance-none rounded-lg border-0 py-2.5 pl-3.5 pr-9 text-[14px] text-slate-900 ' +
    'ring-1 ring-inset focus:ring-2 focus:ring-inset focus:outline-none transition-shadow duration-150 ' +
    'min-h-[44px] bg-white disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed';

  const ring = error
    ? 'ring-red-300 focus:ring-red-500'
    : 'ring-slate-200 focus:ring-blue-500';

  // When no value is set AND a placeholder is provided, render an
  // implicit empty option so the select shows the placeholder text.
  const hasExplicitPlaceholder = placeholder !== undefined;

  return (
    <div className="relative">
      <CustomSelect ref={ref} value={value} className={`${base} ${ring} ${className}`} {...props}>
        {hasExplicitPlaceholder && (
          <option value="" disabled hidden={value !== ''}>
            {placeholder}
          </option>
        )}
        {children}
      </CustomSelect>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
      />
    </div>
  );
});

export default Select;
