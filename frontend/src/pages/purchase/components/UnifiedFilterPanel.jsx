import CustomSelect from "@/components/ui/CustomSelect";
import { FilterMultiSelect } from "@/components/common/FilterPanel";
import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Filter, Plus, Trash2, RotateCcw, ChevronUp, ChevronDown, X } from 'lucide-react';

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
  date: [
    { value: 'equals', label: 'Is equal to' },
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

const emptyRule = { field: '', operator: 'contains', value: '', value2: '' };

function applyRule(rule, rowValue, fieldType = 'text') {
  const { operator, value, value2 } = rule;
  const isDate = fieldType === 'date';
  // Date fields compare by calendar day. Some sources are plain DateFields
  // ('2026-06-15'), others DateTimeFields ('2026-06-15T10:30:00Z'); strip any
  // time component so 'equals' matches the day and the 'between' end day stays
  // inclusive (otherwise '...T10:30Z' > '2026-06-15' silently drops the day).
  const norm = (s) => {
    const x = s != null ? String(s).toLowerCase() : '';
    return isDate ? x.slice(0, 10) : x;
  };
  const rv = norm(rowValue);
  // Multi-value select rule: `value` is an array of picked options — match ANY
  // (equals) or NONE (not_equals). Empty selection ⇒ rule inactive (matches all).
  if (Array.isArray(value)) {
    const vals = value.map(norm).filter((v) => v !== '');
    if (!vals.length) return true;
    return operator === 'not_equals' ? !vals.includes(rv) : vals.includes(rv);
  }
  const fv = norm(value);
  const v2 = norm(value2);
  switch (operator) {
    case 'contains': return rv.includes(fv);
    case 'not_contains': return !rv.includes(fv);
    case 'equals': return rv === fv;
    case 'not_equals': return rv !== fv;
    case 'starts_with': return rv.startsWith(fv);
    case 'ends_with': return rv.endsWith(fv);
    // A real boolean false (e.g. has_po=false) is a present value, not
    // "empty" — only treat genuinely missing/blank values as empty.
    case 'is_empty': return typeof rowValue === 'boolean' ? false : (!rowValue || rv === '' || rv === '-');
    case 'is_not_empty': return typeof rowValue === 'boolean' ? true : !!(rowValue && rv !== '' && rv !== '-');
    case 'gt': return rv > fv;
    case 'lt': return rv < fv;
    case 'between': return rv >= fv && rv <= v2;
    default: return true;
  }
}

function applyFilters(data, rules, logic, filterFields = []) {
  const active = rules.filter(r => r.field && r.operator);
  if (!active.length) return data;
  const typeOf = (field) => filterFields.find(f => f.value === field)?.type || 'text';
  return data.filter(row => {
    const results = active.map(rule => applyRule(rule, row[rule.field], typeOf(rule.field)));
    return logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
  });
}

export function useUnifiedFilter(filterFields, urlKey = 'uf') {
  const [sp, setSp] = useSearchParams();
  // Seed the rule set from the URL once (so Back / refresh / sharing restore the
  // advanced filter), then keep it in the URL as it changes. urlKey namespaces
  // it in case a page mounts more than one unified filter.
  const seed = (() => {
    const raw = sp.get(urlKey);
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (p && Array.isArray(p.rules) && p.rules.length) {
          return { rules: p.rules, logic: p.logic === 'OR' ? 'OR' : 'AND' };
        }
      } catch { /* malformed param — fall back to a blank rule */ }
    }
    return { rules: [{ ...emptyRule }], logic: 'AND' };
  });
  const [rules, setRules] = useState(() => seed().rules);
  const [logic, setLogic] = useState(() => seed().logic);
  const [isExpanded, setIsExpanded] = useState(true);

  // Mirror the active rule set to the URL (replace — a filter edit is not a new
  // history entry). Cleared / all-blank rules remove the param so the URL stays
  // clean and Back still lands on an unfiltered list.
  useEffect(() => {
    const active = rules.some(r => r.field && (
      (Array.isArray(r.value) ? r.value.length : r.value) || ['is_empty', 'is_not_empty'].includes(r.operator)
    ));
    setSp((prev) => {
      const p = new URLSearchParams(prev);
      if (active) p.set(urlKey, JSON.stringify({ rules, logic }));
      else p.delete(urlKey);
      return p;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules, logic, urlKey]);

  const updateRule = useCallback((idx, key, val) => {
    setRules(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      const updated = { ...r, [key]: val };
      if (key === 'field') {
        const fDef = filterFields.find(f => f.value === val);
        const type = fDef?.type || 'text';
        updated.operator = OPERATORS[type]?.[0]?.value || 'contains';
        updated.value = '';
        updated.value2 = '';
      }
      return updated;
    }));
  }, [filterFields]);

  const addRule = useCallback(() => setRules(prev => [...prev, { ...emptyRule }]), []);
  const removeRule = useCallback((idx) => {
    setRules(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : [{ ...emptyRule }]);
  }, []);
  const resetFilters = useCallback(() => { setRules([{ ...emptyRule }]); setLogic('AND'); }, []);

  const filterData = useCallback((data) => applyFilters(data, rules, logic, filterFields), [rules, logic, filterFields]);

  return { rules, logic, setLogic, isExpanded, setIsExpanded, updateRule, addRule, removeRule, resetFilters, filterData };
}

export default function UnifiedFilterPanel({ filterFields, filter, showFilters, onClose }) {
  const { rules, logic, setLogic, isExpanded, setIsExpanded, updateRule, addRule, removeRule, resetFilters } = filter;

  const getFieldDef = useCallback((key) => filterFields.find(f => f.value === key) || { type: 'text' }, [filterFields]);

  const activeRuleCount = rules.filter(r => r.field && r.operator && ((Array.isArray(r.value) ? r.value.length : r.value) || ['is_empty', 'is_not_empty'].includes(r.operator))).length;

  if (!showFilters) return null;

  return (
    <div className="bg-white border border-slate-200 rounded-lg mb-4 shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <Filter size={16} className="text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-700">Filters</h3>
          {activeRuleCount > 0 && (
            <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full font-medium">
              {activeRuleCount} rule{activeRuleCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={resetFilters} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
            <RotateCcw size={12} /> Reset
          </button>
          <button onClick={() => setIsExpanded(!isExpanded)} aria-label={isExpanded ? 'Collapse filters' : 'Expand filters'} title={isExpanded ? 'Collapse filters' : 'Expand filters'} className="text-slate-400 hover:text-slate-600">
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          <button onClick={onClose} aria-label="Close" title="Close" className="text-slate-400 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="p-3 sm:p-4 space-y-2 sm:space-y-3">
          {rules.length > 1 && (
            <div className="flex items-center gap-2 text-xs mb-2">
              <span className="text-slate-500">Match</span>
              <CustomSelect value={logic} onChange={(e) => setLogic(e.target.value)} className="px-2 py-1 border border-slate-300 rounded text-xs font-medium focus:ring-1 focus:ring-primary-500">
                <option value="AND">ALL rules (AND)</option>
                <option value="OR">ANY rule (OR)</option>
              </CustomSelect>
            </div>
          )}

          {rules.map((rule, idx) => {
            const fieldDef = getFieldDef(rule.field);
            const fieldType = fieldDef.type || 'text';
            const operators = OPERATORS[fieldType] || OPERATORS.text;
            const needsValue = !['is_empty', 'is_not_empty'].includes(rule.operator);
            const needsValue2 = rule.operator === 'between';

            return (
              // On phones the rule row wraps onto two lines (field +
              // operator on the first, value + delete on the second)
              // so the inputs stay tappable instead of being squeezed
              // into a single overflowing strip.
              <div key={idx} className="flex flex-wrap items-center gap-2">
                {idx > 0 && (
                  <span className="text-xs font-semibold text-primary-600 uppercase w-10 text-center flex-shrink-0">{logic}</span>
                )}
                <CustomSelect value={rule.field} onChange={(e) => updateRule(idx, 'field', e.target.value)} className="px-2.5 py-1.5 border border-slate-300 rounded-md text-sm flex-1 min-w-[140px] focus:ring-1 focus:ring-primary-500">
                  <option value="">Select field...</option>
                  {filterFields.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </CustomSelect>
                <CustomSelect value={rule.operator} onChange={(e) => updateRule(idx, 'operator', e.target.value)} className="px-2.5 py-1.5 border border-slate-300 rounded-md text-sm flex-1 min-w-[120px] focus:ring-1 focus:ring-primary-500">
                  {operators.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
                </CustomSelect>
                {needsValue && (
                  fieldDef.options ? (
                    // Multi-select value: one "Is / Is not" rule can now match
                    // several options at once (match ANY) instead of needing a
                    // separate OR rule per value.
                    <div className="flex-1 min-w-[140px]">
                      <FilterMultiSelect
                        options={fieldDef.options}
                        value={rule.value}
                        onChange={(arr) => updateRule(idx, 'value', arr)}
                        className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-1 focus:ring-primary-500"
                      />
                    </div>
                  ) : (
                    <input type={fieldType === 'date' ? 'date' : 'text'} value={rule.value} onChange={(e) => updateRule(idx, 'value', e.target.value)} placeholder="Value..." className="px-2.5 py-1.5 border border-slate-300 rounded-md text-sm flex-1 min-w-[140px] focus:ring-1 focus:ring-primary-500" />
                  )
                )}
                {needsValue2 && (
                  <>
                    <span className="text-xs text-slate-500 flex-shrink-0">and</span>
                    <input type={fieldType === 'date' ? 'date' : 'text'} value={rule.value2} onChange={(e) => updateRule(idx, 'value2', e.target.value)} placeholder="Value..." className="px-2.5 py-1.5 border border-slate-300 rounded-md text-sm flex-1 min-w-[140px] focus:ring-1 focus:ring-primary-500" />
                  </>
                )}
                <button onClick={() => removeRule(idx)} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition flex-shrink-0">
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}

          <div className="flex items-center gap-3 pt-2">
            <button onClick={addRule} className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium">
              <Plus size={14} /> Add Rule
            </button>
            <div className="flex-1" />
            <button onClick={resetFilters} className="px-3 py-1.5 text-xs text-slate-600 border border-slate-300 rounded-md hover:bg-slate-50">
              Clear All
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
