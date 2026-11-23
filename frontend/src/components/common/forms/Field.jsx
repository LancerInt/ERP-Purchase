import { AlertCircle } from 'lucide-react';

/**
 * Field — labelled wrapper that surrounds a form control (Input, Select,
 * Textarea, or a custom child). Owns the visual label, required marker,
 * optional help text, and the error message slot. Keeps all forms
 * visually consistent without each page having to re-implement the
 * label/error layout.
 *
 * The visible label is rendered as a <label> and `htmlFor` is wired up
 * automatically when you pass an `id`. Pass the same `id` to the child
 * control so screen readers associate them.
 */
export default function Field({
  id,
  label,
  required,
  hint,
  error,
  colSpan,
  className = '',
  children,
}) {
  // Static class table so Tailwind's JIT can see every value at build
  // time — interpolating `md:col-span-${n}` won't get picked up.
  const colSpanCls = {
    1: '',
    2: 'col-span-2',
    3: 'col-span-2 lg:col-span-3',
    full: 'col-span-full',
  }[colSpan] || '';

  return (
    <div className={`${colSpanCls} ${className}`}>
      {label && (
        <label
          htmlFor={id}
          className="block text-[13px] font-medium text-slate-700 mb-1.5"
        >
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      {children}
      {/* Error wins over hint — only one of the two ever renders. */}
      {error ? (
        <p className="mt-1.5 flex items-start gap-1 text-[12px] text-red-600">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-[12px] text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}
