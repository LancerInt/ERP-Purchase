/**
 * The control vocabulary for every toolbar in the app — view toggles, filter
 * selects, search boxes, export buttons, pagers.
 *
 * WHY THIS EXISTS
 * ---------------
 * There were six control heights in common use (py-1 / 1.5 / 2 / 2.5 / 3 / 4)
 * plus min-h values of 36, 38, 40, 42, 44 and 48px. DataTable alone — which 117
 * list pages render — carried three of them in a single toolbar: the search box
 * at py-2.5, the page-size select at py-2 and the pager at py-1.5. Nothing sat
 * on a shared baseline, so every toolbar read as a pile of loose parts.
 *
 * Importing from here instead of hand-writing padding means a new control
 * cannot introduce a seventh size.
 *
 * HEIGHT IS CHOSEN BY INPUT DEVICE, NOT SCREEN WIDTH
 * --------------------------------------------------
 * A 1024px iPad and a 1024px laptop window are the same width and need
 * different things, so a breakpoint cannot decide this:
 *
 *     mouse / trackpad   32px — compact, so more of the ledger fits on screen
 *     touch              44px — the Apple HIG / Material minimum hit target
 *
 * The default is the touch-safe size and `fine:` tightens it, so a device that
 * reports no pointer capability lands on the comfortable size rather than the
 * cramped one.
 */

/** Height + vertical centring. Every control on a toolbar row uses this. */
export const CTRL_H = 'h-8 coarse:h-11';

const BASE = `${CTRL_H} inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap`;

/** Bordered white control — the default for anything that isn't a primary action. */
export const CTRL_GHOST = `${BASE} px-3 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;

/** <select> / <input>. Not BASE: form elements must not be inline-flex. */
export const CTRL_FIELD = `${CTRL_H} rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-700`;

/** Square icon-only button, so a close/kebab lines up with the row beside it. */
export const CTRL_ICON = `${CTRL_H} aspect-square inline-flex items-center justify-center rounded-lg transition`;

/** Solid actions. Colour carries the meaning; the shell is identical. */
export const CTRL_PRIMARY = `${BASE} px-3 bg-blue-600 text-white hover:bg-blue-700`;
export const CTRL_EXPORT = `${BASE} px-3 bg-emerald-600 text-white hover:bg-emerald-700`;

/**
 * Segmented group — a joined either/or choice (Records | By Month | By Item).
 * Detached bordered buttons read as independent toggles, which is the wrong
 * signal for a single-choice control. Use CTRL_SEG on the wrapper and
 * CTRL_SEG_ITEM on each button.
 */
export const CTRL_SEG = `${CTRL_H} flex rounded-lg border border-slate-300 overflow-hidden`;
export const CTRL_SEG_ITEM = (active, first = false) =>
  `px-2.5 text-xs font-medium transition ${first ? '' : 'border-l border-slate-200'} ${
    active ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
  }`;

/**
 * The row a set of controls sits on. `flex-wrap` is what makes a toolbar
 * survive a 375px phone: controls reflow onto another line instead of
 * overflowing the viewport or being squeezed into an unreadable sliver.
 */
export const CTRL_ROW = 'flex flex-wrap items-center gap-2';
