import { useState, useEffect } from 'react';
import Modal from '../ui/Modal';

/**
 * Party-link picker — a 3-outcome dialog for the "Also a customer / Also a
 * vendor" link. The plain confirm() is binary; linking to a spelling-variant
 * suggestion needs a third path, so this dialog resolves to one of:
 *
 *   { action: 'link', id, name }   // link to a specific chosen counterpart
 *   { action: 'create' }           // create-or-auto-match a new counterpart
 *   { action: 'cancel' }           // leave the checkbox unchecked
 *
 * Mount <PartyLinkPickerHost /> once near the app root, then call
 * `await pickPartyLink({ counterpart, preview, name, gstin, pan })` anywhere.
 *
 * The fuzzy `preview.suggestions` only ever SUGGEST — a link is made solely
 * from an explicit human pick. preview can be null (e.g. the preview request
 * failed): the dialog then offers the plain create/cancel choice.
 */
let openPicker = null;

export function pickPartyLink(options = {}) {
  return new Promise((resolve) => {
    if (!openPicker) {
      // Host not mounted — degrade to a native confirm (create vs cancel).
      const ok = window.confirm(
        `Mark this party as also a ${options.counterpart || 'counterpart'}? `
        + 'A linked record will be created (or matched) on save.');
      resolve(ok ? { action: 'create' } : { action: 'cancel' });
      return;
    }
    openPicker({ ...options, resolve });
  });
}

export function PartyLinkPickerHost() {
  const [state, setState] = useState(null);

  useEffect(() => {
    openPicker = setState;
    return () => { openPicker = null; };
  }, []);

  if (!state) return null;

  const { counterpart = 'counterpart', preview, name, gstin, pan, resolve } = state;
  const finish = (result) => { resolve(result); setState(null); };

  const matched = preview && preview.matched;
  const suggestions = (preview && preview.suggestions) || [];
  const dash = (v) => (v && String(v).trim()) || '—';

  let title;
  let body;
  const footer = [];

  if (matched) {
    title = `Link to existing ${counterpart}?`;
    body = (
      <p className="text-slate-600">
        Found an existing {counterpart} matching on{' '}
        <span className="font-semibold">{preview.basis}</span>:{' '}
        <span className="font-semibold text-slate-800">&quot;{preview.name}&quot;</span>.
      </p>
    );
    footer.push(
      <button key="cancel" onClick={() => finish({ action: 'cancel' })}
        className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">
        Cancel
      </button>,
      <button key="link" autoFocus onClick={() => finish({ action: 'link', id: preview.id, name: preview.name })}
        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
        Link to it
      </button>,
    );
  } else if (suggestions.length > 0) {
    title = `Link to an existing ${counterpart}?`;
    body = (
      <div className="space-y-3">
        <p className="text-slate-600">No exact match. Closest existing {counterpart}s:</p>
        <ul className="space-y-2">
          {suggestions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-slate-800">{s.name}</span>
                {s.code && <span className="text-xs text-slate-500">{s.code}</span>}
              </span>
              <button onClick={() => finish({ action: 'link', id: s.id, name: s.name })}
                className="shrink-0 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
                Link
              </button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-500">
          None of these? A NEW {counterpart} will be created — Name: {dash(name)}, GSTIN: {dash(gstin)}, PAN: {dash(pan)}.
        </p>
      </div>
    );
    footer.push(
      <button key="cancel" onClick={() => finish({ action: 'cancel' })}
        className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">
        Cancel
      </button>,
      <button key="create" onClick={() => finish({ action: 'create' })}
        className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700">
        Create new
      </button>,
    );
  } else {
    title = `Create a linked ${counterpart}?`;
    body = (
      <p className="text-slate-600">
        No matching {counterpart} found. A NEW {counterpart} record will be created from these
        details — Name: <span className="font-medium text-slate-800">{dash(name)}</span>,
        GSTIN: <span className="font-medium text-slate-800">{dash(gstin)}</span>,
        PAN: <span className="font-medium text-slate-800">{dash(pan)}</span>.
      </p>
    );
    footer.push(
      <button key="cancel" onClick={() => finish({ action: 'cancel' })}
        className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">
        Cancel
      </button>,
      <button key="create" autoFocus onClick={() => finish({ action: 'create' })}
        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
        Create &amp; link
      </button>,
    );
  }

  return (
    <Modal isOpen title={title} size="sm" onClose={() => finish({ action: 'cancel' })} footer={footer}>
      {body}
    </Modal>
  );
}

export default pickPartyLink;
