import { useState, useEffect } from 'react';
import { Package } from 'lucide-react';
import apiClient from '../../utils/api.js';

const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/**
 * Fetches and renders product lines for a record when expanded.
 * Props:
 *  - apiUrl: string — e.g. `/api/sales/orders/{id}/`
 *  - linesKey: string — key in response containing lines array
 *  - columns: Array of { field, header, render?, align?, bold? }
 */
export default function ExpandableLines({ apiUrl, linesKey, columns }) {
  const [lines, setLines] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient.get(apiUrl)
      .then(res => {
        const data = res.data;
        setLines(data[linesKey] || []);
      })
      .catch(() => setLines([]))
      .finally(() => setLoading(false));
  }, [apiUrl, linesKey]);

  if (loading) {
    return (
      <div className="px-4 py-3 text-xs text-slate-400 italic">
        Loading lines…
      </div>
    );
  }
  if (!lines || lines.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-slate-400 italic">
        No line items.
      </div>
    );
  }

  return (
    // Layout decisions (indent / max-width) are now owned by the parent —
    // DataTable's `<td>` provides slate background for inline mode, while the
    // modal mode wraps this in a centered popup.
    <div>
      <div className="rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gradient-to-r from-slate-50 to-white border-b border-slate-200">
          <Package size={13} className="text-slate-400" />
          <span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">
            Line Items
          </span>
          <span className="text-[11px] text-slate-400">· {lines.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50">
                <th className="px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 w-8">#</th>
                {columns.map(col => (
                  <th
                    key={col.field}
                    className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap ${
                      col.align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((line, idx) => (
                <tr key={line.id || idx} className="hover:bg-blue-50/30 transition-colors">
                  <td className="px-3 py-2 text-slate-400 font-mono text-[11px]">{idx + 1}</td>
                  {columns.map(col => {
                    const value = col.render ? col.render(line[col.field], line) : (line[col.field] ?? '-');
                    const isProduct = col.field === 'product_name';
                    return (
                      <td
                        key={col.field}
                        className={[
                          'px-3 py-2',
                          col.align === 'right' ? 'text-right' : '',
                          col.bold ? 'font-semibold text-slate-800' : 'text-slate-700',
                          isProduct ? 'min-w-[180px] max-w-[280px] truncate' : 'whitespace-nowrap',
                        ].join(' ')}
                        title={isProduct && typeof value === 'string' ? value : undefined}
                      >
                        {value === '' || value === null || value === undefined ? <span className="text-slate-300">-</span> : value}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Predefined column configs for each Sales module
export const SO_LINE_COLUMNS = [
  { field: 'product_name', header: 'Product', bold: true },
  { field: 'product_sku', header: 'SKU' },
  { field: 'quantity_ordered', header: 'Qty', align: 'right', render: (v) => fmtQty(v) },
  { field: 'uom', header: 'UOM' },
  { field: 'unit_price', header: 'Price', align: 'right', render: (v) => fmt(v) },
  { field: 'discount', header: 'Disc.', align: 'right', render: (v) => fmt(v) },
  { field: 'gst', header: 'GST%', align: 'right', render: (v) => v ? `${v}%` : '-' },
  { field: 'line_total', header: 'Total', align: 'right', bold: true, render: (v) => fmt(v) },
  { field: 'pending_qty', header: 'Pending', align: 'right', render: (v) => <span className="text-orange-600">{fmtQty(v)}</span> },
];

export const DC_LINE_COLUMNS = [
  { field: 'product_name', header: 'Product', bold: true },
  { field: 'product_sku', header: 'SKU' },
  { field: 'quantity_dispatched', header: 'Dispatched', align: 'right', render: (v) => fmtQty(v) },
  { field: 'uom', header: 'UOM' },
  { field: 'pending_qty', header: 'Pending', align: 'right', render: (v) => <span className="text-orange-600">{fmtQty(v)}</span> },
  { field: 'batch', header: 'Batch' },
  { field: 'noa', header: 'NOA', align: 'right' },
];

export const CPO_LINE_COLUMNS = [
  { field: 'product_name', header: 'Product', bold: true },
  { field: 'product_sku', header: 'SKU' },
  { field: 'hsn_code', header: 'HSN' },
  { field: 'quantity', header: 'Qty', align: 'right', render: (v) => fmtQty(v) },
  { field: 'uom', header: 'UOM' },
  { field: 'price', header: 'Rate', align: 'right', render: (v) => fmt(v) },
  { field: 'discount', header: 'Disc.', align: 'right', render: (v) => fmt(v) },
  { field: 'sgst_percent', header: 'SGST%', align: 'right', render: (v) => v > 0 ? `${v}%` : '-' },
  { field: 'cgst_percent', header: 'CGST%', align: 'right', render: (v) => v > 0 ? `${v}%` : '-' },
  { field: 'line_total', header: 'Total', align: 'right', bold: true, render: (v) => fmt(v) },
];

// Plain configs (no render fn) for one-line-per-row Excel exports.
export const CPO_EXPORT_LINES = {
  key: 'parsed_lines',
  columns: [
    { field: 'product_name', header: 'Product' },
    { field: 'product_sku', header: 'SKU' },
    { field: 'hsn_code', header: 'HSN' },
    { field: 'quantity', header: 'Qty' },
    { field: 'uom', header: 'UOM' },
    { field: 'price', header: 'Rate' },
    { field: 'discount', header: 'Discount' },
    { field: 'sgst_percent', header: 'SGST %' },
    { field: 'cgst_percent', header: 'CGST %' },
    { field: 'igst_percent', header: 'IGST %' },
    { field: 'line_total', header: 'Line Total' },
  ],
};

export const SO_EXPORT_LINES = {
  key: 'so_lines',
  columns: [
    { field: 'product_name', header: 'Product' },
    { field: 'product_sku', header: 'SKU' },
    { field: 'quantity_ordered', header: 'Qty Ordered' },
    { field: 'uom', header: 'UOM' },
    { field: 'unit_price', header: 'Unit Price' },
    { field: 'discount', header: 'Discount' },
    { field: 'gst', header: 'GST %' },
    { field: 'line_total', header: 'Line Total' },
    { field: 'pending_qty', header: 'Pending Qty' },
  ],
};

export const DC_EXPORT_LINES = {
  key: 'dc_lines',
  columns: [
    { field: 'product_name', header: 'Product' },
    { field: 'product_sku', header: 'SKU' },
    { field: 'quantity_dispatched', header: 'Qty Dispatched' },
    { field: 'uom', header: 'UOM' },
    { field: 'batch', header: 'Batch' },
    { field: 'noa', header: 'NOA' },
    { field: 'weight', header: 'Weight' },
    { field: 'pending_qty', header: 'Pending Qty' },
  ],
};

export const INVOICE_EXPORT_LINES = {
  key: 'invoice_lines',
  columns: [
    { field: 'sl_no', header: 'Sl No' },
    { field: 'product_name', header: 'Product' },
    { field: 'description', header: 'Description' },
    { field: 'hsn_sac', header: 'HSN/SAC' },
    { field: 'quantity', header: 'Qty' },
    { field: 'uom', header: 'UOM' },
    { field: 'rate', header: 'Rate' },
    { field: 'discount_percent', header: 'Discount %' },
    { field: 'amount', header: 'Amount' },
    { field: 'gst_rate', header: 'GST %' },
    { field: 'cgst_amount', header: 'CGST Amt' },
    { field: 'sgst_amount', header: 'SGST Amt' },
    { field: 'igst_amount', header: 'IGST Amt' },
  ],
};
