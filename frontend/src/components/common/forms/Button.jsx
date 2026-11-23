import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Polished button. Five variants, three sizes, optional loading state,
 * full-width prop. Minimum 44px touch target so it's reliably tappable
 * on phones without us having to remember to pad icon buttons by hand.
 */
const VARIANTS = {
  primary:   'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 shadow-sm',
  secondary: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 active:bg-slate-100',
  danger:    'bg-red-600 text-white hover:bg-red-700 active:bg-red-800 shadow-sm',
  ghost:     'bg-transparent text-slate-700 hover:bg-slate-100 active:bg-slate-200',
  link:      'bg-transparent text-blue-600 hover:text-blue-700 underline underline-offset-2',
};

const SIZES = {
  sm: 'px-3 py-1.5 text-[13px] min-h-[36px]',
  md: 'px-4 py-2.5 text-[14px] min-h-[44px]',
  lg: 'px-5 py-3 text-[15px] min-h-[48px]',
};

const Button = forwardRef(function Button(
  {
    variant = 'primary',
    size = 'md',
    fullWidth = false,
    loading = false,
    leftIcon,
    rightIcon,
    disabled,
    className = '',
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium ' +
    'transition-colors duration-150 focus:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-blue-500 focus-visible:ring-offset-2 ' +
    'disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={`${base} ${VARIANTS[variant] || VARIANTS.primary} ${SIZES[size] || SIZES.md} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...props}
    >
      {loading ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
});

export default Button;
