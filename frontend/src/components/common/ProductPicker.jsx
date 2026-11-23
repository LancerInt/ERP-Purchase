import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, ChevronDown, Loader2, Search } from 'lucide-react';
import {
  CAT_PREFIX, PRODUCT_CATEGORIES, bucketiseProducts, resolveProductLabel,
} from '../../utils/productPicker.js';
import apiClient from '../../utils/api.js';

const RECENT_KEY = 'erp.product.recent';
const RECENT_MAX = 8;
const LABEL_OF = new Map(PRODUCT_CATEGORIES);

const readRecent = () => {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
};

const pushRecent = (id) => {
  if (!id || String(id).startsWith(CAT_PREFIX)) return;
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage unavailable */ }
};

const toPickerRow = (p) => ({
  value: p.id,
  label: p.product_name || p.name || '',
  sku: p.sku_code || '',
  catLabel: LABEL_OF.get(p.goods_sub_type) || '',
});

export default function ProductPicker({
  value = '',
  onChange,
  rows,
  groups = [],
  className = '',
  title = 'Product',
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(readRecent);

  const serverMode = !rows || rows.length === 0;
  const [serverResults, setServerResults] = useState([]);
  const [serverCatCounts, setServerCatCounts] = useState({});
  const [serverFamilies, setServerFamilies] = useState([]);
  const [recentRows, setRecentRows] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef(null);
  const abortRef = useRef(null);
  const openIdRef = useRef(0);

  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const rowRefs = useRef([]);

  // ── client-side mode (rows prop given) ─────────────────────────────────
  const { byCat, loose, all } = useMemo(() => bucketiseProducts(rows), [rows]);
  const MAX_ROWS = 200;

  // ── server-side fetch helpers ──────────────────────────────────────────
  const fetchSearch = useCallback((q, category) => {
    if (!serverMode) return;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSearching(true);
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (category) p.set('category', category);
    apiClient.get(`/api/products/search/?${p}`, { signal: ctrl.signal })
      .then((res) => {
        setServerResults((res.data.results || []).map(toPickerRow));
        if (res.data.category_counts) setServerCatCounts(res.data.category_counts);
        setSearching(false);
      })
      .catch((err) => {
        if (err?.code !== 'ERR_CANCELED') setSearching(false);
      });
  }, [serverMode]);

  const fetchRecent = useCallback((ids) => {
    if (!serverMode || !ids.length) { setRecentRows([]); return; }
    const extra = groups.length === 0 ? '&families=1' : '';
    apiClient.get(`/api/products/search/?ids=${ids.join(',')}${extra}`)
      .then((res) => {
        const byId = new Map((res.data.results || []).map((p) => [String(p.id), toPickerRow(p)]));
        setRecentRows(ids.map((id) => byId.get(String(id))).filter(Boolean));
        if (res.data.category_counts) setServerCatCounts(res.data.category_counts);
        if (res.data.families) setServerFamilies(res.data.families);
      })
      .catch(() => {});
  }, [serverMode, groups.length]);

  // debounced search on query/category change (server mode)
  useEffect(() => {
    if (!serverMode || !open) return;
    clearTimeout(searchTimer.current);
    const q = query.trim();
    if (!q && !cat) {
      setServerResults([]);
      return;
    }
    searchTimer.current = setTimeout(() => fetchSearch(q, cat), 250);
    return () => clearTimeout(searchTimer.current);
  }, [query, cat, open, serverMode, fetchSearch]);

  // ── build result list ──────────────────────────────────────────────────
  const q = query.trim().toLowerCase();

  const effectiveGroups = groups.length ? groups : serverFamilies;

  const results = useMemo(() => {
    if (serverMode) {
      const out = [];
      if (!cat) {
        for (const g of effectiveGroups) {
          if (!q || String(g.label).toLowerCase().includes(q)) {
            out.push({ value: g.value, label: g.label, meta: 'Product family', isCat: true });
          }
        }
      }
      if (cat && cat !== 'OTHER') {
        const count = serverCatCounts[cat] || 0;
        out.push({
          value: CAT_PREFIX + cat,
          label: `${LABEL_OF.get(cat)} — all ${count}`,
          meta: 'Everything in this category',
          isCat: true,
        });
      }
      if (!q && !cat) return [...out, ...recentRows];
      return [...out, ...serverResults];
    }

    // client-side mode (original logic)
    let pool = cat
      ? (cat === 'OTHER' ? loose : (byCat.get(cat) || []))
      : all;
    if (q) {
      pool = pool.filter((p) => p.label.toLowerCase().includes(q)
        || (p.sku || '').toLowerCase().includes(q));
    }
    const out = [];
    if (!cat) {
      for (const g of groups) {
        if (!q || String(g.label).toLowerCase().includes(q)) {
          out.push({ value: g.value, label: g.label, meta: 'Product family', isCat: true });
        }
      }
    }
    if (cat && cat !== 'OTHER') {
      const items = byCat.get(cat) || [];
      out.push({
        value: CAT_PREFIX + cat,
        label: `${PRODUCT_CATEGORIES.find(([k]) => k === cat)?.[1]} — all ${items.length}`,
        meta: 'Everything in this category',
        isCat: true,
      });
    }
    if (!q && !cat) {
      const byId = new Map(all.map((p) => [String(p.value), p]));
      const hits = recent.map((id) => byId.get(String(id))).filter(Boolean);
      return [...out, ...hits];
    }
    return [...out, ...pool.slice(0, MAX_ROWS)];
  }, [serverMode, serverResults, serverCatCounts, recentRows, effectiveGroups,
      all, byCat, loose, cat, q, recent, groups]);

  const matched = useMemo(() => {
    if (serverMode) return serverResults.length;
    if (!q && !cat) return 0;
    const pool = cat ? (cat === 'OTHER' ? loose : (byCat.get(cat) || [])) : all;
    return q
      ? pool.filter((p) => p.label.toLowerCase().includes(q)
        || (p.sku || '').toLowerCase().includes(q)).length
      : pool.length;
  }, [serverMode, serverResults, all, byCat, loose, cat, q]);

  const pickable = results.filter((r) => !r.heading);

  // ── open / close ────────────────────────────────────────────────────────
  const openPanel = () => {
    setRect(btnRef.current?.getBoundingClientRect() || null);
    setQuery('');
    setCat('');
    setActive(0);
    setServerResults([]);
    const ids = readRecent();
    setRecent(ids);
    openIdRef.current++;
    if (serverMode) fetchRecent(ids);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { setActive(0); }, [q, cat]);
  useEffect(() => {
    rowRefs.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const apply = (v) => {
    pushRecent(v);
    setOpen(false);
    onChange?.({ target: { value: v } });
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setActive((i) => Math.min(pickable.length - 1, i + 1)); return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const hit = pickable[active];
      if (hit) apply(hit.value);
    }
  };

  // ── the closed control ──────────────────────────────────────────────────
  const label = serverMode
    ? resolveProductLabel(value, { byCat: new Map(), all: [...recentRows, ...serverResults], groups: effectiveGroups })
    : resolveProductLabel(value, { byCat, all, groups });

  // ── category rail data ─────────────────────────────────────────────────
  const cats = serverMode
    ? PRODUCT_CATEGORIES.filter(([k]) => (serverCatCounts[k] || 0) > 0)
    : PRODUCT_CATEGORIES.filter(([k]) => (byCat.get(k) || []).length);

  const hasUncategorised = serverMode
    ? false  // server mode doesn't track uncategorised separately
    : loose.length > 0;

  // ── panel geometry ─────────────────────────────────────────────────────
  const WIDTH = 640;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const narrow = vw < 720;
  const GAP = 16;
  const below = rect ? vh - rect.bottom - GAP : 9999;
  const above = rect ? rect.top - GAP : 0;
  const dropUp = rect ? below < 280 && above > below : false;
  const roomFor = Math.max(220, Math.min(430, dropUp ? above : below));
  const style = rect
    ? {
      position: 'fixed',
      zIndex: 70,
      maxHeight: roomFor,
      ...(narrow
        ? { left: GAP, right: GAP }
        : { left: Math.max(GAP, Math.min(rect.left, vw - WIDTH - GAP)), width: WIDTH }),
      ...(dropUp
        ? { bottom: vh - rect.top + 4 }
        : { top: rect.bottom + 4 }),
    }
    : { display: 'none' };

  // ── status line ────────────────────────────────────────────────────────
  const statusText = useMemo(() => {
    if (!q && !cat) {
      return pickable.length ? 'Recently used' : 'Start typing, or pick a category';
    }
    if (serverMode && searching) return 'Searching…';
    if (!serverMode && matched > MAX_ROWS) {
      return `Showing ${MAX_ROWS} of ${matched.toLocaleString()}`;
    }
    return `${matched.toLocaleString()} product${matched === 1 ? '' : 's'}`;
  }, [q, cat, pickable.length, serverMode, searching, matched]);

  return (
    <>
      <button
        type="button" ref={btnRef} title={title}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className={className || 'inline-flex items-center gap-1.5 border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white text-slate-700 hover:bg-slate-50 min-w-0 max-w-[190px]'}
      >
        <Box size={14} className="text-slate-400 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown size={14} className="text-slate-400 shrink-0 ml-auto" />
      </button>

      {open && createPortal(
        <div ref={panelRef} style={style}
          className="bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden flex flex-col">
          {/* Search */}
          <div className="px-3 py-2.5 border-b border-slate-100 shrink-0">
            <div className="text-[11px] font-semibold text-slate-700 mb-1.5">Find a product</div>
            <div className="relative">
              <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef} type="text" value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search product name or code"
                className="w-full pl-8 pr-2 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {searching && (
                <Loader2 size={15} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 animate-spin" />
              )}
            </div>
            <div className="text-[11px] text-slate-400 mt-1.5">
              {cat
                ? `Searching ${PRODUCT_CATEGORIES.find(([k]) => k === cat)?.[1] || 'Uncategorised'}`
                : 'Searching all categories'}
            </div>
          </div>

          <div className={`flex min-h-0 flex-1 ${narrow ? 'flex-col' : ''}`}>
            {/* Category rail */}
            {narrow ? (
              <div className="shrink-0 border-b border-slate-100 px-2 py-1.5 overflow-x-auto">
                <div className="flex gap-1.5 w-max">
                  {[['', 'All Categories'], ...cats, ...(hasUncategorised ? [['OTHER', 'Uncategorised']] : [])]
                    .map(([k, l]) => (
                      <button key={k || 'all'} type="button" onClick={() => setCat(k)}
                        className={`px-2.5 py-1 rounded-full text-[12px] whitespace-nowrap border ${cat === k
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'bg-white text-slate-600 border-slate-200'}`}>
                        {l}
                      </button>
                    ))}
                </div>
              </div>
            ) : (
              <div className="w-[170px] shrink-0 border-r border-slate-100 overflow-auto py-1.5">
                <div className="px-3 pb-1 text-[10px] uppercase tracking-wide text-slate-400">
                  Category · optional
                </div>
                {[['', 'All Categories'], ...cats, ...(hasUncategorised ? [['OTHER', 'Uncategorised']] : [])]
                  .map(([k, l]) => (
                    <button key={k || 'all'} type="button" onClick={() => setCat(k)}
                      className={`w-full text-left px-3 py-1.5 text-[13px] truncate ${cat === k
                        ? 'bg-indigo-50 text-indigo-700 font-medium'
                        : 'text-slate-600 hover:bg-slate-50'}`}>
                      {l}
                    </button>
                  ))}
              </div>
            )}

            {/* Results */}
            <div className="flex-1 min-w-0 overflow-auto py-1.5">
              <div className="flex items-center justify-between px-3 pb-1">
                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                  {statusText}
                </span>
                <button type="button" onClick={() => apply('')}
                  className="text-[11px] font-medium text-indigo-600 hover:underline">
                  All Products
                </button>
              </div>
              {pickable.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-slate-400">
                  {searching
                    ? 'Searching…'
                    : q
                      ? <>No product matches "{query}".</>
                      : 'Search by name or code, or choose a category.'}
                </p>
              ) : (
                pickable.map((p, i) => (
                  <button
                    key={`${p.value}-${i}`} type="button"
                    ref={(el) => { rowRefs.current[i] = el; }}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => apply(p.value)}
                    className={`w-full text-left px-3 py-2 ${i === active ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
                  >
                    <div className={`text-[13px] truncate ${p.isCat ? 'font-semibold text-indigo-700' : 'font-medium text-slate-800'}`}>
                      {p.label}
                    </div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {p.isCat ? p.meta : [p.catLabel, p.sku].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-100 bg-slate-50/60 shrink-0">
            <span className="text-[11px] text-slate-500">Choose a product to apply</span>
            <span className="hidden sm:flex items-center gap-1 text-[10px] text-slate-400">
              <kbd className="px-1 py-0.5 bg-white border border-slate-200 rounded">↑</kbd>
              <kbd className="px-1 py-0.5 bg-white border border-slate-200 rounded">↓</kbd> move
              <kbd className="px-1 py-0.5 bg-white border border-slate-200 rounded ml-1">Enter</kbd> select
              <kbd className="px-1 py-0.5 bg-white border border-slate-200 rounded ml-1">Esc</kbd> close
            </span>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
