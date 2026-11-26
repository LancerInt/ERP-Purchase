import toast from 'react-hot-toast';
import apiClient from './api.js';

/**
 * Trigger a backend-built .xlsx export, scoped to exactly the rows the user
 * is looking at.
 *
 * List pages load the full dataset client-side and filter it in the browser,
 * so the server (which doesn't see those client-side filters) would otherwise
 * dump every row. We POST the ids of the currently-visible rows and the
 * backend scopes the export to them — so "no filter" exports everything and a
 * filtered list exports just that subset. Keeps the server's richer output
 * (line items, flattened addresses) that the list payload doesn't carry.
 *
 * @param {string} endpoint - e.g. '/api/sales/orders/export/'
 * @param {Array<Object>} rows - the on-screen (filtered) rows; their `id`s scope the export
 * @param {string} fileName - download name without extension
 */
export async function exportServerSide(endpoint, rows, fileName = 'export') {
  const ids = (rows || []).map(r => r?.id).filter(Boolean);
  const res = await apiClient.post(endpoint, { ids }, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Export data to an Excel (.xlsx) file.
 *
 * @param {Array<Object>} data      - Array of row objects
 * @param {Array<Object>} columns   - Column definitions [{key/field, label/header, render?}]
 * @param {string}        fileName  - File name without extension (default: 'export')
 * @param {string}        sheetName - Sheet name (default: 'Sheet1')
 * @param {Object}        [lineConfig] - Optional per-line expansion:
 *   { key: 'parsed_lines',
 *     columns: [{ field, header }, ...] }
 *   When provided, each parent row is repeated once per line, with the line
 *   columns appended. Parent rows with no lines still appear once with empty
 *   line cells.
 */
export default async function exportToExcel(data, columns, fileName = 'export', sheetName = 'Sheet1', lineConfig = null, metaLines = [], boldRow = null) {
  if (!data || data.length === 0) {
    // The only native alert() left in the app — every other message is a
    // toast, and a browser dialog here both looked foreign and blocked the
    // page until dismissed.
    toast.error('Nothing to export — the list is empty.');
    return;
  }

  const cols = columns.map(c => ({
    field: c.field || c.key,
    header: c.header || c.label || c.field || c.key,
  }));

  const lineCols = lineConfig?.columns?.map(c => ({
    field: c.field || c.key,
    header: c.header || c.label || c.field || c.key,
  })) || [];

  // An address-shaped dict has at least one of these keys. We flatten
  // them to a single readable cell ("Line | City | State | Pincode |
  // Country") instead of dumping raw JSON, which is what the master
  // exports used to do and what made the addresses unusable in Excel.
  // The same pipe-separated format round-trips cleanly during import.
  const ADDRESS_KEYS = new Set([
    'line1', 'line2', 'raw_address', 'address',
    'city', 'district', 'state', 'pincode', 'pin', 'zip', 'country',
  ]);
  const isAddressLike = (o) => o && typeof o === 'object' && !Array.isArray(o)
    && Object.keys(o).some(k => ADDRESS_KEYS.has(String(k).toLowerCase()));
  const formatAddress = (o) => {
    const get = (...keys) => {
      for (const k of keys) {
        if (o[k] != null && String(o[k]).trim() !== '') return String(o[k]).trim();
      }
      return '';
    };
    const line1 = [get('line1', 'raw_address', 'address'), get('line2')]
      .filter(Boolean).join(', ');
    const city = get('city', 'district');
    const state = get('state');
    const pincode = get('pincode', 'pin', 'zip');
    const country = get('country') || 'INDIA';
    // Fixed 5-slot format. Empty slots stay empty so the layout is
    // identical for every row — easy to parse back on import.
    return [line1, city, state, pincode, country].join(' | ');
  };

  const formatVal = (val) => {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) {
      // Array of objects → join their po_number / upload_id / so_no etc.
      // If every entry is address-shaped (e.g. shipping_addresses), join
      // each formatted address on a newline so all addresses are visible
      // and editable inside the single cell.
      if (val.length > 0 && typeof val[0] === 'object') {
        if (val.every(isAddressLike)) {
          return val.map(formatAddress).join('\n');
        }
        return val.map(o => o.po_number || o.upload_id || o.so_no || o.name || JSON.stringify(o)).join(', ');
      }
      return val.join(', ');
    }
    if (typeof val === 'object') {
      if (isAddressLike(val)) return formatAddress(val);
      return JSON.stringify(val);
    }
    return val;
  };

  const headers = [...cols.map(c => c.header), ...lineCols.map(c => c.header)];

  const rows = [];
  const boldRowIdx = new Set();   // indices into `rows` that should be bold
  data.forEach(row => {
    const baseCells = cols.map(col => formatVal(row[col.field]));
    const lines = lineConfig ? (row[lineConfig.key] || []) : [];
    const isBold = typeof boldRow === 'function' && boldRow(row);
    if (!lineConfig || lines.length === 0) {
      if (isBold) boldRowIdx.add(rows.length);
      rows.push([...baseCells, ...lineCols.map(() => '')]);
    } else {
      lines.forEach(line => {
        const lineCells = lineCols.map(lc => formatVal(line[lc.field]));
        if (isBold) boldRowIdx.add(rows.length);
        rows.push([...baseCells, ...lineCells]);
      });
    }
  });

  // Optional context banner at the very top (e.g. which company / period /
  // product / customer filter produced this sheet) so a downloaded file is
  // self-explanatory. Each entry is one row in column A; a blank spacer row
  // separates the banner from the table header.
  const banner = (metaLines || []).filter(l => l != null && String(l).trim() !== '');
  const aoa = banner.length
    ? [...banner.map(l => [String(l)]), [], headers, ...rows]
    : [headers, ...rows];
  // Loaded on CLICK, not on page load. xlsx is 420K, and DataTable imported it
  // statically, so all 117 list pages paid for it whether or not anyone ever
  // exported — 36% of the initial bundle. Fetching it here keeps it out of the
  // initial graph.
  //
  // Wrapped because nothing awaits this function: an unhandled rejection would
  // leave the user staring at a button that did nothing. The realistic failure
  // is a chunk that 404s because the app was redeployed mid-session, which is
  // exactly when a silent no-op is most confusing.
  // xlsx-js-style is the styled drop-in for SheetJS (same utils API) — used so
  // the banner, the column-header row, and any flagged parent rows render BOLD.
  let XLSX;
  try {
    XLSX = (await import('xlsx-js-style')).default || (await import('xlsx-js-style'));
  } catch {
    toast.error('Could not load the export module. Refresh the page and try again.');
    return;
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws['!cols'] = headers.map((h, i) => {
    const maxLen = Math.max(
      String(h).length,
      ...rows.map(r => String(r[i] || '').length)
    );
    return { wch: Math.min(Math.max(maxLen + 2, 10), 50) };
  });

  // ── Styling (xlsx-js-style) ──────────────────────────────────────────────
  // Sheet row layout: [banner rows][spacer][header row][data rows].
  const bannerN = banner.length;
  const headerRowR = bannerN ? bannerN + 1 : 0;   // 0-based sheet row of the headers
  const dataStartR = headerRowR + 1;
  const ncols = headers.length;
  const setStyle = (r, c, style) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (!ws[addr]) ws[addr] = { t: 's', v: '' };
    ws[addr].s = { ...(ws[addr].s || {}), ...style };
  };
  // Banner lines: bold.
  for (let r = 0; r < bannerN; r++) setStyle(r, 0, { font: { bold: true } });
  // Column headers: bold on a light fill.
  for (let c = 0; c < ncols; c++) {
    setStyle(headerRowR, c, { font: { bold: true }, fill: { fgColor: { rgb: 'EEF2FF' } } });
  }
  // Flagged parent rows: bold across all columns.
  boldRowIdx.forEach(i => {
    for (let c = 0; c < ncols; c++) setStyle(dataStartR + i, c, { font: { bold: true } });
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${fileName}.xlsx`);
}
