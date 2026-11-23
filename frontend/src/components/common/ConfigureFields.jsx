import { useState, useEffect, useMemo } from 'react';
import { GripVertical, Eye, EyeOff, RotateCcw } from 'lucide-react';
import Modal from '../ui/Modal';
import { formatDate } from '@/utils/formatters';

/**
 * ConfigureFields - Zoho Creator style field configuration panel.
 * Allows users to show/hide columns and reorder them via drag-and-drop.
 *
 * Props:
 * - allColumns: Array of { field, header, width, ... } — all possible columns
 * - visibleFields: Array of field names currently visible
 * - onApply: (visibleFields) => void — called when user applies changes
 * - onClose: () => void
 * - storageKey: string — localStorage key to persist configuration
 */
export default function ConfigureFields({ allColumns = [], visibleFields, onApply, onClose, storageKey }) {
  const [fields, setFields] = useState([]);

  useEffect(() => {
    // Build field list: visible ones first (in order), then hidden ones
    const visible = new Set(visibleFields || allColumns.map(c => c.field));
    const ordered = [];
    // Add visible fields in their current order
    (visibleFields || allColumns.map(c => c.field)).forEach(f => {
      const col = allColumns.find(c => c.field === f);
      if (col) ordered.push({ ...col, visible: true });
    });
    // Add hidden fields
    allColumns.forEach(c => {
      if (!visible.has(c.field) && c.field !== 'actions') {
        ordered.push({ ...c, visible: false });
      }
    });
    setFields(ordered);
  }, [allColumns, visibleFields]);

  const toggleField = (field) => {
    setFields(prev => prev.map(f => f.field === field ? { ...f, visible: !f.visible } : f));
  };

  const moveField = (fromIdx, toIdx) => {
    setFields(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIdx, 1);
      updated.splice(toIdx, 0, moved);
      return updated;
    });
  };

  const handleApply = () => {
    const visible = fields.filter(f => f.visible).map(f => f.field);
    if (storageKey) {
      localStorage.setItem(storageKey, JSON.stringify(visible));
    }
    onApply(visible);
    onClose();
  };

  const handleReset = () => {
    setFields(allColumns.filter(c => c.field !== 'actions').map(c => ({ ...c, visible: true })));
    if (storageKey) localStorage.removeItem(storageKey);
  };

  const visibleCount = fields.filter(f => f.visible).length;

  // Simple drag state
  const [dragIdx, setDragIdx] = useState(null);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Configure Fields"
      size="sm"
      footer={
        <div className="flex items-center justify-between w-full">
          <button onClick={handleReset} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
            <RotateCcw size={12} /> Reset to default
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-4 py-1.5 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
            <button onClick={handleApply} className="px-4 py-1.5 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 font-medium">Apply</button>
          </div>
        </div>
      }
    >
      <div className="mb-2">
        <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{visibleCount} visible</span>
      </div>
      <div className="space-y-1">
        {fields.map((field, idx) => (
          <div
            key={field.field}
            draggable
            onDragStart={() => setDragIdx(idx)}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={() => { if (dragIdx !== null && dragIdx !== idx) moveField(dragIdx, idx); setDragIdx(null); }}
            onDragEnd={() => setDragIdx(null)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all cursor-move ${
              dragIdx === idx ? 'border-primary-400 bg-primary-50 shadow-md' :
              field.visible ? 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm' :
              'border-slate-100 bg-slate-50'
            }`}
          >
            <GripVertical size={14} className="text-slate-300 flex-shrink-0" />
            <span className={`flex-1 text-sm ${field.visible ? 'text-slate-800 font-medium' : 'text-slate-400'}`}>
              {field.header || field.field}
              {field._autoDetected && (
                <span className="ml-2 text-[10px] uppercase tracking-wide text-violet-500 font-semibold">auto</span>
              )}
            </span>
            <button onClick={() => toggleField(field.field)}
              aria-label={field.visible ? 'Hide column' : 'Show column'}
              title={field.visible ? 'Hide column' : 'Show column'}
              className={`p-1 rounded transition ${field.visible ? 'text-emerald-600 hover:bg-emerald-50' : 'text-slate-300 hover:bg-slate-100 hover:text-slate-500'}`}>
              {field.visible ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ── Auto-detection helpers ──────────────────────────────────────────────────

// Keys we never expose as a column (internal/audit metadata, FK ids that have
// a *_name pair, attachment blobs, etc.). Added to keep the auto-discovered
// list focused on user-facing fields.
const AUTO_FIELD_BLACKLIST = new Set([
  'id', 'pk', 'created_at', 'updated_at', 'created_by', 'updated_by',
  'is_active', '_meta', 'attachments', 'photo_attachments', 'photos',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const humanize = (field) =>
  String(field || '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\bid\b/gi, 'ID')
    .replace(/\bno\b/gi, 'No')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

// ── Value formatters (address JSON, UUID FK, dates, booleans) ─────────────

const ADDRESS_PRIMARY_KEYS = ['raw_address', 'address_line1', 'address_line', 'line1', 'street', 'address'];

function formatAddress(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // Must look like an address: at least one primary key OR a state/pincode.
  const looksLikeAddress = ADDRESS_PRIMARY_KEYS.some((k) => obj[k])
    || obj.state || obj.pincode || obj.pin || obj.zip || obj.district;
  if (!looksLikeAddress) return null;
  const parts = [];
  for (const k of ADDRESS_PRIMARY_KEYS) {
    if (obj[k]) { parts.push(String(obj[k])); break; }
  }
  if (obj.city) parts.push(obj.city);
  if (obj.district && obj.district !== obj.city) parts.push(obj.district);
  if (obj.state) parts.push(obj.state);
  const pin = obj.pincode || obj.pin || obj.zip;
  if (pin) parts.push(String(pin));
  if (obj.country) parts.push(obj.country);
  return parts.length ? parts.join(', ') : null;
}

function tryParseJson(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function defaultRender(v, row, fieldName) {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return v.toLocaleString('en-IN');

  if (Array.isArray(v)) {
    if (!v.length) return '-';
    return v.map((x) => {
      if (x === null || x === undefined) return '';
      if (typeof x === 'object') {
        const addr = formatAddress(x);
        if (addr) return addr;
        return x?.name || x?.label || x?.title || x?.po_number || x?.dc_no || x?.so_no || '';
      }
      return String(x);
    }).filter(Boolean).join(', ') || '-';
  }

  if (typeof v === 'object') {
    const addr = formatAddress(v);
    if (addr) return addr;
    return v.name || v.label || v.title || '-';
  }

  if (typeof v === 'string') {
    // Stored-as-JSON address (common for Address fields persisted as text)
    const parsed = tryParseJson(v);
    if (parsed) {
      const addr = formatAddress(parsed);
      if (addr) return addr;
      if (Array.isArray(parsed)) return parsed.length ? parsed.length + ' item(s)' : '-';
      return parsed.name || parsed.label || parsed.title || '-';
    }
    // ISO date — render as DD MMM YYYY
    if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) {
      try {
        return formatDate(v);
      } catch { /* fall through */ }
    }
    // UUID — prefer a sibling *_name field if one is present on the row.
    if (UUID_RE.test(v) && row && fieldName) {
      const candidates = [
        `${fieldName}_name`,
        `${fieldName.replace(/_id$/, '')}_name`,
        `${fieldName}_display`,
      ];
      for (const c of candidates) {
        if (row[c]) return row[c];
      }
      return '-';
    }
    return v;
  }
  return String(v);
}

/**
 * Walk a sample of API rows and synthesize columns for any keys not already
 * in the static columns list. This is what makes the field configurator
 * automatically pick up new model fields without code changes.
 *
 * Skips FK-shaped UUID fields when a `<field>_name` companion exists on the
 * same row — the readable name column is what users actually want.
 */
function detectExtraColumns(staticColumns, dataRows) {
  if (!Array.isArray(dataRows) || dataRows.length === 0) return [];
  const known = new Set(staticColumns.map((c) => c.field));
  const seen = new Set();
  const allKeys = new Set(known);
  // Sample up to 50 rows to tolerate fields that are null on some rows.
  const sample = dataRows.slice(0, 50);
  sample.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    Object.keys(row).forEach((k) => {
      allKeys.add(k);
      if (known.has(k) || AUTO_FIELD_BLACKLIST.has(k)) return;
      seen.add(k);
    });
  });

  // Drop raw FK UUIDs whose `*_name` companion already covers them.
  const filtered = [...seen].filter((field) => {
    const sampleVal = sample.map((r) => r?.[field]).find((x) => x !== undefined && x !== null && x !== '');
    if (typeof sampleVal === 'string' && UUID_RE.test(sampleVal)) {
      const nameKey = `${field}_name`;
      const altKey = `${field.replace(/_id$/, '')}_name`;
      if (allKeys.has(nameKey) || allKeys.has(altKey)) return false;
    }
    return true;
  });

  return filtered.sort().map((field) => ({
    field,
    header: humanize(field),
    sortable: true,
    width: '160px',
    render: (v, row) => defaultRender(v, row, field),
    _autoDetected: true,
  }));
}

/**
 * Hook to manage field configuration with localStorage persistence.
 *
 * Signature: useConfigureFields(staticColumns, storageKey, dataRows?)
 * - staticColumns: hand-authored columns for the page (always shown by default)
 * - storageKey: localStorage key for persisting visibility/order
 * - dataRows: optional — when provided, the hook scans rows for unknown keys
 *   and synthesizes extra columns so newly-added model fields show up in the
 *   Configure Fields modal automatically (hidden by default for users with
 *   saved preferences; visible by default for first-time users).
 *
 * Returns { visibleColumns, mergedColumns, showConfig, setShowConfig,
 *           handleConfigApply, visibleFieldKeys }.
 */
export function useConfigureFields(staticColumns, storageKey, dataRows) {
  // Normalise column shape: master pages use {key, label}, sales pages use
  // {field, header}. Detection / lookup logic below relies on `field`.
  const normalizedStaticColumns = useMemo(() => (staticColumns || []).map((c) => ({
    ...c,
    field: c.field || c.key,
    header: c.header || c.label,
  })), [staticColumns]);

  // Auto-detection of "extra" columns from API row data has been disabled
  // per user request. The Configure Fields modal and list view now only
  // expose the columns each page declares explicitly — those mirror the
  // inputs on the matching create / edit form, so users no longer see
  // derived fields (Conversion Notes, Custom Service Category, Division,
  // raw FK ids, etc.) that aren't editable in the UI.
  //
  // `dataRows` is still accepted for signature compatibility but no longer
  // used to synthesise columns. `detectExtraColumns` below stays in the
  // file for now in case we ever want a curated re-enable behind a flag.
  const mergedColumns = useMemo(() => normalizedStaticColumns, [normalizedStaticColumns]);

  const hasSavedPref = !!(storageKey && typeof localStorage !== 'undefined' && localStorage.getItem(storageKey));

  const [showConfig, setShowConfig] = useState(false);
  const [visibleFieldKeys, setVisibleFieldKeys] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        try { return JSON.parse(saved); } catch {}
      }
    }
    return normalizedStaticColumns.filter((c) => c.field !== 'actions').map((c) => c.field);
  });

  // For first-time users (no saved preference), keep the visible set in sync
  // with the merged column list as new auto-detected fields appear. Users
  // with a saved preference keep their explicit choice — new fields show up
  // in the modal as hidden, and they can opt in.
  useEffect(() => {
    if (hasSavedPref) return;
    const wantVisible = mergedColumns
      .filter((c) => c.field !== 'actions')
      .map((c) => c.field);
    setVisibleFieldKeys((prev) => {
      const same = prev.length === wantVisible.length && prev.every((f, i) => f === wantVisible[i]);
      return same ? prev : wantVisible;
    });
  }, [mergedColumns, hasSavedPref]);

  const visibleColumns = [
    ...visibleFieldKeys.map((f) => mergedColumns.find((c) => c.field === f)).filter(Boolean),
    mergedColumns.find((c) => c.field === 'actions'),
  ].filter(Boolean);

  const handleConfigApply = (fields) => {
    setVisibleFieldKeys(fields);
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify(fields));
  };

  return {
    visibleColumns,
    mergedColumns,
    // Backwards compat: some pages destructure `allColumns` from the hook.
    allColumns: mergedColumns,
    showConfig,
    setShowConfig,
    handleConfigApply,
    visibleFieldKeys,
  };
}
