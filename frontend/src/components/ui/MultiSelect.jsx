/**
 * MultiSelect — a compact checkbox dropdown for choosing SEVERAL values, styled
 * to line up with CustomSelect in a filter row. CustomSelect is single-value
 * only; this is its multi-value sibling.
 *
 *   <MultiSelect
 *     options={[{ value: 'RM', label: 'Raw Material' }, …]}
 *     value={['RM','PACKING']}            // array of selected values
 *     onChange={(arr) => setPick(arr)}    // called with the next array
 *     placeholder="All Categories"        // shown when nothing is picked
 *   />
 *
 * The trigger reads "All Categories" (none), the single label (one), or
 * "N selected" (many). Clicking outside closes it.
 */
import { useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { CTRL_H } from '@/components/common/controls';

export default function MultiSelect({
  options = [],
  value = [],
  onChange,
  placeholder = 'All',
  title,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const toggle = (v) =>
    onChange?.(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  const label =
    value.length === 0 ? placeholder
      : value.length === 1 ? (options.find((o) => o.value === value[0])?.label || '1 selected')
        : `${value.length} selected`;

  return (
    <div className={`relative ${className}`}>
      <button
        type="button" title={title}
        aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex w-full items-center justify-between gap-1.5 rounded-lg border bg-white px-2 text-xs ${CTRL_H} ${
          value.length ? 'border-primary-300 text-primary-700' : 'border-slate-300 text-slate-700'
        } hover:bg-slate-50`}>
        <span className="truncate">{label}</span>
        <ChevronDown size={13} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          {/* Click-away catcher, behind the menu. */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute z-30 mt-1 min-w-[180px] max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg py-1" role="listbox">
            {options.map((o) => {
              const on = value.includes(o.value);
              return (
                <button
                  type="button" key={o.value} role="option" aria-selected={on}
                  onClick={() => toggle(o.value)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    on ? 'bg-primary-600 border-primary-600 text-white' : 'border-slate-300'
                  }`}>
                    {on && <Check size={11} />}
                  </span>
                  <span className="truncate">{o.label}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
