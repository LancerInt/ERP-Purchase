import { useState, useEffect } from 'react';
import ConfirmModal from './ConfirmModal';

/**
 * App-wide confirmation dialog — a styled, accessible replacement for the
 * native `window.confirm`. Mount <ConfirmHost /> once near the app root,
 * then call `await confirm({ ... })` anywhere; it resolves to true/false
 * exactly like window.confirm, so the call-site control flow is unchanged:
 *
 *   if (!(await confirm({ message: 'Delete this?', isDangerous: true }))) return;
 *
 * Falls back to the native dialog if the host isn't mounted, so it never
 * silently no-ops.
 */
let openConfirm = null;

export function confirm(options = {}) {
  const opts = typeof options === 'string' ? { message: options } : options;
  return new Promise((resolve) => {
    if (!openConfirm) {
      // Host not mounted (e.g. tests / early boot) — degrade gracefully.
      resolve(window.confirm(opts.message || 'Are you sure?'));
      return;
    }
    openConfirm({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [state, setState] = useState(null);

  useEffect(() => {
    openConfirm = setState;
    return () => { openConfirm = null; };
  }, []);

  if (!state) return null;

  const finish = (result) => {
    state.resolve(result);
    setState(null);
  };

  return (
    <ConfirmModal
      isOpen
      title={state.title || 'Please confirm'}
      message={state.message || 'Are you sure?'}
      confirmLabel={state.confirmLabel || 'Confirm'}
      cancelLabel={state.cancelLabel || 'Cancel'}
      isDangerous={!!state.isDangerous}
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
    />
  );
}

export default confirm;
