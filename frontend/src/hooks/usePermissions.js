import { useState, useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import apiClient from '../utils/api.js';

let permCache = null;
let permCacheToken = null; // Track which token the cache belongs to

/**
 * All 14 permission fields returned from the RBAC API.
 * Useful for dynamic rendering (e.g., permission grid).
 */
export const PERMISSION_FIELDS = [
  { key: 'can_view', label: 'View' },
  { key: 'can_create', label: 'Create' },
  { key: 'can_edit', label: 'Edit' },
  { key: 'can_delete', label: 'Delete' },
  { key: 'can_approve', label: 'Approve' },
  { key: 'can_reject', label: 'Reject' },
  { key: 'can_confirm', label: 'Confirm' },
  { key: 'can_close', label: 'Close' },
  { key: 'can_cancel', label: 'Cancel' },
  { key: 'can_issue', label: 'Issue' },
  { key: 'can_convert', label: 'Convert' },
  { key: 'can_send_email', label: 'Send Email' },
  { key: 'can_export', label: 'Export' },
  { key: 'can_print', label: 'Print' },
  { key: 'can_acknowledge', label: 'Acknowledge' },
  { key: 'can_create_dc', label: 'Create DC' },
  { key: 'can_create_so', label: 'Create SO' },
  { key: 'can_create_bom', label: 'Create BOM' },
  { key: 'can_view_inbox', label: 'View Inbox' },
  { key: 'can_create_freight', label: 'Create Freight' },
  { key: 'can_push_tally', label: 'Push Tally' },
];

export default function usePermissions() {
  // Watch the Redux auth token — when it changes (login/logout), refetch permissions
  const authToken = useSelector(state => state.auth.token);

  const [permissions, setPermissions] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuperuser, setIsSuperuser] = useState(false);
  const [role, setRole] = useState(null);
  const [staff, setStaff] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  // True when the permissions fetch failed for a TRANSIENT reason (server
  // unreachable or 5xx) rather than a real auth failure. Lets the UI show a
  // "can't reach the server" state instead of pretending access was revoked.
  const [error, setError] = useState(false);
  // Bumped on a timer while `error` is set, to re-attempt the fetch so the app
  // recovers on its own once the backend comes back.
  const [retry, setRetry] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    if (!error) return undefined;
    const id = setInterval(() => setRetry((r) => r + 1), 8000);
    return () => clearInterval(id);
  }, [error]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    // If no token, reset everything
    if (!authToken) {
      permCache = null;
      permCacheToken = null;
      setPermissions([]);
      setIsAdmin(false);
      setIsSuperuser(false);
      setRole(null);
      setStaff(null);
      setIsLoading(false);
      return;
    }

    // If cache is valid for THIS token, use it
    if (permCache && permCacheToken === authToken) {
      setPermissions(permCache.perms || []);
      setIsAdmin(permCache.isAdmin || false);
      setIsSuperuser(permCache.isSuperuser || false);
      setRole(permCache.role || null);
      setStaff(permCache.staff || null);
      setIsLoading(false);
      setError(false);
      return;
    }

    // Token changed or no cache — fetch fresh.
    //
    // Resilient fetch: a Render redeploy (auto-deploy on every push to main)
    // swaps the instance out for a few seconds, and a cold start after idle can
    // take longer than a normal request. Both surface as "no response / 5xx" and
    // used to flash the "Can't reach the server" screen on every gated page. So
    // we give this one call a longer timeout AND a couple of quiet quick retries
    // before surfacing the error — a brief restart window just waits a beat and
    // loads instead. A real auth error (4xx) still bubbles out immediately.
    const fetchPerms = async (attempts = 3) => {
      let lastErr;
      for (let i = 0; i < attempts; i++) {
        try {
          return await apiClient.get('/api/rbac/my-permissions/', { timeout: 60000 });
        } catch (e) {
          const st = e?.response?.status;
          if (!(st == null || st >= 500)) throw e;   // 4xx → genuine, don't retry
          lastErr = e;
          if (i < attempts - 1) {
            await new Promise((r) => setTimeout(r, 1500 * (i + 1)));  // 1.5s, 3s
          }
        }
      }
      throw lastErr;
    };

    setIsLoading(true);
    fetchPerms()
      .then(res => {
        if (!mounted.current) return;
        const data = res.data || {};
        const perms = data.permissions || [];
        const admin = data.is_admin || false;
        const superuser = data.is_superuser || false;
        const userRole = data.role || null;
        const userStaff = data.staff || null;

        // Cache with token association
        permCache = { perms, isAdmin: admin || superuser, isSuperuser: superuser, role: userRole, staff: userStaff };
        permCacheToken = authToken;

        setPermissions(perms);
        setIsAdmin(admin || superuser);
        setIsSuperuser(superuser);
        setRole(userRole);
        setStaff(userStaff);
        setError(false);
      })
      .catch((err) => {
        if (!mounted.current) return;
        const status = err?.response?.status;
        // Transient: the server is unreachable (network error → no response) or
        // erroring (5xx). Do NOT clear the cache or zero out access — that would
        // demote an admin to a permission-less "Member" and bounce every gated
        // page to the one ungated route. Keep whatever we last knew and flag the
        // error; the retry timer above re-attempts until the backend recovers.
        if (status == null || status >= 500) {
          setError(true);
          return;
        }
        // Genuine auth failure (401/403/…): the token is bad or access was
        // actually removed. Clear so the app reflects that.
        permCache = null;
        permCacheToken = null;
        setPermissions([]);
        setIsAdmin(false);
        setIsSuperuser(false);
        setRole(null);
        setStaff(null);
        setError(false);
      })
      .finally(() => {
        if (mounted.current) setIsLoading(false);
      });
  }, [authToken, retry]); // Re-run on token change (login/logout/switch user) and on retry ticks while erroring

  // ─── Generic permission checker ────────────────────────────────────
  const _check = (moduleName, field) => {
    if (isAdmin || isSuperuser) return true;
    if (isLoading) return false;
    return permissions.some(p =>
      (p.module_name === moduleName || p.module?.name === moduleName) && p[field]
    );
  };

  // ─── CRUD permissions ──────────────────────────────────────────────
  const canView       = (m) => _check(m, 'can_view');
  const canCreate     = (m) => _check(m, 'can_create');
  const canEdit       = (m) => _check(m, 'can_edit');
  const canDelete     = (m) => _check(m, 'can_delete');

  // ─── Action permissions ─────────────────���──────────────────────────
  const canApprove    = (m) => _check(m, 'can_approve');
  const canReject     = (m) => _check(m, 'can_reject');
  // PR 3-stage approval: submit (stage 1) + proceed-to-approve (stage 2).
  const canSubmit          = (m) => _check(m, 'can_submit');
  const canProceedApproval = (m) => _check(m, 'can_proceed_approval');
  const canConfirm    = (m) => _check(m, 'can_confirm');
  const canClose      = (m) => _check(m, 'can_close');
  const canCancel     = (m) => _check(m, 'can_cancel');
  const canIssue      = (m) => _check(m, 'can_issue');
  const canConvert    = (m) => _check(m, 'can_convert');

  // ─── Utility permissions ────────────���──────────────────────────────
  const canSendEmail  = (m) => _check(m, 'can_send_email');
  const canExport     = (m) => _check(m, 'can_export');
  const canPrint      = (m) => _check(m, 'can_print');
  // Bulk .xlsx import — gates the "Import" button on the master list pages.
  const canImport     = (m) => _check(m, 'can_import');
  // Distinct from canConfirm — used by the factory stock-check
  // workflow ("factory accepts ownership of the matrix") on the
  // Sales Order module. Backed by RolePermission.can_acknowledge.
  const canAcknowledge = (m) => _check(m, 'can_acknowledge');
  // Dedicated SO→DC button gate. Backed by RolePermission.can_create_dc.
  // Admins tick it on the Sales Order row in the Sales Module Permissions
  // admin grid; the backend's CreateDispatchChallanPermission accepts
  // this flag as authorization for the DC create endpoint, so a single
  // tick covers both UI visibility and the actual save.
  const canCreateDc = (m) => _check(m, 'can_create_dc');
  // Dedicated CPO→SO button gate. Sibling of canCreateDc. Admins tick
  // it on the Customer PO row; backend CreateSalesOrderPermission
  // honors this flag for the SO create endpoint.
  const canCreateSo = (m) => _check(m, 'can_create_so');
  // Customer PO Inbox button gate. The Inbox is the IMAP-backed
  // email view at /sales/customer-po/inbox. Admins tick this on the
  // Customer PO row to grant a role the Inbox button + page access.
  const canViewInbox = (m) => _check(m, 'can_view_inbox');
  // Dispatch Challan → Outward Freight button. Admins tick this on
  // the Dispatch Challan row in the admin grid; gates the orange
  // "Freight" / "Create Freight" buttons on the DC list + detail pages.
  const canCreateFreight = (m) => _check(m, 'can_create_freight');
  // SO Factory Stock Check → "Create BOM Template" button gate. Admins
  // tick this on the Sales Order row to grant a factory role the
  // ability to seed a missing BOM directly from the matrix row, without
  // also granting broader Product BOM master write access.
  const canCreateBom = (m) => _check(m, 'can_create_bom');
  // RFQ → "Quote Response" button gate. Admins tick this on the RFQ
  // row in the admin grid; gates the purple "Quote Response" button on
  // the RFQ list rows (captures the vendor's reply). Distinct from
  // can_create on the Quote module so a role can be limited to
  // capturing RFQ replies without also being able to create
  // free-standing quotes.
  const canQuoteResponse = (m) => _check(m, 'can_quote_response');
  // Quote → "Evaluate" button gate. Admins tick this on the Quote
  // row in the admin grid; gates the "Evaluate" button on each Quote
  // row of the Quote list (Quote → Quote Evaluation conversion flow).
  // Distinct from can_create on the Quote Evaluation module so a role
  // can be limited to starting an evaluation against an existing
  // quote without being able to invent free-standing evaluations.
  const canEvaluate = (m) => _check(m, 'can_evaluate');
  // Receipt Advice → "Bill" button gate. Admins tick this on the
  // Receipt Advice row in the admin grid; gates the inline "Bill"
  // button on each receipt row (Receipt → Vendor Bill conversion).
  // Distinct from can_create on the Vendor Bill module so a role can
  // be limited to converting receipts without being able to invent
  // free-standing bills.
  const canCreateBill = (m) => _check(m, 'can_create_bill');
  // Receipt Advice → "Wages" button gate. Admins tick this on the
  // Receipt Advice row in the admin grid; gates the inline "Wages"
  // button on each receipt row (Receipt → Wage Entry conversion for
  // loading / unloading wages). Distinct from can_create on the Wage
  // Entry module so a role can be limited to receipt-linked wage
  // entries without broader wage-create capability.
  const canCreateWage = (m) => _check(m, 'can_create_wage');
  // Vendor Bill → "Record Payment" / "Apply Debit" / "Apply Credit" /
  // "Apply Advance" button gates. All four dedicated flags live on the
  // Vendor Bill row of the admin grid so admins can give a role the
  // ability to settle bills without also granting unrelated bill-write
  // capability. Pass the module name (typically 'Vendor Bill').
  const canRecordPayment = (m) => _check(m, 'can_record_payment');
  const canApplyDebit    = (m) => _check(m, 'can_apply_debit');
  const canApplyCredit   = (m) => _check(m, 'can_apply_credit');
  const canApplyAdvance  = (m) => _check(m, 'can_apply_advance');
  // Purchase Request → "Skip RFQ" button gate. Admins tick this on the
  // Purchase Request row in the admin grid; gates the Skip RFQ button
  // on the PR detail page that bypasses the RFQ stage and auto-cuts
  // the PO from the PR's preferred vendor.
  const canSkipRfq = (m) => _check(m, 'can_skip_rfq');
  // Receipt Advice → "Direct Receipt" source toggle gate. A direct receipt
  // posts stock IN with no upstream PO (rate/GST keyed by hand), so admins
  // grant it on the Receipt Advice row separately from create rights.
  const canDirectReceipt = (m) => _check(m, 'can_direct_receipt');
  // PO amendment workflow: raise vs approve an amendment on an approved PO.
  const canRequestAmendment = (m) => _check(m, 'can_request_amendment');
  const canApproveAmendment = (m) => _check(m, 'can_approve_amendment');
  // Sales Invoice → "Go to Tally" button gate. Admins tick this on the
  // Sales Invoice row in the Sales Module Permissions admin grid; it's
  // opened to Sales Coordinator so they can push/queue invoices to Tally
  // without broader invoice edit rights. Backed by RolePermission.can_push_tally.
  const canPushTally = (m) => _check(m, 'can_push_tally');

  /**
   * Generic checker: can(moduleName, 'approve') → bool
   * Useful for dynamic permission checks from config objects.
   */
  const can = (moduleName, action) => _check(moduleName, `can_${action}`);

  return {
    permissions, isLoading, error, isAdmin, isSuperuser, role, staff,
    // CRUD
    canView, canCreate, canEdit, canDelete,
    // Actions
    canApprove, canReject, canSubmit, canProceedApproval, canConfirm, canClose, canCancel, canIssue, canConvert,
    canAcknowledge, canCreateDc, canCreateSo, canCreateBom, canViewInbox, canCreateFreight, canQuoteResponse, canEvaluate, canCreateBill, canCreateWage,
    canRecordPayment, canApplyDebit, canApplyCredit, canApplyAdvance, canSkipRfq, canDirectReceipt,
    canRequestAmendment, canApproveAmendment, canPushTally,
    // Utilities
    canSendEmail, canExport, canPrint, canImport,
    // Generic
    can,
  };
}

/**
 * Clear the permissions cache (e.g., after role/permission change).
 */
export function clearPermissionsCache() {
  permCache = null;
  permCacheToken = null;
}
