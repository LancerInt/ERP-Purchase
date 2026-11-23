import { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import apiClient from '../../utils/api.js';

/**
 * Gmail-style email input with contact suggestions.
 *
 * Backed by /api/communications/email-suggestions/ (vendors + customers +
 * users). As the user types, a dropdown of matching contacts appears; pick
 * one with the mouse or the keyboard (↑/↓ + Enter, Esc to dismiss).
 *
 * Controlled: pass `value` (string) and `onChange(nextValue)`.
 *  - multiple=true  (default) → comma-separated recipients (CC / BCC). Each
 *    address before the last comma renders as a removable pill; the text after
 *    the last comma is the "active" token being typed. Typing a comma / space,
 *    pressing Enter, or picking a suggestion commits the active token to a pill;
 *    Backspace on an empty box removes the last pill. `value` stays a plain
 *    comma-separated string, so a typed-but-not-yet-committed address is still
 *    included on send — nothing is silently dropped.
 *  - multiple=false (To) → a single address; selecting replaces the whole value.
 */
export default function EmailAutocomplete({
  value = '',
  onChange,
  placeholder = '',
  className = '',
  type = 'text',
  id,
  multiple = true,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  // Split the comma-separated value into committed pills + the active token.
  // Everything before the last comma is a finished address (a pill); the text
  // after the last comma is what's currently being typed.
  const segments = value.split(',');
  const pills = multiple ? segments.slice(0, -1).map(t => t.trim()).filter(Boolean) : [];
  const draft = multiple ? (segments[segments.length - 1] || '').replace(/^\s+/, '') : value;

  // The token driving suggestions: the draft (multi) or the whole value (single).
  const activeToken = (multiple ? draft : value).trim();
  // Addresses already present, lower-cased, so we don't re-suggest them.
  const chosen = value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

  // Rebuild the comma-separated value from a pill list + the active draft.
  const rebuild = (pillArr, draftText) =>
    (pillArr.length ? `${pillArr.join(', ')}, ` : '') + draftText;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = activeToken;
    if (q.length < 1) { setSuggestions([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await apiClient.get('/api/communications/email-suggestions/', { params: { q, limit: 8 } });
        const list = (res.data || []).filter(s => !chosen.includes((s.email || '').toLowerCase()));
        setSuggestions(list);
        setHighlight(0);
        setOpen(list.length > 0);
      } catch {
        setSuggestions([]);
        setOpen(false);
      }
    }, 200);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeToken, value]);

  // Dismiss on click outside.
  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const applySuggestion = (s) => {
    if (!s) return;
    onChange(multiple ? rebuild([...pills, s.email], '') : s.email);
    setOpen(false);
    setSuggestions([]);
  };

  // Turn the current draft into a pill (Enter / comma / space).
  const commitDraft = () => {
    const t = draft.trim();
    if (!t) return;
    onChange(rebuild([...pills, t], ''));
    setOpen(false);
    setSuggestions([]);
  };

  const removePill = (idx) => {
    onChange(rebuild(pills.filter((_, i) => i !== idx), draft));
    inputRef.current?.focus();
  };

  // Single-recipient (To): plain input, unchanged behaviour.
  if (!multiple) {
    return (
      <div ref={wrapRef} className="relative flex-1 min-w-0">
        <input
          id={id}
          type={type}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (!open || suggestions.length === 0) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, suggestions.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); applySuggestion(suggestions[highlight]); }
            else if (e.key === 'Escape') { setOpen(false); }
          }}
          onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
          placeholder={placeholder}
          autoComplete="off"
          className={className}
        />
        {open && (
          <SuggestionList suggestions={suggestions} highlight={highlight} setHighlight={setHighlight} applySuggestion={applySuggestion} />
        )}
      </div>
    );
  }

  const onKeyDown = (e) => {
    // Keyboard navigation while the dropdown is open.
    if (open && suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, suggestions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); return; }
      if (e.key === 'Enter') { e.preventDefault(); applySuggestion(suggestions[highlight]); return; }
      if (e.key === 'Escape') { setOpen(false); return; }
    }
    // Commit the draft to a pill on Enter / comma / space.
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      if (draft.trim()) { e.preventDefault(); commitDraft(); }
      return;
    }
    // Backspace on an empty draft removes the last pill.
    if (e.key === 'Backspace' && !draft && pills.length > 0) {
      e.preventDefault();
      removePill(pills.length - 1);
    }
  };

  return (
    <div ref={wrapRef} className="relative flex-1 min-w-0">
      <div
        className={`${className} flex flex-wrap items-center gap-1.5 cursor-text focus-within:ring-2 focus-within:ring-primary-500 focus-within:border-primary-500`}
        onClick={() => inputRef.current?.focus()}
      >
        {pills.map((email, i) => (
          <span
            key={`${email}-${i}`}
            className="inline-flex items-center gap-1 max-w-full bg-primary-50 text-primary-700 border border-primary-200 rounded-md pl-2 pr-1 py-0.5 text-xs font-medium"
          >
            <span className="truncate">{email}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removePill(i); }}
              className="flex-shrink-0 text-primary-400 hover:text-primary-700 hover:bg-primary-100 rounded-full p-0.5"
              aria-label={`Remove ${email}`}
              tabIndex={-1}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          ref={inputRef}
          type={type}
          value={draft}
          onChange={e => onChange(rebuild(pills, e.target.value))}
          onKeyDown={onKeyDown}
          onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
          placeholder={pills.length ? '' : placeholder}
          autoComplete="off"
          className="flex-1 min-w-[10rem] bg-transparent border-0 p-0 text-sm focus:ring-0 focus:outline-none placeholder:text-slate-400"
        />
      </div>
      {open && (
        <SuggestionList suggestions={suggestions} highlight={highlight} setHighlight={setHighlight} applySuggestion={applySuggestion} />
      )}
    </div>
  );
}

function SuggestionList({ suggestions, highlight, setHighlight, applySuggestion }) {
  return (
    <ul className="absolute z-50 mt-1 left-0 right-0 max-h-60 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg text-sm">
      {suggestions.map((s, i) => (
        <li
          key={`${s.email}-${i}`}
          onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }}
          onMouseEnter={() => setHighlight(i)}
          className={`px-3 py-2 cursor-pointer flex items-center justify-between gap-2 ${i === highlight ? 'bg-primary-50' : 'hover:bg-slate-50'}`}
        >
          <span className="flex flex-col min-w-0">
            <span className="font-medium text-slate-800 truncate">{s.name || s.email}</span>
            {s.name ? <span className="text-xs text-slate-500 truncate">{s.email}</span> : null}
          </span>
          {s.source ? <span className="text-[10px] uppercase tracking-wide text-slate-400 flex-shrink-0">{s.source}</span> : null}
        </li>
      ))}
    </ul>
  );
}
