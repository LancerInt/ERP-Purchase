import { useState, useEffect } from 'react';
import Modal from '../ui/Modal';
import VoiceDictation from './VoiceDictation.jsx';

/**
 * App-wide text-input dialog — a styled, accessible replacement for the
 * native `window.prompt`. Mount <PromptHost /> once near the app root, then
 * call `await promptText({ ... })` anywhere; it resolves to the entered
 * string, or `null` if cancelled — same contract as window.prompt, so
 * `result === null` cancel checks at the call site keep working.
 *
 *   const reason = await promptText({ title: 'Reject', label: 'Reason',
 *                                     multiline: true, required: true });
 *   if (reason === null) return;
 *
 * Falls back to the native prompt if the host isn't mounted, so it never
 * silently no-ops.
 */
let openPrompt = null;

export function promptText(options = {}) {
  const opts = typeof options === 'string' ? { label: options } : options;
  return new Promise((resolve) => {
    if (!openPrompt) {
      resolve(window.prompt(opts.label || opts.message || ''));
      return;
    }
    openPrompt({ ...opts, resolve });
  });
}

export function PromptHost() {
  const [state, setState] = useState(null);
  const [value, setValue] = useState('');
  // When the prompt is opened with voice:true, the recorded audio clip (from
  // VoiceDictation.onAudio) is held here and handed back alongside the text.
  const [audioFile, setAudioFile] = useState(null);

  useEffect(() => {
    openPrompt = (s) => { setValue(s.defaultValue || ''); setAudioFile(null); setState(s); };
    return () => { openPrompt = null; };
  }, []);

  if (!state) return null;

  const required = !!state.required;
  // In voice mode a recorded clip alone satisfies "required" even with no typed
  // text — a spoken reason is still a reason.
  const canSubmit = !required || value.trim().length > 0 || !!audioFile;
  const finish = (result) => { state.resolve(result); setState(null); setValue(''); setAudioFile(null); };
  const onCancel = () => finish(null);
  // Voice mode resolves to { text, audioFile } so the caller can attach the
  // clip; non-voice callers keep the original string | null contract.
  const onSubmit = (e) => {
    if (e) e.preventDefault();
    if (!canSubmit) return;
    finish(state.voice ? { text: value, audioFile } : value);
  };

  return (
    <Modal isOpen onClose={onCancel} title={state.title || 'Enter a value'} size="sm">
      <form onSubmit={onSubmit}>
        {state.label && (
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-sm text-slate-600">
              {state.label}{required && <span className="text-red-500"> *</span>}
            </label>
            {state.voice && (
              <VoiceDictation
                onText={(t) => setValue((v) => (v ? `${v} ${t}` : t))}
                onAudio={(file) => setAudioFile(file)}
              />
            )}
          </div>
        )}
        {state.multiline ? (
          <textarea
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={state.placeholder || ''}
            rows={3}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        ) : (
          <input
            autoFocus
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={state.placeholder || ''}
            onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(e); }}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        )}
        {state.voice && audioFile && (
          <div className="mt-2 flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5">
            <span className="font-medium">🎙 Voice note recorded</span>
            <audio controls src={URL.createObjectURL(audioFile)} className="h-7 max-w-[200px]" />
            <button type="button" onClick={() => setAudioFile(null)} className="ml-auto text-slate-400 hover:text-red-600" title="Discard clip">✕</button>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50">
            {state.cancelLabel || 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={`px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50 ${state.isDangerous ? 'bg-red-600 hover:bg-red-700' : 'bg-primary-600 hover:bg-primary-700'}`}
          >
            {state.confirmLabel || 'OK'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default promptText;
