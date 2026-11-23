from django.db import models
from rest_framework.permissions import BasePermission

from rbac.models import RolePermission, UserRoleAssignment


# All permission field names on RolePermission
ALL_PERM_FIELDS = [
    'can_view', 'can_create', 'can_edit', 'can_delete',
    'can_approve', 'can_reject', 'can_send_email', 'can_export', 'can_print',
    'can_confirm', 'can_close', 'can_cancel', 'can_issue', 'can_convert',
    # PR 3-stage approval flags — listed so check_permission()/can() can
    # test them programmatically (e.g. the WM edit-before-proceed gate).
    'can_submit', 'can_proceed_approval',
    'can_acknowledge',
    'can_create_dc',
    'can_create_so',
    'can_create_bom',
    'can_view_inbox',
    'can_create_freight',
    'can_return_customer', 'can_return_sales', 'can_return_damage', 'can_return_qc',
    'can_request_amendment', 'can_approve_amendment',
    'can_push_tally',
]


class HasModulePermission(BasePermission):
    """Check if user's ROLE has permission for the module.

    Set ``module_name`` on the view to the ERPModule.name value that
    should be checked.  The HTTP method is mapped to the corresponding
    permission flag (can_view, can_create, can_edit, can_delete).

    For custom actions, map view action names to permission fields via
    ``ACTION_PERM_MAP``.

    Superusers always pass.
    """

    # Modules that allow read-only access for any authenticated user
    # so that dropdown lookups work on form pages (e.g. PO list in receipt form)
    LOOKUP_MODULES = {
        # Every Scan-Inbox user reads the shared dropdown options; only ADDING
        # one (POST) is gated on this module's create permission.
        'Scan Categories',
        'Company', 'Warehouse', 'Godown',
        'Machinery Division', 'Machinery Expense', 'Expense Category',
        'Product',
        'Service Catalogue', 'Vendor', 'Customer', 'Transporter',
        'Price List', 'State Group', 'Tax Master', 'Template',
        # Transaction modules needed as lookups in downstream forms
        'Purchase Order', 'Purchase Request', 'RFQ', 'Quote',
        'Receipt Advice', 'Sales Order', 'Dispatch Challan',
        'Freight Advice', 'Freight Payment', 'Wage Entry',
        'Material Rejection',
        'Bank Account',
        # Production lookups: the Packing Process / Work Order create forms
        # pick a Work Order, a Process, and a BOM template (the BOM template
        # endpoint is gated on the 'BOM Request' module). Treat these as
        # read-only lookups so a warehouse-scoped operator who can create
        # packing runs can populate those dropdowns without being granted
        # full page access to each module. Data stays warehouse-filtered.
        'Work Order', 'Process', 'BOM Request',
    }

    # Map DRF view action names → permission field on RolePermission
    ACTION_PERM_MAP = {
        # Standard CRUD (handled by HTTP method, but explicit overrides)
        'list': 'can_view',
        'retrieve': 'can_view',
        'create': 'can_create',
        'update': 'can_edit',
        'partial_update': 'can_edit',
        'destroy': 'can_delete',
        'bulk_delete': 'can_delete',

        # Workflow actions
        'approve': 'can_approve',
        'reject': 'can_reject',
        'confirm': 'can_confirm',
        'submit': 'can_confirm',
        'proceed_to_approve': 'can_edit',
        'close_entry': 'can_close',
        'close': 'can_close',
        'complete': 'can_close',
        'cancel': 'can_cancel',
        'issue': 'can_issue',
        # Wage Voucher "Mark Paid" (APPROVED → PAID) — gated on the
        # Issue / Mark Paid button permission.
        'mark_paid': 'can_issue',
        # Dispatch Challan "Release for Dispatch" (DRAFT → RELEASED) —
        # gated on the Issue button permission for the Dispatch Challan module.
        'release': 'can_issue',

        # Conversion actions (PR→RFQ, RFQ→Quote, Quote→PO, etc.)
        'convert': 'can_convert',
        'create_rfq': 'can_convert',
        'create_po': 'can_convert',
        'create_receipt': 'can_convert',
        'create_dc': 'can_convert',
        'create_invoice': 'can_convert',
        # Convert a HELD PR line (PENDING_PRICE) into a DRAFT PO once
        # the operator has the price. Gated on can_edit because it's
        # really "supplement the PR + spawn a DRAFT PO"; the DRAFT
        # itself still needs its own approval before hitting the vendor.
        # Falling back to the method map (POST → can_create) blocked
        # every Purchase Coordinator from finishing the workflow.
        'convert_held_line': 'can_edit',
        # Bulk variant — multiple held lines into ONE DRAFT PO. Same
        # gate as the single-line convert; without this it fell back to
        # POST → can_create and 403'd the same coordinators.
        'convert_held_lines': 'can_edit',
        # Split a DRAFT PO into N DRAFT POs by batch quantity. Same
        # rationale as convert_held_line: the resulting DRAFTs still
        # need their own approval before the vendor sees them, so this
        # is an edit-level action, not create.
        'split': 'can_edit',

        # Communication
        'send_email': 'can_send_email',
        'send_rfq_email': 'can_send_email',
        'send_po_email': 'can_send_email',
        'preview_email': 'can_send_email',
        'send_emails': 'can_send_email',

        # Payment/Financial
        'record_payment': 'can_edit',
        'add_payment': 'can_edit',
        'delete_payment': 'can_edit',
        'apply_to_bill': 'can_apply_to_bill',
        # Generate a Debit Note (Vendor Credit) from a Receipt Advice — gated
        # on the Receipt Advice "Apply Debit" button permission, matching the
        # frontend button.
        'generate_debit_note': 'can_apply_debit',

        # "Go to Tally" — push a sales invoice into TallyPrime (or queue it
        # for the on-prem connector). Gated on the dedicated can_push_tally
        # flag so the button can be opened to Sales Coordinator alone,
        # instead of falling back to can_create for the POST.
        'tally_push': 'can_push_tally',

        # Other edit-level actions
        'edit_record': 'can_edit',
        'edit': 'can_edit',
        'update_status': 'can_edit',
        'add_line': 'can_create',
        'update_line': 'can_edit',
        'remove_line': 'can_edit',
        'mark_delivered': 'can_confirm',

        # Read-level actions (GET custom actions)
        'skip_rfq_po_data': 'can_view',
        'vendors': 'can_view',
        'payments': 'can_view',
        'list_payments': 'can_view',
        'vendor_advances': 'can_view',
        'available_for_bill': 'can_view',

        # Skip-RFQ: create a PO directly from a PR. Gated on the "Skip RFQ"
        # button permission (can_skip_rfq) — the very button the user clicks
        # to start this flow — NOT can_convert (which belongs to the normal
        # RFQ -> Quote -> PO conversion path). Using can_convert here meant a
        # role granted Skip RFQ still got "no permission" on Create PO.
        'skip_rfq_create_po': 'can_skip_rfq',

        # Export/Print
        'export': 'can_export',
        'download_pdf': 'can_print',
        'print': 'can_print',

        # Bulk import (.xlsx) — BulkImportMixin actions
        'import_bulk': 'can_import',
        'import_template': 'can_import',

        # Attach a voice note to a Stock Movement Request — part of raising it.
        'upload_audio': 'can_create',
    }

    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False

        # Superusers bypass all checks
        if request.user.is_superuser:
            return True

        module_name = getattr(view, 'module_name', None)
        if not module_name:
            return True

        # Allow read-only access to master/lookup modules for any authenticated user
        if request.method in ('GET', 'HEAD', 'OPTIONS') and module_name in self.LOOKUP_MODULES:
            return True

        # Get user's role
        try:
            assignment = UserRoleAssignment.objects.select_related('role').get(user=request.user)
            role = assignment.role
        except UserRoleAssignment.DoesNotExist:
            return False

        # Determine required permission field
        view_action = getattr(view, 'action', None)

        # Per-view override: a view can declare get_required_perm(request) to
        # pick the perm field based on request context (e.g. receipt_advice in
        # POST body switches a Vendor Bill create from can_create to can_convert).
        resolve = getattr(view, 'get_required_perm', None)
        perm_field = resolve(request) if callable(resolve) else None

        if not perm_field:
            if view_action and view_action in self.ACTION_PERM_MAP:
                perm_field = self.ACTION_PERM_MAP[view_action]
            else:
                # Default: map HTTP method to permission field
                method_map = {
                    'GET': 'can_view',
                    'HEAD': 'can_view',
                    'OPTIONS': 'can_view',
                    'POST': 'can_create',
                    'PUT': 'can_edit',
                    'PATCH': 'can_edit',
                    'DELETE': 'can_delete',
                }
                perm_field = method_map.get(request.method, 'can_view')

        has_perm = RolePermission.objects.filter(
            role=role,
            module__name=module_name,
            **{perm_field: True},
        ).exists()

        # Implicit-view rule: any mutate permission grants View.
        #
        # If the user can Create / Edit / Delete a record in a module
        # they MUST be able to read it too — otherwise after creating
        # a record they can't see what they just made (detail page
        # 403s, list 403s, etc.). This pattern keeps showing up as
        # "Failed to load <thing>" right after a successful create.
        # Easier to fix in one place than ask every admin to also
        # tick View whenever they tick Create/Edit/Delete.
        if not has_perm and perm_field == 'can_view':
            has_perm = RolePermission.objects.filter(
                role=role,
                module__name=module_name,
            ).filter(
                # any one of these → grants implicit View
                models.Q(can_create=True)
                | models.Q(can_edit=True)
                | models.Q(can_delete=True)
                | models.Q(can_approve=True)
                | models.Q(can_reject=True)
                | models.Q(can_confirm=True)
                | models.Q(can_close=True)
                | models.Q(can_cancel=True)
                | models.Q(can_issue=True)
                | models.Q(can_convert=True)
                | models.Q(can_send_email=True)
                | models.Q(can_export=True)
                | models.Q(can_print=True)
            ).exists()

        # Per-view extra permissions: a view can declare additional permission
        # fields that also grant access for a given action. Example: a Vendor
        # Bill created from a receipt is functionally a "convert" action, so the
        # create endpoint should accept either can_create OR can_convert.
        if not has_perm:
            extra_map = getattr(view, 'additional_action_perms', None) or {}
            extra_fields = extra_map.get(view_action) or []
            for field in extra_fields:
                if field not in ALL_PERM_FIELDS:
                    continue
                if RolePermission.objects.filter(
                    role=role,
                    module__name=module_name,
                    **{field: True},
                ).exists():
                    has_perm = True
                    break

        # Fallback: for payment-related actions on parent modules (e.g. add_payment on
        # Freight Advice), also check the payment-specific module (Freight Payment).
        #
        # Recording a payment CREATES a new record in the dedicated payment
        # module, so honor that module's Create checkbox — that's exactly what
        # an admin ticks on the "Freight Payment" / "Payment Made" row when they
        # want a role to be able to record payments. (The add_payment action
        # itself maps to can_edit, but the user never sees an "Edit" toggle for
        # a payment they're creating — they tick "Create".) Edit is still
        # accepted for back-compat. Deleting a payment checks Delete/Edit; the
        # read actions keep their View check (perm_field).
        if not has_perm and view_action in ('add_payment', 'delete_payment', 'record_payment', 'payments', 'list_payments'):
            PAYMENT_MODULE_MAP = {
                'Freight Advice': 'Freight Payment',   # inward / purchase freight
                'Sales Freight': 'Freight Payment',    # outward / sales freight
                'Vendor Bill': 'Payment Made',
            }
            payment_module = PAYMENT_MODULE_MAP.get(module_name)
            if payment_module:
                if view_action in ('add_payment', 'record_payment'):
                    fallback_fields = ('can_create', 'can_edit')
                elif view_action == 'delete_payment':
                    fallback_fields = ('can_delete', 'can_edit')
                else:  # payments / list_payments (read)
                    fallback_fields = (perm_field,)
                fallback_q = models.Q()
                for _f in fallback_fields:
                    fallback_q |= models.Q(**{_f: True})
                has_perm = RolePermission.objects.filter(
                    role=role,
                    module__name=payment_module,
                ).filter(fallback_q).exists()
            elif view_action in ('add_payment', 'record_payment', 'delete_payment'):
                # No dedicated payment module — the payment is recorded on the
                # module's OWN record (e.g. Receivable.record_payment, which
                # creates a payment row in place). Honor the module's own Create
                # checkbox for record/add (an admin ticks "Create" on the
                # Receivable row to let a role receive payments) and Delete for
                # delete_payment. Edit is already accepted via ACTION_PERM_MAP,
                # kept here for parity.
                self_fields = ('can_delete', 'can_edit') if view_action == 'delete_payment' else ('can_create', 'can_edit')
                self_q = models.Q()
                for _f in self_fields:
                    self_q |= models.Q(**{_f: True})
                has_perm = RolePermission.objects.filter(
                    role=role,
                    module__name=module_name,
                ).filter(self_q).exists()

        # Alternate modules: one endpoint reached from several menu items, each
        # with its OWN module, can list the others here — a role granted ANY of
        # them passes. Example: /payments-made/ backs Payments Made, Payables
        # Overview AND Payment Entries, so granting just Payment Entries must let
        # its list load. The implicit-view rule (any mutate flag ⇒ view) is
        # applied to the alternate too, matching the primary module above.
        if not has_perm:
            for alt_module in getattr(view, 'alternate_modules', None) or []:
                alt_q = models.Q(**{perm_field: True})
                if perm_field == 'can_view':
                    alt_q |= (models.Q(can_create=True) | models.Q(can_edit=True)
                              | models.Q(can_delete=True) | models.Q(can_approve=True)
                              | models.Q(can_reject=True) | models.Q(can_confirm=True)
                              | models.Q(can_close=True) | models.Q(can_cancel=True)
                              | models.Q(can_issue=True) | models.Q(can_convert=True)
                              | models.Q(can_send_email=True) | models.Q(can_export=True)
                              | models.Q(can_print=True))
                if RolePermission.objects.filter(
                        role=role, module__name=alt_module).filter(alt_q).exists():
                    has_perm = True
                    break

        # Phase 4: apply per-user overrides AFTER the full role-based
        # resolution. DENY wins when both are present for the same
        # (user, module, action) — matches the "least privilege"
        # principle: an explicit deny should never be overridden by
        # a co-existing grant.
        #
        # Imported lazily to avoid a circular import with the rbac
        # models module at app startup.
        from rbac.models import UserPermissionOverride
        overrides = UserPermissionOverride.objects.filter(
            user=request.user,
            module_name=module_name,
            action=perm_field,
        ).values_list('mode', flat=True)
        if overrides:
            if 'DENY' in overrides:
                has_perm = False
            elif 'GRANT' in overrides:
                has_perm = True

        return has_perm


def check_permission(user, module_name, action):
    """Utility to check role-based permission programmatically.

    ``can(user, action, module)`` style — works as both ``check_permission``
    and the ``can`` alias below.

    Args:
        user: Django User instance.
        module_name: Name of the ERPModule (e.g. 'Purchase Request').
        action: One of 'view', 'create', 'edit', 'delete', 'approve',
                'reject', 'send_email', 'export', 'print', 'confirm',
                'close', 'cancel', 'issue', 'convert'.

    Returns:
        bool
    """
    if user.is_superuser:
        return True
    try:
        assignment = UserRoleAssignment.objects.select_related('role').get(user=user)
    except UserRoleAssignment.DoesNotExist:
        return False

    field = f'can_{action}'
    if field not in ALL_PERM_FIELDS:
        return False

    return RolePermission.objects.filter(
        role=assignment.role,
        module__name=module_name,
        **{field: True},
    ).exists()


# Alias: can(user, 'approve', 'Purchase Order')
def can(user, action, module_name):
    """Shorthand: can(user, 'approve', 'Purchase Order') → bool."""
    return check_permission(user, module_name, action)


def get_user_role(user):
    """Get the ERP role for a user.

    Returns:
        ERPRole instance or None.
    """
    if user.is_superuser:
        return None  # superuser has all access
    try:
        return UserRoleAssignment.objects.select_related('role').get(user=user).role
    except UserRoleAssignment.DoesNotExist:
        return None
