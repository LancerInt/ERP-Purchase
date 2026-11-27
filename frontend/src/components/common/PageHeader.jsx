import { Link } from 'react-router-dom';
import { Plus, Download, Filter, Settings2, Upload, Printer, ChevronLeft } from 'lucide-react';
import BackToModule from './BackToModule';
import { Button } from '../ui';
import CompanyFilter from './CompanyFilter';

export default function PageHeader({
  title,
  subtitle,
  breadcrumbs = [],
  actions = {},
  center = null,
  onBack = null,
  compact = false,
  hideCompanyFilter = false,
  band = false,          // teal-gradient banner header (SS Biochem house style)
}) {
  // ── Teal band header (SS Biochem house style) ──────────────────────────
  // One consistent banner across every page: breadcrumb + back + title/subtitle
  // on the left, company filter + page actions on the right, on a teal gradient.
  if (band) {
    const backBtn = onBack ? (
      <button type="button" onClick={onBack} aria-label="Back"
        className="shrink-0 w-8 h-8 rounded border border-white/40 bg-white/15 text-white flex items-center justify-center hover:bg-white/25 transition">
        <ChevronLeft size={18} />
      </button>
    ) : (
      <BackToModule className="!ml-0 !p-0 !rounded !w-8 !h-8 flex items-center justify-center border border-white/40 !bg-white/15 !text-white hover:!bg-white/25" />
    );
    return (
      <div className="mb-3 print:hidden shadow-sm bg-gradient-to-r from-[#1d6b5c] to-[#2b8273]">
        {breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="hidden sm:flex items-center gap-1.5 px-4 pt-2.5 text-[11px] text-teal-50/80">
            {breadcrumbs.map((crumb, idx) => {
              const to = crumb.href || crumb.path || crumb.to;
              return (
                <span key={idx} className="flex items-center gap-1.5">
                  {idx > 0 && <span className="text-white/40">/</span>}
                  {to ? <Link to={to} className="hover:text-white font-medium">{crumb.label}</Link>
                      : <span className="text-white/90 font-medium">{crumb.label}</span>}
                </span>
              );
            })}
          </nav>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {backBtn}
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-extrabold text-white truncate">{title}</h1>
              {subtitle && <p className="hidden sm:block text-[11.5px] text-teal-50/85 mt-0.5 truncate">{subtitle}</p>}
            </div>
          </div>
          {actions.left && <div className="flex flex-wrap items-center gap-1.5 shrink-0">{actions.left}</div>}
          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2 shrink-0">
            {!hideCompanyFilter && <CompanyFilter onDark />}
            {actions.right}
            {actions.onImport && <Button variant="outline" icon={Download} responsiveLabel onClick={actions.onImport} className="border-white/40 text-white hover:bg-white/15" title="Import">Import</Button>}
            {actions.onExport && <Button variant="outline" icon={Upload} responsiveLabel onClick={actions.onExport} className="border-white/40 text-white hover:bg-white/15" title="Export">Export</Button>}
            {actions.onFilter && <Button variant="outline" icon={Filter} responsiveLabel onClick={actions.onFilter} className="border-white/40 text-white hover:bg-white/15" title="Filters">Filters</Button>}
            {actions.onConfigureFields && <Button variant="outline" icon={Settings2} responsiveLabel onClick={actions.onConfigureFields} className="border-white/40 text-white hover:bg-white/15" title="Fields">Fields</Button>}
            {actions.onPrint && <Button variant="outline" icon={Printer} iconOnly onClick={actions.onPrint} className="border-white/40 text-white hover:bg-white/15" aria-label="Print" title="Print" />}
            {actions.createLink && (
              <Button as={Link} to={actions.createLink} variant="primary" icon={Plus} className="!bg-white !text-[#12463c] hover:!bg-teal-50 !rounded">
                {actions.createLabel || 'New'}
              </Button>
            )}
            {Array.isArray(actions.extraLinks) && actions.extraLinks.map((lnk) => (
              <Button key={lnk.to} as={Link} to={lnk.to} variant="outline" icon={Plus} className="border-white/40 text-white hover:bg-white/15">{lnk.label}</Button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* Back chevron. When the page supplies `onBack` (e.g. Customer Insights
     returning from a customer's 360 to its welcome list) we use that;
     otherwise the default module-back behaviour. Shared by both layouts. */
  const backEl = onBack ? (
    <button type="button" onClick={onBack} aria-label="Back"
      className="-ml-1 shrink-0 p-2 rounded-lg text-slate-500 hover:bg-slate-100 active:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
      <ChevronLeft size={compact ? 18 : 22} />
    </button>
  ) : <BackToModule />;

  const actionsEl = (
    <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-3 shrink-0 max-w-full">
      {/* Global company filter — sticks across every page/tab (only shows
          when there is more than one company). */}
      {!hideCompanyFilter && <CompanyFilter />}
      {/* Page-supplied control rendered inline with the title (e.g. a
          status pill or an Approve button) — keeps it at the top
          instead of eating its own row below the header. */}
      {actions.right}
      {/* Secondary actions collapse to icon-only on mobile, icon+label
          from sm up (responsiveLabel). */}
      {actions.onImport && (
        <Button variant="outline" icon={Download} responsiveLabel onClick={actions.onImport} aria-label="Import" title="Import">Import</Button>
      )}
      {actions.onExport && (
        <Button variant="outline" icon={Upload} responsiveLabel onClick={actions.onExport} aria-label="Export" title="Export">Export</Button>
      )}
      {actions.onFilter && (
        <Button variant="outline" icon={Filter} responsiveLabel onClick={actions.onFilter} aria-label="Filters" title="Filters">Filters</Button>
      )}
      {actions.onConfigureFields && (
        <Button variant="outline" icon={Settings2} responsiveLabel onClick={actions.onConfigureFields} aria-label="Fields" title="Configure fields">Fields</Button>
      )}
      {/* Print loses its label in the compact header. "Print" next to a
          printer icon tells you nothing the icon did not, and the ~45px it
          costs is width the filter row next to it actually uses — dropping it
          is what lets the last filter come up onto the crumb row instead of
          wrapping. Blue rather than outline so the one action on the row still
          reads as an action at a glance. Same height as before, so nothing
          above or below it moves. */}
      {actions.onPrint && (compact ? (
        <Button variant="primary" icon={Printer} iconOnly onClick={actions.onPrint} aria-label="Print" title="Print" />
      ) : (
        <Button variant="outline" icon={Printer} responsiveLabel onClick={actions.onPrint} aria-label="Print" title="Print">Print</Button>
      ))}
      {/* Primary create — keeps its label on mobile (the action the
          user came here to do). */}
      {actions.createLink && (
        <Button as={Link} to={actions.createLink} variant="primary" icon={Plus}>
          {actions.createLabel || 'New'}
        </Button>
      )}
      {Array.isArray(actions.extraLinks) && actions.extraLinks.map((lnk) => (
        <Button
          key={lnk.to}
          as={Link}
          to={lnk.to}
          variant="outline"
          icon={Plus}
          className="border-primary-300 text-primary-700 hover:bg-primary-50 hover:border-primary-400"
        >
          {lnk.label}
        </Button>
      ))}
    </div>
  );

  /* Compact header — ONE row: back, the breadcrumb trail, then the actions.
     The trail's last crumb IS the page name, so a separate title block and
     subtitle would just repeat it down a second and third row. On a dense
     analytics page that reclaims ~70px, which is the difference between the
     first metric being above or below the fold.

     The <h1> stays as screen-reader-only text: dropping it entirely would
     leave the page with no heading and break heading order for assistive
     tech, even though sighted users read the crumb instead. */
  if (compact) {
    return (
      <div className="mb-2 print:hidden flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-1 min-w-0">
          {backEl}
          <h1 className="sr-only">{title}</h1>
          {breadcrumbs.length > 0 && (
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0 flex-wrap">
              {breadcrumbs.map((crumb, idx) => {
                const to = crumb.href || crumb.path || crumb.to;
                const last = idx === breadcrumbs.length - 1;
                return (
                  <span key={idx} className="flex items-center gap-1.5 min-w-0">
                    {idx > 0 && <span className="text-slate-300" aria-hidden="true">/</span>}
                    {last ? (
                      <span aria-current="page" className="text-sm font-semibold text-slate-900 truncate">{crumb.label}</span>
                    ) : to ? (
                      <Link to={to} className="text-xs text-primary-600 font-medium hover:text-primary-700 hover:underline">{crumb.label}</Link>
                    ) : (
                      <span className="text-xs text-primary-600 font-medium">{crumb.label}</span>
                    )}
                  </span>
                );
              })}
            </nav>
          )}
        </div>

        {actions.left && (
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">{actions.left}</div>
        )}

        {/* Filters (or any page control set) ride on the SAME row as the
            crumb from lg up, so a dense page spends one row on chrome instead
            of two. Below lg they are dropped here and the page shows them in
            its own sheet — a full control set cannot share a phone row. */}
        {center && (
          <div className="hidden lg:flex flex-1 min-w-0 items-center">{center}</div>
        )}

        {actionsEl}
      </div>
    );
  }

  return (
    <div className="mb-2 sm:mb-3 print:hidden">
      {/* Breadcrumbs — hidden on mobile. On a phone the trail eats a
          whole row for little value (the sidebar/back already give
          context), so we only show it from sm up to reclaim vertical
          space and cut scrolling. */}
      {breadcrumbs.length > 0 && (
        <nav className="hidden sm:flex items-center gap-1.5 sm:gap-2 text-xs text-slate-500 mb-1 flex-wrap">
          {breadcrumbs.map((crumb, idx) => {
            const to = crumb.href || crumb.path || crumb.to;
            const last = idx === breadcrumbs.length - 1;
            // Consistent rule: parent crumbs are teal (section colour), the
            // current page (last crumb) is grey — whether or not it links.
            return (
              <span key={idx} className="flex items-center gap-1.5 sm:gap-2">
                {idx > 0 && <span>/</span>}
                {last ? (
                  <span className="text-slate-600 font-semibold">{crumb.label}</span>
                ) : to ? (
                  <Link to={to} className="text-primary-600 font-medium hover:text-primary-700 hover:underline">{crumb.label}</Link>
                ) : (
                  <span className="text-primary-600 font-medium">{crumb.label}</span>
                )}
              </span>
            );
          })}
        </nav>
      )}

      {/* Title + actions on a SINGLE row — the big-SaaS mobile pattern
          (Linear/Stripe): compact title on the left, icon actions on
          the right, never stacked. The title truncates first so the
          action buttons keep their place; `shrink-0` protects them.
          The subtitle drops below the row and is hidden on phones
          (kept from sm up) so the header stays one tight line on mobile
          and reclaims the vertical space for actual content. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 sm:gap-x-4 gap-y-2">
        {/* When a `center` slot is supplied it fills the middle (e.g. the
            Sales Dashboard filter bar sitting inline with the title), so the
            title block shrinks to its content instead of grabbing flex-1.
            On sm+ the title reserves a min width so a crowded action set
            (e.g. Bills: Scan/Import/Reconcile×2/Revert/Filters/New) wraps to
            its own row below instead of crushing the title into a one-word-
            per-line column. On mobile min-w-0 keeps truncation working. */}
        <div className={`min-w-0 ${(center || actions.left) ? '' : 'flex-1 sm:min-w-[15rem]'} flex items-center gap-1.5`}>
          {backEl}
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-bold text-slate-900 truncate lg:whitespace-normal lg:overflow-visible">{title}</h1>
            {subtitle && <p className="hidden sm:block text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
        </div>

        {/* Page-supplied controls that belong on the LEFT, beside the title,
            rather than with the actions on the right — a basis or mode switch
            that changes what the whole page is showing, as opposed to an action
            you perform. Unlike `center` this is visible at every width, because
            a control that changes the numbers must not disappear on a laptop.
            Additive: pages that don't pass it render exactly as before. */}
        {actions.left && (
          <div className="flex flex-wrap items-center gap-1.5 shrink-0 mr-auto">{actions.left}</div>
        )}

        {center && (
          <div className="flex-1 min-w-0 hidden lg:block">{center}</div>
        )}

        {actionsEl}
      </div>
    </div>
  );
}
