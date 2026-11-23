import { Plus } from 'lucide-react';

/**
 * MobileFAB — floating action button, mobile-only.
 *
 * Zoho Inventory's "+" lives bottom-right of every list page and creates
 * a new record. We mirror that pattern: fixed-position circular button
 * with a gradient fill, lifted shadow, and a tiny scale on press to feel
 * responsive on touch.
 *
 * Two variants:
 *   - `circular` (default) — 56px circle, icon only.
 *   - `extended` — pill with icon + label for primary screens where the
 *     action benefits from a verb ("Add Customer").
 *
 * Always `lg:hidden` so desktop keeps the inline "Add" button in the
 * page header. `bottom-20` lifts it clear of the fixed mobile bottom-nav
 * (MobileBottomNav, ~60px tall), and the safe-area inset keeps it above
 * the iPhone home indicator.
 */
export default function MobileFAB({
  onClick,
  icon: Icon = Plus,
  label,
  extended = false,
  variant = 'primary',
  className = '',
  ariaLabel,
}) {
  const gradients = {
    primary: 'from-blue-500 to-blue-700 shadow-blue-500/30',
    success: 'from-emerald-500 to-emerald-700 shadow-emerald-500/30',
    danger:  'from-red-500 to-red-700 shadow-red-500/30',
  };
  const grad = gradients[variant] || gradients.primary;

  return (
    <div
      className={`fixed right-4 bottom-20 z-30 lg:hidden print:hidden ${className}`}
      style={{
        paddingRight: 'env(safe-area-inset-right)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel || label || 'Action'}
        className={`group flex items-center justify-center gap-2 bg-gradient-to-br ${grad} text-white font-semibold shadow-lg active:scale-95 hover:shadow-xl transition-all duration-150 ${
          extended ? 'h-14 px-5 rounded-full text-[14px]' : 'h-14 w-14 rounded-full'
        }`}
      >
        <Icon size={extended ? 18 : 22} strokeWidth={2.25} />
        {extended && label && <span className="pr-1">{label}</span>}
      </button>
    </div>
  );
}
