/**
 * Wrap a form's field region so it becomes genuinely read-only when the user
 * lacks edit permission — instead of showing editable-looking fields whose
 * save is merely blocked.
 *
 * It renders a `<fieldset disabled>`, which natively locks every input /
 * textarea / select / button inside; scoped CSS (globals.css, `.edit-gate`)
 * then styles the locked fields as clearly read-only (muted, not-allowed).
 *
 * Keep page-level chrome (Back, Print, breadcrumbs) OUTSIDE this wrapper —
 * only the editable form fields (and their add/remove buttons) go inside.
 *
 *   const { canEdit } = usePermissions();
 *   <EditGate canEdit={canEdit('Vendor')}>
 *     …form fields…
 *   </EditGate>
 *
 * `min-w-0 p-0 m-0 border-0` neutralises the browser's default fieldset box so
 * it doesn't affect layout.
 */
export default function EditGate({ canEdit = true, children, className = '' }) {
  return (
    <fieldset disabled={!canEdit} className={`edit-gate min-w-0 p-0 m-0 border-0 ${className}`}>
      {children}
    </fieldset>
  );
}
