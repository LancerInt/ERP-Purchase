import { ChevronRight } from 'lucide-react';

/**
 * MobileListCard — Zoho-style record card.
 *
 * One record per card with a strict visual hierarchy:
 *   row 1: avatar + title + status pill (top-right)
 *   row 2: subtitle (smaller, muted)
 *   row 3: two-column metadata grid (label → value pairs)
 *   row 4 (optional): action bar with tap-targets
 *
 * The avatar is auto-generated from the title's first letter with a
 * deterministic accent color so each card gets a stable identity color
 * (similar to how Notion, Linear, and Zoho's mobile app paint contact
 * avatars). Callers can pass `avatar` to override with a custom node.
 */

// Deterministic accent palette — same string always picks the same
// color so a customer's avatar doesn't change between renders.
const AVATAR_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-violet-100 text-violet-700',
  'bg-cyan-100 text-cyan-700',
  'bg-indigo-100 text-indigo-700',
  'bg-fuchsia-100 text-fuchsia-700',
];

function avatarColorFor(seed) {
  if (!seed) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function MobileListCard({
  title,
  subtitle,
  badge,
  fields = [],
  actions = [],
  avatar,
  avatarSeed,
  onClick,
  className = '',
}) {
  const seed = avatarSeed || title || '';
  const avatarColor = avatarColorFor(seed);
  const initial = (seed.toString().trim().charAt(0) || '?').toUpperCase();

  return (
    <div
      className={`bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden transition-all active:scale-[0.99] active:shadow-md ${className}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left p-4 active:bg-slate-50"
      >
        {/* Top row — avatar, title block, badge, chevron */}
        <div className="flex items-start gap-3">
          {avatar !== undefined ? (
            avatar
          ) : (
            <div
              className={`shrink-0 w-11 h-11 rounded-full flex items-center justify-center font-semibold text-[16px] ${avatarColor}`}
              aria-hidden="true"
            >
              {initial}
            </div>
          )}

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              {/* Party names (customer / vendor / product) land here and are
                  the row's identity — wrap them onto a second line rather
                  than truncating, since two records often differ only in the
                  clipped tail ("… - South" vs "… - Coimbatore"). */}
              <p className="text-[15px] font-semibold text-slate-900 leading-snug break-words">
                {title || '—'}
              </p>
              {badge && (
                <span
                  className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${
                    badge.cls || 'bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                >
                  {badge.label}
                </span>
              )}
            </div>
            {subtitle && (
              <p className="text-[13px] text-slate-500 mt-0.5 break-words">{subtitle}</p>
            )}
          </div>

          {/* Chevron hints at a tappable row, Zoho-style. */}
          <ChevronRight size={16} className="text-slate-300 mt-1.5 shrink-0" />
        </div>

        {/* Metadata grid — two-column on phones for compact display */}
        {fields.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-x-3 gap-y-2">
            {fields
              .filter((f) => f && f.value !== null && f.value !== undefined && f.value !== '')
              .map((f, idx) => (
                <div key={idx} className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {f.label}
                  </p>
                  <p className={`text-[13px] break-words ${f.cls || 'text-slate-800'}`}>
                    {f.value}
                  </p>
                </div>
              ))}
          </div>
        )}
      </button>

      {/* Action bar — surfaces inline tap-targets without leaving the list */}
      {actions.length > 0 && (
        <div className="border-t border-slate-100 px-2 py-1.5 flex items-center gap-1">
          {actions.map((a, idx) => {
            const Icon = a.icon;
            return (
              <button
                key={idx}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  a.onClick?.();
                }}
                aria-label={a.label}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[13px] font-medium rounded-lg min-h-[40px] ${
                  a.cls || 'text-slate-700 active:bg-slate-100'
                }`}
              >
                {Icon && <Icon size={14} />}
                {a.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
