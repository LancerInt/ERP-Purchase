import { useEffect } from 'react';

/**
 * Warn before leaving a form with unsaved changes.
 *
 * Wires `window.beforeunload` while `isDirty` is true, so a browser
 * refresh, tab-close, or hardware back prompts the native
 * "Leave site? Changes you made may not be saved." dialog — the most
 * common way data-entry work gets lost on a long ERP form.
 *
 * Usage:
 *   const [form, setForm] = useState(initial);
 *   useUnsavedChanges(JSON.stringify(form) !== JSON.stringify(initial));
 *
 * Note on in-app navigation: blocking React-Router navigations (clicking a
 * sidebar link / Cancel) requires the data router (createBrowserRouter +
 * useBlocker), which this app's <Routes> tree doesn't use. For that path,
 * gate the Cancel/navigate handler with the shared confirm():
 *   const leave = async () => {
 *     if (dirty && !(await confirm({ message: 'Discard unsaved changes?', isDangerous: true }))) return;
 *     navigate(-1);
 *   };
 */
export default function useUnsavedChanges(isDirty) {
  useEffect(() => {
    if (!isDirty) return undefined;
    const handler = (e) => {
      e.preventDefault();
      // Required for the prompt to show in Chrome/Edge; the string is ignored
      // by modern browsers (they show their own generic message).
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);
}
