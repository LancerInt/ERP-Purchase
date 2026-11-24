import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Robust localStorage-backed form draft designed for the ERP's
// shop-floor forms where operators fill data incrementally between
// physical measurements — closing a tab, refreshing, or a power blip
// should never cost them their work in progress.
//
// Design goals (and how each is met):
//   * Zero data loss on refresh / crash → debounced write to
//     localStorage on every state change (500 ms after last edit).
//     Storage happens client-side only — no network in the loop, so
//     no async race can drop data.
//   * Schema safety → every draft carries a numeric `version` field.
//     Bump the version in the caller when the persisted shape
//     changes; old drafts are silently discarded (never migrated —
//     migration code rots and crashes at the worst moment).
//   * Never surprise the operator → the hook does NOT auto-populate.
//     It surfaces `hasDraft` + a small preview; the caller renders
//     a banner and the operator explicitly hits Restore or Discard.
//   * Fault tolerant → JSON parse errors, quota-exceeded on write,
//     and localStorage unavailability (private browsing) are all
//     caught silently. The form stays usable even without drafts.
//   * Multi-form → keyed by a per-form string so New Production
//     Entry, Edit Production Entry #X, New Adjustment, etc. each
//     get their own independent draft.
//
// Deliberately NOT in scope (yet):
//   * Cross-device sync (needs a server-side Draft record — bigger
//     project; the localStorage draft already handles 95% of the
//     shop-floor case where the operator uses the same terminal).
//   * Multi-tab conflict detection (accept last-write-wins for now;
//     add a "modified in another tab" indicator later if it bites).

const NAMESPACE = 'lancer-erp:draft:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEBOUNCE_MS = 300;             // trailing-edge write delay
const MAX_WAIT_MS = 2000;            // force a save at least this often
                                      //  during continuous typing so a
                                      //  quick refresh doesn't lose work.
const RESTORE_SUPPRESS_MS = 1500;

// Human-friendly relative time — kept small so we don't drag in
// date-fns just for one label.
const relTime = (ms) => {
  if (!ms || !Number.isFinite(ms)) return 'unknown';
  const diff = Date.now() - ms;
  if (diff < 0)             return 'just now';
  if (diff < 60_000)        return 'just now';
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
};

// One-time capability probe. Private-mode Safari / disabled storage
// throw on setItem; we bail out gracefully in that case.
const detectStorage = () => {
  try {
    const t = '__lancer_erp_draft_probe__';
    window.localStorage.setItem(t, '1');
    window.localStorage.removeItem(t);
    return true;
  } catch {
    return false;
  }
};

/**
 * @typedef {Object} UseFormDraftOptions
 * @property {string} key - Unique per form/mode (e.g. "production-entry:new"
 *                          or "production-entry:edit:<uuid>").
 * @property {number} version - Bump when the persisted state shape changes.
 * @property {any}    state - Current form state (must be JSON-serialisable).
 * @property {(restored: any) => void} onRestore - Called when the operator
 *                          hits Restore; receives the persisted state.
 * @property {boolean} [enabled=true] - Set false to disable persistence
 *                          entirely (e.g. read-only mode). Governs read,
 *                          write AND unload-flush.
 * @property {boolean} [writeGate=true] - Additional guard for writes only.
 *                          Set to false when the current state isn't worth
 *                          persisting (e.g. an empty scaffold that would
 *                          overwrite a real draft the operator hasn't
 *                          restored yet). Reads + banner detection still
 *                          run normally when this is false. Manual
 *                          ``saveNow()`` ignores this flag — an explicit
 *                          click always writes.
 */
export default function useFormDraft({
  key, version, state, onRestore,
  enabled = true,
  writeGate = true,
}) {
  const storageKey = NAMESPACE + key;
  const [foundDraft, setFoundDraft] = useState(null); // {state, savedAt} | null

  const debounceRef = useRef(null);
  const suppressUntilRef = useRef(0);
  const hasSavedOnceRef = useRef(false);
  const lastSavedAtRef = useRef(0);
  // Guard so the draft check runs at most once per hook life, even
  // though its effect re-fires when `enabled` flips true (permissions
  // often load a beat after mount — without this guard the check
  // would silently skip and never come back).
  const didReadRef = useRef(false);
  // Always-fresh state ref — beforeunload / visibilitychange handlers
  // must see the CURRENT state, not a stale closure. Refs bypass the
  // effect-recreation cycle so one listener works for the whole life.
  const stateRef = useRef(state);
  const canUseStorage = useMemo(detectStorage, []);
  // Exposed as state so the form can render a "Draft saved N ago"
  // chip that live-updates every time a write actually lands.
  const [lastSavedAt, setLastSavedAt] = useState(0);
  // Slow ticker — bumps a counter every 30 s so the "N ago" labels
  // recompute even between saves. Without this, "just now" stays
  // printed on-screen forever until the next keystroke fires a save.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastSavedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [!!lastSavedAt]);

  // ── Look for an existing draft. Silently prune stale /
  //    version-mismatched / corrupted entries so the form never
  //    starts from a broken restore.
  //
  //    Effect re-runs when `enabled` flips (permissions-load race
  //    on mount would otherwise silently miss the draft). The
  //    `didReadRef` guard makes sure we still only do the read
  //    ONCE per hook life even if enabled toggles multiple times. ─
  useEffect(() => {
    if (didReadRef.current) return;
    if (!enabled || !canUseStorage) return;
    didReadRef.current = true;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // Version mismatch → the schema has moved on. Don't attempt
      // migration; just clear so the operator gets a clean form.
      if (parsed?.version !== version) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      // Too old to be relevant — plant DPRs are same-day work.
      if (!parsed.savedAt || Date.now() - parsed.savedAt > MAX_AGE_MS) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      setFoundDraft(parsed);
    } catch {
      // Corrupted JSON or storage read failure — treat as no draft.
      try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
    }
  }, [enabled, canUseStorage, storageKey, version]);

  // Synchronous write helper — used by both the debounced normal
  // path AND the beforeunload / visibilitychange fallback. Kept
  // outside the effect so the ref-based unload listeners can call it
  // with the latest state without needing to be re-bound.
  const writeNow = useCallback((currentState) => {
    if (!enabled || !canUseStorage) return;
    try {
      const now = Date.now();
      const payload = JSON.stringify({
        version,
        savedAt: now,
        state: currentState,
      });
      window.localStorage.setItem(storageKey, payload);
      lastSavedAtRef.current = now;
      setLastSavedAt(now);  // triggers a re-render for the UI chip
    } catch {
      // QuotaExceededError / serialization failure — silently skip.
    }
  }, [enabled, canUseStorage, storageKey, version]);

  // Keep stateRef in sync so unload flush sees the freshest state.
  useEffect(() => { stateRef.current = state; }, [state]);

  // ── State change → debounced write with a max-wait cap. First
  //    state emission after mount is skipped so the initial "empty
  //    form" state doesn't overwrite a real draft the operator
  //    hasn't restored yet. ────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !canUseStorage) return;
    // Skip the first synchronous state emission after mount — the
    // form's initial empty state shouldn't clobber an existing
    // draft before the operator has seen the banner.
    if (!hasSavedOnceRef.current) {
      hasSavedOnceRef.current = true;
      lastSavedAtRef.current = Date.now();  // start the max-wait clock
      return;
    }
    // Restore just fired — suppress writes for a short window so the
    // debounced tail from pre-restore state doesn't overwrite the
    // freshly-restored one.
    if (Date.now() < suppressUntilRef.current) return;
    // Meaningful-state gate. When the caller says the current state
    // isn't worth persisting (e.g. fresh empty scaffold), skip the
    // write ENTIRELY — do NOT delete the stored draft. That way an
    // operator who opens the form and closes it without typing keeps
    // yesterday's real draft intact for tomorrow's restore.
    if (!writeGate) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Max-wait cap: if it's been ≥ MAX_WAIT_MS since the last save,
    // fire on the next tick instead of waiting the full debounce.
    // Keeps continuous-typing sessions from delaying saves forever
    // — a quick refresh mid-typing still recovers everything typed
    // within the last MAX_WAIT_MS.
    const elapsed = Date.now() - lastSavedAtRef.current;
    const delay = elapsed >= MAX_WAIT_MS ? 0 : DEBOUNCE_MS;
    debounceRef.current = setTimeout(() => writeNow(stateRef.current), delay);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [state, enabled, canUseStorage, writeGate, writeNow]);

  // ── Unload-safety flush ─────────────────────────────────────────
  // A tab close, F5 refresh, or backgrounded mobile tab must not
  // lose work still in the debounce window. beforeunload fires
  // synchronously so a localStorage.setItem here is guaranteed to
  // land. visibilitychange catches mobile browsers where
  // beforeunload isn't reliable (Safari iOS in particular). Both
  // are idempotent — worst case we save twice, no harm done.
  useEffect(() => {
    if (!enabled || !canUseStorage) return;
    // Ref-gated flush so the listener reads the current writeGate
    // at fire time (bound once — closure would freeze the initial
    // value and defeat the point of the gate).
    const gateRef = { current: writeGate };
    gateRef.current = writeGate;
    const flush = () => {
      if (!gateRef.current) return;
      writeNow(stateRef.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    // pagehide is the mobile-Safari counterpart of beforeunload.
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [enabled, canUseStorage, writeGate, writeNow]);

  // Restore explicitly — never auto. Pushes state back into the form
  // via the caller's onRestore callback, then dismisses the banner.
  const restore = useCallback(() => {
    if (!foundDraft) return;
    suppressUntilRef.current = Date.now() + RESTORE_SUPPRESS_MS;
    try {
      onRestore(foundDraft.state);
    } finally {
      setFoundDraft(null);
    }
  }, [foundDraft, onRestore]);

  // Discard removes the stored draft AND dismisses the banner. The
  // operator confirms they don't want it back.
  const discard = useCallback(() => {
    try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
    setFoundDraft(null);
  }, [storageKey]);

  // Clear is the "operation successful" path — call after Save so
  // the draft doesn't linger and get offered on the next new form.
  const clear = useCallback(() => {
    try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
    setFoundDraft(null);
  }, [storageKey]);

  // Manual save trigger — flushes the current state immediately
  // (bypasses the debounce). Exposed so the form can offer a
  // "Save draft now" button + so the operator has a visible way to
  // force persistence right before an intentional refresh.
  const saveNow = useCallback(() => writeNow(stateRef.current), [writeNow]);

  return {
    hasDraft: !!foundDraft,
    draftAge: relTime(foundDraft?.savedAt),
    draftSavedAt: foundDraft?.savedAt,
    draftState: foundDraft?.state,
    restore,
    discard,
    clear,
    saveNow,
    lastSavedAt,
    lastSavedAgo: lastSavedAt ? relTime(lastSavedAt) : '',
    enabled: enabled && canUseStorage,
  };
}
