import CustomSelect from "@/components/ui/CustomSelect";
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronsUpDown,
  ChevronUp,
  ChevronDown,
  Search,
  Upload,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Inbox,
  Printer,
} from 'lucide-react';
import exportToExcel from '../../utils/exportExcel.js';
import usePagerKeys from '../../hooks/usePagerKeys.js';
import Modal from '../ui/Modal';
import { CTRL_FIELD, CTRL_GHOST, CTRL_EXPORT, CTRL_PRIMARY } from './controls';

// Compare two non-empty cell values for the table's own sorting. Numbers
// compare numerically so 9 sorts before 10 rather than after it (DRF sends
// decimals as strings, so "1625.00" arrives as text); date-like strings
// compare as instants, which covers both ISO timestamps (created_at) and
// plain 'YYYY-MM-DD' columns; everything else falls back to a natural-order
// string compare.
function compareCells(a, b) {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return a === b ? 0 : (a ? -1 : 1);
  }
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  const ad = Date.parse(a);
  const bd = Date.parse(b);
  if (Number.isFinite(ad) && Number.isFinite(bd)) return ad - bd;
  return String(a).localeCompare(String(b), undefined,
    { numeric: true, sensitivity: 'base' });
}

export default function DataTable({
  columns = [],
  data = [],
  isLoading = false,
  page = 1,
  pageSize = 10,
  totalRecords = 0,
  onPageChange = () => {},
  // null (not a no-op) so the table can tell whether the CALLER is sorting.
  // Pass a handler to sort server-side / in the page; omit it and the table
  // sorts its own rows. See the sorting block below.
  onSort = null,
  sortBy = null,
  sortOrder = 'asc',
  onRowClick = null,
  onSearch = () => {},
  searchPlaceholder = 'Search...',
  showSearch = true,
  filters = [],
  onFilterChange = () => {},
  onExport = null,
  exportFileName = 'export',
  exportLineConfig = null,
  // Permission gate for the Export button. Defaults to true so callers
  // who don't pass it (older usages, modules without an Export perm in
  // the RBAC system) keep the old behavior. Pass `canExport={canExport('Sales Order')}`
  // (from usePermissions) to honor role-based Export permission.
  canExport = true,
  showBulkSelect = false,
  onBulkSelect = () => {},
  selectedRows = [],
  emptyMessage = 'No data found',
  emptyIcon = null,    // optional lucide icon component for the empty state
  emptyHint = '',      // optional subtext under the empty message
  emptyAction = null,  // optional node (e.g. a "Create" button) for the empty state
  expandableContent = null, // (row) => JSX — renders expandable sub-content
  expandAsModal = false, // when true, the chevron opens a centered modal instead of expanding inline
  expandModalTitle = null, // optional (row) => string — title for the modal header
  extraSearchFields = [], // additional row fields to include in built-in search (e.g. ['product_names'])
  // When set, the search term and current page are kept in the URL query string
  // (?q=&page=) instead of local state, so opening a record and coming back
  // (browser back / navigate(-1)) restores the list on the same page with the
  // same search still applied. Opt-in — omit it and the table behaves exactly as
  // before, so other lists and server-paginated tables are unaffected.
  persistKey = null,
  // Tighter cell padding for wide tables that would otherwise force a
  // horizontal scroll. Opt-in; default keeps the roomy spacing.
  dense = false,
  // Optional node rendered in the pagination row, just before the page arrows
  // (e.g. a colour legend for the table). Hidden on phones to keep that row
  // from wrapping.
  footerExtra = null,
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const persist = !!persistKey;
  // One padding token for header / body / footer cells, so a dense table stays
  // internally consistent. The `fine:` variant tightens further on a mouse.
  // py-2.5 (not py-3) matches the Purchase Analytics "Vendor details" table,
  // the reference density adopted app-wide — same text-sm font + 11px uppercase
  // headers, slightly tighter rows so lists read as one consistent design.
  const cellPad = dense ? 'px-2 py-2 fine:px-1.5' : 'px-4 py-2.5 fine:px-3 fine:py-2';
  // A dense table also drops the body/footer font a notch, so more rows read at
  // a glance without changing any of the ~115 non-dense lists.
  const cellText = dense ? 'text-[13px]' : 'text-sm';

  const [searchTermState, setSearchTermState] = useState('');
  const [currentPageState, setCurrentPageState] = useState(page);
  const [expandedRows, setExpandedRows] = useState([]);
  const [modalRow, setModalRow] = useState(null);
  const [appliedFilters, setAppliedFilters] = useState({});

  // Effective search/page: read from the URL in persist mode, else local state.
  const searchTerm = persist ? (searchParams.get('q') || '') : searchTermState;
  const currentPage = persist
    ? Math.max(1, parseInt(searchParams.get('page'), 10) || 1)
    : currentPageState;

  // The visible search box is driven by its own URGENT state. In persist
  // mode the URL (?q=) is the source of truth for filtering, but
  // useSearchParams updates ride a router navigation (wrapped in
  // startTransition), so a controlled input bound directly to it gets
  // its value re-applied a tick late — deleting a character mid-word
  // threw the caret to the end. The box renders from `searchInput`
  // synchronously; the URL / state update follows, and the table keeps
  // filtering off `searchTerm` as before.
  const [searchInput, setSearchInput] = useState(searchTerm);
  const searchBoxRef = useRef(null);
  useEffect(() => {
    // Adopt external changes (back/forward nav, programmatic clear) —
    // but never while the user is typing in the box: the URL lags the
    // keystrokes, and syncing mid-type would clobber the text and
    // recreate the exact caret jump this state exists to prevent.
    if (document.activeElement !== searchBoxRef.current) {
      setSearchInput(searchTerm);
    }
  }, [searchTerm]);

  const setSearchTerm = (val) => {
    if (!persist) { setSearchTermState(val); return; }
    const next = new URLSearchParams(searchParams);
    if (val) next.set('q', val); else next.delete('q');
    next.delete('page'); // a new search always starts on page 1
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  };

  const setCurrentPage = (val) => {
    if (!persist) { setCurrentPageState(val); return; }
    const next = new URLSearchParams(searchParams);
    if (val > 1) next.set('page', String(val)); else next.delete('page');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  };

  // Normalize columns: support both {key, label} and {field, header} formats
  const normalizedColumns = useMemo(() =>
    columns.map(col => ({
      ...col,
      field: col.field || col.key,
      header: col.header || col.label,
    })),
    [columns]
  );

  const handleSearch = (value) => {
    setSearchInput(value);
    setSearchTerm(value);
    onSearch(value);
  };

  // ── Sorting ───────────────────────────────────────────────────────────
  // CONTROLLED when the caller passes onSort: it reorders `data` itself and
  // tells us which header to mark, exactly as before.
  //
  // UNCONTROLLED otherwise: the table sorts its own rows. It has to, because
  // a header is rendered clickable for every column that isn't explicitly
  // `sortable: false`, and onSort used to default to a no-op — so a list that
  // declared sortable columns but passed no handler got arrows that did
  // nothing at all. That was 69 of the app's 97 lists, Vendor Bills among
  // them: clicking "Entry Date" called the no-op and the order never changed.
  const controlledSort = typeof onSort === 'function';

  const [innerSortState, setInnerSortState] = useState({ by: null, order: 'asc' });
  // In persist mode the sort rides the URL beside ?q= and ?page=, so opening a
  // row and coming back restores the ordering too — not just the page. The
  // ?sort=/?dir= spelling matches what the hand-rolled sorted lists (Sales
  // Invoices, DCs, SOs) already put in their URLs; those pass onSort, so they
  // take the controlled path and never reach this.
  const innerSort = persist
    ? {
        by: searchParams.get('sort') || null,
        order: searchParams.get('dir') === 'desc' ? 'desc' : 'asc',
      }
    : innerSortState;

  const activeSortBy = controlledSort ? sortBy : innerSort.by;
  const activeSortOrder = controlledSort ? sortOrder : innerSort.order;

  const handleSort = (field) => {
    const newOrder =
      activeSortBy === field && activeSortOrder === 'asc' ? 'desc' : 'asc';
    if (controlledSort) {
      onSort(field, newOrder);
      return;
    }
    // A new ordering always starts at the top — staying on page 7 of a list
    // that just changed order shows rows nobody asked to see.
    if (!persist) {
      setInnerSortState({ by: field, order: newOrder });
      setCurrentPageState(1);
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('sort', field);
    if (newOrder === 'desc') next.set('dir', 'desc'); else next.delete('dir');
    next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const handleFilterChange = (filterKey, value) => {
    const newFilters = { ...appliedFilters, [filterKey]: value };
    setAppliedFilters(newFilters);
    onFilterChange(newFilters);
  };

  const handleSelectAll = (checked) => {
    if (checked) {
      onBulkSelect(filteredData.map((row) => row.id));
    } else {
      onBulkSelect([]);
    }
  };

  const handleSelectRow = (rowId, checked) => {
    if (checked) {
      onBulkSelect([...selectedRows, rowId]);
    } else {
      onBulkSelect(selectedRows.filter((id) => id !== rowId));
    }
  };

  // Built-in client-side search: filter data by searchTerm across all visible columns + extra fields
  const filteredData = useMemo(() => {
    if (!searchTerm.trim()) return data;
    const term = searchTerm.toLowerCase();
    const checkVal = (val) => {
      if (val === null || val === undefined) return false;
      if (Array.isArray(val)) return val.some(v => String(v).toLowerCase().includes(term));
      return String(val).toLowerCase().includes(term);
    };
    return data.filter(row =>
      normalizedColumns.some(col => checkVal(row[col.field])) ||
      extraSearchFields.some(f => checkVal(row[f]))
    );
  }, [data, searchTerm, normalizedColumns, extraSearchFields]);

  // Apply the table's own sort. Controlled callers already handed us ordered
  // rows, so this is a pass-through for them. Blank cells sink to the bottom
  // in BOTH directions (handled before the asc/desc flip) — a screenful of
  // "-" is never what someone clicking a header is looking for.
  const sortedData = useMemo(() => {
    if (controlledSort || !activeSortBy) return filteredData;
    const dir = activeSortOrder === 'desc' ? -1 : 1;
    return [...filteredData].sort((a, b) => {
      const av = a[activeSortBy];
      const bv = b[activeSortBy];
      const aEmpty = av === null || av === undefined || av === '';
      const bEmpty = bv === null || bv === undefined || bv === '';
      if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : (aEmpty ? 1 : -1);
      return dir * compareCells(av, bv);
    });
  }, [filteredData, controlledSort, activeSortBy, activeSortOrder]);

  // Sync internal page with the controlled `page` prop (server-paginated
  // callers). In persist mode the page comes from the URL, so leave it be.
  useEffect(() => { if (!persist) setCurrentPageState(page); }, [page, persist]);

  // Reset to page 1 when the user changes the search, or when the data-set
  // genuinely changes AFTER it has loaded (e.g. a filter). Crucially, do NOT reset
  // on the initial async 0→N fill — otherwise coming back to the list (which
  // re-fetches) would wipe the page restored from the URL and dump you on page 1.
  const skipPageReset = useRef(true);
  const prevSearch = useRef(searchTerm);
  const prevLen = useRef(data.length);
  useEffect(() => {
    const searchChanged = prevSearch.current !== searchTerm;
    const lenChanged = prevLen.current !== data.length;
    const wasEmpty = prevLen.current === 0;   // data was still loading in
    prevSearch.current = searchTerm;
    prevLen.current = data.length;
    if (skipPageReset.current) { skipPageReset.current = false; return; }
    // Persist mode: the page is in the URL and a new search already clears it
    // (setSearchTerm deletes ?page). Never auto-reset from data changes here —
    // otherwise re-fetching on back-navigation (0→N rows, possibly in steps)
    // would wipe the page and dump you on page 1. safePage clamps display if the
    // stored page is out of range.
    if (persist) return;
    if (searchChanged || (lenChanged && !wasEmpty)) setCurrentPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, data.length]);

  const effectiveTotalRecords = totalRecords || filteredData.length;
  const totalPages = Math.max(1, Math.ceil(effectiveTotalRecords / pageSize));

  // Clamp page if it exceeds total
  const safePage = Math.min(currentPage, totalPages);

  // Slice data for current page (client-side pagination)
  const paginatedData = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, safePage, pageSize]);

  const handlePageChange = (newPage) => {
    if (newPage < 1 || newPage > totalPages) return;
    setCurrentPage(newPage);
    onPageChange(newPage);
  };

  // ← / → page the list without reaching for the on-screen arrows. Disabled
  // on single-page lists so arrow-scrolling still behaves normally there.
  usePagerKeys({
    enabled: totalPages > 1,
    onPrev: () => handlePageChange(safePage - 1),
    onNext: () => handlePageChange(safePage + 1),
  });

  // Shared empty-state content (icon + message + optional hint/CTA), used by
  // both the desktop table and the mobile card list.
  const EmptyIcon = emptyIcon || Inbox;
  const emptyContent = (
    <div className="flex flex-col items-center justify-center gap-2 py-2">
      <div className="h-12 w-12 rounded-full bg-slate-100 flex items-center justify-center">
        <EmptyIcon size={22} className="text-slate-400" />
      </div>
      <p className="text-sm font-medium text-slate-600">{emptyMessage}</p>
      {emptyHint && <p className="text-xs text-slate-400 max-w-xs">{emptyHint}</p>}
      {emptyAction && <div className="mt-1">{emptyAction}</div>}
    </div>
  );

  // Loading skeleton — shaped like the real table (blue header + staggered
  // row shimmer) so the page doesn't visibly re-lay-out when data lands.
  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <div className="h-10 w-64 bg-slate-200 rounded-lg animate-pulse" />
          {onExport && <div className="h-10 w-24 bg-slate-200 rounded-lg animate-pulse" />}
        </div>
        <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <div className="h-10 bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-primary-100" />
          <div className="divide-y divide-slate-100">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-11 bg-white flex items-center px-4 gap-4">
                <div className="h-3 flex-1 max-w-[32%] rounded bg-slate-100 animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
                <div className="h-3 w-20 rounded bg-slate-100 animate-pulse" style={{ animationDelay: `${i * 80 + 40}ms` }} />
                <div className="h-3 w-16 rounded bg-slate-100 animate-pulse" style={{ animationDelay: `${i * 80 + 80}ms` }} />
                <div className="h-3 w-24 rounded bg-slate-100 animate-pulse ml-auto" style={{ animationDelay: `${i * 80 + 120}ms` }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="space-y-2">
        {/* Search + Export + Print — share one row at every width. Hidden on
            print so the printout shows just the table, not the controls. */}
        {(showSearch || filteredData.length > 0) && (
          <div className="flex items-center gap-2 print:hidden">
            {showSearch && (
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                <input
                  ref={searchBoxRef}
                  type="search"
                  placeholder={searchPlaceholder}
                  value={searchInput}
                  onChange={(e) => handleSearch(e.target.value)}
                  className={`w-full pl-9 pr-3 ${CTRL_FIELD} focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500`}
                />
              </div>
            )}

            {/* Export button — only when (a) there's data, AND (b) caller
                has granted Export permission via the canExport prop.
                When the caller passes `onExport`, prefer it over the
                client-side stringify — backend exports can include line/
                subform rows the list payload doesn't carry, and emit
                human-readable FK + JSONField values. */}
            {canExport && filteredData.length > 0 && (
              <button
                onClick={() => onExport
                  ? onExport(sortedData)
                  : exportToExcel(sortedData, normalizedColumns, exportFileName, 'Sheet1', exportLineConfig)
                }
                className={`${CTRL_EXPORT} flex-shrink-0`}
              >
                <Upload size={16} />
                Export
              </button>
            )}
            {filteredData.length > 0 && (
              <button
                onClick={() => window.print()}
                title="Print this list"
                className={`${CTRL_PRIMARY} flex-shrink-0`}
              >
                <Printer size={16} />
                <span className="hidden sm:inline">Print</span>
              </button>
            )}
          </div>
        )}

        {filters.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {filters.map((filter) => (
              <CustomSelect
                key={filter.key}
                // In persist mode the URL is the source of truth, so the control
                // reflects ?<key>= after Back / refresh (page writes it via
                // onFilterChange). Non-persist tables keep internal state.
                value={persist ? (searchParams.get(filter.key) || '') : (appliedFilters[filter.key] || '')}
                onChange={(e) => handleFilterChange(filter.key, e.target.value)}
                className={`${CTRL_FIELD} focus:outline-none focus:ring-2 focus:ring-primary-500`}
              >
                <option value="">{filter.label}</option>
                {filter.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </CustomSelect>
            ))}
          </div>
        )}
      </div>

      {/* Table — desktop (sm+) only; phones get the card list below so the
          800px-min table never forces horizontal scrolling. Pages that ship
          their own <MobileListCards> wrap this whole DataTable in `hidden
          sm:block`, so this mobile list stays hidden there (no double view). */}
      <div className="hidden sm:block overflow-x-auto border border-slate-200 rounded-xl shadow-sm">
        <table className="w-full min-w-[800px]">
          {/* Header — subtle blue tint (app-wide) so tables read less plain */}
          <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-primary-100">
            <tr>
              {expandableContent && <th className="px-2 py-3 fine:py-2 w-8"></th>}
              {showBulkSelect && (
                <th className="px-4 sm:px-5 py-3 fine:px-4 fine:py-2 w-12">
                  <input
                    type="checkbox"
                    checked={
                      paginatedData.length > 0 &&
                      selectedRows.length === paginatedData.length
                    }
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    className="rounded"
                  />
                </th>
              )}
              {normalizedColumns.map((col) => (
                <th
                  key={col.field}
                  className={`${cellPad} text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap`}
                  style={{ width: col.width }}
                >
                  {col.sortable !== false ? (
                    <button
                      onClick={() => handleSort(col.field)}
                      aria-label={`Sort by ${col.header}${activeSortBy === col.field ? (activeSortOrder === 'asc' ? ', ascending' : ', descending') : ''}`}
                      className="flex items-center gap-1 hover:text-slate-900 transition rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    >
                      {col.header}
                      {activeSortBy === col.field ? (
                        activeSortOrder === 'asc' ? (
                          <ChevronUp size={16} />
                        ) : (
                          <ChevronDown size={16} />
                        )
                      ) : (
                        <ChevronsUpDown size={16} className="text-slate-400" />
                      )}
                    </button>
                  ) : (
                    <span className="cursor-default select-none">{col.header}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>

          {/* Body */}
          <tbody className="divide-y divide-slate-100">
            {paginatedData.length === 0 ? (
              <tr>
                <td
                  colSpan={normalizedColumns.length + (showBulkSelect ? 1 : 0) + (expandableContent ? 1 : 0)}
                  className="px-4 sm:px-5 py-12 text-center text-slate-500"
                >
                  {searchTerm ? (
                    <>
                      <p className="text-sm">No results for &quot;{searchTerm}&quot;</p>
                      <button
                        onClick={() => handleSearch('')}
                        className="mt-2 text-xs font-medium text-primary-600 hover:underline"
                      >
                        Clear search
                      </button>
                    </>
                  ) : (
                    emptyContent
                  )}
                </td>
              </tr>
            ) : (
              paginatedData.map((row) => {
                const isExpanded = expandedRows.includes(row.id);
                return (
                  <React.Fragment key={row.id}>
                    <tr
                      onClick={() => { if (window.getSelection()?.toString()) return; onRowClick && onRowClick(row); }}
                      className={`transition-colors duration-150 odd:bg-white even:bg-slate-100/70 ${
                        onRowClick ? 'cursor-pointer hover:bg-primary-50' : 'hover:bg-primary-50/40'
                      } ${isExpanded ? 'bg-primary-50/50' : ''}`}
                    >
                      {expandableContent && (
                        <td className="px-2 py-3 fine:py-2 w-8">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              if (expandAsModal) {
                                setModalRow(row);
                              } else {
                                setExpandedRows(prev => prev.includes(row.id) ? prev.filter(id => id !== row.id) : [...prev, row.id]);
                              }
                            }}
                            className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                            aria-label={expandAsModal ? 'View line items' : 'Expand row'}
                            title={expandAsModal ? 'View line items' : 'Expand'}
                          >
                            {expandAsModal
                              ? <Maximize2 size={14} />
                              : <ChevronDown size={16} className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />}
                          </button>
                        </td>
                      )}
                      {showBulkSelect && (
                        <td className="px-4 py-3 fine:px-3 fine:py-2 w-12">
                          <input type="checkbox" checked={selectedRows.includes(row.id)}
                            onChange={(e) => handleSelectRow(row.id, e.target.checked)}
                            onClick={(e) => e.stopPropagation()} className="rounded" />
                        </td>
                      )}
                      {normalizedColumns.map((col) => (
                        <td key={`${row.id}-${col.field}`}
                          className={`${cellPad} ${cellText} text-slate-700 whitespace-nowrap tabular-nums`}>
                          {col.render ? col.render(row[col.field], row) : row[col.field]}
                        </td>
                      ))}
                    </tr>
                    {isExpanded && expandableContent && !expandAsModal && (
                      <tr className="bg-slate-50/80">
                        <td colSpan={normalizedColumns.length + (expandableContent ? 1 : 0) + (showBulkSelect ? 1 : 0)} className="px-4 py-3">
                          {expandableContent(row)}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>

          {/* Optional totals row — rendered only when a column defines `footer`
              (a (pageRows) => node fn), so every other list is unaffected. Sums
              the CURRENT page's rows ("total at the end of each page"). */}
          {paginatedData.length > 0 && normalizedColumns.some((c) => c.footer) && (
            <tfoot className="bg-slate-50 border-t-2 border-slate-300">
              <tr>
                {expandableContent && <td className="px-2 py-3 fine:py-2 w-8" />}
                {showBulkSelect && <td className="px-4 py-3 fine:px-3 fine:py-2 w-12" />}
                {normalizedColumns.map((col) => (
                  <td key={`foot-${col.field}`}
                    className={`${cellPad} ${cellText} font-bold text-slate-800 whitespace-nowrap tabular-nums`}>
                    {col.footer ? col.footer(paginatedData, filteredData) : null}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Mobile card list — shown < sm; auto-derived from the same columns so
          every list page is usable on a phone without a bespoke mobile view. */}
      <div className="sm:hidden space-y-2">
        {paginatedData.length === 0 ? (
          <div className="text-center text-slate-500 text-sm py-10 border border-slate-200 rounded-xl">
            {searchTerm ? (
              <>
                <p>No results for &quot;{searchTerm}&quot;</p>
                <button onClick={() => handleSearch('')} className="mt-2 text-xs font-medium text-primary-600 hover:underline">Clear search</button>
              </>
            ) : emptyContent}
          </div>
        ) : (
          paginatedData.map((row) => {
            const actionsCol = normalizedColumns.find(c => String(c.field).toLowerCase() === 'actions' || String(c.header || '').toLowerCase() === 'actions');
            const titleCol = normalizedColumns.find(c => c !== actionsCol && c.header);
            const fieldCols = normalizedColumns.filter(c => c !== actionsCol && c !== titleCol);
            return (
              <div
                key={row.id}
                onClick={() => { if (window.getSelection()?.toString()) return; onRowClick && onRowClick(row); }}
                className={`border border-slate-200 rounded-xl p-3 bg-white shadow-sm ${onRowClick ? 'cursor-pointer active:bg-primary-50' : ''}`}
              >
                {titleCol && (
                  <div className="font-semibold text-slate-800 text-sm mb-2 break-words">
                    {titleCol.render ? titleCol.render(row[titleCol.field], row) : row[titleCol.field]}
                  </div>
                )}
                <div className="space-y-1">
                  {fieldCols.map((col) => (
                    <div key={col.field} className="flex items-start justify-between gap-3 text-xs">
                      {col.header && <span className="text-slate-400 shrink-0">{col.header}</span>}
                      <span className="text-slate-700 text-right min-w-0 break-words ml-auto tabular-nums">
                        {col.render ? col.render(row[col.field], row) : row[col.field]}
                      </span>
                    </div>
                  ))}
                </div>
                {actionsCol && (
                  <div className="mt-2 pt-2 border-t border-slate-100 flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                    {actionsCol.render ? actionsCol.render(row[actionsCol.field], row) : null}
                  </div>
                )}
              </div>
            );
          })
        )}
        {/* Mobile page total — mirrors the desktop <tfoot>. */}
        {paginatedData.length > 0 && normalizedColumns.some((c) => c.footer) && (
          <div className="border-2 border-slate-300 rounded-xl p-3 bg-slate-50 shadow-sm">
            {normalizedColumns.filter((c) => c.footer).map((col) => (
              <div key={`mfoot-${col.field}`} className="flex items-center justify-between gap-3 text-xs font-bold text-slate-800">
                <span className="text-slate-500">{col.header}</span>
                <span className="tabular-nums">{col.footer(paginatedData, filteredData)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <p className="order-2 sm:order-1 text-xs sm:text-sm text-slate-600">
          Showing {effectiveTotalRecords === 0 ? 0 : Math.min((safePage - 1) * pageSize + 1, effectiveTotalRecords)} to{' '}
          {Math.min(safePage * pageSize, effectiveTotalRecords)} of {effectiveTotalRecords} results
          {/* Shortcut hint — otherwise nobody discovers it. Desktop only:
              there's no keyboard to speak of on a phone. */}
          {totalPages > 1 && (
            <span className="hidden lg:inline text-slate-400">
              {' · '}
              <kbd className="px-1 py-0.5 border border-slate-200 rounded bg-slate-50 font-sans text-[10px]">←</kbd>
              {' '}
              <kbd className="px-1 py-0.5 border border-slate-200 rounded bg-slate-50 font-sans text-[10px]">→</kbd>
              {' to page'}
            </span>
          )}
        </p>

        <div className="order-1 sm:order-2 flex items-center gap-2">
          {footerExtra && <div className="hidden sm:block mr-2">{footerExtra}</div>}
          <button
            onClick={() => handlePageChange(safePage - 1)}
            disabled={safePage <= 1}
            aria-label="Previous page"
            title="Previous page"
            className="p-2 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <ChevronLeft size={18} />
          </button>

          <div className="flex items-center gap-1">
            {Array.from({ length: totalPages }).map((_, i) => {
              const pageNum = i + 1;
              const isNear = Math.abs(pageNum - safePage) <= 1;
              const isFirst = pageNum === 1;
              const isLast = pageNum === totalPages;

              if (!isNear && !isFirst && !isLast) {
                if (pageNum === 2 || pageNum === totalPages - 1) {
                  return <span key={`dots-${pageNum}`} className="px-1 text-slate-400">...</span>;
                }
                return null;
              }

              return (
                <button
                  key={pageNum}
                  onClick={() => handlePageChange(pageNum)}
                  className={`w-10 h-10 rounded-lg transition ${
                    safePage === pageNum
                      ? 'bg-primary-600 text-white shadow-sm'
                      : 'border border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => handlePageChange(safePage + 1)}
            disabled={safePage >= totalPages}
            aria-label="Next page"
            title="Next page"
            className="p-2 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* Modal-mode line-items popup */}
      {expandAsModal && modalRow && expandableContent && (
        <Modal
          isOpen
          onClose={() => setModalRow(null)}
          title={expandModalTitle ? expandModalTitle(modalRow) : 'Line Items'}
          size="xl"
          footer={
            <button
              onClick={() => setModalRow(null)}
              className={CTRL_GHOST}
            >
              Close
            </button>
          }
        >
          {expandableContent(modalRow)}
        </Modal>
      )}
    </div>
  );
}
