import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, RotateCcw, Plus, Trash2, Filter, ChevronDown, ChevronUp, Check } from 'lucide-react';
import useIsNarrow from '../../hooks/useIsNarrow.js';

const OPERATORS = {
  text: [
    { value: 'contains', label: 'Contains' },
    { value: 'not_contains', label: 'Does not contain' },
    { value: 'equals', label: 'Is equal to' },
    { value: 'not_equals', label: 'Is not equal to' },
    { value: 'starts_with', label: 'Starts with' },
    { value: 'ends_with', label: 'Ends with' },
    { value: 'is_empty', label: 'Is empty' },
    { value: 'is_not_empty', label: 'Is not empty' },
  ],
  number: [
    { value: 'equals', label: 'Is equal to' },
    { value: 'not_equals', label: 'Is not equal to' },
    { value: 'gt', label: 'Greater than' },
    { value: 'gte', label: 'Greater than or equal' },
    { value: 'lt', label: 'Less than' },
    { value: 'lte', label: 'Less than or equal' },
    { value: 'between', label: 'Between' },
    { value: 'is_empty', label: 'Is empty' },
  ],
  date: [
    { value: 'equals', label: 'Is equal to' },
    { value: 'not_equals', label: 'Is not equal to' },
    { value: 'gt', label: 'Is after' },
    { value: 'lt', label: 'Is before' },
    { value: 'between', label: 'Between' },
    { value: 'is_empty', label: 'Is empty' },
    { value: 'is_not_empty', label: 'Is not empty' },
  ],
  select: [
    { value: 'equals', label: 'Is' },
    { value: 'not_equals', label: 'Is not' },
    { value: 'is_empty', label: 'Is empty' },
    { value: 'is_not_empty', label: 'Is not empty' },
  ],
};

const inputClass = 'w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

const emptyRule = { field: '', operator: 'contains', value: '', value2: '' };

const isISODate = (x) => /^\d{4}-\d{2}-\d{2}/.test(String(x ?? ''));

// Order-comparison for gt/lt/between. ISO dates (YYYY-MM-DD) sort
// chronologically as plain strings, so compare those lexically; everything
// else falls back to numeric comparison. Returns -1 | 0 | 1, or NaN when a
// side isn't comparable (callers treat NaN as "no match").
function cmp(a, b) {
  if (isISODate(a) && isISODate(b)) {
    const sa = String(a).slice(0, 10);
    const sb = String(b).slice(0, 10);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return NaN;
  return na < nb ? -1 : na > nb ? 1 : 0;
}

// Apply a single filter rule to a row value
function applyRule(rule, rowValue) {
  const { operator, value, value2 } = rule;
  const rv = rowValue != null ? String(rowValue).toLowerCase() : '';
  const fv = (value || '').toLowerCase();

  switch (operator) {
    case 'contains': return rv.includes(fv);
    case 'not_contains': return !rv.includes(fv);
    case 'equals': return rv === fv;
    case 'not_equals': return rv !== fv;
    case 'starts_with': return rv.startsWith(fv);
    case 'ends_with': return rv.endsWith(fv);
    case 'is_empty': return !rowValue || rv === '' || rv === '-';
    case 'is_not_empty': return rowValue && rv !== '' && rv !== '-';
    case 'gt': return cmp(rowValue, value) > 0;
    case 'gte': return cmp(rowValue, value) >= 0;
    case 'lt': return cmp(rowValue, value) < 0;
    case 'lte': return cmp(rowValue, value) <= 0;
    case 'between': return cmp(rowValue, value) >= 0 && cmp(rowValue, value2) <= 0;
    default: return true;
  }
}

// Simple-mode select match. `selected` may be an array (multi-select), a bare
// scalar (legacy single value / a filter marked `single`), or empty/undefined.
// Empty ⇒ no filter (every row matches); otherwise a row matches when its value
// equals ANY selected value. String-compared so number/string ids interoperate.
export function matchesSelect(rowValue, selected) {
  if (selected == null || selected === '') return true;
  const arr = Array.isArray(selected) ? selected : [selected];
  if (arr.length === 0) return true;
  const rv = rowValue == null ? '' : String(rowValue);
  return arr.some((v) => String(v) === rv);
}

// Multi-select dropdown for simple-mode filters: pick several values, match ANY.
// value is an array of selected values (a bare scalar is tolerated for legacy
// callers); onChange always emits an array. Empty array ⇒ "All".
export function FilterMultiSelect({ options = [], value, onChange, className, label = 'Select options', placeholder = 'All' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  // The open panel is rendered into <body>, not beside the trigger, so it needs
  // the trigger's screen position. See the popover below for why.
  const popRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  // Below `sm` the anchored popover inherits the trigger's narrow width, which
  // truncated every party name. Phones get a full-width bottom sheet instead.
  const isNarrow = useIsNarrow();
  const selected = (Array.isArray(value) ? value : value === '' || value == null ? [] : [value]).map(String);
  // Search box only appears for longer lists so short filters stay uncluttered.
  const searchable = options.length > 8;
  const shown = q.trim()
    ? options.filter((o) => String(o.label ?? '').toLowerCase().includes(q.trim().toLowerCase()))
    : options;

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      // The panel lives in <body>, so it is NOT inside `ref` -- without the
      // second test, clicking an option would close the dropdown instantly.
      if (ref.current && ref.current.contains(e.target)) return;
      if (popRef.current && popRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEffect(() => { if (!open) setQ(''); }, [open]);   // clear the search when the dropdown closes

  // Track where the trigger is on screen while the panel is open. `true` on the
  // scroll listener is the capture phase, which is what catches scrolling
  // INSIDE a drill-down panel -- a scroll event on an inner element does not
  // bubble to window.
  useLayoutEffect(() => {
    if (!open || isNarrow) { setAnchor(null); return undefined; }
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      // Flip above the trigger when the list would run off the bottom.
      const up = below < 260 && r.top > below;
      setAnchor({ left: r.left, width: r.width, top: up ? null : r.bottom + 4,
                  bottom: up ? window.innerHeight - r.top + 4 : null });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, isNarrow]);

  const toggle = (v) => {
    const sv = String(v);
    onChange(selected.includes(sv) ? selected.filter((x) => x !== sv) : [...selected, sv]);
  };
  const labelFor = (v) => options.find((o) => String(o.value) === String(v))?.label ?? v;
  // `placeholder` lets the empty state name what it filters ("All items")
  // instead of a bare "All", so the control is self-describing and the caller
  // does not need an extra text label beside it — which is what made the
  // drill-down toolbar read as three different control styles.
  const summary = selected.length === 0
    ? placeholder
    : selected.length === 1 ? labelFor(selected[0]) : `${selected.length} selected`;

  // Ticked options float to the top so the current selection is always in
  // view and the next pick is one tap away.
  const ordered = [...shown].sort(
    (a, b) => Number(selected.includes(String(b.value))) - Number(selected.includes(String(a.value))),
  );

  // Shared innards — identical in the desktop popover and the mobile sheet;
  // only the shell around them differs.
  const panel = (listClass) => (
    <>
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-slate-100 bg-slate-50/70">
          {selected.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-primary-50 border border-primary-200 text-primary-700 text-xs font-medium">
              <span className="truncate max-w-[190px]">{labelFor(v)}</span>
              <button type="button" onClick={() => toggle(v)} aria-label={`Remove ${labelFor(v)}`}
                className="p-1 rounded-full hover:bg-primary-100 shrink-0">
                <X size={11} />
              </button>
            </span>
          ))}
          <button type="button" onClick={() => onChange([])}
            className="ml-auto text-[11px] font-medium text-slate-500 hover:text-slate-700 underline shrink-0">
            Clear
          </button>
        </div>
      )}
      {searchable && (
        <div className="p-2 border-b border-slate-100">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus={!isNarrow}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="w-full pl-8 pr-2 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
            />
          </div>
        </div>
      )}
      <div className={listClass}>
        <button
          type="button"
          onClick={() => onChange([])}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 min-h-[44px] text-sm text-slate-500 hover:bg-slate-50 active:bg-slate-100"
        >
          <span className="w-[18px] h-[18px] shrink-0" />
          <span>All</span>
        </button>
        {ordered.map((opt) => {
          const isSel = selected.includes(String(opt.value));
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              aria-pressed={isSel}
              className={`w-full flex items-start gap-2.5 px-3 py-2.5 min-h-[44px] text-sm text-left hover:bg-slate-50 active:bg-slate-100 ${isSel ? 'bg-primary-50/40' : ''}`}
            >
              <span className={`w-[18px] h-[18px] mt-0.5 shrink-0 border rounded flex items-center justify-center ${isSel ? 'bg-primary-600 border-primary-600' : 'border-slate-300'}`}>
                {isSel && <Check size={13} className="text-white" />}
              </span>
              {/* Full label, wrapped. Truncating hid the very part that tells
                  two similarly-named parties apart, and the title-attribute
                  fallback doesn't exist on touch. */}
              <span className="text-slate-700 leading-snug break-words">{opt.label}</span>
            </button>
          );
        })}
        {shown.length === 0 && (
          <div className="px-3 py-3 text-xs text-slate-400">No matches</div>
        )}
      </div>
    </>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${className} flex items-center justify-between text-left bg-white`}
      >
        <span className={`truncate ${selected.length === 0 ? 'text-slate-400' : 'text-slate-700'}`}>{summary}</span>
        <ChevronDown size={14} className={`text-slate-400 flex-shrink-0 ml-1 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Phone: bottom sheet. The anchored popover inherited the trigger's
          width (~160px), which truncated every name; a sheet gets the full
          viewport width and comfortable 44px rows. */}
      {open && isNarrow && (
        <div className="fixed inset-0 z-[80] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={label}>
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <div
            className="relative bg-white rounded-t-2xl shadow-xl max-h-[78dvh] flex flex-col"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-800">{label}</h3>
              <button type="button" onClick={() => setOpen(false)}
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-primary-600 text-white hover:bg-primary-700">
                Done
              </button>
            </div>
            {panel('flex-1 overflow-auto overscroll-contain divide-y divide-slate-50')}
          </div>
        </div>
      )}

      {/* Desktop: anchored popover, rendered into <body>.
          It used to be an absolutely-positioned child of this trigger, which
          meant any ancestor that scrolls -- and the drill-down panels all do --
          CLIPPED it. The list came out cut off at the bottom and boxed inside
          the table instead of floating over it. A portal has no such ancestor,
          so the panel is only ever bounded by the window; `anchor` carries the
          trigger's position, re-measured on scroll and resize. */}
      {open && !isNarrow && anchor && createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed',
            left: anchor.left,
            minWidth: anchor.width,
            ...(anchor.top != null ? { top: anchor.top } : { bottom: anchor.bottom }),
          }}
          className="z-[90] w-max max-w-[min(24rem,80vw)] bg-white border border-slate-200 rounded-lg shadow-lg"
        >
          {panel('max-h-72 overflow-auto py-1')}
        </div>,
        document.body,
      )}
    </div>
  );
}

// Apply all filter rules to data
export function applyAdvancedFilters(data, rules, logic = 'AND') {
  const activeRules = rules.filter(r => r.field && r.operator);
  if (activeRules.length === 0) return data;

  return data.filter(row => {
    const results = activeRules.map(rule => {
      const val = row[rule.field];
      return applyRule(rule, val);
    });

    return logic === 'AND'
      ? results.every(Boolean)
      : results.some(Boolean);
  });
}

export default function FilterPanel({ filters = [], values = {}, onChange, onReset, onClose, columns = [], data = [], onAdvancedFilter, initialRules, initialLogic }) {
  // Seed the advanced builder from the currently-applied rules (e.g. restored
  // from the URL by the page), so reopening the panel shows them instead of a
  // blank rule. Falls back to one empty rule when nothing is applied.
  const [mode, setMode] = useState(() => (Array.isArray(initialRules) && initialRules.length ? 'advanced' : 'simple')); // 'simple' | 'advanced'
  const [rules, setRules] = useState(() => (Array.isArray(initialRules) && initialRules.length ? initialRules : [{ ...emptyRule }]));
  const [logic, setLogic] = useState(() => (initialLogic === 'OR' ? 'OR' : 'AND'));
  const [isExpanded, setIsExpanded] = useState(true);

  // Build field options from columns prop
  const fieldOptions = (columns.length > 0 ? columns : filters.map(f => ({ field: f.key, header: f.label, type: f.type })))
    .filter(c => c.field !== 'actions' && c.field !== 'id')
    .map(c => ({
      value: c.field || c.key,
      label: c.header || c.label || c.field || c.key,
      type: c.filterType || c.type || 'text',
      options: c.filterOptions || c.options || null,
    }));

  const getFieldDef = (fieldKey) => fieldOptions.find(f => f.value === fieldKey) || { type: 'text' };

  // Rule handlers
  const updateRule = (idx, key, val) => {
    setRules(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      const updated = { ...r, [key]: val };
      // Reset operator when field changes
      if (key === 'field') {
        const fDef = fieldOptions.find(f => f.value === val);
        const type = fDef?.type || 'text';
        updated.operator = OPERATORS[type]?.[0]?.value || 'contains';
        updated.value = '';
        updated.value2 = '';
      }
      return updated;
    }));
  };
  const addRule = () => setRules(prev => [...prev, { ...emptyRule }]);
  const removeRule = (idx) => {
    if (rules.length > 1) setRules(prev => prev.filter((_, i) => i !== idx));
    else setRules([{ ...emptyRule }]);
  };

  const handleApplyAdvanced = () => {
    if (onAdvancedFilter) {
      onAdvancedFilter(rules, logic);
    } else if (onChange) {
      // Fallback: store rules in a special filter key so pages can use applyAdvancedFilters
      onChange('__advancedRules', rules);
      onChange('__advancedLogic', logic);
    }
  };

  const handleResetAdvanced = () => {
    setRules([{ ...emptyRule }]);
    setLogic('AND');
    if (onAdvancedFilter) onAdvancedFilter([], 'AND');
    else if (onChange) {
      onChange('__advancedRules', []);
      onChange('__advancedLogic', 'AND');
    }
    if (onReset) onReset();
  };

  const activeRuleCount = rules.filter(r => r.field && r.operator).length;

  return (
    <div className="bg-white border border-slate-200 rounded-lg mb-4 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <Filter size={16} className="text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-700">Filters</h3>
          {/* Mode toggle */}
          <div className="flex bg-slate-100 rounded-md p-0.5 text-xs">
            <button
              onClick={() => setMode('simple')}
              className={`px-2.5 py-1 rounded transition ${mode === 'simple' ? 'bg-white text-slate-800 shadow-sm font-medium' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Simple
            </button>
            <button
              onClick={() => setMode('advanced')}
              className={`px-2.5 py-1 rounded transition ${mode === 'advanced' ? 'bg-white text-slate-800 shadow-sm font-medium' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Advanced
            </button>
          </div>
          {activeRuleCount > 0 && mode === 'advanced' && (
            <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full font-medium">{activeRuleCount} rule{activeRuleCount > 1 ? 's' : ''}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={mode === 'advanced' ? handleResetAdvanced : onReset} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
            <RotateCcw size={12} /> Reset
          </button>
          <button onClick={() => setIsExpanded(!isExpanded)} aria-label={isExpanded ? 'Collapse filters' : 'Expand filters'} title={isExpanded ? 'Collapse filters' : 'Expand filters'} className="text-slate-400 hover:text-slate-600">
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {onClose && (
            <button onClick={onClose} aria-label="Close filters" title="Close filters" className="text-slate-400 hover:text-slate-600">
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="p-3 sm:p-4">
          {/* ============ SIMPLE MODE ============ */}
          {mode === 'simple' && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
              {filters.map((filter) => (
                <div key={filter.key}>
                  <label className="block text-xs font-medium text-slate-600 mb-1">{filter.label}</label>
                  {/* Any filter that carries an `options` list renders
                      as a dropdown — explicit `type: 'select'` not
                      required. Lets existing pages whose Status / PO
                      Status entries omit the type still render as
                      proper selects instead of text-search inputs. */}
                  {(filter.type === 'select' || Array.isArray(filter.options)) ? (
                    // `single: true` keeps a plain single-select — used for
                    // cascade parents (e.g. Company → Warehouse → Godown) whose
                    // value feeds a dependent API request and can't be a list.
                    filter.single ? (
                      <CustomSelect
                        value={values[filter.key] || ''}
                        onChange={(e) => onChange(filter.key, e.target.value)}
                        className={inputClass}
                      >
                        <option value="">All</option>
                        {filter.options?.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </CustomSelect>
                    ) : (
                      <FilterMultiSelect
                        options={filter.options || []}
                        value={values[filter.key]}
                        onChange={(arr) => onChange(filter.key, arr)}
                        label={filter.label}
                        className={inputClass}
                      />
                    )
                  ) : filter.type === 'date' ? (
                    <CustomDatePicker
                      value={values[filter.key] || ''}
                      onChange={(e) => onChange(filter.key, e.target.value)}
                      className={inputClass}
                    />
                  ) : (
                    <div className="relative">
                      <Search size={14} className="absolute left-2.5 top-2 text-slate-400" />
                      <input
                        type="text"
                        placeholder={filter.placeholder || `Search ${filter.label}...`}
                        value={values[filter.key] || ''}
                        onChange={(e) => onChange(filter.key, e.target.value)}
                        className={`${inputClass} pl-8`}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ============ ADVANCED MODE ============ */}
          {mode === 'advanced' && (
            <div className="space-y-3">
              {/* Logic selector */}
              {rules.length > 1 && (
                <div className="flex items-center gap-2 text-xs mb-2">
                  <span className="text-slate-500">Match</span>
                  <CustomSelect
                    value={logic}
                    onChange={(e) => setLogic(e.target.value)}
                    className="px-2 py-1 border border-slate-300 rounded text-xs font-medium focus:ring-1 focus:ring-primary-500"
                  >
                    <option value="AND">ALL rules (AND)</option>
                    <option value="OR">ANY rule (OR)</option>
                  </CustomSelect>
                </div>
              )}

              {/* Rules */}
              {rules.map((rule, idx) => {
                const fieldDef = getFieldDef(rule.field);
                const fieldType = fieldDef.type || 'text';
                const operators = OPERATORS[fieldType] || OPERATORS.text;
                const needsValue = !['is_empty', 'is_not_empty'].includes(rule.operator);
                const needsValue2 = rule.operator === 'between';

                return (
                  <div key={idx} className="flex items-start gap-2 flex-wrap">
                    {/* Connector label */}
                    {idx > 0 && (
                      <div className="flex items-center h-8 px-2">
                        <span className="text-xs font-semibold text-primary-600 uppercase">{logic}</span>
                      </div>
                    )}

                    {/* Field */}
                    <CustomSelect
                      value={rule.field}
                      onChange={(e) => updateRule(idx, 'field', e.target.value)}
                      className="px-2.5 py-1.5 border border-slate-300 rounded-md text-sm min-w-[150px] focus:ring-1 focus:ring-primary-500"
                    >
                      <option value="">Select field...</option>
                      {fieldOptions.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </CustomSelect>

                    {/* Operator */}
                    <CustomSelect
                      value={rule.operator}
                      onChange={(e) => updateRule(idx, 'operator', e.target.value)}
                      className="px-2.5 py-1.5 border border-slate-300 rounded-md text-sm min-w-[150px] focus:ring-1 focus:ring-primary-500"
                    >
                      {operators.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
                    </CustomSelect>

                    {/* Value */}
                    {needsValue && (
                      fieldDef.options ? (
                        <CustomSelect
                          value={rule.value}
                          onChange={(e) => updateRule(idx, 'value', e.target.value)}
                          className="px-2.5 py-1.5 border border-slate-300 rounded-md text-sm min-w-[150px] focus:ring-1 focus:ring-primary-500"
                        >
                          <option value="">Select...</option>
                          {fieldDef.options.map(o => <option key={o.value || o} value={o.value || o}>{o.label || o}</option>)}
                        </CustomSelect>
                      ) : (
                        <input
                          type={fieldType === 'number' ? 'number' : fieldType === 'date' ? 'date' : 'text'}
                          value={rule.value}
                          onChange={(e) => updateRule(idx, 'value', e.target.value)}
                          placeholder="Value..."
                          className="px-2.5 py-1.5 border border-slate-300 rounded-md text-sm min-w-[150px] focus:ring-1 focus:ring-primary-500"
                        />
                      )
                    )}

                    {/* Value2 for "between" */}
                    {needsValue2 && (
                      <>
                        <span className="flex items-center h-8 text-xs text-slate-500">and</span>
                        <input
                          type={fieldType === 'number' ? 'number' : fieldType === 'date' ? 'date' : 'text'}
                          value={rule.value2}
                          onChange={(e) => updateRule(idx, 'value2', e.target.value)}
                          placeholder="Value..."
                          className="px-2.5 py-1.5 border border-slate-300 rounded-md text-sm min-w-[120px] focus:ring-1 focus:ring-primary-500"
                        />
                      </>
                    )}

                    {/* Remove rule */}
                    <button onClick={() => removeRule(idx)} aria-label="Remove rule" title="Remove rule" className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition">
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}

              {/* Add rule + Apply */}
              <div className="flex items-center gap-3 pt-2">
                <button onClick={addRule} className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium">
                  <Plus size={14} /> Add Rule
                </button>
                <div className="flex-1" />
                <button onClick={handleResetAdvanced} className="px-3 py-1.5 text-xs text-slate-600 border border-slate-300 rounded-md hover:bg-slate-50">
                  Clear All
                </button>
                <button onClick={handleApplyAdvanced} className="px-4 py-1.5 text-xs bg-primary-600 text-white rounded-md hover:bg-primary-700 font-medium">
                  Apply Filters
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
