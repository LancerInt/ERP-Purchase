"""
Core app models for ERP system.
Defines organizations, warehouses, roles, and user stakeholders.
"""
import json
from decimal import Decimal
from django.db import models
from django.core.validators import RegexValidator
from django.contrib.auth.models import User
from common.models import BaseModel
from common.gst import pan_from_gstin


class Company(BaseModel):
    """Organization entity with legal and financial details."""

    CURRENCY_CHOICES = (
        ('INR', 'Indian Rupee'),
        ('USD', 'US Dollar'),
        ('EUR', 'Euro'),
    )

    company_code = models.CharField(
        max_length=10,
        unique=True,
        db_index=True,
        help_text="Unique company identifier"
    )
    legal_name = models.CharField(
        max_length=255,
        help_text="Legal registered name"
    )
    trade_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text="Business name (if different from legal name)"
    )
    tally_company_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text="Exact company name as loaded in TallyPrime (may differ from "
                  "legal name, e.g. 'SS BIOCHEM (INDIA) PVT LTD., SLM Br. 26-27'). "
                  "Used as the target company for Import/Reconcile with Tally.",
    )
    # ── TDS engine settings (read by purchase/tds_engine.py) ──────────────
    tds_engine_enabled = models.BooleanField(
        default=False,
        help_text="Compute expected TDS on each bill (validate-first: flags "
                  "mismatches vs Tally; does not change the bill's totals).")
    tds_194q_applicable = models.BooleanField(
        default=True,
        help_text="Buyer turnover exceeded Rs 10 Cr in the preceding FY, so "
                  "Sec 194Q (TDS on purchase of goods) applies.")
    # ── What Tally CALLS things, per company ──────────────────────────────
    #
    # The importer has to decide, for every ledger on every voucher, whether it
    # is a customer, a supplier, borrowing, or a charge. It decided that with
    # English words compiled into the code — "sundry debtor", "sundry creditor",
    # a blacklist of loans|bank|capital|... that the code itself admits "had to
    # be widened three times", and CHARGE_KEYS = ("FREIGHT", "TESTING").
    #
    # That is a rename away from breaking, and a new group away from leaking.
    # Tally group names belong to the BOOKS, not to the source: a company that
    # calls its debtors "Trade Receivables" is not a code change. Blank means
    # "use the default", so nothing changes for a company that never sets them.
    tally_debtor_group = models.CharField(
        max_length=120, blank=True, default='',
        help_text="Tally primary group holding customers. Blank = 'Sundry Debtors'.")
    tally_creditor_group = models.CharField(
        max_length=120, blank=True, default='',
        help_text="Tally primary group holding suppliers. A receipt from one of "
                  "these is still cash (shown under Receipts, outside the "
                  "Received total). Blank = 'Sundry Creditors'.")
    tally_sales_group = models.CharField(
        max_length=120, blank=True, default='',
        help_text="Tally group holding SALES revenue ledgers. Any other income "
                  "ledger on an invoice is a charge (freight, testing, packing), "
                  "not turnover. Blank = 'Sales Accounts'.")
    tally_non_trading_groups = models.TextField(
        blank=True, default='',
        help_text="Comma-separated group words that can NEVER be a customer — "
                  "money landing there is borrowing, a bank transfer, capital or "
                  "an expense. Blank = the built-in list.")

    gstin = models.CharField(
        max_length=15,
        validators=[RegexValidator(
            regex=r'^(\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1})?$',
            message='Invalid GSTIN format'
        )],
        unique=True,
        db_index=True,
        blank=True,
        null=True,
        default=None,
        help_text="15-digit Goods and Services Tax Identification Number"
    )
    pan = models.CharField(
        max_length=10,
        blank=True,
        default='',
        validators=[RegexValidator(
            regex=r'^([A-Z]{5}[0-9]{4}[A-Z]{1})?$',
            message='Invalid PAN format'
        )],
        db_index=True,
        help_text="10-character PAN"
    )
    cin = models.CharField(
        max_length=21,
        blank=True,
        default='',
        help_text="Corporate Identification Number (for companies)"
    )
    msme_no = models.CharField(
        max_length=30,
        blank=True,
        default='',
        db_index=True,
        help_text="MSME / Udyam Registration Number"
    )
    msme_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text="Registered MSME entity name (if different from legal name)"
    )
    # ── Are WE an MSME supplier? (A8) ─────────────────────────────────────
    # The sell-side counterpart of Vendor.is_msme: when our own company is
    # MSME-registered we print our Udyam number on sales invoices (so our
    # customers are bound by the 45-day rule) and track receivables we can
    # claim §16 interest on. This is distinct from the vendor flag and must
    # NOT drive any vendor payment-term logic.
    MSME_CATEGORY_CHOICES = (
        ('MICRO', 'Micro'),
        ('SMALL', 'Small'),
        ('MEDIUM', 'Medium'),
    )
    is_msme = models.BooleanField(
        default=False, db_index=True,
        help_text="This company is itself registered as an MSME supplier.")
    msme_category = models.CharField(
        max_length=10, blank=True, default='', choices=MSME_CATEGORY_CHOICES,
        help_text="Our MSME category (Micro / Small / Medium).")
    msme_certificate = models.FileField(
        upload_to='companies/msme/%Y/%m/', blank=True, null=True,
        help_text="Our Udyam registration certificate.")
    registered_address = models.JSONField(
        default=dict,
        blank=True,
        help_text="Street address, city, state, country, pincode"
    )
    billing_address = models.JSONField(
        default=dict,
        blank=True,
        help_text="Billing address details"
    )
    contact_email = models.EmailField(blank=True, default='', db_index=True)
    contact_phone = models.CharField(
        max_length=20,
        blank=True,
        default='',
    )
    geo_latitude = models.DecimalField(
        max_digits=10,
        decimal_places=7,
        null=True,
        blank=True,
        help_text="Latitude coordinate (office-staff attendance geofence)"
    )
    geo_longitude = models.DecimalField(
        max_digits=10,
        decimal_places=7,
        null=True,
        blank=True,
        help_text="Longitude coordinate (office-staff attendance geofence)"
    )
    default_currency = models.CharField(
        max_length=3,
        choices=CURRENCY_CHOICES,
        default='INR'
    )
    books_export_flag = models.BooleanField(
        default=False,
        help_text="Enable accounting export features"
    )
    active_from = models.DateField(null=True, blank=True)
    active_to = models.DateField(
        null=True,
        blank=True,
        help_text="Company closure/shutdown date"
    )
    notes = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'core_company'
        ordering = ['company_code']
        constraints = []
        verbose_name_plural = 'Companies'
        indexes = [
            models.Index(fields=['company_code', 'is_active']),
            models.Index(fields=['gstin']),
        ]

    def __str__(self):
        return f"{self.company_code} - {self.legal_name}"

    def save(self, *args, **kwargs):
        # Derive PAN from the GSTIN (embedded as chars 3–12) when PAN is blank,
        # so companies get their PAN filled automatically from the GSTIN.
        if self.gstin and not (self.pan or '').strip():
            derived = pan_from_gstin(self.gstin)
            if derived:
                self.pan = derived
        super().save(*args, **kwargs)


class Warehouse(BaseModel):
    """Physical storage facility for inventory."""

    TYPE_CHOICES = (
        ('WAREHOUSE', 'Warehouse'),
        ('HEAD_OFFICE', 'Head Office'),
        ('FACTORY', 'Factory/Manufacturing'),
        ('JOB_WORK_PARTNER', 'Job Work Partner'),
    )

    STATE_CHOICES = (
        ('AN', 'Andaman and Nicobar Islands'),
        ('AP', 'Andhra Pradesh'),
        ('AR', 'Arunachal Pradesh'),
        ('AS', 'Assam'),
        ('BR', 'Bihar'),
        ('CG', 'Chhattisgarh'),
        ('CH', 'Chandigarh'),
        ('CT', 'Chhattisgarh'),
        ('DD', 'Daman and Diu'),
        ('DL', 'Delhi'),
        ('DN', 'Dadra and Nagar Haveli'),
        ('GA', 'Goa'),
        ('GJ', 'Gujarat'),
        ('HR', 'Haryana'),
        ('HP', 'Himachal Pradesh'),
        ('JK', 'Jammu and Kashmir'),
        ('JH', 'Jharkhand'),
        ('KA', 'Karnataka'),
        ('KL', 'Kerala'),
        ('LA', 'Ladakh'),
        ('LD', 'Lakshadweep'),
        ('MP', 'Madhya Pradesh'),
        ('MH', 'Maharashtra'),
        ('MN', 'Manipur'),
        ('ML', 'Meghalaya'),
        ('MZ', 'Mizoram'),
        ('NL', 'Nagaland'),
        ('OR', 'Odisha'),
        ('PB', 'Punjab'),
        ('PY', 'Puducherry'),
        ('RJ', 'Rajasthan'),
        ('SK', 'Sikkim'),
        ('TG', 'Telangana'),
        ('TN', 'Tamil Nadu'),
        ('TR', 'Tripura'),
        ('UP', 'Uttar Pradesh'),
        ('UT', 'Uttarakhand'),
        ('WB', 'West Bengal'),
    )

    warehouse_code = models.CharField(
        max_length=10,
        unique=True,
        db_index=True
    )
    company = models.ForeignKey(
        Company,
        on_delete=models.PROTECT,
        related_name='warehouses'
    )
    name = models.CharField(max_length=255)
    warehouse_type = models.CharField(
        max_length=20,
        choices=TYPE_CHOICES
    )
    address = models.JSONField(default=dict, blank=True)
    city = models.CharField(max_length=100, db_index=True, blank=True, default='')
    state = models.CharField(max_length=2, choices=STATE_CHOICES, blank=True, default='')
    country = models.CharField(max_length=100, default='India')
    pincode = models.CharField(max_length=10, blank=True, default='')
    geo_latitude = models.DecimalField(
        max_digits=10,
        decimal_places=7,
        null=True,
        blank=True,
        help_text="Latitude coordinate"
    )
    geo_longitude = models.DecimalField(
        max_digits=10,
        decimal_places=7,
        null=True,
        blank=True,
        help_text="Longitude coordinate"
    )
    time_zone = models.CharField(
        max_length=50,
        default='Asia/Kolkata'
    )
    default_currency = models.CharField(
        max_length=3,
        choices=Company.CURRENCY_CHOICES,
        default='INR'
    )
    active_flag = models.BooleanField(default=True, db_index=True)
    notes = models.TextField(blank=True, default='')

    # Foreign keys for coordinators
    warehouse_coordinator_office = models.ForeignKey(
        'StakeholderUser',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='office_coordinator_warehouses'
    )
    warehouse_hr_coordinator = models.ForeignKey(
        'StakeholderUser',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='hr_coordinator_warehouses'
    )

    # Many-to-many relationships
    warehouse_managers = models.ManyToManyField(
        'StakeholderUser',
        related_name='managed_warehouses',
        blank=True
    )
    warehouse_coordinators = models.ManyToManyField(
        'StakeholderUser',
        related_name='coordinated_warehouses',
        blank=True
    )
    warehouse_supervisors = models.ManyToManyField(
        'StakeholderUser',
        related_name='supervised_warehouses',
        blank=True
    )

    class Meta:
        db_table = 'core_warehouse'
        ordering = ['warehouse_code']
        unique_together = [['company', 'warehouse_code']]
        indexes = [
            models.Index(fields=['company', 'active_flag']),
            models.Index(fields=['city', 'state']),
        ]

    def __str__(self):
        return f"{self.warehouse_code} - {self.name}"


class Godown(BaseModel):
    """Storage zone within a warehouse."""

    CONDITION_CHOICES = (
        ('AMBIENT', 'Ambient Temperature'),
        ('COLD', 'Cold Storage'),
        ('HAZARDOUS', 'Hazardous Materials'),
    )

    UOM_CHOICES = (
        ('CBM', 'Cubic Meter'),
        ('SQM', 'Square Meter'),
        ('UNIT', 'Units'),
        ('KG', 'Kilograms'),
    )

    godown_code = models.CharField(
        max_length=15,
        unique=True,
        db_index=True
    )
    warehouse = models.ForeignKey(
        Warehouse,
        on_delete=models.CASCADE,
        related_name='godowns'
    )
    godown_name = models.CharField(max_length=255)
    storage_condition = models.CharField(
        max_length=20,
        choices=CONDITION_CHOICES,
        blank=True,
        default=''
    )
    capacity_uom = models.CharField(
        max_length=10,
        choices=UOM_CHOICES,
        blank=True,
        default=''
    )
    capacity_value = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        null=True,
        blank=True,
        default=0
    )
    batch_tracking_enabled = models.BooleanField(default=False)
    default_qc_hold_area = models.BooleanField(
        default=False,
        help_text="Designate as default QC hold area"
    )
    active_flag = models.BooleanField(default=True, db_index=True)
    notes = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'core_godown'
        ordering = ['godown_code']
        unique_together = [['warehouse', 'godown_code']]
        indexes = [
            models.Index(fields=['warehouse', 'storage_condition']),
        ]

    def __str__(self):
        return f"{self.godown_code} - {self.godown_name}"


class RoleDefinition(BaseModel):
    """Role and permission templates."""

    SCOPE_CHOICES = (
        ('GLOBAL', 'Global Access'),
        ('COMPANY', 'Company Level'),
        ('WAREHOUSE', 'Warehouse Level'),
    )

    role_code = models.CharField(
        max_length=20,
        unique=True,
        db_index=True
    )
    role_name = models.CharField(max_length=255)
    module_permissions = models.JSONField(
        default=dict,
        help_text="Module-wise permission mapping: {module: [action1, action2]}"
    )
    data_scope = models.CharField(
        max_length=20,
        choices=SCOPE_CHOICES,
        default='COMPANY'
    )
    active_flag = models.BooleanField(default=True, db_index=True)

    class Meta:
        db_table = 'core_role_definition'
        ordering = ['role_code']
        indexes = [
            models.Index(fields=['data_scope', 'active_flag']),
        ]

    def __str__(self):
        return f"{self.role_code} - {self.role_name}"


class ApprovalLevel(BaseModel):
    """Approval workflow stages and thresholds for roles."""

    MODULE_CHOICES = (
        ('PURCHASE', 'Purchase Orders'),
        ('SALES', 'Sales Orders'),
        ('INVENTORY', 'Inventory'),
        ('FINANCE', 'Finance'),
        ('HR', 'Human Resources'),
    )

    STAGE_CHOICES = (
        ('DRAFT', 'Draft'),
        ('SUBMITTED', 'Submitted'),
        ('L1_APPROVAL', 'Level 1 Approval'),
        ('L2_APPROVAL', 'Level 2 Approval'),
        ('L3_APPROVAL', 'Level 3 Approval'),
        ('APPROVED', 'Final Approval'),
        ('REJECTED', 'Rejected'),
    )

    role = models.ForeignKey(
        RoleDefinition,
        on_delete=models.CASCADE,
        related_name='approval_levels'
    )
    module = models.CharField(max_length=20, choices=MODULE_CHOICES)
    stage = models.CharField(max_length=20, choices=STAGE_CHOICES)
    min_amount = models.DecimalField(
        max_digits=15,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Minimum amount for this approval level"
    )
    max_amount = models.DecimalField(
        max_digits=15,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Maximum amount for this approval level"
    )

    class Meta:
        db_table = 'core_approval_level'
        ordering = ['role', 'module', 'stage']
        unique_together = [['role', 'module', 'stage']]
        indexes = [
            models.Index(fields=['role', 'module']),
        ]

    def __str__(self):
        return f"{self.role.role_code} - {self.module} - {self.stage}"


class StakeholderUser(BaseModel):
    """System user with role assignments and warehouse access."""

    STATUS_CHOICES = (
        ('ACTIVE', 'Active'),
        ('SUSPENDED', 'Suspended'),
        ('INACTIVE', 'Inactive'),
    )

    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name='stakeholder_profile'
    )
    employee_record = models.ForeignKey(
        'hr.Staff',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='stakeholder_users',
        help_text="Link to HR staff record"
    )
    primary_email = models.EmailField(db_index=True, blank=True, default='')
    mobile = models.CharField(
        max_length=20,
        blank=True,
        default='',
    )
    default_warehouse = models.ForeignKey(
        Warehouse,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='default_users'
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='ACTIVE',
        db_index=True
    )
    last_accessed = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True, default='')

    # Many-to-many relationships
    assigned_roles = models.ManyToManyField(
        RoleDefinition,
        related_name='stakeholder_users',
        blank=True
    )
    warehouse_scope = models.ManyToManyField(
        Warehouse,
        related_name='scoped_users',
        blank=True,
        help_text="Warehouses accessible to this user"
    )

    class Meta:
        db_table = 'core_stakeholder_user'
        ordering = ['user__username']
        indexes = [
            models.Index(fields=['primary_email']),
            models.Index(fields=['status', 'is_active']),
        ]

    def __str__(self):
        return f"{self.user.username} - {self.user.get_full_name()}"


class UserSessionRevocation(models.Model):
    """When this user last said "sign me out of every device".

    Blacklisting refresh tokens alone does not end a session: the access
    token already in the other device's hands is verified by signature
    and never looked up, so it keeps working until it expires — up to
    ACCESS_TOKEN_LIFETIME (1 hour). A stolen phone staying usable for an
    hour after you hit the button makes the button a lie.

    So authentication compares each access token's `iat` against this
    stamp and rejects anything older (see
    core.jwt_auth.RevocableJWTAuthentication). One row per user, written
    only when someone actually revokes, and read as part of the user
    lookup authentication already performs — so it costs no extra query.
    """
    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name='session_revocation',
    )
    revoked_at = models.DateTimeField()

    class Meta:
        db_table = 'core_user_session_revocation'

    def __str__(self):
        return f'{self.user.username} revoked all sessions at {self.revoked_at}'


class SyncRun(models.Model):
    """The last time a given sync action ran, PER COMPANY.

    Every "Import from Tally", "Import from Zoho", creditors / TDS / freight
    sync etc. is a distinct KIND, and each company is imported separately — so
    "last synced 2 hours ago" has to be answered per (kind, company), not
    globally. A global stamp would hide that United Agro has not synced in a
    week while SS Biochem synced this morning.

    One row per (kind, company), upserted on each successful run via
    `record_sync`, so the table stays bounded (kinds x companies, a couple of
    dozen rows) and always reflects the MOST RECENT run. History is not kept —
    this answers "when last", nothing more. Only real runs are recorded; a
    dry-run preview writes nothing, since nothing was imported.
    """
    KIND_CHOICES = (
        # Sales and Purchase are imported separately (different pages, different
        # `what`), so each gets its own row per company. 'tally_transactions'
        # stays for older rows written before the split.
        ('tally_sales', 'Tally — Sales'),
        ('tally_purchase', 'Tally — Purchase'),
        ('tally_transactions', 'Tally — Sales/Purchase'),
        ('tally_creditors', 'Tally — Creditors'),
        ('tally_tds_payable', 'Tally — TDS Payable'),
        ('tally_freight_inward', 'Tally — Freight Inward'),
        ('tally_reconcile', 'Tally — Reconcile'),
        ('tally_file', 'Tally — File import'),
        ('zoho_bills', 'Zoho — Bills'),
        ('bank_tally', 'Bank — Tally import'),
    )
    STATUS_CHOICES = (('ok', 'OK'), ('error', 'Error'))

    kind = models.CharField(max_length=40, choices=KIND_CHOICES, db_index=True)
    # Nullable: a few syncs are company-agnostic. Most carry one.
    company = models.ForeignKey(
        'Company', null=True, blank=True, on_delete=models.CASCADE,
        related_name='sync_runs',
    )
    finished_at = models.DateTimeField()
    status = models.CharField(max_length=8, choices=STATUS_CHOICES, default='ok')
    # A short human line: counts on success, the reason on failure.
    detail = models.CharField(max_length=200, blank=True, default='')
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name='+',
    )

    class Meta:
        db_table = 'core_sync_run'
        constraints = [
            models.UniqueConstraint(
                fields=['kind', 'company'], name='uniq_sync_kind_company',
            ),
        ]
        indexes = [models.Index(fields=['kind', 'company'])]

    def __str__(self):
        return f'{self.kind} / {self.company_id or "-"} @ {self.finished_at}'


def record_sync(kind, *, company=None, user=None, status='ok', detail=''):
    """Stamp a sync run as just-finished. Best-effort: a logging failure must
    never break the import it is logging."""
    from django.utils import timezone
    try:
        SyncRun.objects.update_or_create(
            kind=kind,
            company=company if getattr(company, 'pk', None) else None,
            defaults={
                'finished_at': timezone.now(),
                'status': status,
                'detail': (detail or '')[:200],
                'created_by': user if getattr(user, 'pk', None) else None,
            },
        )
    except Exception:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).exception('record_sync(%s) failed', kind)


class AppSetting(models.Model):
    """A single GLOBAL key→value setting shared by every user (not per-user).

    One row per key. Used for small company-wide UI flags — right now just
    whether the once-per-login Tally-sync greeting popup is shown. Kept
    generic on purpose so a new global toggle doesn't need its own column +
    migration each time; scalars are wrapped as ``{"v": <value>}`` so the
    JSONField is happy storing a bare bool/number/string.
    """
    key = models.CharField(max_length=64, unique=True)
    value = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+',
    )

    class Meta:
        db_table = 'core_app_setting'

    def __str__(self):
        return f'{self.key}={self.value!r}'


# The ONLY keys readable/writable through /api/app-settings/, with their
# defaults. An allow-list, so the (intentionally) open endpoint can never be
# used to stash arbitrary data — unknown keys are ignored.
APP_SETTING_DEFAULTS = {
    # Show the once-per-login Tally-sync greeting modal. Global: one value for
    # everyone, flippable by any signed-in user from the top-bar chip.
    'tally_login_popup': True,
}


def get_app_setting(key, default=None):
    """Read a global setting, falling back to its registered default."""
    if default is None:
        default = APP_SETTING_DEFAULTS.get(key)
    try:
        row = AppSetting.objects.filter(key=key).first()
    except Exception:  # noqa: BLE001 — table missing mid-migration, etc.
        return default
    if row is None:
        return default
    v = row.value
    return v.get('v', default) if isinstance(v, dict) else v


def set_app_setting(key, value, user=None):
    """Upsert a global setting (scalar wrapped as {"v": value})."""
    AppSetting.objects.update_or_create(
        key=key,
        defaults={
            'value': {'v': value},
            'updated_by': user if getattr(user, 'pk', None) else None,
        },
    )


class DeviationAck(BaseModel):
    """A user's acknowledgement / resolution of ONE deviation surfaced on the
    unified Deviations report.

    The deviations themselves are computed on the fly from many sources (MSME
    ageing, GSTR-1/2B reconciliations, ERP↔Tally source compare, overdue/draft
    exceptions). This row only records that someone has acted on one, keyed by a
    STABLE business identity (`dedup_key`) — never a volatile upload-row PK — so
    the mark survives a GSTR re-upload or a ledger refresh. No row == the
    deviation is still open; only acknowledged/resolved states are persisted.
    `snapshot` freezes the identifying fields so a resolved deviation keeps an
    audit trail even if the source row later disappears.
    """

    CATEGORY_CHOICES = (
        ('MSME_PAY', 'MSME payable'),
        ('MSME_RECV', 'MSME receivable'),
        ('GSTR1', 'GSTR-1'),
        ('GSTR2B', 'GSTR-2B'),
        ('TALLY_ERP', 'ERP vs Tally'),
        ('PAYMENT_MADE', 'Payment made (bank)'),
        ('PAYMENT_RECV', 'Payment received (bank)'),
        ('EXCEPTION', 'Exception'),
    )
    STATUS_CHOICES = (
        ('acknowledged', 'Acknowledged'),
        ('resolved', 'Resolved'),
    )

    category = models.CharField(max_length=20, choices=CATEGORY_CHOICES, db_index=True)
    dedup_key = models.CharField(max_length=255, db_index=True)
    company = models.ForeignKey(
        'core.Company', null=True, blank=True, on_delete=models.CASCADE,
        related_name='deviation_acks')
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default='acknowledged')
    note = models.TextField(blank=True, default='')
    snapshot = models.JSONField(default=dict, blank=True)
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name='deviation_resolved')
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(fields=['category', 'dedup_key'],
                                    name='uniq_deviation_ack'),
        ]
        indexes = [
            models.Index(fields=['company', 'category']),
        ]

    def __str__(self):
        return f'{self.category}:{self.dedup_key} ({self.status})'
