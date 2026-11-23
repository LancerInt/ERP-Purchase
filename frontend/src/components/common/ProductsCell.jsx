/**
 * Compact "Products" cell for purchase list tables.
 *
 * The backend list serializers expose `product_names` (a de-duplicated list of
 * item names across the doc's lines / linked PRs). This shows the first two and
 * "+N more", with the full list on hover.
 */
export default function ProductsCell({ names }) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (list.length === 0) return <span className="text-slate-400">—</span>;
  const shown = list.slice(0, 2).join(', ');
  const extra = list.length - 2;
  return (
    <span title={list.join(', ')} className="text-sm text-slate-700">
      {shown}
      {extra > 0 && <span className="text-slate-400"> +{extra} more</span>}
    </span>
  );
}
