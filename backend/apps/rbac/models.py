from django.db import models
from django.conf import settings


PREDEFINED_ROLES = [
    'Office Manager',
    'Purchase Manager',
    'Purchase Coordinator',
    'Sales Manager',
    'Sales Coordinator',
    'Finance Manager',
    'Accounts Manager',
    'Freight Coordinator',
    'QC Manager',
    'QC Coordinator',
    'QC Analyst',
    'Warehouse Manager',
    'Warehouse Coordinator',
    'Warehouse Supervisor',
    'Warehouse Coordinator (Office)',
    'HR Coordinator (Office)',
    'Warehouse HR Coordinator',
    'IT Admin',
]


class ERPRole(models.Model):
    """Predefined ERP roles for the organization."""

    name = models.CharField(max_length=100, unique=True)
    description = models.TextField(blank=True, default='')
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    # Two-factor login (see mfa app + core.jwt_auth) is opt-in by default —
    # this flags a role where it's mandatory instead (e.g. IT Admin,
    # Finance). A user in a flagged role who hasn't set up TOTP yet still
    # gets a normal login (never a hard lockout — see
    # MessagefulTokenObtainPairSerializer's `must_setup_mfa` flag), but the
    # frontend forces them through setup before anything else.
    mfa_required = models.BooleanField(
        default=False,
        help_text='Users in this role must have two-factor login set up.',
    )

    class Meta:
        db_table = 'rbac_erp_role'
        ordering = ['name']
        verbose_name = 'ERP Role'
        verbose_name_plural = 'ERP Roles'

    def __str__(self):
        return self.name


class ERPModule(models.Model):
    """ERP modules available in the system."""

    CATEGORY_CHOICES = [
        ('PURCHASE', 'Purchase'),
        ('SALES', 'Sales'),
        ('FREIGHT', 'Freight/Wage Billing'),
        ('PRODUCTION', 'Production'),
        ('QUALITY', 'Quality'),
        ('INVENTORY', 'Inventory'),
        ('FINANCE', 'Finance'),
        ('BANK', 'Bank'),
        ('HR', 'HR'),
        ('MASTERS', 'Masters'),
        ('ADMIN', 'Admin'),
        # Added later (modules were seeded into these via migrations, so the
        # choices had drifted behind the data); needed so the admin UI can
        # create modules under these cards.
        ('REPORTS', 'Reports'),
        ('EXPENSES', 'Expenses'),
        ('IMPORT', 'Import Data'),
    ]

    name = models.CharField(max_length=150, unique=True)
    slug = models.SlugField(max_length=150, unique=True)
    description = models.TextField(blank=True, default='')
    icon = models.CharField(max_length=50, blank=True, default='')
    category = models.CharField(max_length=20, choices=CATEGORY_CHOICES, default='', blank=True)
    order = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = 'rbac_erp_module'
        ordering = ['order', 'name']
        verbose_name = 'ERP Module'
        verbose_name_plural = 'ERP Modules'

    def __str__(self):
        return self.name


class ERPPermission(models.Model):
    """Per-user, per-module permission grants."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='erp_permissions',
    )
    module = models.ForeignKey(
        ERPModule,
        on_delete=models.CASCADE,
        related_name='permissions',
    )
    can_view = models.BooleanField(default=False)
    can_create = models.BooleanField(default=False)
    can_edit = models.BooleanField(default=False)
    can_delete = models.BooleanField(default=False)
    granted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='permissions_granted',
    )
    granted_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'rbac_erp_permission'
        unique_together = ('user', 'module')
        ordering = ['user', 'module__order']
        verbose_name = 'ERP Permission'
        verbose_name_plural = 'ERP Permissions'

    def __str__(self):
        flags = []
        if self.can_view:
            flags.append('V')
        if self.can_create:
            flags.append('C')
        if self.can_edit:
            flags.append('E')
        if self.can_delete:
            flags.append('D')
        return f'{self.user} - {self.module} [{",".join(flags)}]'


class RolePermission(models.Model):
    """Role-based permission for each module. Users inherit via their role."""
    role = models.ForeignKey(ERPRole, on_delete=models.CASCADE, related_name='permissions')
    module = models.ForeignKey(ERPModule, on_delete=models.CASCADE, related_name='role_permissions')
    can_view = models.BooleanField(default=False)
    can_create = models.BooleanField(default=False)
    can_edit = models.BooleanField(default=False)
    can_delete = models.BooleanField(default=False)
    # Action-level permissions
    can_approve = models.BooleanField(default=False)
    can_reject = models.BooleanField(default=False)
    # PR multi-stage approval. can_submit lets a role SUBMIT a draft PR
    # (DRAFT → PENDING); can_proceed_approval lets a role advance a
    # submitted PR to the final approver (PENDING → PENDING_APPROVAL).
    # Both are distinct from can_approve (the final PENDING_APPROVAL →
    # APPROVED step) so the three PR stages — Warehouse Coordinator →
    # Warehouse Manager → Purchase Coordinator — can each be granted to a
    # different role from the permission grid.
    can_submit = models.BooleanField(default=False)
    can_proceed_approval = models.BooleanField(default=False)
    can_send_email = models.BooleanField(default=False)
    can_export = models.BooleanField(default=False)
    can_print = models.BooleanField(default=False)
    # Bulk data import (.xlsx upload) — gates the "Import" button on the
    # master list pages (Products, Customers, Vendors, …) and the backend
    # import_bulk / import_template actions. Distinct from can_create so
    # admins can grant row-by-row creation without granting bulk upload.
    can_import = models.BooleanField(default=False)
    # Workflow-level permissions
    can_confirm = models.BooleanField(default=False)
    can_close = models.BooleanField(default=False)
    can_cancel = models.BooleanField(default=False)
    can_issue = models.BooleanField(default=False)
    can_convert = models.BooleanField(default=False)
    # Acknowledge — distinct from Confirm. Used today by the factory
    # stock-check workflow on a Sales Order (factory user accepts
    # ownership of the matrix). Kept as its own flag so admins can
    # grant the right to acknowledge without also granting the broader
    # Confirm capability used for finalizing other documents.
    can_acknowledge = models.BooleanField(default=False)
    # Create DC — dedicated permission for the "Create Dispatch
    # Challan" button on the Sales Order detail/list pages (SO→DC
    # conversion flow). Distinct from `can_convert` (generic) and
    # `can_create` on the Dispatch Challan module (DC-from-scratch).
    # Admins tick this on the Sales Order row in the admin grid to
    # grant a role the SO→DC button without also granting unrelated
    # Convert or DC-create permissions.
    can_create_dc = models.BooleanField(default=False)
    # Create SO — dedicated permission for the "Create Sales Order"
    # button on the Customer PO detail/list pages (CPO→SO conversion
    # flow). Same shape as can_create_dc: admins tick this on the
    # Customer PO row to grant a role the CPO→SO button without also
    # granting unrelated Convert or SO-create permissions.
    can_create_so = models.BooleanField(default=False)
    # View Inbox — dedicated permission for the "Inbox" button on the
    # Customer PO list page (IMAP email ingestion view for incoming
    # POs). Admins tick this on the Customer PO row to grant a role
    # access to the inbox without granting the broader Customer PO
    # write capabilities.
    can_view_inbox = models.BooleanField(default=False)
    # Create Freight — dedicated permission for the "Freight" / "Create
    # Freight" button on the Dispatch Challan list + detail pages. The
    # button kicks off an outward freight advice from a released DC.
    # Admins tick this on the Dispatch Challan row so logistics-only
    # roles can raise a freight advice without also being granted
    # broader DC-create or generic Convert permissions.
    can_create_freight = models.BooleanField(default=False)
    # Create BOM — dedicated permission for the "Create BOM Template"
    # button that appears inline on the SO Factory Stock Check matrix
    # for products with no BOM yet at the SO's warehouse. Admins tick
    # this on the Sales Order row so factory roles can seed missing
    # BOMs without being granted the broader Product BOM master write
    # capability.
    can_create_bom = models.BooleanField(default=False)
    # Quote Response — dedicated permission for the "Quote Response"
    # button on the RFQ list page (RFQ → Quote conversion flow).
    # Same shape as can_create_dc / can_create_so: admins tick this on
    # the RFQ row to grant a role the right to capture a vendor's quote
    # response without also granting the broader Quote-create capability
    # (which would let them create stand-alone quotes outside the RFQ
    # flow).
    can_quote_response = models.BooleanField(default=False)
    # Evaluate — dedicated permission for the "Evaluate" button on each
    # Quote row of the Quote list page (Quote → Quote Evaluation
    # conversion flow). Admins tick this on the Quote row so a role can
    # kick off an evaluation against a specific quote without also being
    # granted the broader Quote Evaluation create capability (which
    # would let them open evaluations not tied to any quote).
    can_evaluate = models.BooleanField(default=False)
    # Create Bill — dedicated permission for the "Bill" button on each
    # Receipt row of the Receipt Advice list page (Receipt → Vendor
    # Bill conversion flow). Admins tick this on the Receipt Advice row
    # so a role can convert receipts into bills without also being
    # granted the broader Vendor Bill can_create (which would let them
    # invent stand-alone bills outside the receipt flow).
    can_create_bill = models.BooleanField(default=False)
    # Create Wage — dedicated permission for the "Wages" button on each
    # Receipt row (Receipt → Wage Entry conversion flow for loading /
    # unloading wages). Admins tick this on the Receipt Advice row so a
    # role can raise wage entries against a receipt without also being
    # granted the broader Wage Entry can_create capability.
    can_create_wage = models.BooleanField(default=False)
    # Record Payment — dedicated permission for the "Record Payment"
    # button on the Vendor Bill detail page (Bill → PaymentMade flow).
    # Distinct from can_create on Payment Made so a role can record
    # payments against an existing bill without being able to invent
    # free-standing payments.
    can_record_payment = models.BooleanField(default=False)
    # Apply Debit — dedicated permission for the "Apply Debit" button on
    # the Vendor Bill detail page. Settles part of the bill with an
    # approved Debit Note (Vendor Credit, credit_type=DEBIT).
    can_apply_debit = models.BooleanField(default=False)
    # Apply Credit — dedicated permission for the "Apply Credit" button
    # on the Vendor Bill detail page. Settles part of the bill with an
    # approved Credit Note (Vendor Credit, credit_type=CREDIT).
    can_apply_credit = models.BooleanField(default=False)
    # Apply Advance — dedicated permission for the "Apply Advance"
    # button on the Vendor Bill detail page. Settles part of the bill
    # with an approved Vendor Advance (Vendor Credit, type=ADVANCE).
    can_apply_advance = models.BooleanField(default=False)
    # Apply to Vendor Bill — dedicated permission for the "Apply to
    # Vendor Bill" button on the Vendor Credit (Debit/Credit Note,
    # Advance) detail page. Settles part of a bill from the credit's
    # side — the mirror of the Apply Debit/Credit/Advance buttons that
    # live on the Vendor Bill page.
    can_apply_to_bill = models.BooleanField(default=False)
    # Skip RFQ — dedicated permission for the "Skip RFQ" button on the
    # Purchase Request detail page. Bypasses the normal RFQ → Quote →
    # Evaluation chain: auto-approves the PR (DRAFT → APPROVED) and
    # cuts the PO in DRAFT against the preferred vendor in one shot.
    # Admins tick this on the Purchase Request row so a role can take
    # the shortcut without also getting blanket PR / PO create rights.
    can_skip_rfq = models.BooleanField(default=False)
    # Direct Receipt — gates the "Direct Receipt" source toggle on the
    # Create Receipt Advice page. A direct receipt records stock IN with no
    # upstream PO (emergency / sample / opening stock) and the user keys the
    # rate + GST by hand, so it's a privileged shortcut admins grant on the
    # Receipt Advice row separately from normal receipt-create rights.
    can_direct_receipt = models.BooleanField(default=False)
    # Return Type access — gates which options appear in the "Return Type"
    # dropdown on the Create Return page (Sales Return module). Admins tick
    # the types a role may raise; deny-by-default so only granted types show.
    can_return_customer = models.BooleanField(default=False)
    can_return_sales = models.BooleanField(default=False)
    can_return_damage = models.BooleanField(default=False)
    can_return_qc = models.BooleanField(default=False)
    # PO amendment workflow — change an already-APPROVED Purchase Order.
    # The coordinator raises an amendment request (proposed new prices / data
    # + reason); a manager/admin reviews and approves it to apply. The two
    # flags split the two ends so a coordinator can raise but not self-approve.
    can_request_amendment = models.BooleanField(default=False)
    can_approve_amendment = models.BooleanField(default=False)
    # Requirement-type ROW scope for the purchase chain — only meaningful on a
    # role's 'Purchase Request' permission row. Tick the types this role may
    # access; the scope cascades PR → RFQ → Quote → Evaluation → PO. Leaving
    # ALL THREE unchecked means "no restriction" (see every type) — the safe
    # default so existing roles/managers aren't accidentally locked out.
    req_scope_goods = models.BooleanField(default=False)
    req_scope_services = models.BooleanField(default=False)
    req_scope_machinery = models.BooleanField(default=False)
    # "Go to Tally" button gate — push (or connector-queue) a sales invoice
    # into TallyPrime. Dedicated flag so the import-to-Tally action can be
    # opened to a specific role (Sales Coordinator) without also granting
    # broader invoice create/edit rights.
    can_push_tally = models.BooleanField(default=False)

    class Meta:
        db_table = 'rbac_role_permission'
        unique_together = ['role', 'module']
        ordering = ['role__name', 'module__name']

    def __str__(self):
        return f"{self.role.name} - {self.module.name}"


class UserRoleAssignment(models.Model):
    """Links a Django user to an ERP role."""
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='erp_role_assignment',
    )
    role = models.ForeignKey(ERPRole, on_delete=models.PROTECT, related_name='users')
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name='+',
    )
    assigned_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'rbac_user_role'

    def __str__(self):
        return f"{self.user.username} → {self.role.name}"


class AuditLog(models.Model):
    """Audit trail for RBAC-related actions."""

    ACTION_CHOICES = (
        ('CREATE', 'Create'),
        ('VIEW', 'View'),
        ('EDIT', 'Edit'),
        ('DELETE', 'Delete'),
        ('LOGIN', 'Login'),
        ('LOGOUT', 'Logout'),
        # Distinct from EDIT so admins can answer "when was the user's
        # password last changed?" without scanning every edit event.
        ('PASSWORD', 'Password Change'),
        # An admin clearing someone's second factor (lost phone + spent
        # backup codes). Kept separate from EDIT because it is a security
        # event in its own right — it is the one action that takes 2FA off
        # an account, so it must be answerable on its own.
        ('MFA_RESET', 'Two-Factor Reset'),
    )

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='rbac_audit_logs',
    )
    role_name = models.CharField(max_length=100, blank=True, default='')
    module_name = models.CharField(max_length=150, blank=True, default='')
    action = models.CharField(max_length=10, choices=ACTION_CHOICES)
    details = models.TextField(blank=True, default='')
    # Optional record reference — lets the per-record "Activity Log" tab
    # on a detail page pull just that record's events (PR-2026-00001,
    # PO-TVP-26-27-005, etc.). Stored as the record UUID string to avoid
    # cross-app FK entanglement. record_repr is the human-readable label
    # (pr_no / po_no / vendor_name) captured at log time, so the trail
    # stays readable even if the source row is later renamed or deleted.
    record_id = models.CharField(max_length=64, blank=True, default='', db_index=True)
    record_repr = models.CharField(max_length=255, blank=True, default='')
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'rbac_audit_log'
        ordering = ['-timestamp']
        verbose_name = 'Audit Log'
        verbose_name_plural = 'Audit Logs'
        indexes = [
            # Speeds up the per-record activity tab (module + record_id
            # filter) — the hot query.
            models.Index(fields=['module_name', 'record_id'], name='audit_module_record_idx'),
            # Every list-page query orders by -timestamp (Meta.ordering) and
            # the audit browser now also filters on a timestamp range. With
            # 100k+ rows and no index here, both the ORDER BY and the
            # date-range WHERE fell back to a full-table sort/scan on every
            # request.
            models.Index(fields=['-timestamp'], name='audit_timestamp_desc_idx'),
        ]

    def __str__(self):
        return f'{self.user} - {self.action} - {self.module_name} @ {self.timestamp}'


class UserPermissionOverride(models.Model):
    """Per-user grant/deny on top of role-based module permissions.

    Phase 4 of the Sales permission system. The base layer is still
    RolePermission (a role allows X actions); this model lets an admin
    surgically flip individual actions for individual users without
    creating a one-off role.

    Resolution order applied by HasModulePermission:
        role check → GRANT override → DENY override → final answer.
      * A DENY override blocks the action even if the role allows it.
      * A GRANT override allows the action even if the role denies it.
      * Both together for the same (user, module, action) = DENY wins
        (safer default; matches "least privilege").

    Module-agnostic on purpose so future phases (Purchase, HR, etc.)
    can reuse the same row. Stored as text `module_name` instead of an
    FK so the row survives module renames without a data migration.
    """

    MODE_CHOICES = [
        ('GRANT', 'Grant (allow even if role denies)'),
        ('DENY',  'Deny (block even if role allows)'),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='permission_overrides',
    )
    module_name = models.CharField(max_length=150, db_index=True)
    # Permission flag being overridden — must match one of the 14
    # boolean field names on RolePermission (can_view, can_approve,
    # etc.). Stored as text rather than a FK to avoid coupling to the
    # RolePermission schema if we add more action flags later.
    action = models.CharField(max_length=50)
    mode = models.CharField(max_length=10, choices=MODE_CHOICES)
    # Optional context for auditing — who granted/denied and why.
    granted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='+',
    )
    notes = models.TextField(blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'rbac_user_permission_override'
        unique_together = [['user', 'module_name', 'action', 'mode']]
        indexes = [
            models.Index(fields=['user', 'module_name']),
        ]

    def __str__(self):
        return f'{self.user} · {self.module_name}.{self.action} = {self.mode}'


class UserFieldPermissionOverride(models.Model):
    """Per-user field access override on top of role field perms.

    Same shape as RoleFieldPermission but keyed by user instead of
    role. Used when a role's field policy is the right default but a
    specific user needs a different view (e.g. senior coordinator
    sees grand_total even though the role hides it). VIEW means
    "treat as no override" — the role's field policy applies again.
    """

    ACCESS_CHOICES = [
        ('VIEW',      'Visible'),
        ('READ_ONLY', 'Read-only'),
        ('HIDDEN',    'Hidden'),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='field_permission_overrides',
    )
    module_name = models.CharField(max_length=150, db_index=True)
    field_name = models.CharField(max_length=100)
    access = models.CharField(max_length=20, choices=ACCESS_CHOICES)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'rbac_user_field_permission_override'
        unique_together = [['user', 'module_name', 'field_name']]
        indexes = [
            models.Index(fields=['user', 'module_name']),
        ]

    def __str__(self):
        return f'{self.user} · {self.module_name}.{self.field_name} = {self.access}'


class RoleFieldPermission(models.Model):
    """Per-role field-level access overrides for sensitive fields.

    Phase 3 of the Sales-module permission system. Each row says
    "for role X on module Y, field Z is HIDDEN / READ_ONLY / VIEW".
    Default access is VIEW (i.e. no override), so the absence of a
    row means the field behaves normally. Admins only create rows
    for fields they want to restrict.

    The model is module-agnostic so future phases can re-use it for
    Purchase / HR / etc. — only the surfacing UI and the registered
    "manageable field" catalog need to grow.
    """

    ACCESS_CHOICES = [
        ('VIEW',      'Visible (default)'),
        ('READ_ONLY', 'Read-only'),
        ('HIDDEN',    'Hidden'),
    ]

    role = models.ForeignKey(
        ERPRole,
        on_delete=models.CASCADE,
        related_name='field_permissions',
    )
    # Stored as the human-readable module name (matching the
    # `module_name` attribute on viewsets) rather than an FK to
    # ERPModule so the row is portable across permission key
    # renames. Indexed for the per-request lookup hot path.
    module_name = models.CharField(max_length=150, db_index=True)
    field_name = models.CharField(max_length=100)
    access = models.CharField(
        max_length=20,
        choices=ACCESS_CHOICES,
        default='VIEW',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'rbac_role_field_permission'
        unique_together = [['role', 'module_name', 'field_name']]
        indexes = [
            models.Index(fields=['role', 'module_name']),
        ]

    def __str__(self):
        return f'{self.role} · {self.module_name}.{self.field_name} = {self.access}'
