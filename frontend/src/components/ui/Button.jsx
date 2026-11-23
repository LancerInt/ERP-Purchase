/**
 * Premium base Button — the single source of button styling.
 *
 * Clean/modern (Linear/Stripe) look: rounded-lg, medium weight, subtle
 * borders/shadows, blue accent. Use everywhere instead of ad-hoc button
 * classes so the app stays consistent.
 *
 *   <Button onClick={...}>Save</Button>
 *   <Button variant="outline" icon={Filter}>Filters</Button>
 *   <Button as={Link} to="/x" variant="primary" icon={Plus}>New</Button>
 *   <Button variant="danger" loading={saving}>Delete</Button>
 *   <Button variant="ghost" icon={Pencil} iconOnly aria-label="Edit" />
 *
 * Props:
 *   variant: primary | secondary | outline | ghost | danger | success
 *   size:    sm | md | lg
 *   icon:    a lucide icon component (rendered leading)
 *   iconOnly: square icon button (hide label)
 *   loading: shows a spinner and disables
 *   as:      'button' (default) | 'a' | Link  — element to render
 */
import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

const VARIANTS = {
  primary:
    'bg-primary-600 text-white shadow-sm hover:bg-primary-700 active:bg-primary-800 focus-visible:ring-primary-500 disabled:bg-primary-300',
  secondary:
    'bg-slate-100 text-slate-800 hover:bg-slate-200 active:bg-slate-300 focus-visible:ring-slate-400',
  outline:
    'bg-white text-slate-700 border border-slate-300 shadow-sm hover:bg-slate-50 hover:border-slate-400 active:bg-slate-100 focus-visible:ring-slate-400',
  ghost:
    'text-slate-600 hover:bg-slate-100 active:bg-slate-200 focus-visible:ring-slate-400',
  danger:
    'bg-red-600 text-white shadow-sm hover:bg-red-700 active:bg-red-800 focus-visible:ring-red-500 disabled:bg-red-300',
  success:
    'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 active:bg-emerald-800 focus-visible:ring-emerald-500 disabled:bg-emerald-300',
};

const SIZES = {
  sm: { btn: 'h-8 text-xs gap-1.5', px: 'px-3', square: 'w-8', rsq: 'w-8 sm:w-auto sm:px-3', icon: 14 },
  md: { btn: 'h-9 sm:h-10 text-sm gap-2', px: 'px-3.5 sm:px-4', square: 'w-9 sm:w-10', rsq: 'w-9 sm:w-auto sm:px-4', icon: 16 },
  lg: { btn: 'h-11 text-sm gap-2', px: 'px-5', square: 'w-11', rsq: 'w-11 sm:w-auto sm:px-5', icon: 18 },
};

const Button = forwardRef(function Button(
  {
    as: Comp = 'button',
    variant = 'primary',
    size = 'md',
    icon: Icon,
    iconOnly = false,
    responsiveLabel = false, // icon-only on mobile, icon+label from sm up
    loading = false,
    disabled = false,
    className = '',
    children,
    type,
    ...rest
  },
  ref,
) {
  const s = SIZES[size] || SIZES.md;
  const base =
    'inline-flex items-center justify-center font-medium rounded-lg transition-colors ' +
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ' +
    'disabled:opacity-60 disabled:cursor-not-allowed disabled:shadow-none shrink-0 whitespace-nowrap';
  const shape = iconOnly ? s.square : responsiveLabel ? s.rsq : s.px;
  const cls = `${base} ${s.btn} ${shape} ${VARIANTS[variant] || VARIANTS.primary} ${className}`;

  const isNativeButton = Comp === 'button';
  const content = (
    <>
      {loading ? (
        <Loader2 size={s.icon} className="animate-spin" />
      ) : (
        Icon && <Icon size={s.icon} />
      )}
      {!iconOnly &&
        (responsiveLabel ? <span className="hidden sm:inline">{children}</span> : children)}
    </>
  );

  return (
    <Comp
      ref={ref}
      className={cls}
      disabled={isNativeButton ? disabled || loading : undefined}
      aria-disabled={!isNativeButton && (disabled || loading) ? true : undefined}
      type={isNativeButton ? type || 'button' : type}
      {...rest}
    >
      {content}
    </Comp>
  );
});

export default Button;
