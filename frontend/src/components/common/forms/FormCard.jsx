/**
 * Section card that hosts a form. Tightens spacing on phones, gives
 * forms a quiet border + subtle shadow, and exposes a `<Section>` /
 * `<SectionGrid>` pair so pages don't have to repeat the slightly
 * fiddly heading + grid markup.
 *
 * Usage:
 *   <FormCard>
 *     <FormCard.Section title="Basic Information">
 *       <FormCard.Grid>
 *         <Field label="…">…</Field>
 *       </FormCard.Grid>
 *     </FormCard.Section>
 *     <FormCard.Actions>…</FormCard.Actions>
 *   </FormCard>
 */
function FormCard({ children, className = '' }) {
  return (
    <div
      className={`bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

// Tightened one step across the board: a long form is faster to fill when more
// of it is visible at once, and the section border already separates groups, so
// the extra padding was doing that job twice.
function Section({ title, description, children, className = '' }) {
  return (
    <section className={`px-4 sm:px-5 py-4 sm:py-5 border-b border-slate-100 last:border-b-0 ${className}`}>
      {(title || description) && (
        <header className="mb-3 sm:mb-4">
          {title && (
            <h3 className="text-[15px] sm:text-base font-semibold text-slate-900">{title}</h3>
          )}
          {description && (
            <p className="text-[12px] sm:text-[13px] text-slate-500 mt-0.5">{description}</p>
          )}
        </header>
      )}
      {children}
    </section>
  );
}

function Grid({ cols = 3, children, className = '' }) {
  // Static lookup so Tailwind sees every class at build time.
  const colsCls = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 lg:grid-cols-4',
  }[cols] || 'grid-cols-2 lg:grid-cols-3';

  return (
    <div className={`grid ${colsCls} gap-x-3 sm:gap-x-4 gap-y-3 sm:gap-y-4 ${className}`}>
      {children}
    </div>
  );
}

/**
 * Actions footer. Two modes:
 *   - default: inline footer bar, lives at the bottom of the form card.
 *   - sticky:  on mobile, pins to the viewport bottom (Zoho-style action
 *              dock); on desktop it falls back to the inline footer.
 *
 * The sticky variant is paired with bottom padding inside the parent
 * page so the last form section isn't hidden under the dock. We add
 * pb-24 on the FormCard automatically when sticky is set.
 */
function Actions({ children, className = '', sticky = false }) {
  if (!sticky) {
    return (
      <div
        className={`px-4 sm:px-6 py-4 bg-slate-50 border-t border-slate-100 flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3 ${className}`}
      >
        {children}
      </div>
    );
  }
  return (
    <>
      {/* Mobile: fixed dock with safe-area inset */}
      <div
        className={`sm:hidden fixed inset-x-0 bottom-0 z-20 bg-white/95 backdrop-blur border-t border-slate-200 px-4 py-3 flex gap-2 print:hidden ${className}`}
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {children}
      </div>
      {/* Desktop: regular inline footer */}
      <div className={`hidden sm:flex px-4 sm:px-6 py-4 bg-slate-50 border-t border-slate-100 sm:justify-end gap-2 sm:gap-3 ${className}`}>
        {children}
      </div>
    </>
  );
}

FormCard.Section = Section;
FormCard.Grid = Grid;
FormCard.Actions = Actions;

export default FormCard;
