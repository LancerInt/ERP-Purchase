"""Models for the purchase application."""

import uuid
from decimal import Decimal
from django.conf import settings
from django.db import models
from django.core.validators import MinValueValidator, MaxValueValidator
from django.utils.translation import gettext_lazy as _

from common.models import BaseModel
from common.utils import generate_document_number


def _tds_already_in_total(*, total_is_net, tds_withheld, tds_deducted,
                          subtotal, tax_amount, total_amount):
    """Pure decision: is `total_amount` ALREADY net of the TDS, so TDS must NOT be
    subtracted a second time? Factored out of VendorBill.tds_already_in_total so
    the (financial) logic is unit-testable without a DB. See that property's
    docstring for the ordering; all args are Decimals.

    1. total_is_net flag (True/False) — trust it. NULL → guess:
    2. the bill's OWN deducted TDS baked in:  subtotal + GST − deducted ≈ total
    3. else the withheld-TDS arithmetic:      total closer to (gross − withheld)
                                              than to gross, within ₹2.
    No TDS withheld → False.
    """
    _Z = Decimal('0')
    tds = tds_withheld or _Z
    if tds <= 0:
        return False
    if total_is_net is not None:
        return bool(total_is_net)
    gross = (subtotal or _Z) + (tax_amount or _Z)
    if gross <= 0:
        return False
    total = total_amount or _Z
    deducted = tds_deducted or _Z
    if deducted > 0 and abs(total - (gross - deducted)) <= Decimal('2'):
        return True
    d_net = abs(total - (gross - tds))
    return d_net < abs(total - gross) and d_net <= Decimal('2')


# ── Canonical "physical received" definition ─────────────────────────────────
# A PO's fulfillment closes against what PHYSICALLY arrived, not what the vendor
# invoiced — so a short delivery (received < invoiced) keeps the PO OPEN for the
# shortfall, which the next delivery/bill can fulfill. Exception: a line flagged
# is_debit_note is financially settled (the short qty was debited back), so it
# counts its invoice qty and closes that slice.
#
#   physical = invoice qty (quantity_received)  when is_debit_note
#            = net_quantity                      when captured (weighed/inspected)
#            = invoice qty                        as a fallback (legacy/simple rows)
#
# This is ONE definition, as an ORM expression, so every balance path (PO totals,
# per-line received, the receipt total, the over-receipt guard) agrees exactly
# and cannot drift. Pass the field prefix for related lookups ('' on ReceiptLine,
# 'receipt_lines__' from a PO, etc.).
def received_qty_expr(prefix=''):
    """Case() giving the physical-received quantity for a ReceiptLine."""
    from django.db.models import Case, When, F, DecimalField
    from django.db.models.functions import Coalesce
    qr = f'{prefix}quantity_received'
    nq = f'{prefix}net_quantity'
    dn = f'{prefix}is_debit_note'
    return Case(
        When(**{dn: True}, then=F(qr)),
        default=Coalesce(F(nq), F(qr)),
        output_field=DecimalField(max_digits=18, decimal_places=4),
    )


def received_qty_of(line):
    """Python twin of received_qty_expr for a single in-memory ReceiptLine.

    Kept beside the expression so the row-at-a-time path (e.g. a freshly built
    line not yet re-queried) answers identically to the grouped SQL.
    """
    if getattr(line, 'is_debit_note', False):
        return Decimal(str(line.quantity_received or 0))
    nq = getattr(line, 'net_quantity', None)
    return Decimal(str((nq if nq is not None else line.quantity_received) or 0))


class PurchaseRequest(BaseModel):
    """Main purchase request model."""

    REQUIREMENT_TYPES = (
        ('GOODS', _('Goods')),
        ('SERVICES', _('Services')),
        ('MACHINERY', _('Machinery')),
    )

    PRIORITY_CHOICES = (
        ('LOW', _('Low')),
        ('MEDIUM', _('Medium')),
        ('HIGH', _('High')),
    )

    APPROVAL_STATUS_CHOICES = (
        ('DRAFT', _('Draft')),
        ('EDITED', _('Edited')),
        ('PENDING', _('Pending Approval')),
        # After the Warehouse Manager advances a submitted PR it sits here
        # awaiting the Purchase Coordinator's final decision. Labelled
        # "Factory Approved" because the factory (warehouse) side has signed
        # off and only the purchase side's approval remains.
        ('PENDING_APPROVAL', _('Factory Approved')),
        ('APPROVED', _('Approved')),
        ('REJECTED', _('Rejected')),
        ('PARTIALLY_APPROVED', _('Partially Approved')),
    )

    pr_no = models.CharField(
        max_length=50,
        unique=True,
        db_index=True,
        editable=False,
        help_text="Auto-generated PR number"
    )
    request_date = models.DateTimeField(auto_now_add=True, db_index=True)
    company = models.ForeignKey(
        'core.Company',
        on_delete=models.PROTECT,
        related_name='purchase_requests',
        null=True,
        blank=True,
        help_text="Company this PR belongs to"
    )
    warehouse = models.ForeignKey(
        'core.Warehouse',
        on_delete=models.PROTECT,
        related_name='purchase_requests',
        help_text="Primary warehouse for this PR"
    )
    godown = models.ForeignKey(
        'core.Godown',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='purchase_requests',
        help_text="Primary godown (first of godown_ids) — kept for stock-location logic"
    )
    # A product in one warehouse may be needed across several godowns, so the
    # PR can target multiple. Stored as a list of Godown UUID strings; `godown`
    # above mirrors the first for backward-compatible single-godown consumers.
    godown_ids = models.JSONField(default=list, blank=True)
    requested_by = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='purchase_requests_created',
        help_text="User who created the PR"
    )
    requestor_role = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text="Role of the requestor (cached for audit trail)"
    )
    requirement_type = models.CharField(
        max_length=20,
        choices=REQUIREMENT_TYPES,
        default='GOODS',
        db_index=True
    )
    priority = models.CharField(
        max_length=20,
        choices=PRIORITY_CHOICES,
        default='MEDIUM',
        db_index=True
    )
    required_by_date = models.DateField(
        null=True,
        blank=True,
        db_index=True,
        help_text="When items are needed"
    )
    justification = models.TextField(
        blank=True,
        default='',
        help_text="Business justification for the purchase"
    )
    approval_status = models.CharField(
        max_length=30,
        choices=APPROVAL_STATUS_CHOICES,
        default='DRAFT',
        db_index=True
    )
    visibility_scope = models.JSONField(
        default=dict,
        help_text="Controls who can view this PR (departments, roles, etc.)"
    )
    notes = models.TextField(blank=True, default='')
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='approved_purchase_requests',
        help_text="User who approved this PR"
    )
    approved_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Timestamp when the PR was approved"
    )
    reject_reason = models.TextField(
        blank=True,
        default='',
        help_text="Mandatory reason captured when a PR is rejected."
    )
    allow_rfq_skip = models.BooleanField(
        default=False,
        help_text="If True, approval creates PO directly instead of RFQ"
    )
    preferred_vendor = models.ForeignKey(
        'master.Vendor',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='purchase_requests',
        help_text="Preferred vendor for direct PO creation (used with RFQ skip)"
    )
    linked_rfq = models.ForeignKey(
        'purchase.RFQHeader',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='source_purchase_requests',
        help_text="RFQ auto-created upon approval"
    )
    # Optional justification link: many requisitions exist to fulfil a
    # specific Sales Order, and approvers ask "why is this being bought?".
    # The Warehouse Coordinator/Manager records the driving SO here so the
    # answer travels with the PR instead of living in someone's memory.
    sales_order = models.ForeignKey(
        'sales.SalesOrder',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='purchase_requests',
        help_text="Sales Order this requisition was raised to fulfil (justification reference)"
    )

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['warehouse', 'approval_status']),
            models.Index(fields=['required_by_date', 'priority']),
            models.Index(fields=['requested_by', 'created_at']),
        ]
        verbose_name = _('Purchase Request')
        verbose_name_plural = _('Purchase Requests')

    def __str__(self):
        return f"{self.pr_no} - {self.get_requirement_type_display()}"

    def save(self, *args, **kwargs):
        if not self.pr_no:
            from django.utils import timezone
            year = timezone.now().year
            prefix = f'PR-{year}-'
            last = PurchaseRequest.objects.filter(
                pr_no__startswith=prefix
            ).order_by('-pr_no').values_list('pr_no', flat=True).first()
            if last:
                try:
                    num = int(last.split('-')[-1]) + 1
                except (ValueError, IndexError):
                    num = 1
            else:
                num = 1
            self.pr_no = f'{prefix}{num:05d}'
        super().save(*args, **kwargs)

    def get_total_requested_quantity(self):
        """Get sum of all requested quantities."""
        return self.lines.aggregate(
            total=models.Sum('quantity_requested')
        )['total'] or Decimal('0.00')

    def get_total_approved_quantity(self):
        """Get sum of all approved quantities."""
        return self.lines.aggregate(
            total=models.Sum('approved_quantity')
        )['total'] or Decimal('0.00')


class PRLine(BaseModel):
    """Individual line items within a purchase request."""

    PURPOSE_CHOICES = (
        ('PRODUCTION', _('Production')),
        ('MAINTENANCE', _('Maintenance')),
        ('CONSUMABLE', _('Consumable')),
    )

    LINE_STATUS_CHOICES = (
        ('PENDING', _('Pending')),
        ('APPROVED', _('Approved')),
        ('REJECTED', _('Rejected')),
        ('FULFILLED', _('Fulfilled')),
        # HOLD route in the Approve modal: vendor is picked but the unit
        # price isn't known yet. The line sits on the PR until the operator
        # comes back with the price and converts it to a DRAFT PO via the
        # per-line /convert/ endpoint. The parent PR stays in
        # PARTIALLY_APPROVED while any PENDING_PRICE lines remain.
        ('PENDING_PRICE', _('Pending Price')),
    )

    purchase_request = models.ForeignKey(
        PurchaseRequest,
        on_delete=models.CASCADE,
        related_name='lines'
    )
    line_no = models.PositiveIntegerField(
        help_text="Sequential line number"
    )
    category = models.CharField(
        max_length=80,
        blank=True,
        default='',
        help_text=(
            "Line category. For Goods requirement_type the value is one of "
            "'RAW_MATERIAL' / 'FINISHED_GOODS'; for other requirement types it is "
            "free-form text typed by the user."
        )
    )
    # Exactly ONE of (product_service, service_catalogue) is populated per
    # line, matching the parent PR's requirement_type:
    #   GOODS / MACHINERY → product_service set (FK to master.Product)
    #   SERVICES          → service_catalogue set (FK to master.ServiceCatalogue)
    # Both are nullable so the serializer can validate at save time.
    # Backward compat: existing PR lines (all Goods) already have
    # product_service populated; the migration is purely additive.
    product_service = models.ForeignKey(
        'master.Product',
        on_delete=models.PROTECT,
        related_name='pr_lines',
        null=True,
        blank=True,
        help_text="Product (when requirement_type=GOODS).",
    )
    service_catalogue = models.ForeignKey(
        'master.ServiceCatalogue',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='pr_lines',
        help_text="Service catalogue entry (when requirement_type=SERVICES).",
    )
    # Per-line preferred vendor for the RFQ-skip path. When set, skip-RFQ
    # creates one PO per distinct vendor (clubbing that vendor's lines);
    # falls back to the PR-header preferred_vendor / wizard choice when null.
    preferred_vendor = models.ForeignKey(
        'master.Vendor',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='pr_lines_preferred',
        help_text="Preferred vendor for this line (RFQ-skip per-line PO clubbing).",
    )
    description_override = models.TextField(
        blank=True,
        default='',
        help_text="Override product description if needed"
    )
    quantity_requested = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.01'))],
        help_text="Quantity requested"
    )
    uom = models.CharField(
        max_length=10,
        help_text="Unit of measure (PCS, KG, L, etc.)"
    )
    required_date = models.DateField(
        null=True,
        blank=True,
        db_index=True
    )
    purpose = models.CharField(
        max_length=20,
        choices=PURPOSE_CHOICES,
        default='PRODUCTION'
    )
    allow_rfq_skip = models.BooleanField(
        default=False,
        help_text="Allow direct PO creation without RFQ"
    )
    status = models.CharField(
        max_length=20,
        choices=LINE_STATUS_CHOICES,
        default='PENDING',
        db_index=True
    )
    approved_quantity = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        null=True,
        blank=True,
        help_text="Approved quantity (if partial approval)"
    )

    class Meta:
        ordering = ['line_no']
        indexes = [
            models.Index(fields=['purchase_request', 'status']),
            models.Index(fields=['product_service', 'required_date']),
        ]
        unique_together = [['purchase_request', 'line_no']]
        verbose_name = _('Purchase Request Line')
        verbose_name_plural = _('Purchase Request Lines')

    def __str__(self):
        return f"{self.purchase_request.pr_no} - Line {self.line_no}"


class PRApprovalTrail(BaseModel):
    """Append-only audit trail for PR lifecycle actions. Rows are only ever
    created (edit/submit/approve each add one) — no update/delete API exists,
    so the trail is the immutable change history of the PR."""

    ACTION_CHOICES = (
        ('APPROVED', _('Approved')),
        ('REJECTED', _('Rejected')),
        ('PARTIAL', _('Partially Approved')),
        ('EDITED', _('Edited')),
        ('SUBMITTED', _('Submitted')),
        ('PROCEEDED', _('Proceeded')),
    )

    purchase_request = models.ForeignKey(
        PurchaseRequest,
        on_delete=models.CASCADE,
        related_name='approval_trails'
    )
    action = models.CharField(max_length=20, choices=ACTION_CHOICES)
    # Nullable: some login users have no StakeholderUser profile, and their
    # edits must still be recordable — actor_label keeps the display name.
    actor = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='pr_approvals'
    )
    actor_label = models.CharField(
        max_length=150,
        blank=True,
        default='',
        help_text="Username fallback for display when actor is null"
    )
    action_date = models.DateTimeField(auto_now_add=True, db_index=True)
    remarks = models.TextField(blank=True, default='')
    # Display-ready field diff captured when action='EDITED':
    #   [{"scope": "header"|"line", "label": str, "old": str, "new": str}]
    # Empty list for all other actions.
    changes = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ['-action_date']
        indexes = [
            models.Index(fields=['purchase_request', 'action_date']),
        ]
        verbose_name = _('PR Approval Trail')
        verbose_name_plural = _('PR Approval Trails')

    def __str__(self):
        return f"{self.purchase_request.pr_no} - {self.get_action_display()}"


class RFQHeader(BaseModel):
    """Request for Quotation header."""

    RFQ_MODE_CHOICES = (
        ('EMAIL', _('Email')),
        ('PORTAL', _('Portal')),
        ('PHONE', _('Phone')),
    )

    RFQ_STATUS_CHOICES = (
        ('OPEN', _('Open')),
        ('CLOSED', _('Closed')),
        ('CANCELLED', _('Cancelled')),
    )

    rfq_no = models.CharField(
        max_length=50,
        unique=True,
        db_index=True,
        editable=False
    )
    creation_date = models.DateTimeField(auto_now_add=True, db_index=True)
    created_by = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='rfqs_created'
    )
    rfq_mode = models.CharField(
        max_length=20,
        choices=RFQ_MODE_CHOICES,
        default='EMAIL'
    )
    rfq_status = models.CharField(
        max_length=20,
        choices=RFQ_STATUS_CHOICES,
        default='OPEN',
        db_index=True
    )
    quote_count_expected = models.PositiveIntegerField(
        default=3,
        help_text="Expected number of quote responses"
    )
    skip_rfq_flag = models.BooleanField(
        default=False,
        help_text="Flag if RFQ was skipped for direct PO"
    )
    skip_rfq_justification = models.TextField(blank=True, default='')
    purchase_manager_approval = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='rfqs_approved'
    )
    vendor_routing = models.JSONField(
        null=True, blank=True, default=None,
        help_text="Draft line→vendor mapping saved from Send Email page. Shape: {product_id: [vendor_id, ...]}"
    )
    linked_prs = models.ManyToManyField(
        PurchaseRequest,
        related_name='rfqs',
        help_text="Purchase requests linked to this RFQ"
    )

    class Meta:
        ordering = ['-creation_date']
        indexes = [
            models.Index(fields=['rfq_status', 'creation_date']),
            models.Index(fields=['created_by', 'creation_date']),
        ]
        verbose_name = _('RFQ Header')
        verbose_name_plural = _('RFQ Headers')

    def __str__(self):
        return self.rfq_no

    def save(self, *args, **kwargs):
        if not self.rfq_no:
            from django.utils import timezone as tz
            year = tz.now().year
            prefix = f'RFQ-{year}-'
            last = RFQHeader.objects.filter(rfq_no__startswith=prefix).order_by('-rfq_no').values_list('rfq_no', flat=True).first()
            num = int(last.split('-')[-1]) + 1 if last else 1
            self.rfq_no = f'{prefix}{num:04d}'
        super().save(*args, **kwargs)

    def get_active_quote_count(self):
        """Get count of active quote responses."""
        return self.quote_responses.filter(is_active=True).count()

    def get_invited_vendor_count(self):
        """Distinct vendors this RFQ was emailed to — the 'quotes expected'
        denominator shown as N/M on the Quote Responses list."""
        from communications.models import EmailLog
        return (
            EmailLog.objects
            .filter(rfq_id=self.id, email_sent=True)
            .values('vendor').distinct().count()
        )

    def is_fully_quoted(self):
        """True once every invited vendor's quote is recorded (or when no
        vendors were emailed, so there's no expected count to wait on).
        Gates the evaluation — you can't evaluate a half-collected RFQ."""
        invited = self.get_invited_vendor_count()
        return invited == 0 or self.get_active_quote_count() >= invited

    def get_average_evaluation_score(self):
        """Get average score from evaluations."""
        return self.evaluations.aggregate(
            avg_score=models.Avg('evaluation__score')
        )['avg_score']


class DispatchETAUpdate(BaseModel):
    """ETA updates for RFQ dispatches."""

    rfq = models.ForeignKey(
        RFQHeader,
        on_delete=models.CASCADE,
        related_name='eta_updates'
    )
    update_date = models.DateTimeField(auto_now_add=True)
    updated_by = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.PROTECT
    )
    expected_arrival = models.DateField(null=True, blank=True)
    remarks = models.TextField(blank=True, default='')

    class Meta:
        ordering = ['-update_date']
        verbose_name = _('Dispatch ETA Update')
        verbose_name_plural = _('Dispatch ETA Updates')

    def __str__(self):
        return f"{self.rfq.rfq_no} - {self.expected_arrival}"


class QuoteResponse(BaseModel):
    """Vendor quote responses to RFQ."""

    quote_id = models.CharField(
        max_length=50,
        unique=True,
        db_index=True,
        editable=False
    )
    rfq = models.ForeignKey(
        RFQHeader,
        on_delete=models.CASCADE,
        related_name='quote_responses'
    )
    vendor = models.ForeignKey(
        'master.Vendor',
        on_delete=models.PROTECT,
        related_name='quotes'
    )
    vendor_name_text = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text='Vendor name as printed on the quote document. Used when the '
                  'extracted name does not exactly match the vendor master, so '
                  'the original spelling is preserved for review.'
    )
    quote_date = models.DateField(auto_now_add=True, db_index=True)
    price_valid_till = models.DateField(
        null=True,
        blank=True,
        help_text="Quote validity date"
    )
    currency = models.CharField(
        max_length=3,
        default='INR',
        help_text="Currency code"
    )
    freight_terms = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text="e.g., FOB, CIF, DDP"
    )
    payment_terms = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text="e.g., Net 30, COD"
    )
    custom_payment_terms = models.TextField(
        blank=True,
        default='',
        help_text="Free-text terms used when payment_terms is CUSTOM"
    )
    delivery_terms = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text="e.g., 15 days, immediate"
    )
    lead_time_days = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text="Days from order to delivery"
    )
    remarks = models.TextField(blank=True, default='')
    evaluation_score = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        null=True,
        blank=True,
        validators=[MinValueValidator(Decimal('0.00')), MaxValueValidator(Decimal('100.00'))],
        help_text="Score from quote evaluation (0-100)"
    )
    chosen_flag = models.BooleanField(
        default=False,
        db_index=True,
        help_text="Mark if this quote was selected for PO"
    )

    class Meta:
        ordering = ['-quote_date']
        indexes = [
            models.Index(fields=['rfq', 'chosen_flag']),
            models.Index(fields=['vendor', 'quote_date']),
        ]
        verbose_name = _('Quote Response')
        verbose_name_plural = _('Quote Responses')

    def __str__(self):
        return f"{self.quote_id} - {self.vendor.vendor_name if self.vendor else 'N/A'}"

    def save(self, *args, **kwargs):
        if not self.quote_id:
            from django.utils import timezone as tz
            year = tz.now().year
            prefix = f'QT-{year}-'
            last = QuoteResponse.objects.filter(quote_id__startswith=prefix).order_by('-quote_id').values_list('quote_id', flat=True).first()
            num = int(last.split('-')[-1]) + 1 if last else 1
            self.quote_id = f'{prefix}{num:04d}'
        super().save(*args, **kwargs)

    def get_total_cost(self):
        """Calculate total cost for all lines."""
        return self.quote_lines.aggregate(
            total=models.Sum(
                models.F('quantity_offered') * models.F('unit_price') -
                models.F('quantity_offered') * models.F('unit_price') * models.F('discount') / 100 +
                models.F('freight_charge')
            )
        )['total'] or Decimal('0.00')


class QuoteLine(BaseModel):
    """Individual line items in a quote.

    Carries one of two possible item references — Product or
    ServiceCatalogue — mirroring PRLine/POLine. Exactly one of
    (product_service, service_catalogue) is populated per line
    (enforced in QuoteLineSerializer.validate). `product_service`
    is nullable so a vendor can quote on Service lines that were
    carried forward from a non-Goods PR.
    """

    quote = models.ForeignKey(
        QuoteResponse,
        on_delete=models.CASCADE,
        related_name='quote_lines'
    )
    pr_line = models.ForeignKey(
        PRLine,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='quote_lines',
        help_text="Referenced PR line"
    )
    product_service = models.ForeignKey(
        'master.Product',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='quote_lines',
        help_text='Goods line: FK to master.Product. Mutually exclusive with service_catalogue.'
    )
    service_catalogue = models.ForeignKey(
        'master.ServiceCatalogue',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='quote_lines',
        help_text='Service line: FK to master.ServiceCatalogue. Mutually exclusive with product_service.'
    )
    specification = models.TextField(
        blank=True,
        default='',
        help_text="Vendor's specification/variation"
    )
    quantity_offered = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.01'))]
    )
    uom = models.CharField(max_length=10)
    unit_price = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.00'))]
    )
    discount = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(Decimal('0.00')), MaxValueValidator(Decimal('100.00'))],
        help_text="Discount percentage"
    )
    gst = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(Decimal('0.00')), MaxValueValidator(Decimal('100.00'))],
        help_text="GST percentage"
    )
    freight_charge = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        null=True,
        blank=True,
        default=0
    )
    # Set when the evaluator awards THIS product to THIS vendor. Per-product
    # award: for a given PR product exactly one vendor's quote line wins; PO
    # generation then groups awarded lines by vendor into one PO each.
    is_awarded = models.BooleanField(default=False)
    delivery_timeline = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text="Days from order placement"
    )

    # Optional physical dimensions captured per line — used when the
    # quote is for items where size matters (e.g. fabric rolls, sheet
    # metal, packaged goods with palletisation constraints). All four
    # are nullable so existing rows / quotes that don't care about
    # dimensions aren't forced to backfill. Units are not enforced at
    # the DB layer — the form labels them and the operator stays
    # consistent (typically mm or cm).
    length = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text='Optional physical length per unit.',
    )
    width = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text='Optional physical width per unit.',
    )
    breadth = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text='Optional physical breadth per unit (distinct from width when both are relevant).',
    )
    height = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text='Optional physical height per unit.',
    )

    class Meta:
        ordering = ['quote', 'pr_line']
        indexes = [
            models.Index(fields=['quote', 'pr_line']),
        ]
        verbose_name = _('Quote Line')
        verbose_name_plural = _('Quote Lines')

    def __str__(self):
        # Pick whichever FK is set so non-Goods rows don't raise
        # AttributeError on display.
        if self.product_service_id:
            name = getattr(self.product_service, 'product_name', None) or getattr(self.product_service, 'name', '')
        elif self.service_catalogue_id:
            name = getattr(self.service_catalogue, 'name', '') or str(self.service_catalogue_id)
        else:
            name = '(unknown)'
        return f"{self.quote.quote_id} - {name}"

    def get_line_total(self):
        """Calculate line total with discount and GST."""
        base = Decimal(str(self.quantity_offered)) * Decimal(str(self.unit_price))
        discounted = base - (base * Decimal(str(self.discount or 0)) / 100)
        with_gst = discounted + (discounted * Decimal(str(self.gst or 0)) / 100)
        freight = Decimal(str(self.freight_charge or 0))
        return with_gst + freight


class QuoteEvaluation(BaseModel):
    """Evaluation and comparison of quotes."""

    APPROVAL_STATUS_CHOICES = (
        ('PENDING', _('Pending')),
        ('APPROVED', _('Approved')),
        ('REJECTED', _('Rejected')),
    )

    evaluation_id = models.CharField(
        max_length=50,
        unique=True,
        db_index=True,
        editable=False
    )
    rfq = models.ForeignKey(
        RFQHeader,
        on_delete=models.CASCADE,
        related_name='evaluations'
    )
    evaluation_date = models.DateTimeField(auto_now_add=True, db_index=True)
    evaluated_by = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='quote_evaluations'
    )
    best_quote_flag = models.BooleanField(
        default=False,
        help_text="Mark if this is the best quote"
    )
    recommended_vendor = models.ForeignKey(
        'master.Vendor',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='evaluations_recommended',
        help_text="Recommended vendor from evaluation"
    )
    justification_notes = models.TextField(blank=True, default='')
    approval_status = models.CharField(
        max_length=20,
        choices=APPROVAL_STATUS_CHOICES,
        default='PENDING',
        db_index=True
    )

    class Meta:
        ordering = ['-evaluation_date']
        indexes = [
            models.Index(fields=['rfq', 'best_quote_flag']),
            models.Index(fields=['evaluated_by', 'evaluation_date']),
        ]
        verbose_name = _('Quote Evaluation')
        verbose_name_plural = _('Quote Evaluations')

    def __str__(self):
        return f"{self.evaluation_id} - {self.rfq.rfq_no}"

    def save(self, *args, **kwargs):
        if not self.evaluation_id:
            from django.utils import timezone as tz
            year = tz.now().year
            prefix = f'EVAL-{year}-'
            last = QuoteEvaluation.objects.filter(evaluation_id__startswith=prefix).order_by('-evaluation_id').values_list('evaluation_id', flat=True).first()
            num = int(last.split('-')[-1]) + 1 if last else 1
            self.evaluation_id = f'{prefix}{num:04d}'
        super().save(*args, **kwargs)


class ComparisonEntry(BaseModel):
    """Comparison metrics for quote evaluation."""

    evaluation = models.ForeignKey(
        QuoteEvaluation,
        on_delete=models.CASCADE,
        related_name='comparison_entries'
    )
    vendor = models.ForeignKey(
        'master.Vendor',
        on_delete=models.PROTECT,
        related_name='comparison_entries'
    )
    total_cost = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        help_text="Total cost from this vendor"
    )
    lead_time = models.PositiveIntegerField(
        help_text="Lead time in days"
    )
    freight_terms = models.CharField(max_length=100, blank=True, default='')
    payment_terms = models.CharField(max_length=100, blank=True, default='')
    score = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.00')), MaxValueValidator(Decimal('100.00'))],
        help_text="Evaluation score"
    )
    remarks = models.TextField(blank=True, default='')

    class Meta:
        ordering = ['evaluation', '-score']
        indexes = [
            models.Index(fields=['evaluation', 'vendor']),
        ]
        unique_together = [['evaluation', 'vendor']]
        verbose_name = _('Comparison Entry')
        verbose_name_plural = _('Comparison Entries')

    def __str__(self):
        return f"{self.evaluation.evaluation_id} - {self.vendor.vendor_name}"


class EvalApprovalTrail(BaseModel):
    """Approval audit trail for quote evaluations."""

    evaluation = models.ForeignKey(
        QuoteEvaluation,
        on_delete=models.CASCADE,
        related_name='approval_trails'
    )
    actor = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.PROTECT
    )
    action = models.CharField(max_length=50)
    action_date = models.DateTimeField(auto_now_add=True, db_index=True)
    remarks = models.TextField(blank=True, default='')

    class Meta:
        ordering = ['-action_date']
        verbose_name = _('Evaluation Approval Trail')
        verbose_name_plural = _('Evaluation Approval Trails')

    def __str__(self):
        return f"{self.evaluation.evaluation_id} - {self.action}"


class PurchaseOrder(BaseModel):
    """Main Purchase Order model."""

    PO_STATUS_CHOICES = (
        ('DRAFT', _('Draft')),
        ('APPROVED', _('Approved')),
        ('ISSUED', _('Issued')),
        ('CLOSED', _('Closed')),
        ('CANCELLED', _('Cancelled')),
        # Split — this PO was reorganised into N child DRAFT POs via the
        # Split-into-batches action. Total obligation is preserved (sum
        # of children = original qty); the parent stays for audit trail
        # only and shouldn't show up in "active" lists. Distinct from
        # CANCELLED, which means the vendor has no obligation at all.
        ('SPLIT', _('Split')),
    )

    po_no = models.CharField(
        max_length=50,
        unique=True,
        db_index=True,
        editable=False
    )
    revision_no = models.PositiveIntegerField(
        default=0,
        help_text="Revision number for PO amendments"
    )
    vendor = models.ForeignKey(
        'master.Vendor',
        on_delete=models.PROTECT,
        related_name='purchase_orders',
        null=True,
        blank=True
    )
    company = models.ForeignKey(
        'core.Company',
        on_delete=models.PROTECT,
        related_name='purchase_orders'
    )
    warehouse = models.ForeignKey(
        'core.Warehouse',
        on_delete=models.PROTECT,
        related_name='purchase_orders'
    )
    linked_rfq = models.ForeignKey(
        RFQHeader,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='purchase_orders'
    )
    po_date = models.DateField(auto_now_add=True, db_index=True)
    expected_delivery_start = models.DateField(
        null=True,
        blank=True,
        db_index=True
    )
    expected_delivery_end = models.DateField(
        null=True,
        blank=True,
        db_index=True
    )
    freight_terms = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text="e.g., FOB, CIF, DDP"
    )
    transporter = models.ForeignKey(
        'master.Transporter',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='purchase_orders'
    )
    payment_terms = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text="e.g., Net 30, Net 60"
    )
    currency = models.CharField(
        max_length=3,
        default='INR'
    )
    terms_and_conditions = models.TextField(
        blank=True,
        default='',
        help_text="Standard T&C and special conditions"
    )
    broker_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text="Optional broker/agent name (free-form)"
    )
    status = models.CharField(
        max_length=20,
        choices=PO_STATUS_CHOICES,
        default='DRAFT',
        db_index=True
    )
    partial_receipt_flag = models.BooleanField(
        default=False,
        help_text="Allow partial receipts against this PO"
    )
    # Short-close: the balance (ordered − physically received) will never arrive
    # (damaged / cancelled). A user closes the PO early; status→CLOSED, the
    # reason is kept, and the admins are notified.
    close_reason = models.TextField(
        blank=True, default='',
        help_text="Why the PO was closed short of full receipt"
    )
    closed_at = models.DateTimeField(null=True, blank=True)
    closed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='closed_purchase_orders'
    )
    linked_prs = models.ManyToManyField(
        PurchaseRequest,
        related_name='purchase_orders'
    )

    class Meta:
        ordering = ['-po_date']
        indexes = [
            models.Index(fields=['vendor', 'status']),
            models.Index(fields=['warehouse', 'po_date']),
            models.Index(fields=['expected_delivery_end', 'status']),
        ]
        verbose_name = _('Purchase Order')
        verbose_name_plural = _('Purchase Orders')

    def __str__(self):
        return f"{self.po_no} (Rev {self.revision_no})"

    def save(self, *args, **kwargs):
        if not self.po_no:
            import re
            from django.utils import timezone as tz
            now = tz.now()
            # Indian financial year (Apr 1 – Mar 31): "26-27" for FY 2026-2027.
            start = now.year if now.month >= 4 else now.year - 1
            fy = f'{start % 100:02d}-{(start + 1) % 100:02d}'
            # Warehouse LOCATION token, e.g. "TVP" / "NKP" / "SLP". This is the
            # warehouse NAME, not the warehouse_code — the code is a generic
            # "WARH-##" / "W-##" that is the same for every location, so it
            # can't distinguish TVP from NKP. The name carries the company
            # suffix ("TVP-SS"), which we drop by keeping only the part before
            # the first hyphen ("without the company indications"), then clean
            # to an alphanumeric token. Falls back to the code prefix, then GEN.
            wh = ''
            if self.warehouse_id:
                name = (getattr(self.warehouse, 'name', '') or '').strip().upper()
                wh = re.sub(r'[^A-Z0-9]', '', name.split('-')[0])
                if not wh:
                    code = (getattr(self.warehouse, 'warehouse_code', '') or '').strip().upper()
                    wh = code.split('-')[0]
            prefix = f'PO-{wh or "GEN"}-{fy}-'
            from django.db.models.functions import Length
            last = (PurchaseOrder.objects.filter(po_no__startswith=prefix)
                    .annotate(_len=Length('po_no'))
                    .order_by('-_len', '-po_no')
                    .values_list('po_no', flat=True).first())
            num = 1
            if last:
                try:
                    num = int(last.rsplit('-', 1)[-1]) + 1
                except (ValueError, IndexError):
                    num = 1
            self.po_no = f'{prefix}{num:04d}'
        super().save(*args, **kwargs)

    @classmethod
    def totals_order_value(cls, po_ids):
        """{po_id: total PO value} for many POs in ONE query.

        Same expression as the single-PO method below, grouped by po instead
        of filtered to one. Kept as the only definition of the arithmetic so
        a page and a single PO cannot drift apart: the method below is this
        one called with a single id.
        """
        ids = list(po_ids)
        if not ids:
            return {}
        return {
            r['po_id']: (r['total'] or Decimal('0.00'))
            for r in POLine.objects.filter(po_id__in=ids).values('po_id').annotate(
                total=models.Sum(
                    models.F('quantity_ordered') * models.F('unit_price') -
                    models.F('quantity_ordered') * models.F('unit_price') * models.F('discount') / 100
                )
            )
        }

    def get_total_order_value(self):
        """Calculate total PO value."""
        return self.totals_order_value([self.id]).get(self.id) or Decimal('0.00')

    @classmethod
    def totals_received(cls, po_ids):
        """{po_id: total received} for many POs in a fixed number of queries.

        This holds the arithmetic; `get_total_received` below is this method
        called with a single id. They are one definition on purpose - a page
        total and a single-PO total that are computed separately can drift,
        and a quantity that disagrees with itself is worse than a slow page.

        The per-PO version cost four queries, so a 100-row list paid 400 round
        trips. Grouping by po instead of filtering to one cannot move any
        individual total: a ReceiptLine or PackingMaterialLine reaches exactly
        one po_line and therefore exactly one PO, so the buckets are only
        labelled, never merged.

        The legacy fallback keeps its dedupe. `receipt__linked_pos` is an M2M,
        so a receipt linked to two POs yields its line once PER PO - which is
        what the per-PO query did too, and why the row's own PO is selected
        alongside the id: (po, id) is distinct even where id alone is not.
        """
        from django.db.models import Sum, Q, F
        from django.db.models.functions import Coalesce
        ids = list(po_ids)
        if not ids:
            return {}
        live = Q(receipt__is_active=True)
        # PHYSICAL received (received_qty_expr): net qty when weighed, invoice qty
        # for debit-note or legacy rows. A short delivery leaves the PO open.
        received = {
            r['po_line__po_id']: r['total']
            for r in ReceiptLine.objects.filter(live, po_line__po_id__in=ids)
            .values('po_line__po_id')
            .annotate(total=Sum(received_qty_expr()))
        }
        packing_direct = {
            r['po_line__po_id']: r['total']
            for r in PackingMaterialLine.objects.filter(live, po_line__po_id__in=ids)
            .values('po_line__po_id')
            .annotate(total=Sum(Coalesce(F('net_quantity'), F('quantity'))))
        }
        lines_by_po = {}
        for pl in POLine.objects.filter(po_id__in=ids).only(
                'id', 'po_id', 'product_service_id'):
            lines_by_po.setdefault(pl.po_id, []).append(pl)
        sku_ids = {pl.product_service_id
                   for pls in lines_by_po.values() for pl in pls
                   if pl.product_service_id}
        # Fallback for lines NOT tied to a po_line FK (Goods receipt lines +
        # packing lines), matched by product + the receipt's linked PO. Deduped
        # on the row id because receipt__linked_pos is an M2M. Mirrors the
        # grouped physical definition.
        fallback = {}
        if sku_ids:
            for pid, _lid, sku, qr, nq, dn in (
                ReceiptLine.objects.filter(
                    live, po_line__isnull=True, product_id__in=sku_ids,
                    receipt__linked_pos__in=ids,
                ).values_list('receipt__linked_pos', 'id', 'product_id',
                              'quantity_received', 'net_quantity', 'is_debit_note').distinct()
            ):
                if sku is None:
                    continue
                phys = (Decimal(str(qr or 0)) if dn
                        else Decimal(str((nq if nq is not None else qr) or 0)))
                bucket = fallback.setdefault(pid, {})
                bucket[sku] = (bucket.get(sku) or Decimal('0.00')) + phys
            for pid, _lid, sku, q, nq in (
                PackingMaterialLine.objects.filter(
                    live, po_line__isnull=True, packaging_sku_id__in=sku_ids,
                    receipt__linked_pos__in=ids,
                ).values_list('receipt__linked_pos', 'id',
                              'packaging_sku_id', 'quantity', 'net_quantity').distinct()
            ):
                if sku is None:
                    continue
                phys = Decimal(str((nq if nq is not None else q) or 0))
                bucket = fallback.setdefault(pid, {})
                bucket[sku] = (bucket.get(sku) or Decimal('0.00')) + phys
        out = {}
        for pid in ids:
            total = ((received.get(pid) or Decimal('0.00'))
                     + (packing_direct.get(pid) or Decimal('0.00')))
            per_sku = fallback.get(pid)
            if per_sku:
                # Added once per MATCHING LINE, as the per-PO version did: a PO
                # with two lines ordering the same SKU counts it twice.
                for pl in lines_by_po.get(pid, []):
                    if pl.product_service_id in per_sku:
                        total += per_sku[pl.product_service_id]
            out[pid] = total
        return out

    def get_total_received(self):
        """Get total quantity received across all PO lines.

        Per receipt line:
          • `is_debit_note=True`  → use `quantity_received` (invoice
            qty). The receiver short-shipped, the missing qty was
            debited back to the vendor, so the PO obligation for that
            invoice slice is settled and counts toward closure.
          • `is_debit_note=False` → use `net_quantity` (physical), with
            a per-row fallback to `quantity_received` for legacy rows
            that never captured net. The missing qty is still
            outstanding so only what's physically on hand counts.

        Without the debit-note branch a receipt of Invoice=50 / Net=40
        with the operator's debit-note ON left the PO with a balance of
        60 instead of 50, forcing a phantom receipt for the 10 that was
        never going to arrive.

        Only excludes soft-deleted receipts (is_active=False) — must match
        POLineSerializer.get_received_quantity's same filter. DRAFT receipts
        are deliberately still counted: ReceiptAdvice.approval_status only
        has DRAFT/APPROVED, DRAFT is the default every receipt starts in,
        and it still represents real recorded intake.
        """
        return self.totals_received([self.id]).get(self.id) or Decimal('0.00')

    def is_fully_received(self):
        """Check if PO is fully received."""
        ordered = sum(
            line.quantity_ordered for line in self.po_lines.all()
        )
        received = self.get_total_received()
        return received >= ordered


class POLine(BaseModel):
    """Individual line items in a PO.

    Like PRLine, a POLine carries one of two possible item references —
    Product or ServiceCatalogue — but only ONE is set per line.
    `product_service` stays for the existing Goods flow (and is nullable
    so Service lines can save), while `service_catalogue` is additive.
    Exactly one of the two must be populated (enforced in
    POLineSerializer.validate).
    """

    po = models.ForeignKey(
        PurchaseOrder,
        on_delete=models.CASCADE,
        related_name='po_lines'
    )
    line_no = models.PositiveIntegerField()
    product_service = models.ForeignKey(
        'master.Product',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='po_lines',
        help_text='Goods line: FK to master.Product. Mutually exclusive with service_catalogue.'
    )
    service_catalogue = models.ForeignKey(
        'master.ServiceCatalogue',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='po_lines',
        help_text='Service line: FK to master.ServiceCatalogue. Mutually exclusive with product_service. Stock ledger is skipped for these lines on Receipt.'
    )
    description = models.TextField(
        blank=True,
        default='',
        help_text="Detailed description (auto-copied from the PR line remark on PO create — preserves the requester's context)."
    )
    # Manually-typed 'Specification' on the PO document. Deliberately
    # SEPARATE from description so the auto-copied PR remark and the
    # operator-typed spec don't overwrite each other. Rendered on the
    # PO document + vendor email PDF when non-empty; blank by default,
    # only populated when the operator types on the document form.
    specification = models.TextField(
        blank=True,
        default='',
        help_text='Operator-typed specification for this line on the PO document (blank until manually entered).',
    )
    # Per-line category mirrored from the originating PR line, but
    # also editable directly on the PO. Two reasons to store it on the
    # POLine itself rather than always walking back to PR:
    #
    #   1. PO lines created without a PR (RFQ-skip "Add line manually"
    #      or a Quote line that doesn't trace to a PR) had no
    #      category at all before this — the Receipt-routing fallback
    #      couldn't tell PACKING_MATERIAL apart from goods.
    #   2. Operators occasionally need to override the PR category at
    #      PO time (e.g. a raw material being repurposed as packing
    #      material for one shipment). Storing on POLine lets them
    #      change it without editing the upstream PR.
    #
    # Values match PRLine.category — for Goods PRs it's one of
    # RAW_MATERIAL / PACKING_MATERIAL / FINISHED_GOODS; for Machinery
    # / Services PRs it's free-form text. Blank means "inherit from PR
    # at read time" — the serializer's get_pr_line_category resolver
    # falls back to linked_pr_line.category when this is empty.
    category = models.CharField(
        max_length=80,
        blank=True,
        default='',
        help_text=(
            "Per-line category. Mirrors PRLine.category by default; can be "
            "overridden on the PO. Drives Receipt routing (PACKING_MATERIAL "
            "→ Packing Materials subform, others → Receipt Line Items)."
        ),
    )
    quantity_ordered = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.01'))]
    )
    uom = models.CharField(max_length=10)
    unit_price = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.00'))]
    )
    discount = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(Decimal('0.00')), MaxValueValidator(Decimal('100.00'))]
    )
    gst = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(Decimal('0.00')), MaxValueValidator(Decimal('100.00'))]
    )
    extra_commission = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        default=0,
        help_text="Extra commission amount"
    )
    agent_commission = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        default=0,
        help_text="Agent commission amount"
    )
    freight_estimate = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        null=True,
        blank=True
    )
    delivery_schedule = models.DateField(
        null=True,
        blank=True,
        help_text="Expected delivery date"
    )
    linked_pr_line = models.ForeignKey(
        PRLine,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='po_lines',
        help_text="Linked PR line (if any)"
    )
    linked_rfq_line = models.ForeignKey(
        QuoteLine,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='po_lines',
        help_text="Linked quote line (if any)"
    )
    batch_requirement_notes = models.TextField(
        blank=True,
        default='',
        help_text="Special batch/lot requirements"
    )

    class Meta:
        ordering = ['po', 'line_no']
        indexes = [
            models.Index(fields=['po', 'line_no']),
            models.Index(fields=['product_service']),
        ]
        unique_together = [['po', 'line_no']]
        verbose_name = _('PO Line')
        verbose_name_plural = _('PO Lines')

    def __str__(self):
        return f"{self.po.po_no} - Line {self.line_no}"

    def get_line_total(self):
        """Calculate line total."""
        base = self.quantity_ordered * self.unit_price
        discounted = base - (base * self.discount / 100)
        with_gst = discounted + (discounted * self.gst / 100)
        commissions = self.extra_commission + self.agent_commission
        freight = self.freight_estimate or Decimal('0.00')
        return with_gst + commissions + freight


class POETAUpdate(BaseModel):
    """ETA updates for Purchase Orders."""

    PO_ETA_STATUS = (
        ('PENDING', _('Pending')),
        ('UPDATED', _('Updated')),
    )

    po = models.ForeignKey(
        PurchaseOrder,
        on_delete=models.CASCADE,
        related_name='eta_updates'
    )
    update_date = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_by = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.PROTECT
    )
    expected_arrival_date = models.DateField(null=True, blank=True)
    status = models.CharField(
        max_length=20,
        choices=PO_ETA_STATUS,
        default='PENDING'
    )
    remarks = models.TextField(blank=True, default='')

    class Meta:
        ordering = ['-update_date']
        verbose_name = _('PO ETA Update')
        verbose_name_plural = _('PO ETA Updates')

    def __str__(self):
        return f"{self.po.po_no} - {self.expected_arrival_date}"


class ReceiptAdvice(BaseModel):
    """Goods receipt advice/GRN model."""

    QC_ROUTING_CHOICES = (
        ('WAREHOUSE', _('Warehouse')),
        ('QC_COORDINATOR', _('QC Coordinator')),
        ('QC_MANAGER', _('QC Manager')),
    )

    QC_STATUS_CHOICES = (
        ('PENDING', _('Pending QC')),
        ('PASS', _('QC Passed')),
        ('FAIL', _('QC Failed')),
        ('HOLD', _('On Hold')),
    )

    receipt_advice_no = models.CharField(
        max_length=50,
        unique=True,
        db_index=True,
        editable=False
    )
    receipt_date = models.DateTimeField(auto_now_add=True, db_index=True)
    warehouse = models.ForeignKey(
        'core.Warehouse',
        on_delete=models.PROTECT,
        related_name='receipt_advices'
    )
    godown = models.ForeignKey(
        'core.Godown',
        on_delete=models.PROTECT,
        related_name='receipt_advices',
        null=True,
        blank=True
    )
    vendor = models.ForeignKey(
        'master.Vendor',
        on_delete=models.PROTECT,
        related_name='receipt_advices'
    )
    vehicle_number = models.CharField(
        max_length=50,
        blank=True,
        default='',
        help_text="Vehicle registration number"
    )
    driver_name = models.CharField(
        max_length=100,
        blank=True,
        default='',
    )
    driver_phone = models.CharField(
        max_length=20,
        blank=True,
        default='',
        help_text="Driver's contact number — used to reach the driver on transit issues.",
    )
    transporter_name = models.CharField(
        max_length=255, blank=True, default='',
        help_text="Name of the transporter / carrier.",
    )
    freight_bill_no = models.CharField(
        max_length=100, blank=True, default='',
        help_text="Freight bill / LR number from the transporter.",
    )
    freight_bill_date = models.DateField(
        null=True, blank=True,
        help_text="Date on the freight bill.",
    )
    qc_routing = models.CharField(
        max_length=20,
        choices=QC_ROUTING_CHOICES,
        default='WAREHOUSE'
    )
    qc_status = models.CharField(
        max_length=20,
        choices=QC_STATUS_CHOICES,
        default='PENDING',
        db_index=True
    )
    # Physical-condition check — separate from qc_status (which is the
    # pass/fail of lab/parameter testing). Weight can match the PO yet the
    # consignment arrives with damaged boxes / spoiled material; this
    # captures that condition at receiving time.
    PHYSICAL_QC_STATUS_CHOICES = (
        ('OK', _('OK — No Damage')),
        ('PARTIALLY_DAMAGED', _('Partially Damaged')),
        ('FULLY_DAMAGED', _('Fully Damaged / Not Usable')),
        ('HOLD', _('On Hold — Inspection Pending')),
    )
    physical_qc_status = models.CharField(
        max_length=20, choices=PHYSICAL_QC_STATUS_CHOICES, default='OK',
        db_index=True,
        help_text='Physical condition of the consignment at receiving.',
    )
    physical_qc_remarks = models.TextField(
        blank=True, default='',
        help_text='Damage description / inspection notes.',
    )
    partial_receipt_flag = models.BooleanField(
        default=False,
        help_text="Partial receipt of PO"
    )
    APPROVAL_STATUS_CHOICES = (
        ('DRAFT', _('Draft')),
        ('APPROVED', _('Approved')),
    )
    approval_status = models.CharField(
        max_length=20, choices=APPROVAL_STATUS_CHOICES,
        default='DRAFT', db_index=True,
    )
    approved_by = models.ForeignKey(
        'core.StakeholderUser', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='approved_receipts',
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    advance_amount = models.DecimalField(
        max_digits=14, decimal_places=2, default=0,
        help_text="Advance paid to transporter"
    )
    freight_value = models.DecimalField(
        max_digits=14, decimal_places=2, default=0,
        help_text="Total freight value"
    )
    FREIGHT_TERMS_CHOICES = (
        ('PAID', _('Paid')),
        ('TO_PAY', _('To Pay')),
    )
    freight_terms = models.CharField(
        max_length=20, choices=FREIGHT_TERMS_CHOICES, blank=True, default=''
    )
    remarks = models.TextField(blank=True, default='')
    linked_pos = models.ManyToManyField(
        PurchaseOrder,
        blank=True,
        related_name='receipt_advices'
    )

    # ── Direct Receipt support ───────────────────────────────────────────
    # A "Direct Receipt" is a GRN with no upstream PO (emergency buy,
    # free sample, replacement, opening stock etc). It needs the user to
    # enter what the PO would have auto-filled (vendor, product, rate,
    # GST) plus a justification reason for the audit trail.
    RECEIPT_SOURCE_CHOICES = (
        ('AGAINST_PO', _('Against PO')),
        ('DIRECT', _('Direct Receipt')),
    )
    DIRECT_REASON_CHOICES = (
        ('EMERGENCY', _('Emergency Purchase')),
        ('FREE_SAMPLE', _('Free Sample')),
        ('REPLACEMENT', _('Replacement / Warranty')),
        ('OPENING_STOCK', _('Opening Stock')),
        ('RETURN_FROM_JOBWORK', _('Returned from Job Work')),
        ('GIFT', _('Gift / Donation')),
        ('OTHER', _('Other')),
    )
    receipt_source = models.CharField(
        max_length=20,
        choices=RECEIPT_SOURCE_CHOICES,
        default='AGAINST_PO',
        db_index=True,
    )
    direct_reason = models.CharField(
        max_length=30,
        choices=DIRECT_REASON_CHOICES,
        blank=True,
        default='',
        help_text="Why this receipt has no PO. Required when receipt_source=DIRECT.",
    )
    invoice_no = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text="Vendor invoice number (mainly for direct receipts).",
    )
    invoice_date = models.DateField(null=True, blank=True)
    invoice_amount = models.DecimalField(
        max_digits=14,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Vendor invoice total. Captured here so the Bill page can prefill.",
    )

    class Meta:
        ordering = ['-receipt_date']
        indexes = [
            models.Index(fields=['warehouse', 'qc_status']),
            models.Index(fields=['vendor', 'receipt_date']),
        ]
        verbose_name = _('Receipt Advice')
        verbose_name_plural = _('Receipt Advices')

    def __str__(self):
        return self.receipt_advice_no

    def save(self, *args, **kwargs):
        if not self.receipt_advice_no:
            from datetime import datetime
            year = datetime.now().year
            prefix = f"GRN-{year}-"
            last = ReceiptAdvice.objects.filter(
                receipt_advice_no__startswith=prefix
            ).order_by('-receipt_advice_no').first()
            if last:
                try:
                    num = int(last.receipt_advice_no.split('-')[-1]) + 1
                except (ValueError, IndexError):
                    num = 1
            else:
                num = 1
            self.receipt_advice_no = f"{prefix}{num:05d}"
        super().save(*args, **kwargs)

    def get_total_received(self):
        """Get total quantity received on this receipt.

        Mirrors PurchaseOrder.get_total_received's debit-note-aware
        logic — see that docstring. Lines flagged as debit notes count
        their invoice qty (settled financially); other lines count
        their physical net qty (falling back to invoice qty when net
        is NULL for legacy rows)."""
        # Invoice-driven aggregation — matches PO.get_total_received.
        return self.totals_received([self.id]).get(self.id) or Decimal('0.00')

    @classmethod
    def totals_received(cls, receipt_ids):
        """{receipt_id: total received} for many receipts in ONE query.

        Same SUM as the single-receipt method above, grouped by receipt instead
        of filtered to one - and the method above is now this one called with a
        single id, so the two cannot drift.

        The aggregation stays in SQL deliberately. Summing the prefetched lines
        in Python would have to reproduce the `or Decimal('0.00')` fallback
        exactly, where a sum of zero must print "0.00" and not "0.0000";
        grouping the same SUM keeps the database's own scale and sidesteps that
        entirely.

        A list page asks for 500 rows (useApiData sends page_size=500 and then
        follows `next` until it has the whole table), so this was 500 round
        trips per request, not the 100 a default page suggested.
        """
        ids = list(receipt_ids)
        if not ids:
            return {}
        # PHYSICAL received — same canonical definition as PO.totals_received.
        return {
            r['receipt_id']: r['total']
            for r in ReceiptLine.objects.filter(receipt_id__in=ids)
            .values('receipt_id').annotate(total=models.Sum(received_qty_expr()))
        }


class ReceiptLine(BaseModel):
    """Individual line items in a receipt advice.

    Like the other purchase line models, a receipt line carries one of
    three possible item references. Stock-ledger posting on receipt
    approval is GATED by which FK is set:
      - Goods (product) → ledger entry written
      - Service         → NO ledger entry (services don't move stock)
    See ReceiptAdviceViewSet.approve for the gating logic.
    """

    receipt = models.ForeignKey(
        ReceiptAdvice,
        on_delete=models.CASCADE,
        related_name='receipt_lines'
    )
    line_no = models.PositiveIntegerField()
    po_line = models.ForeignKey(
        POLine,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='receipt_lines'
    )
    product = models.ForeignKey(
        'master.Product',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='receipt_lines',
        help_text='Goods line: FK to master.Product. Mutually exclusive with service_catalogue.'
    )
    service_catalogue = models.ForeignKey(
        'master.ServiceCatalogue',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='receipt_lines',
        help_text='Service line: FK to master.ServiceCatalogue. Stock ledger writes are SKIPPED for these lines on receipt approval.'
    )
    batch_no = models.CharField(
        max_length=100,
        blank=True,
        default='',
        db_index=True
    )
    expiry_date = models.DateField(
        null=True,
        blank=True,
        help_text="Expiry date for consumables"
    )
    quantity_received = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.00'))]
    )
    net_quantity = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        null=True,
        blank=True,
        help_text="Actual net quantity after weighment / inspection"
    )
    # Optional density (g/ml or kg/L) captured for liquid intake — the
    # frontend surfaces the input only when the linked PR line's UOM is
    # LTR, since it's the value used to reconcile mass-vs-volume for
    # solvents. Nullable so goods lines and legacy rows aren't affected.
    density = models.DecimalField(
        max_digits=10, decimal_places=4,
        null=True, blank=True,
        help_text="Density (g/ml or kg/L) for liquid receipts — only captured when the PR line's UOM is LTR."
    )
    # Batch-specific Specific Gravity for kg-purchased / litre-consumed
    # products (Product.sg_applicable=True). The frontend surfaces this
    # input only for those products; on save quantity_in_litres is
    # derived as quantity_received / specific_gravity and frozen for the
    # Production Stock post so a later SG edit doesn't retroactively
    # drift stored litres.
    specific_gravity = models.DecimalField(
        max_digits=8, decimal_places=4,
        null=True, blank=True,
        help_text='Batch SG for kg-purchased / litre-consumed products.',
    )
    quantity_in_litres = models.DecimalField(
        max_digits=18, decimal_places=4,
        null=True, blank=True,
        help_text='Derived at save time: quantity_received / specific_gravity.',
    )
    uom = models.CharField(max_length=10)
    extra_commission = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        default=0
    )
    agent_commission = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        default=0
    )
    quantity_accepted = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        null=True,
        blank=True,
        help_text="Quantity accepted after QC"
    )
    quantity_rejected = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        null=True,
        blank=True,
        help_text="Quantity rejected in QC"
    )
    godown_location = models.ForeignKey(
        'core.Godown',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='received_items'
    )
    remarks = models.TextField(blank=True, default='')
    is_debit_note = models.BooleanField(
        default=False,
        help_text="If True, this receipt line is eligible for a Debit Note "
                  "via Vendor Credit. The bill linked to this receipt will "
                  "appear in the Vendor Credit Bill No dropdown."
    )
    # ── Direct-receipt pricing fields ────────────────────────────────────
    # Without a PO these aren't pulled from anywhere, so we capture them
    # on the receipt line directly so the Bill page can prefill.
    rate = models.DecimalField(
        max_digits=14,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Per-unit rate. Required for direct receipts (no PO source).",
    )
    gst_percentage = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="GST %% for this line. Used for direct receipts.",
    )

    # Optional physical-measurement fields captured at receipt time —
    # useful for items where palletisation, cubing, or per-piece weight
    # matters (timber, sheet metal, sacks). All four are nullable so
    # existing rows / lines that don't track dimensions aren't forced
    # to backfill. Units are operator-managed (typically mm / kg) and
    # not enforced at the DB layer.
    length = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text='Optional physical length per unit.',
    )
    breadth = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text='Optional physical breadth per unit.',
    )
    width = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text='Optional physical width per unit (distinct from breadth when both are relevant).',
    )
    weight = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text='Optional per-unit weight, recorded at receipt time.',
    )
    category = models.CharField(
        max_length=80, blank=True, default='',
        help_text=(
            "Line category (RAW_MATERIAL, PACKING_MATERIAL, FRUIT, MAIZE, etc.). "
            "Auto-populated from po_line.category on save when blank."
        ),
    )

    TOLERANCE_CATEGORIES = {'RAW_MATERIAL', 'PACKING_MATERIAL', 'FRUIT', 'MAIZE', 'FINISHED_GOODS'}
    TOLERANCE_MIN_QTY = Decimal('10')
    TOLERANCE_PCT = Decimal('5')

    @property
    def has_qty_tolerance(self):
        return self.category.upper() in self.TOLERANCE_CATEGORIES

    def qty_within_tolerance(self):
        """Check if net_quantity is within ±5% of quantity_received.
        Returns (is_within, diff_pct) or (True, 0) when not applicable."""
        if self.net_quantity is None:
            return True, Decimal('0')
        invoiced = self.quantity_received or Decimal('0')
        received = self.net_quantity
        if invoiced <= Decimal('0'):
            return True, Decimal('0')
        if not self.has_qty_tolerance:
            return invoiced == received, Decimal('0')
        if invoiced <= self.TOLERANCE_MIN_QTY:
            return invoiced == received, Decimal('0')
        diff_pct = abs(invoiced - received) / invoiced * 100
        return diff_pct <= self.TOLERANCE_PCT, diff_pct

    class Meta:
        ordering = ['receipt', 'line_no']
        indexes = [
            models.Index(fields=['receipt', 'line_no']),
            models.Index(fields=['batch_no', 'expiry_date']),
        ]
        unique_together = [['receipt', 'line_no']]
        verbose_name = _('Receipt Line')
        verbose_name_plural = _('Receipt Lines')

    def __str__(self):
        return f"{self.receipt.receipt_advice_no} - Line {self.line_no}"


class PackingMaterialLine(BaseModel):
    """Packing materials received with goods."""

    CONDITION_CHOICES = (
        ('NEW', _('New')),
        ('DAMAGED', _('Damaged')),
    )

    receipt = models.ForeignKey(
        ReceiptAdvice,
        on_delete=models.CASCADE,
        related_name='packing_materials'
    )
    packaging_sku = models.ForeignKey(
        'master.Product',
        on_delete=models.PROTECT,
        related_name='packing_material_lines',
        help_text="Packaging material SKU"
    )
    # Optional link back to the PO line this packing-material row was
    # auto-filled from. Surfaces PO Qty / Rcvd / Balance on the row so
    # the operator sees the same context Receipt Line Items show. Null
    # for Direct Receipts or for lines added manually after the auto-
    # fill happened.
    po_line = models.ForeignKey(
        'POLine',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='packing_material_lines',
        help_text='Originating PO line (when this row came from a PO auto-fill).',
    )
    # `quantity` = Invoice Quantity (what the vendor invoiced). Kept as
    # the existing required column for back-compat with rows saved
    # before this expansion.
    quantity = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.01'))]
    )
    # net_quantity = Received Quantity (what was actually accepted on
    # the floor, after counting / inspection). Nullable so legacy rows
    # remain valid and operators can leave it blank when not yet known.
    net_quantity = models.DecimalField(
        max_digits=18, decimal_places=4, null=True, blank=True,
        help_text='Received quantity after physical count / inspection.',
    )
    uom = models.CharField(max_length=10)
    # Optional physical-measurement fields (same shape as ReceiptLine
    # so reports can union the two tables without per-source branching).
    length = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
    )
    breadth = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
    )
    width = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
    )
    weight = models.DecimalField(
        max_digits=12, decimal_places=4, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0.00'))],
    )
    batch_no = models.CharField(
        max_length=100, blank=True, default='', db_index=True,
    )
    godown_location = models.ForeignKey(
        'core.Godown',
        on_delete=models.PROTECT,
        null=True, blank=True,
        related_name='received_packing_materials',
    )
    remarks = models.TextField(blank=True, default='')
    condition = models.CharField(
        max_length=20,
        choices=CONDITION_CHOICES,
        default='NEW'
    )

    class Meta:
        ordering = ['receipt']
        verbose_name = _('Packing Material Line')
        verbose_name_plural = _('Packing Material Lines')

    def __str__(self):
        # Product exposes `product_name`, not `name` — the old `.name`
        # lookup crashed the Receipt Advice change view with
        # AttributeError when this inline row was rendered.
        return f"{self.receipt.receipt_advice_no} - {self.packaging_sku.product_name}"


class WeighmentDetail(BaseModel):
    """Weighbridge readings captured against a receipt advice."""

    receipt = models.ForeignKey(
        ReceiptAdvice,
        on_delete=models.CASCADE,
        related_name='weighment_details',
    )
    weighment_name = models.CharField(
        max_length=150,
        blank=True,
        default='',
        help_text='Weighbridge / station name (free-form)',
    )
    weighment_number = models.CharField(
        max_length=80,
        blank=True,
        default='',
        help_text='Slip / ticket number',
    )
    first_weight = models.DecimalField(
        max_digits=14,
        decimal_places=3,
        null=True,
        blank=True,
        validators=[MinValueValidator(Decimal('0'))],
    )
    second_weight = models.DecimalField(
        max_digits=14,
        decimal_places=3,
        null=True,
        blank=True,
        validators=[MinValueValidator(Decimal('0'))],
    )
    tare_weight = models.DecimalField(
        max_digits=14,
        decimal_places=3,
        null=True,
        blank=True,
        validators=[MinValueValidator(Decimal('0'))],
    )
    # Free-form so the user can enter whatever the weighbridge prints
    # (KG / MTS / TON / LITRES …). Not enforced against the Product
    # UOM list because weighbridges have their own conventions and we
    # don't want to reject a slip that says "MT" or "Quintal".
    uom = models.CharField(
        max_length=10,
        blank=True,
        default='KG',
        help_text='Unit for the weight readings (KG, MTS, etc).',
    )

    class Meta:
        ordering = ['created_at']
        verbose_name = _('Weighment Detail')
        verbose_name_plural = _('Weighment Details')

    def __str__(self):
        return f"{self.receipt.receipt_advice_no} - {self.weighment_number or self.weighment_name or 'Weighment'}"


class FreightDetail(BaseModel):
    """Freight charges for receipt."""

    FREIGHT_TYPE_CHOICES = (
        ('LOCAL_DRAYAGE', _('Local Drayage')),
        ('LINEHAUL', _('Linehaul')),
    )

    PAYABLE_BY_CHOICES = (
        ('COMPANY', _('Company')),
        ('VENDOR', _('Vendor')),
    )

    receipt = models.ForeignKey(
        ReceiptAdvice,
        on_delete=models.CASCADE,
        related_name='freight_details'
    )
    freight_type = models.CharField(
        max_length=30,
        choices=FREIGHT_TYPE_CHOICES
    )
    transporter = models.ForeignKey(
        'master.Transporter',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='freight_details',
        help_text="Transporter"
    )
    freight_terms = models.CharField(max_length=100, blank=True, default='')
    tentative_charge = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(Decimal('0.00'))]
    )
    discount = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(Decimal('0.00')), MaxValueValidator(Decimal('100.00'))]
    )
    payable_by = models.CharField(
        max_length=20,
        choices=PAYABLE_BY_CHOICES,
        default='COMPANY'
    )
    quantity_basis = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        null=True,
        blank=True,
        help_text="Quantity for freight calculation"
    )
    quantity_uom = models.CharField(
        max_length=10,
        blank=True,
        default='',
        help_text="UOM for freight calculation"
    )
    destination_state = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text="For tax calculation"
    )
    cost_per_unit_calc = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        null=True,
        blank=True,
        help_text="Cost per unit (tentative_charge / quantity_basis)"
    )

    class Meta:
        ordering = ['receipt']
        indexes = [
            models.Index(fields=['receipt', 'freight_type']),
        ]
        verbose_name = _('Freight Detail')
        verbose_name_plural = _('Freight Details')

    def __str__(self):
        return f"{self.receipt.receipt_advice_no} - {self.get_freight_type_display()}"

    def get_payable_amount(self):
        """Calculate payable amount after discount."""
        return self.tentative_charge - (
            self.tentative_charge * self.discount / 100
        )


class LoadingUnloadingWage(BaseModel):
    """Loading and unloading wages."""

    WAGE_TYPE_CHOICES = (
        ('LOADING', _('Loading')),
        ('UNLOADING', _('Unloading')),
    )

    PAYABLE_BY_CHOICES = (
        ('COMPANY', _('Company')),
        ('VENDOR', _('Vendor')),
    )

    receipt = models.ForeignKey(
        ReceiptAdvice,
        on_delete=models.CASCADE,
        related_name='loading_unloading_wages'
    )
    wage_type = models.CharField(
        max_length=20,
        choices=WAGE_TYPE_CHOICES
    )
    contractor_vendor = models.ForeignKey(
        'master.Vendor',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='loading_unloading_wages'
    )
    amount = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(Decimal('0.00'))]
    )
    tds_applicable = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(Decimal('0.00')), MaxValueValidator(Decimal('100.00'))],
        help_text="TDS percentage"
    )
    payable_by = models.CharField(
        max_length=20,
        choices=PAYABLE_BY_CHOICES,
        default='COMPANY'
    )
    remarks = models.TextField(blank=True, default='')

    class Meta:
        ordering = ['receipt', 'wage_type']
        verbose_name = _('Loading/Unloading Wage')
        verbose_name_plural = _('Loading/Unloading Wages')

    def __str__(self):
        return f"{self.receipt.receipt_advice_no} - {self.get_wage_type_display()}"

    def get_tds_amount(self):
        """Calculate TDS amount."""
        return self.amount * self.tds_applicable / 100

    def get_net_payable(self):
        """Calculate net payable after TDS."""
        return self.amount - self.get_tds_amount()


class FreightPaymentSchedule(BaseModel):
    """Payment schedule for freight."""

    receipt = models.ForeignKey(
        ReceiptAdvice,
        on_delete=models.CASCADE,
        related_name='freight_payment_schedules'
    )
    freight_type = models.CharField(
        max_length=30,
        choices=FreightDetail.FREIGHT_TYPE_CHOICES
    )
    transporter = models.ForeignKey(
        'master.Vendor',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='freight_payment_schedules'
    )
    due_date = models.DateField(db_index=True)
    amount = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.00'))]
    )
    tds = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        default=0,
        help_text="TDS amount"
    )
    reminder_flag = models.BooleanField(
        default=False,
        help_text="Reminder sent flag"
    )

    class Meta:
        ordering = ['due_date']
        indexes = [
            models.Index(fields=['due_date', 'transporter']),
        ]
        verbose_name = _('Freight Payment Schedule')
        verbose_name_plural = _('Freight Payment Schedules')

    def __str__(self):
        return f"{self.receipt.receipt_advice_no} - {self.due_date}"


class WageEntry(BaseModel):
    """Header for loading/unloading wage entries in Freight & Billing module."""

    STATUS_CHOICES = (
        ('DRAFT', _('Draft')),
        ('CONFIRMED', _('Confirmed')),
        # Auto-transitioned by WagePaymentSerializer.create() when every
        # non-cancelled line on this entry has been settled via a Wage
        # Payment. A WagePayment.cancel() releases the lines and reverts
        # this back to CONFIRMED.
        ('PAID', _('Paid')),
        ('CLOSED', _('Closed')),
        ('CANCELLED', _('Cancelled')),
    )

    SOURCE_TYPE_CHOICES = (
        ('PURCHASE_RECEIPT', _('Purchase Receipt')),
        ('INVENTORY_TRANSFER', _('Inventory Transfer')),
        ('INVENTORY_SHIFTING', _('Inventory Shifting')),
        ('SALES_DISPATCH_CHALLAN', _('Sales Dispatch Challan')),
    )

    entry_no = models.CharField(max_length=50, unique=True, db_index=True, editable=False)
    date = models.DateField(db_index=True)
    source_type = models.CharField(
        max_length=30,
        choices=SOURCE_TYPE_CHOICES,
        default='PURCHASE_RECEIPT',
        db_index=True,
        help_text='Which kind of document this wage bill is for.',
    )
    # Exactly one of the four source FKs is populated per record. Validation is
    # enforced in the serializer rather than as a DB constraint so error
    # messages stay friendly.
    receipt = models.ForeignKey(
        ReceiptAdvice, on_delete=models.SET_NULL, null=True, blank=True, related_name='wage_entries'
    )
    transfer_source = models.ForeignKey(
        'inventory.StockTransferDC', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='wage_entries',
    )
    shifting_source = models.ForeignKey(
        'inventory.WarehouseShifting', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='wage_entries',
    )
    dispatch_challan_source = models.ForeignKey(
        'sales.DispatchChallan', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='wage_entries',
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='DRAFT', db_index=True)
    overall_remarks = models.TextField(blank=True, default='')
    additional_charges = models.JSONField(null=True, blank=True)
    additional_charges_remarks = models.TextField(blank=True, default='')
    created_by = models.ForeignKey(
        'core.StakeholderUser', on_delete=models.SET_NULL, null=True, blank=True
    )

    class Meta:
        ordering = ['-date', '-created_at']
        verbose_name = _('Wage Entry')
        verbose_name_plural = _('Wage Entries')

    def __str__(self):
        return self.entry_no

    def save(self, *args, **kwargs):
        if not self.entry_no:
            from datetime import datetime
            year = datetime.now().year
            prefix = f"WE-{year}-"
            last = WageEntry.objects.filter(entry_no__startswith=prefix).order_by('-entry_no').first()
            num = int(last.entry_no.split('-')[-1]) + 1 if last else 1
            self.entry_no = f"{prefix}{num:05d}"
        super().save(*args, **kwargs)

    def get_total_amount(self):
        lines_total = self.wage_lines.aggregate(total=models.Sum('amount'))['total'] or Decimal('0')
        extra = Decimal('0')
        for c in (self.additional_charges or []):
            if c.get('add_to_total'):
                try:
                    extra += Decimal(str(c.get('amount') or 0))
                except Exception:
                    pass
        return lines_total + extra

    def get_total_advance(self):
        return self.wage_lines.aggregate(total=models.Sum('advance_paid'))['total'] or Decimal('0')

    def get_total_balance(self):
        return self.get_total_amount() - self.get_total_advance()


class WageEntryLine(BaseModel):
    """Individual wage row within a WageEntry."""

    WAGE_TYPE_CHOICES = (
        ('LOADING', _('Loading')),
        ('UNLOADING', _('Unloading')),
    )

    # Payment-cycle status per line. Wage payments are made periodically
    # (weekly / 14-day / custom range) and group multiple lines per
    # contractor. Until a line is included in a completed WagePayment it
    # stays UNPAID; once paid the FK below points at the settlement and
    # the line becomes locked from future selection.
    PAYMENT_STATUS_CHOICES = (
        ('UNPAID', _('Unpaid')),
        ('PAID',   _('Paid')),
    )

    entry = models.ForeignKey(WageEntry, on_delete=models.CASCADE, related_name='wage_lines')
    wage_type = models.CharField(max_length=20, choices=WAGE_TYPE_CHOICES)
    contractor = models.ForeignKey(
        'master.Vendor', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='wage_entry_lines'
    )
    work_date = models.DateField(null=True, blank=True)
    tons = models.DecimalField(max_digits=18, decimal_places=4, null=True, blank=True, help_text="Tonnage for wage calculation")
    cost_per_ton = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True, help_text="Cost per ton")
    amount = models.DecimalField(max_digits=18, decimal_places=2, default=0, validators=[MinValueValidator(Decimal('0.00'))])
    advance_paid = models.DecimalField(max_digits=18, decimal_places=2, default=0, validators=[MinValueValidator(Decimal('0.00'))])
    remarks = models.TextField(blank=True, default='')
    payment_status = models.CharField(
        max_length=20, choices=PAYMENT_STATUS_CHOICES, default='UNPAID', db_index=True,
        help_text='Whether this line has been settled via a Wage Payment.',
    )
    wage_payment = models.ForeignKey(
        'WagePayment', on_delete=models.PROTECT,
        null=True, blank=True, related_name='paid_lines',
        help_text='The WagePayment that settled this line, if any.',
    )

    class Meta:
        ordering = ['entry', 'wage_type']

    def __str__(self):
        return f"{self.entry.entry_no} - {self.get_wage_type_display()}"

    @property
    def balance(self):
        return self.amount - self.advance_paid


class WagePayment(BaseModel):
    """Periodic settlement against a single contractor's unpaid wage lines.

    A WagePayment groups N WageEntryLine rows (across many wage entries)
    belonging to ONE contractor vendor, settled over a date window
    (weekly / fortnightly / custom). Each included line gets its FK set
    on save and its `payment_status` flipped to PAID — so the same line
    can never be picked up twice. Summary fields (gross_wages / advance
    / net_payable / paid_amount / balance) are snapshotted at save time
    so the settlement document is stable even if the underlying lines
    are later cancelled at the entry level.
    """

    CYCLE_CHOICES = (
        ('WEEKLY',         _('Weekly')),
        ('FOURTEEN_DAYS',  _('14 Days')),
        ('CUSTOM',         _('Custom Range')),
    )
    STATUS_CHOICES = (
        ('DRAFT',     _('Draft')),
        ('COMPLETED', _('Completed')),
        ('CANCELLED', _('Cancelled')),
    )
    PAYMENT_MODE_CHOICES = (
        ('CASH',   _('Cash')),
        ('BANK',   _('Bank Transfer')),
        ('UPI',    _('UPI')),
        ('CHEQUE', _('Cheque')),
        ('NEFT',   _('NEFT')),
        ('RTGS',   _('RTGS')),
        ('OTHER',  _('Other')),
    )

    payment_no = models.CharField(max_length=50, unique=True, db_index=True, editable=False)
    contractor = models.ForeignKey(
        'master.Vendor', on_delete=models.PROTECT, related_name='wage_payments',
        help_text='Vendor (must be marked CONTRACTOR / WAGES in vendor_type).',
    )
    cycle_type = models.CharField(max_length=20, choices=CYCLE_CHOICES, default='WEEKLY')
    from_date = models.DateField()
    to_date = models.DateField()
    payment_date = models.DateField(db_index=True)

    # Snapshots — totals at settlement time. Recomputed in serializer.create().
    line_count    = models.PositiveIntegerField(default=0)
    gross_wages   = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    total_advance = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    net_payable   = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    paid_amount   = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    balance_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)

    payment_mode = models.CharField(max_length=20, choices=PAYMENT_MODE_CHOICES, default='BANK')
    reference_no = models.CharField(max_length=100, blank=True, default='')
    remarks = models.TextField(blank=True, default='')
    # Default DRAFT — the payment is only considered settled after an
    # explicit Approve action. Until then the lines stay UNPAID but
    # are claimed (via FK) so they don't appear in another payment's
    # unpaid-lines list.
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='DRAFT', db_index=True)
    created_by = models.ForeignKey(
        'core.StakeholderUser', on_delete=models.SET_NULL, null=True, blank=True,
    )

    class Meta:
        ordering = ['-payment_date', '-created_at']
        verbose_name = _('Wage Payment')
        verbose_name_plural = _('Wage Payments')

    def __str__(self):
        return self.payment_no

    def save(self, *args, **kwargs):
        if not self.payment_no:
            from datetime import datetime
            year = datetime.now().year
            prefix = f"WP-{year}-"
            last = WagePayment.objects.filter(payment_no__startswith=prefix).order_by('-payment_no').first()
            num = int(last.payment_no.split('-')[-1]) + 1 if last else 1
            self.payment_no = f"{prefix}{num:05d}"
        super().save(*args, **kwargs)


class FreightAdviceInbound(BaseModel):
    """Freight advice for inbound shipments."""

    FREIGHT_ADVICE_STATUS = (
        ('DRAFT', _('Draft')),
        ('PENDING_APPROVAL', _('Pending Approval')),
        ('APPROVED', _('Approved')),
        ('IN_TRANSIT', _('In Transit')),
        ('COMPLETED', _('Completed')),
        ('PAID', _('Paid')),
        ('CANCELLED', _('Cancelled')),
    )

    FREIGHT_TERMS_CHOICES = (
        ('PAID', _('Paid')),
        ('TO_PAY', _('To Pay')),
    )

    SOURCE_TYPE_CHOICES = (
        ('PURCHASE_RECEIPT', _('Purchase Receipt')),
        ('INVENTORY_TRANSFER', _('Inventory Transfer')),
        ('INVENTORY_SHIFTING', _('Inventory Shifting')),
        ('SALES_DISPATCH_CHALLAN', _('Sales Dispatch Challan')),
        ('VENDOR_BILL', _('Vendor Bill')),
    )

    # Whether the freight is billed on the vendor's own invoice (a line inside a
    # goods bill) or came on a separate transporter slip. Separate-slip is the
    # existing operational flow (paid via FreightPaymentInbound); invoice-included
    # freight is tracking-only — its paid/pending FOLLOWS the linked vendor bill
    # (goods first, freight last), never a separate payment.
    FREIGHT_SOURCE_CHOICES = (
        ('SEPARATE_SLIP', _('Separate freight slip')),
        ('INVOICE_INCLUDED', _('Included in vendor invoice')),
    )

    advice_no = models.CharField(
        max_length=50,
        unique=True,
        db_index=True,
        editable=False
    )
    direction = models.CharField(
        max_length=20,
        default='INBOUND',
        editable=False
    )
    freight_source = models.CharField(
        max_length=20,
        choices=FREIGHT_SOURCE_CHOICES,
        default='SEPARATE_SLIP',
        db_index=True,
    )
    # For invoice-included freight: the goods VendorBill this freight is a line
    # on. Its paid/pending is derived from this bill's payment, not a separate
    # freight payment. CASCADE so reverting/deleting the bill drops the freight.
    vendor_bill = models.ForeignKey(
        'purchase.VendorBill',
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='invoice_freight_advices',
    )
    # One transporter slip can cover SEVERAL goods bills (one trip, many invoices).
    # `vendor_bill` above is the primary bill; these are the ADDITIONAL bills the
    # same freight covers. The freight is still ONE record, paid once — it just
    # shows on every covered bill. A bill has at most one covering freight.
    covered_bills = models.ManyToManyField(
        'purchase.VendorBill',
        blank=True,
        related_name='covering_freights',
    )
    source_type = models.CharField(
        max_length=30,
        choices=SOURCE_TYPE_CHOICES,
        default='PURCHASE_RECEIPT',
        db_index=True,
        help_text='Which kind of document this freight is billed against.',
    )
    # Exactly one of the three source FKs is populated per record. Validation
    # is enforced in the serializer rather than as a DB constraint so we can
    # produce a friendly error message; the model just makes all three
    # nullable so an existing PURCHASE_RECEIPT freight can keep its
    # receipt_advice while a new INVENTORY_TRANSFER freight uses
    # transfer_source instead.
    receipt_advice = models.ForeignKey(
        ReceiptAdvice,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='freight_advices'
    )
    transfer_source = models.ForeignKey(
        'inventory.StockTransferDC',
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='freight_advices'
    )
    shifting_source = models.ForeignKey(
        'inventory.WarehouseShifting',
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='freight_advices'
    )
    dispatch_challan_source = models.ForeignKey(
        'sales.DispatchChallan',
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='inbound_freight_advices',
        help_text='Sales DC used as the source document for this freight bill.'
    )
    transporter = models.ForeignKey(
        'master.Transporter',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='freight_advices_inbound'
    )
    freight_type = models.CharField(
        max_length=30,
        choices=FreightDetail.FREIGHT_TYPE_CHOICES
    )
    created_by = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.SET_NULL,
        null=True,
        blank=True
    )
    created_date = models.DateTimeField(auto_now_add=True, db_index=True)
    base_amount = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.00'))]
    )
    discount = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(Decimal('0.00')), MaxValueValidator(Decimal('100.00'))]
    )
    loading_wages_amount = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        default=0
    )
    unloading_wages_amount = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        default=0
    )
    # Mamul and the generic "less" adjustment can each be a PLUS or a LESS —
    # the sign decides whether the amount adds to or subtracts from the
    # payable. TDS is always a deduction.
    mamul_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    mamul_sign = models.CharField(max_length=4, choices=[('PLUS', 'Plus'), ('LESS', 'Less')], default='LESS')
    tds_less = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    less_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    less_amount_sign = models.CharField(max_length=4, choices=[('PLUS', 'Plus'), ('LESS', 'Less')], default='LESS')
    # User-defined extra charges (list of {type, label, amount, add_to_total}).
    additional_charges = models.JSONField(null=True, blank=True)
    additional_charges_remarks = models.TextField(blank=True, default='')
    quantity_basis = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        null=True,
        blank=True
    )
    quantity_uom = models.CharField(max_length=10, blank=True, default='')
    cost_per_unit_calc = models.DecimalField(
        max_digits=18,
        decimal_places=4,
        null=True,
        blank=True
    )
    destination_state = models.CharField(max_length=100, blank=True, default='')
    payable_amount = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.00'))]
    )
    status = models.CharField(
        max_length=30,
        choices=FREIGHT_ADVICE_STATUS,
        default='DRAFT',
        db_index=True
    )
    lorry_no = models.CharField(max_length=50, blank=True, default='')
    driver_name = models.CharField(max_length=100, blank=True, default='')
    driver_contact = models.CharField(max_length=20, blank=True, default='')
    # Header date entered by the user — when the freight bill itself is
    # raised. Distinct from dispatch_date (when the truck left) and
    # created_at (DB-side audit timestamp).
    freight_date = models.DateField(null=True, blank=True, db_index=True)
    dispatch_date = models.DateField(null=True, blank=True)
    expected_arrival_date = models.DateField(null=True, blank=True)
    actual_arrival_date = models.DateField(null=True, blank=True)
    other_charges = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    freight_terms = models.CharField(
        max_length=20,
        choices=FREIGHT_TERMS_CHOICES,
        blank=True,
        default=''
    )
    transport_document_no = models.CharField(max_length=100, blank=True, default='')
    delivery_remarks = models.TextField(blank=True, default='')
    remarks = models.TextField(blank=True, default='')
    # Source Tally journal GUID when created from a Tally freight reconcile — dedupes
    # re-creates and lets the reconcile list drop off freight already created.
    tally_guid = models.CharField(max_length=64, blank=True, default='', db_index=True)
    # Beneficiary bank details for paying the transporter (freight payment).
    bank_name = models.CharField(max_length=255, blank=True, default='')
    ifsc_code = models.CharField(max_length=20, blank=True, default='')
    beneficiary_name = models.CharField(max_length=255, blank=True, default='')
    account_no = models.CharField(max_length=50, blank=True, default='')
    approved_by = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='approved_freight_advices'
    )
    approved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_date']
        indexes = [
            models.Index(fields=['transporter', 'status']),
            models.Index(fields=['receipt_advice', 'created_date']),
        ]
        verbose_name = _('Freight Advice Inbound')
        verbose_name_plural = _('Freight Advices Inbound')

    def __str__(self):
        return self.advice_no

    def save(self, *args, **kwargs):
        if not self.advice_no:
            from datetime import datetime
            year = datetime.now().year
            prefix = f"FA-{year}-"
            last = FreightAdviceInbound.objects.filter(advice_no__startswith=prefix).order_by('-advice_no').first()
            num = int(last.advice_no.split('-')[-1]) + 1 if last else 1
            self.advice_no = f"{prefix}{num:05d}"
        super().save(*args, **kwargs)

    total_paid = models.DecimalField(
        max_digits=18, decimal_places=2, default=0,
        validators=[MinValueValidator(Decimal('0.00'))]
    )
    balance = models.DecimalField(
        max_digits=18, decimal_places=2, default=0,
        validators=[MinValueValidator(Decimal('0.00'))]
    )
    # Settled from an EXISTING vendor PaymentMade (Day-Book reconcile) rather than a
    # separate freight bank event — so the slip counts as PAID without creating a
    # FreightPaymentInbound (keeps finance bank-rec / freight-ledger clean; the cash
    # is the vendor payment, already bank-matched). Set by settle_freight_from_daybook;
    # reversible by clearing it. SET_NULL so deleting the payment never deletes freight.
    settled_from_payment = models.ForeignKey(
        'purchase.PaymentMade', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='freight_settlements',
        help_text='Existing vendor payment that settled this freight (no new cash).'
    )

    def resolve_company(self):
        """The Company this inbound freight belongs to. FreightAdviceInbound has NO
        company FK, so it is derived — and it used to be derived THREE different
        ways (the list serializer walked bill→warehouse→company, the filter/summary
        views walked bill→vendor→company), which could disagree and leave the
        company blank on one side. This is now the SINGLE source of truth both use,
        so the displayed company and the company a record filters under can never
        diverge.

        Order (first hit wins), trying the vendor-company and the warehouse-company
        at each step so messy data (a bill whose vendor-company ≠ warehouse-company)
        still resolves instead of blanking:
          1. the linked goods bill  → its warehouse's company, else its vendor's
          2. any covered bill       → same (shared-slip path)
          3. the transporter's company
          4. the freight's own source-document warehouse → company
        Returns a Company or None.
        """
        def co_of_bill(b):
            if b is None:
                return None
            wh = getattr(b, 'warehouse', None)
            if wh and getattr(wh, 'company_id', None):
                return wh.company
            v = getattr(b, 'vendor', None)
            if v and getattr(v, 'company_id', None):
                return v.company
            return None

        # 1. linked goods bill
        if self.vendor_bill_id:
            co = co_of_bill(self.vendor_bill)
            if co:
                return co
        # 2. any covered bill (shared slip) — read the prefetch cache
        for cb in self.covered_bills.all():
            co = co_of_bill(cb)
            if co:
                return co
        # 3. the transporter's company
        if self.transporter_id and getattr(self.transporter, 'company_id', None):
            return self.transporter.company
        # 4. the freight's own source-document warehouse
        wh = None
        if self.source_type == 'PURCHASE_RECEIPT' and self.receipt_advice_id:
            wh = getattr(self.receipt_advice, 'warehouse', None)
        elif self.source_type == 'INVENTORY_TRANSFER' and self.transfer_source_id:
            wh = getattr(self.transfer_source, 'to_warehouse', None)
        elif self.source_type == 'INVENTORY_SHIFTING' and self.shifting_source_id:
            wh = getattr(self.shifting_source, 'warehouse', None)
        elif self.source_type == 'SALES_DISPATCH_CHALLAN' and self.dispatch_challan_source_id:
            wh = getattr(self.dispatch_challan_source, 'warehouse', None)
        if wh and getattr(wh, 'company_id', None):
            return wh.company
        return None

    def resolve_company_id(self):
        """The id of resolve_company(), or None. Convenience for filter/scoping."""
        co = self.resolve_company()
        return co.id if co else None

    def get_total_payable(self):
        """Calculate total payable amount.

        mamul and the 'less' adjustment apply with their sign (PLUS adds, LESS
        subtracts); TDS always subtracts; additional charges flagged
        add_to_total are added.
        """
        freight = self.base_amount - (self.base_amount * self.discount / 100)
        mamul = self.mamul_amount if self.mamul_sign == 'PLUS' else -self.mamul_amount
        less = self.less_amount if self.less_amount_sign == 'PLUS' else -self.less_amount
        extra = Decimal('0')
        for c in (self.additional_charges or []):
            if c.get('add_to_total'):
                try:
                    extra += Decimal(str(c.get('amount') or 0))
                except Exception:
                    pass
        return (freight + self.loading_wages_amount + self.unloading_wages_amount
                + self.other_charges + mamul + less - self.tds_less + extra)

    def invoice_freight_paid(self):
        """Invoice-included freight is paid THROUGH the bill, never on its own — so
        its paid amount FOLLOWS the bill's ACTUAL payment (it is not paid just by
        creating the bill). GOODS FIRST, FREIGHT LAST: the vendor's payment clears
        the goods value before any of it counts towards freight, so
            freight_paid = clamp(bill.amount_paid - goods_value, 0, freight)
        When a payment is later applied to the bill, `resync_bill_freight_payment`
        recomputes this so the freight card updates. Returns None for separate-slip
        freight (which uses its own real payment rows)."""
        if self.freight_source != 'INVOICE_INCLUDED' or not self.vendor_bill_id:
            return None
        bill = self.vendor_bill
        freight = self.get_total_payable()
        goods = (bill.total_amount or Decimal('0')) - freight
        if goods < 0:
            goods = Decimal('0')
        paid = (bill.amount_paid or Decimal('0')) - goods
        if paid < 0:
            paid = Decimal('0')
        return min(paid, freight)

    def get_total_paid(self):
        """Sum of all payment entries — or, for invoice-included freight, the
        amount derived from the linked bill's payment (goods first, freight last)."""
        derived = self.invoice_freight_paid()
        if derived is not None:
            return derived
        # Sum the rows we ALREADY have rather than asking the database again.
        # FreightAdviceInboundViewSet prefetches `freight_payments`, but
        # .aggregate() ignores a prefetch and always issues its own query - so
        # the payments were being fetched once and then re-counted per row.
        # The list serializer reads total_paid AND balance, so that was two
        # queries a row: 822 of them for 412 freight advices.
        #
        # Same arithmetic: Sum over an empty set is None and falls to
        # Decimal('0'); an empty Python sum starts at Decimal('0'). A non-empty
        # sum keeps the column's own scale either way, and a total of zero is
        # falsy in both, so it lands on Decimal('0') exactly as before.
        paid = sum((p.amount_paid or Decimal('0')
                    for p in self.freight_payments.all()),
                   Decimal('0'))
        # Settled from an existing vendor payment (no FreightPaymentInbound row) —
        # the slip is paid in full from that advance.
        if self.settled_from_payment_id:
            paid += self.get_total_payable()
        # Tally-imported freight: payments settle the VendorBill (PaymentMade),
        # not the FA (FreightPaymentInbound).  Derive from the bill when no
        # own payment rows exist.  When the bill is fully paid, report the FA
        # as fully paid too — the bill's net (after TDS) differs from the FA's
        # gross base_amount, so a numeric comparison would show "partially paid"
        # even though the transporter is fully settled.
        if paid == 0 and self.vendor_bill_id and self.freight_source == 'SEPARATE_SLIP':
            bill = self.vendor_bill
            if getattr(bill, 'purchase_category', '') == 'FREIGHT':
                if bill.status == 'PAID':
                    paid = self.get_total_payable()
                else:
                    paid = bill.amount_paid or Decimal('0')
        return paid or Decimal('0')

    def update_payment_status(self):
        """Recalculate paid/balance and auto-update status."""
        self.total_paid = self.get_total_paid()
        payable = self.get_total_payable()
        self.balance = max(Decimal('0'), payable - self.total_paid)
        # Invoice-included freight is tracking-only: its status purely mirrors the
        # bill's payment of the freight (unpaid -> DRAFT, part -> PARTIALLY_PAID,
        # full -> PAID) — so reversing the bill's payment cleanly returns it to
        # DRAFT instead of the generic PAID->COMPLETED path.
        if self.freight_source == 'INVOICE_INCLUDED' and self.status != 'CANCELLED':
            if payable > 0 and self.total_paid >= payable:
                self.status = 'PAID'
            elif self.total_paid > 0:
                self.status = 'PARTIALLY_PAID'
            else:
                self.status = 'DRAFT'
            self.save(update_fields=['total_paid', 'balance', 'status', 'updated_at'])
            return
        if self.status == 'CANCELLED':
            pass
        elif self.total_paid <= 0:
            if self.status == 'PAID':
                self.status = 'COMPLETED'
        elif self.total_paid >= payable:
            self.status = 'PAID'
        else:
            # Partial payment: keep it PARTIALLY_PAID until fully settled —
            # without this branch a partial payment left the status stale.
            self.status = 'PARTIALLY_PAID'
        self.save(update_fields=['total_paid', 'balance', 'status', 'updated_at'])


class FreightPaymentInbound(BaseModel):
    """Individual payment entry against an Inbound Freight Advice."""

    PAYMENT_MODE_CHOICES = [
        ('CASH', 'Cash'),
        ('BANK', 'Bank Transfer'),
        ('UPI', 'UPI'),
        ('CHEQUE', 'Cheque'),
        ('NEFT', 'NEFT'),
        ('RTGS', 'RTGS'),
        ('OTHER', 'Other'),
    ]

    freight = models.ForeignKey(
        FreightAdviceInbound, on_delete=models.CASCADE, related_name='freight_payments'
    )
    payment_date = models.DateField(db_index=True)
    amount_paid = models.DecimalField(
        max_digits=18, decimal_places=2, validators=[MinValueValidator(Decimal('0.01'))]
    )
    payment_mode = models.CharField(max_length=20, choices=PAYMENT_MODE_CHOICES)
    paid_to = models.CharField(max_length=200, blank=True, default='')
    reference_no = models.CharField(max_length=100, blank=True, default='')
    notes = models.TextField(blank=True, default='')
    created_by = models.ForeignKey(
        'core.StakeholderUser', on_delete=models.SET_NULL, null=True, blank=True
    )

    class Meta:
        ordering = ['freight', 'payment_date']
        indexes = [
            models.Index(fields=['freight', 'payment_date']),
        ]
        verbose_name = _('Freight Payment Inbound')
        verbose_name_plural = _('Freight Payments Inbound')

    def __str__(self):
        return f"{self.freight.advice_no} - {self.amount_paid} on {self.payment_date}"


class VendorPaymentAdvice(BaseModel):
    """Payment advice for vendor payments."""

    SOURCE_DOCUMENT_CHOICES = (
        ('PO', _('Purchase Order')),
        ('RECEIPT', _('Receipt/GRN')),
        ('FREIGHT', _('Freight')),
        ('WAGE', _('Loading/Unloading Wage')),
        ('CREDIT_NOTE', _('Credit Note')),
    )

    PAYMENT_METHOD_CHOICES = (
        ('BANK_TRANSFER', _('Bank Transfer')),
        ('CASH', _('Cash')),
        ('CHEQUE', _('Cheque')),
        ('UPI', _('UPI')),
        ('NEFT', _('NEFT')),
        ('RTGS', _('RTGS')),
    )

    PAYMENT_STATUS_CHOICES = (
        ('DRAFT', _('Draft')),
        ('PENDING', _('Pending')),
        ('APPROVED', _('Approved')),
        ('PARTIALLY_PAID', _('Partially Paid')),
        ('PAID', _('Paid')),
        ('ON_HOLD', _('On Hold')),
    )

    advice_no = models.CharField(
        max_length=50,
        unique=True,
        db_index=True,
        editable=False
    )
    vendor = models.ForeignKey(
        'master.Vendor',
        on_delete=models.PROTECT,
        related_name='payment_advices'
    )
    receipt_advice = models.ForeignKey(
        'purchase.ReceiptAdvice',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='payment_advices',
        help_text="Linked receipt advice / GRN"
    )
    source_document_type = models.CharField(
        max_length=20,
        choices=SOURCE_DOCUMENT_CHOICES,
        blank=True,
        default=''
    )
    source_document_id = models.UUIDField(
        db_index=True,
        null=True,
        blank=True,
        help_text="ID of source document (PO, Receipt, etc.)"
    )
    invoice_no = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text="Vendor bill / invoice number"
    )
    invoice_date = models.DateField(
        null=True,
        blank=True,
        help_text="Vendor invoice date"
    )
    amount = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text="Total invoice amount"
    )
    tds_amount = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        default=Decimal('0.00'),
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text="TDS deduction amount"
    )
    other_deductions = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        default=Decimal('0.00'),
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text="Other deductions"
    )
    paid_amount = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        default=Decimal('0.00'),
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text="Amount paid so far"
    )
    due_date = models.DateField(db_index=True, null=True, blank=True)
    payment_method = models.CharField(
        max_length=20,
        choices=PAYMENT_METHOD_CHOICES,
        default='BANK_TRANSFER',
        blank=True
    )
    payment_reference = models.CharField(
        max_length=200,
        blank=True,
        default='',
        help_text="Payment reference / UTR number"
    )
    payment_date = models.DateField(
        null=True,
        blank=True,
        help_text="Date of payment"
    )
    bank_name = models.CharField(
        max_length=200,
        blank=True,
        default='',
        help_text="Bank name for payment"
    )
    transaction_id = models.CharField(
        max_length=200,
        blank=True,
        default='',
        help_text="Bank transaction ID"
    )
    prepared_by = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.PROTECT,
        null=True,
        blank=True
    )
    status = models.CharField(
        max_length=20,
        choices=PAYMENT_STATUS_CHOICES,
        default='DRAFT',
        db_index=True
    )
    notes = models.TextField(blank=True, default='')

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['vendor', 'status']),
            models.Index(fields=['due_date', 'status']),
            models.Index(fields=['source_document_type', 'source_document_id']),
        ]
        verbose_name = _('Vendor Payment Advice')
        verbose_name_plural = _('Vendor Payment Advices')

    def __str__(self):
        return self.advice_no

    def save(self, *args, **kwargs):
        if not self.advice_no:
            from datetime import datetime
            year = datetime.now().year
            prefix = f"VPA-{year}-"
            last = VendorPaymentAdvice.objects.filter(advice_no__startswith=prefix).order_by('-advice_no').first()
            num = int(last.advice_no.split('-')[-1]) + 1 if last else 1
            self.advice_no = f"{prefix}{num:05d}"
        super().save(*args, **kwargs)

    @property
    def net_payable(self):
        """Calculate net payable: amount - TDS - other deductions."""
        return self.amount - self.tds_amount - self.other_deductions

    @property
    def balance_amount(self):
        """Calculate balance: net_payable - paid_amount."""
        return self.net_payable - self.paid_amount

    def get_net_payable(self):
        """Calculate net payable with taxes (legacy)."""
        tax_total = self.tax_components.aggregate(
            total=models.Sum('amount')
        )['total'] or Decimal('0.00')
        return self.amount + tax_total


class PaymentTaxComponent(BaseModel):
    """Tax components for vendor payments."""

    TAX_TYPE_CHOICES = (
        ('TDS', _('TDS (Tax Deducted at Source)')),
        ('TCS', _('TCS (Tax Collected at Source)')),
    )

    advice = models.ForeignKey(
        VendorPaymentAdvice,
        on_delete=models.CASCADE,
        related_name='tax_components'
    )
    tax_type = models.CharField(
        max_length=20,
        choices=TAX_TYPE_CHOICES
    )
    rate = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.00')), MaxValueValidator(Decimal('100.00'))],
        help_text="Tax rate percentage"
    )
    amount = models.DecimalField(
        max_digits=18,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text="Calculated tax amount"
    )

    class Meta:
        ordering = ['advice']
        unique_together = [['advice', 'tax_type']]
        verbose_name = _('Payment Tax Component')
        verbose_name_plural = _('Payment Tax Components')


# ──────────────────────────────────────────────────────────────
#  Zoho-style Purchase: Vendor Bills, Payments Made, Vendor Credits
# ──────────────────────────────────────────────────────────────

def _unique_bill_no(base):
    """Return base, or base-2, base-3 … until free."""
    from purchase.models import VendorBill as _VB
    for i in range(2, 100):
        candidate = f"{base}-{i}"
        if not _VB.objects.filter(bill_no=candidate).exists():
            return candidate
    return f"{base}-{uuid.uuid4().hex[:6]}"


class VendorBill(BaseModel):
    """Vendor invoice/bill received against a PO/Receipt."""

    BILL_STATUS_CHOICES = (
        ('DRAFT', _('Draft')),
        ('OPEN', _('Open')),
        ('PARTIALLY_PAID', _('Partially Paid')),
        ('PAID', _('Paid')),
        ('OVERDUE', _('Overdue')),
        ('CANCELLED', _('Cancelled')),
    )

    # What KIND of spend this bill is. Derived (not hand-keyed) from Tally's own
    # structure — primarily the VENDOR's creditor group (RM / Packing / Transport /
    # …), falling back to the line items' product sub-type and the operator's
    # expense flag for vendors Tally files under a generic group (Other / MSME).
    # Populated by apps/purchase/bill_classification.py; reporting-only. See
    # PURCHASE_CATEGORY_SOURCE for where a given bill's category came from.
    PURCHASE_CATEGORY_CHOICES = (
        ('RM', 'RM Purchase'),
        ('MAIZE', 'Maize Purchase'),
        ('BOUGHT_NOTE', 'Bought Note (Exempt)'),
        ('PACKING', 'Packing Material'),
        ('FRUIT', 'Fruit Purchase'),
        ('FREIGHT', 'Freight / Transport'),
        ('EXPENSES', 'Expenses'),
        ('LAB_EXPENSE', 'Lab Expense'),
        ('MACHINERY', 'Machinery / Capital'),
        ('BRANCH', 'Branch Transfer'),
    )

    bill_no = models.CharField(max_length=50, unique=True, db_index=True, editable=False)
    vendor = models.ForeignKey(
        'master.Vendor', on_delete=models.PROTECT, related_name='bills'
    )
    vendor_invoice_no = models.CharField(
        max_length=100, blank=True, default='',
        help_text="Vendor's own invoice number"
    )
    bill_date = models.DateField(db_index=True)
    due_date = models.DateField(null=True, blank=True, db_index=True)
    purchase_order = models.ForeignKey(
        'purchase.PurchaseOrder', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='vendor_bills'
    )
    receipt_advice = models.ForeignKey(
        'purchase.ReceiptAdvice', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='vendor_bills'
    )
    # Which warehouse the bill's goods are destined for — read off the bill's
    # ship-to address (auto-suggested) or picked in review. A tag/reporting field;
    # it does NOT post stock on its own (that's the Update-stock flow).
    warehouse = models.ForeignKey(
        'core.Warehouse', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='+'
    )

    # Amounts
    subtotal = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    discount_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    tax_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # GST split (India): intra-state books CGST + SGST (each half the rate),
    # inter-state books IGST. tax_amount stays the combined total.
    cgst_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    sgst_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    igst_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    tds_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # ── Computed TDS (validate-first engine, purchase/tds_engine.py) ──────
    # The engine writes the EXPECTED TDS here; `tds_amount` above stays Tally's
    # actual deduction. `tds_status` compares the two so a mismatch is visible
    # without ever changing the bill's totals. Reporting-only.
    computed_tds_amount = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True,
                                              help_text="Expected TDS from the engine (not deducted).")
    computed_tds_section = models.CharField(max_length=12, blank=True, default='',
                                            help_text="Section the engine applied (194Q / 194C / ...).")
    TDS_STATUS_CHOICES = (
        ('', 'Not computed'),
        ('OK', 'Matches deduction'),
        ('MISMATCH', 'Differs from deduction'),
        ('NONE_DUE', 'No TDS due'),
        ('MISSING_DATA', 'Vendor data incomplete'),
    )
    tds_status = models.CharField(max_length=14, blank=True, default='', choices=TDS_STATUS_CHOICES,
                                  db_index=True)
    shipping_charges = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # Non-purchase charges bundled on the voucher (Freight Inward) that Tally
    # books OUTSIDE "Purchase Accounts". Part of total_amount (we pay it) but
    # kept OUT of the purchase value (subtotal) so the tile mirrors Tally.
    other_charges = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # Same idea as other_charges, but for an EXPENSE leg bundled on a goods
    # voucher (insurance, rate difference, misc service charge) that Tally books
    # to an expense ledger instead of Purchase Accounts. other_charges rolls up
    # under Freight; this one rolls up under EXPENSES. Kept out of the bill's own
    # purchase category in the by-category view so RM/Packing mirror Tally, and
    # part of total_amount since we still pay it. (e.g. Raj Enterprises' Rs 4,500
    # Insurance Charges line on an RM invoice — belongs in Expenses, not RM.)
    expense_charges = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    adjustment = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    total_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    amount_paid = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # Whether total_amount is ALREADY net of 194Q/194C TDS. Some sources (Zoho /
    # the scanner reading a Tally voucher) book total = subtotal + GST − TDS, so
    # the TDS is already inside the total; others book it GROSS (subtotal + GST).
    # net_payable_to_vendor must subtract TDS ONCE, never twice — see that
    # property. Set at import time by whichever importer KNOWS; NULL = unknown
    # (old bills) → fall back to an arithmetic guess. This is what stops the
    # double-count permanently without a monthly cleanup command.
    total_is_net = models.BooleanField(
        null=True, blank=True, default=None, db_index=True,
        help_text='total_amount already net of TDS? True=net, False=gross, '
                  'NULL=unknown (guessed arithmetically).')

    # User-defined extra charges: list of {type, label, amount, add_to_total}.
    # Charges flagged add_to_total are already folded into total_amount above;
    # the rest are kept for the record. Remarks are required when any present.
    additional_charges = models.JSONField(null=True, blank=True)
    additional_charges_remarks = models.TextField(blank=True, default='')

    status = models.CharField(max_length=20, choices=BILL_STATUS_CHOICES, default='DRAFT', db_index=True)
    # Source Tally purchase-voucher identity when imported from Tally; dedupes
    # re-imports so the same Tally voucher never creates two bills.
    tally_guid = models.CharField(max_length=64, blank=True, default='', db_index=True)
    tally_voucher_no = models.CharField(max_length=100, blank=True, default='', db_index=True)
    # The Tally VOUCHERTYPENAME this bill came from (e.g. "GST Purchase",
    # "Purchase-Bought Note"), so the import-reconciliation can group/compare
    # Bills vs Tally per voucher type. Blank for non-Tally bills.
    tally_voucher_type = models.CharField(max_length=100, blank=True, default='', db_index=True)
    # Operator category for bills created from Tally via Reconcile:
    # '' = Normal, 'RM1' / 'RM2' = raw-material categories. Filterable.
    rm_category = models.CharField(max_length=10, blank=True, default='', db_index=True)
    # Operator-declared "this is an expense" flag, set from the scan voucher-type
    # pick (Journal / GST Journal — rent, professional, freight/contract). Kept
    # SEPARATE from tally_voucher_type on purpose: tally_voucher_type is Tally's
    # own type (reconciliation owns it and re-compare backfills it), so a bill
    # matched to a Tally "GST Purchase" voucher would lose an override. This flag
    # survives that and drives the Bills "Expenses" tab.
    is_expense = models.BooleanField(default=False, db_index=True)
    # Paid on the spot in CASH (Tally "Cash Payment" / cash ledger) — there is NO
    # bank payment for it. Like a bought note, a cash bill is self-settled (Paid)
    # and kept OUT of the "Amount Paid" (bank) figure. Split cash by category:
    # BOUGHT_NOTE + is_cash = farmer/bought-note cash; EXPENSES + is_cash = expense
    # cash. Bought notes are cash by nature (their own settle path also covers them).
    is_cash = models.BooleanField(default=False, db_index=True)
    # Spend category (RM / Packing / Freight / Expenses / Machinery), derived from
    # Tally's structure — see PURCHASE_CATEGORY_CHOICES and bill_classification.py.
    # Blank = not yet classified. Reporting-only; never affects amounts or totals.
    purchase_category = models.CharField(
        max_length=12, blank=True, default='', db_index=True,
        choices=PURCHASE_CATEGORY_CHOICES)
    # HOW the category was decided: 'creditor_group' | 'product' | 'expense_flag' |
    # 'voucher_type' | 'manual' | '' . Lets the UI show why, and a manual override
    # (source='manual') survives re-classification so a hand-fix is never lost.
    category_source = models.CharField(max_length=16, blank=True, default='')
    # For an expense-like bill (FREIGHT / EXPENSES / MACHINERY), the finer Tally
    # Expenses split: which group ('DIRECT' / 'INDIRECT') and SUB-category
    # (Electricity, Labour & Wages, Rent, Salary, Interest, Freight In/Out, ...)
    # it belongs to, so the by-category Expenses section mirrors Tally's Direct /
    # Indirect Expenses groups. Derived from the voucher's expense ledger with the
    # shared _expense_subcategory rules; blank = not an expense / not yet split.
    # Reporting-only; never affects amounts or totals.
    expense_group = models.CharField(max_length=10, blank=True, default='', db_index=True)
    expense_subcategory = models.CharField(max_length=40, blank=True, default='', db_index=True)
    # ── Where this bill came from, and whether it may be compared to Tally ──
    #
    # Tally is the ledger of record for purchases, so a figure that claims to
    # match Tally must be built from TALLY rows alone. Mixing sources in one
    # total is what let the ERP report Rs 13.28 crore for an April in which
    # Tally holds Rs 12.97 crore, with no way to see which rows caused it.
    #
    #   TALLY          mirrors a Tally purchase voucher. The only source that
    #                  counts towards a Tally-compared figure.
    #   TALLY_OPENING  a vendor's opening creditor balance carried in from
    #                  before the window. Needed for Outstanding to reconcile
    #                  against Sundry Creditors; never part of Total Purchase.
    #   ZOHO_ONLY      Zoho holds it and Tally has no voucher for it. Kept and
    #                  visible, shown as its own line, excluded from anything
    #                  compared against Tally - it is a discrepancy to chase,
    #                  not purchases to report.
    #   MANUAL         keyed into the ERP. Default, so an unmarked row is never
    #                  mistaken for Tally-derived.
    SOURCE_CHOICES = (
        ('MANUAL', _('Entered in the ERP')),
        ('TALLY', _('Imported from Tally')),
        ('TALLY_OPENING', _('Opening balance from Tally')),
        ('ZOHO_ONLY', _('In Zoho, no Tally voucher')),
    )
    source = models.CharField(max_length=14, choices=SOURCE_CHOICES, default='MANUAL',
                              db_index=True)
    # Fingerprint of the Tally voucher's material content - date, party, the
    # money, and the lines. Tally cannot give us ALTERID or MASTERID on this
    # build (both come back empty even when named in <FETCH>), so a voucher
    # edited after import cannot be spotted by an alteration counter. Hashing
    # what we actually care about does the same job and is stricter: it reacts
    # to a real change rather than to any touch.
    #
    #   same guid, same hash  -> already current, skip
    #   same guid, new hash   -> re-import over this bill
    #   guid absent in Tally  -> the voucher was deleted; cancel the bill
    tally_hash = models.CharField(max_length=64, blank=True, default='', db_index=True)
    notes = models.TextField(blank=True, default='')
    terms_and_conditions = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'purchase_vendor_bill'
        ordering = ['-bill_date']
        indexes = [
            models.Index(fields=['vendor', 'status']),
            models.Index(fields=['status', '-bill_date']),
        ]
        verbose_name = _('Vendor Bill')
        verbose_name_plural = _('Vendor Bills')

    def __str__(self):
        return self.bill_no

    def save(self, *args, **kwargs):
        if not self.bill_no:
            invoice_no = (self.vendor_invoice_no or '').strip()
            if invoice_no:
                if not VendorBill.objects.filter(bill_no=invoice_no).exists():
                    self.bill_no = invoice_no
                else:
                    self.bill_no = _unique_bill_no(invoice_no)
            else:
                from datetime import datetime
                from django.db.models.functions import Length
                year = datetime.now().year
                prefix = f"BILL-{year}-"
                last = (VendorBill.objects.filter(bill_no__startswith=prefix)
                        .annotate(_len=Length('bill_no'))
                        .order_by('-_len', '-bill_no').first())
                num = 1
                if last:
                    try:
                        num = int(last.bill_no.split('-')[-1]) + 1
                    except (ValueError, IndexError):
                        num = 1
                self.bill_no = f"{prefix}{num:05d}"

        # Proper linkage: a bill raised against a receipt inherits that receipt's
        # purchase order when it doesn't already name one. So a bill reached via
        # PR -> PO -> Receipt -> Bill carries its PO (the "O" reach chip lights,
        # the chain is traversable) without the caller having to pass it. Only
        # fills a blank PO; never overrides an explicit one, and takes the
        # receipt's first linked PO (receipts here link a single PO).
        if self.receipt_advice_id and not self.purchase_order_id:
            try:
                po = self.receipt_advice.linked_pos.first()
                if po is not None:
                    self.purchase_order = po
            except Exception:
                pass

        super().save(*args, **kwargs)

    @property
    def balance_due(self):
        return self.total_amount - self.amount_paid

    @property
    def tds_withheld(self):
        """194Q/194C TDS the company withheld from THIS bill, from Tally's TDS
        Payable register (tds_deductions, linked by Agst Ref). In Tally the
        vendor is credited NET of this TDS (it goes to TDS Payable, not the
        party), so what we actually owe the VENDOR is total - TDS - paid. The
        bill's total_amount stays GROSS (the invoice value) — this only affects
        the vendor-payable figure, mirroring Tally's party ledger."""
        from django.db.models import Sum
        return (self.tds_deductions
                .filter(is_active=True, amount__gt=0)
                .exclude(voucher_type='Opening Balance')
                .aggregate(t=Sum('amount'))['t']) or Decimal('0')

    @property
    def tds_already_in_total(self):
        """True when total_amount is ALREADY net of the withheld TDS, so it must
        NOT be subtracted a second time (the double-count that under-states the
        vendor payable and wrongly rejects the real gross bank payment).

        Decided in order of certainty:
          1. The stored `total_is_net` flag — set by whichever importer KNOWS how
             it booked the total. Trust it absolutely.
          2. The bill's OWN recorded deduction `tds_amount` (what the scanner read
             off the Tally voucher). If subtotal + GST − tds_amount ≈ total_amount,
             the deduction is demonstrably baked INTO the total → net. This is the
             strongest signal for old bills because it uses the bill's real figures,
             not a guess, and ties to what the validate-first engine already checked.
          3. Else the same arithmetic test unlink_double_tds uses, against the
             withheld TDS: total ≈ (subtotal + GST − tds_withheld).
        No TDS → trivially False."""
        return _tds_already_in_total(
            total_is_net=self.total_is_net,
            tds_withheld=self.tds_withheld,
            tds_deducted=self.tds_amount or Decimal('0'),
            subtotal=self.subtotal or Decimal('0'),
            tax_amount=self.tax_amount or Decimal('0'),
            total_amount=self.total_amount or Decimal('0'))

    @property
    def net_payable_to_vendor(self):
        """What we actually owe the vendor = total − TDS − payments, matching
        Tally's party-ledger balance. The TDS is subtracted ONCE: skip it when
        total_amount is already net (tds_already_in_total), else remove it here."""
        tds = Decimal('0') if self.tds_already_in_total else self.tds_withheld
        return self.total_amount - tds - self.amount_paid


class VendorBillLine(BaseModel):
    """Line items in a vendor bill.

    Mirrors the two-FK shape used by PRLine / POLine / QuoteLine /
    ReceiptLine — exactly one of (product, service_catalogue) is
    populated per line. `product` stays for the existing Goods flow
    (made nullable so Service lines can save).
    """

    bill = models.ForeignKey(VendorBill, on_delete=models.CASCADE, related_name='bill_lines')
    product = models.ForeignKey(
        'master.Product', on_delete=models.PROTECT,
        null=True, blank=True,
        related_name='vendor_bill_lines',
        help_text='Goods line: FK to master.Product. Mutually exclusive with service_catalogue.'
    )
    service_catalogue = models.ForeignKey(
        'master.ServiceCatalogue', on_delete=models.PROTECT,
        null=True, blank=True,
        related_name='vendor_bill_lines',
        help_text='Service line: FK to master.ServiceCatalogue.'
    )
    description = models.TextField(blank=True, default='')
    quantity = models.DecimalField(max_digits=18, decimal_places=4, default=1)
    uom = models.CharField(max_length=10, blank=True, default='')
    rate = models.DecimalField(max_digits=18, decimal_places=4, default=0)
    discount_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    tax_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)

    class Meta:
        db_table = 'purchase_vendor_bill_line'
        ordering = ['bill', 'id']
        verbose_name = _('Vendor Bill Line')
        verbose_name_plural = _('Vendor Bill Lines')

    def __str__(self):
        item = (
            getattr(self.product, 'product_name', None)
            or getattr(self.service_catalogue, 'name', None)
            or '(unknown)'
        )
        return f"{self.bill.bill_no} - {item}"


class PaymentMade(BaseModel):
    """Payment record against vendor bills."""

    PAYMENT_MODE_CHOICES = (
        ('BANK_TRANSFER', _('Bank Transfer')),
        ('CASH', _('Cash')),
        ('CHEQUE', _('Cheque')),
        ('UPI', _('UPI')),
        ('NEFT', _('NEFT')),
        ('RTGS', _('RTGS')),
        ('ADVANCE', _('Advance')),
        ('CREDIT', _('Credit')),
        ('DEBIT', _('Debit Note')),
    )
    PAYMENT_STATUS_CHOICES = (
        ('DRAFT', _('Draft')),
        ('APPROVED', _('Approved')),
        ('SENT', _('Sent')),
        ('CANCELLED', _('Cancelled')),
    )

    payment_no = models.CharField(max_length=50, unique=True, db_index=True, editable=False)
    vendor = models.ForeignKey(
        'master.Vendor', on_delete=models.PROTECT, related_name='payments_made'
    )
    payment_date = models.DateField(db_index=True)
    payment_mode = models.CharField(max_length=20, choices=PAYMENT_MODE_CHOICES, default='BANK_TRANSFER')
    amount = models.DecimalField(max_digits=18, decimal_places=2)
    reference_no = models.CharField(max_length=100, blank=True, default='')
    bank_name = models.CharField(max_length=200, blank=True, default='')
    bank_account = models.ForeignKey(
        'bank.BankAccount', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='vendor_payments',
        help_text='Our bank account the payment went out from',
    )
    bill = models.ForeignKey(
        VendorBill, on_delete=models.SET_NULL, null=True, blank=True, related_name='payments'
    )
    # Source Tally payment-voucher identity when imported from Tally; dedupes
    # re-imports so the same payment isn't applied twice.
    tally_guid = models.CharField(max_length=64, blank=True, default='', db_index=True)
    status = models.CharField(max_length=20, choices=PAYMENT_STATUS_CHOICES, default='DRAFT', db_index=True)
    notes = models.TextField(blank=True, default='')

    # This "payment" is really money moving between OUR OWN accounts (a bank/cash
    # contra), not a payment to a trade vendor — e.g. its "vendor" is actually a
    # bank-account ledger ("ICICI Bank-CA-...-Exp DLOD Ac", "Cash"). Flagged so it
    # drops out of vendor on-account and never distorts vendor Outstanding.
    PAYMENT_CATEGORY_CHOICES = (
        ('VENDOR', _('Vendor Payment')),
        ('TRANSFER', _('Inter-Account Transfer')),
        # Money RECEIVED back from a vendor (an overpayment refund). Stored as a
        # PaymentMade with a NEGATIVE amount so the existing Sum('amount') nets it
        # out of Amount Paid automatically — no special-casing anywhere.
        ('REFUND', _('Refund Received')),
    )
    is_transfer = models.BooleanField(
        default=False, db_index=True,
        help_text="True = inter-account transfer / bank contra, not a vendor payment.")
    payment_category = models.CharField(
        max_length=20, choices=PAYMENT_CATEGORY_CHOICES, default='VENDOR', db_index=True,
        help_text="VENDOR for a real supplier payment; TRANSFER for a bank/cash contra.")

    class Meta:
        db_table = 'purchase_payment_made'
        ordering = ['-payment_date']
        indexes = [
            models.Index(fields=['vendor', 'status']),
            models.Index(fields=['status', '-payment_date']),
        ]
        verbose_name = _('Payment Made')
        verbose_name_plural = _('Payments Made')

    def __str__(self):
        return self.payment_no

    def save(self, *args, **kwargs):
        if not self.payment_no:
            from datetime import datetime
            year = datetime.now().year
            prefix = f"PAY-{year}-"
            last = PaymentMade.objects.filter(payment_no__startswith=prefix).order_by('-payment_no').first()
            num = int(last.payment_no.split('-')[-1]) + 1 if last else 1
            self.payment_no = f"{prefix}{num:05d}"
        super().save(*args, **kwargs)


class VendorCredit(BaseModel):
    """Vendor credit note / debit note."""

    CREDIT_STATUS_CHOICES = (
        ('DRAFT', _('Draft')),
        ('OPEN', _('Open')),
        ('APPLIED', _('Applied')),
        ('CLOSED', _('Closed')),
        ('CANCELLED', _('Cancelled')),
    )

    credit_no = models.CharField(max_length=50, unique=True, db_index=True, editable=False)
    vendor = models.ForeignKey(
        'master.Vendor', on_delete=models.PROTECT, related_name='vendor_credits'
    )
    credit_date = models.DateField(db_index=True)
    CREDIT_TYPE_CHOICES = (
        ('CREDIT', _('Credit Note')),
        ('DEBIT', _('Debit Note')),
        ('ADVANCE', _('Advance Payment')),
    )
    credit_type = models.CharField(
        max_length=20,
        choices=CREDIT_TYPE_CHOICES,
        default='CREDIT'
    )
    reason = models.TextField(blank=True, default='')
    bill = models.ForeignKey(
        VendorBill, on_delete=models.SET_NULL, null=True, blank=True, related_name='credits'
    )
    subtotal = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    tax_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    total_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    amount_applied = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    status = models.CharField(max_length=20, choices=CREDIT_STATUS_CHOICES, default='DRAFT', db_index=True)
    notes = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'purchase_vendor_credit'
        ordering = ['-credit_date']
        indexes = [
            models.Index(fields=['vendor', 'status']),
            models.Index(fields=['status', '-credit_date']),
        ]
        verbose_name = _('Vendor Credit')
        verbose_name_plural = _('Vendor Credits')

    def __str__(self):
        return self.credit_no

    def save(self, *args, **kwargs):
        if not self.credit_no:
            from datetime import datetime
            year = datetime.now().year
            prefix = f"VCR-{year}-"
            last = VendorCredit.objects.filter(credit_no__startswith=prefix).order_by('-credit_no').first()
            num = int(last.credit_no.split('-')[-1]) + 1 if last else 1
            self.credit_no = f"{prefix}{num:05d}"
        super().save(*args, **kwargs)

    @property
    def balance(self):
        return self.total_amount - self.amount_applied


class VendorCreditLine(BaseModel):
    """Line items in a vendor credit note.

    Two-FK shape — exactly one of (product, service_catalogue) is set per
    line, same pattern as the rest of the purchase line models.
    """

    credit = models.ForeignKey(VendorCredit, on_delete=models.CASCADE, related_name='credit_lines')
    product = models.ForeignKey(
        'master.Product', on_delete=models.PROTECT,
        null=True, blank=True,
        related_name='vendor_credit_lines',
        help_text='Goods line: FK to master.Product. Mutually exclusive with service_catalogue.'
    )
    service_catalogue = models.ForeignKey(
        'master.ServiceCatalogue', on_delete=models.PROTECT,
        null=True, blank=True,
        related_name='vendor_credit_lines',
        help_text='Service line: FK to master.ServiceCatalogue.'
    )
    description = models.TextField(blank=True, default='')
    quantity = models.DecimalField(max_digits=18, decimal_places=4, default=1)
    uom = models.CharField(max_length=10, blank=True, default='')
    rate = models.DecimalField(max_digits=18, decimal_places=4, default=0)
    tax_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)

    class Meta:
        db_table = 'purchase_vendor_credit_line'
        ordering = ['credit', 'id']
        verbose_name = _('Vendor Credit Line')
        verbose_name_plural = _('Vendor Credit Lines')

    def __str__(self):
        # Original __str__ referenced `self.advice.advice_no` which
        # doesn't exist on this model — fixed to use credit_no, and
        # picks the populated item FK for the display name.
        item = (
            getattr(self.product, 'product_name', None)
            or getattr(self.service_catalogue, 'name', None)
            or '(unknown)'
        )
        return f"{self.credit.credit_no} - {item}"


class PurchaseAttachment(BaseModel):
    """File attachments for any purchase module document."""

    MODULE_CHOICES = (
        ('PR', _('Purchase Request')),
        ('RFQ', _('RFQ')),
        ('QUOTE', _('Quote Response')),
        ('EVALUATION', _('Evaluation')),
        ('PO', _('Purchase Order')),
        ('RECEIPT', _('Receipt Advice')),
        ('FREIGHT', _('Freight')),
        ('BILL', _('Vendor Bill')),
        ('PAYMENT', _('Payment Made')),
        ('CREDIT', _('Vendor Credit')),
        ('REJECTION', _('Material Rejection')),
        # Wage Entry attachments: photos of the labour gate-pass /
        # signed wage register / receipt of advance, etc. Also
        # populated by WageEntryViewSet.perform_create which copies
        # receipt-level attachments down to the wage entry.
        ('WAGE_ENTRY', _('Wage Entry')),
    )

    CATEGORY_CHOICES = (
        ('GENERAL', _('General')),
        ('TRANSPORT', _('Transport')),
        ('WEIGHMENT', _('Weighment Slip')),
        ('DAMAGE_PROOF', _('Damage Proof')),
        ('DEVIATION_PROOF', _('Deviation Proof')),
        # A recorded audio clip — e.g. the spoken "reason for change" on a PR.
        ('VOICE_NOTE', _('Voice Note')),
        # Invoice / quote / document justifying a line's unit price when the
        # Purchase Coordinator routes a product straight to PO (Skip RFQ).
        ('RATE_PROOF', _('Rate Proof')),
    )

    module = models.CharField(max_length=20, choices=MODULE_CHOICES, db_index=True)
    record_id = models.UUIDField(db_index=True, help_text="ID of the related record")
    category = models.CharField(max_length=20, choices=CATEGORY_CHOICES, default='GENERAL', db_index=True)
    file = models.FileField(upload_to='purchase/attachments/%Y/%m/')
    file_name = models.CharField(max_length=255)
    file_size = models.PositiveIntegerField(default=0, help_text="File size in bytes")
    file_type = models.CharField(max_length=100, blank=True, default='')
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='purchase_attachments'
    )

    class Meta:
        db_table = 'purchase_attachment'
        ordering = ['-created_at']
        verbose_name = _('Purchase Attachment')
        verbose_name_plural = _('Purchase Attachments')

    def __str__(self):
        return f"{self.module} - {self.file_name}"


class MaterialRejection(BaseModel):
    """Material rejection header — linked to Receipt Advice (GRN)."""

    STATUS_CHOICES = (
        ('DRAFT', _('Draft')),
        ('APPROVED', _('Approved')),
        ('RETURNED', _('Returned')),
        ('CANCELLED', _('Cancelled')),
    )

    RETURN_TYPE_CHOICES = (
        ('REPLACE', _('Replace')),
        ('REFUND', _('Refund')),
        ('SCRAP', _('Scrap')),
    )

    rejection_no = models.CharField(max_length=50, unique=True, db_index=True, editable=False)
    rejection_date = models.DateField(db_index=True)
    receipt_advice = models.ForeignKey(
        ReceiptAdvice, on_delete=models.CASCADE, related_name='material_rejections'
    )
    purchase_order = models.ForeignKey(
        PurchaseOrder, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='material_rejections'
    )
    vendor = models.ForeignKey(
        'master.Vendor', on_delete=models.PROTECT, related_name='material_rejections'
    )
    warehouse = models.ForeignKey(
        'core.Warehouse', on_delete=models.PROTECT, related_name='material_rejections'
    )
    rejected_by = models.ForeignKey(
        'core.StakeholderUser', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='material_rejections_created'
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='DRAFT', db_index=True)

    # Return details
    return_to_vendor = models.BooleanField(default=False)
    return_type = models.CharField(max_length=20, choices=RETURN_TYPE_CHOICES, blank=True, default='')
    return_date = models.DateField(null=True, blank=True)
    replacement_expected_date = models.DateField(null=True, blank=True)
    debit_note_required = models.BooleanField(default=False)

    # Overall
    description = models.TextField(blank=True, default='', help_text="Overall rejection description")
    remarks = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'purchase_material_rejection'
        ordering = ['-rejection_date', '-created_at']
        indexes = [
            models.Index(fields=['vendor', 'status']),
            models.Index(fields=['receipt_advice', 'status']),
        ]
        verbose_name = _('Material Rejection')
        verbose_name_plural = _('Material Rejections')

    def __str__(self):
        return self.rejection_no

    def save(self, *args, **kwargs):
        if not self.rejection_no:
            from django.utils import timezone as tz
            year = tz.now().year
            prefix = f"MRJ-{year}-"
            last = MaterialRejection.objects.filter(rejection_no__startswith=prefix).order_by('-rejection_no').first()
            num = int(last.rejection_no.split('-')[-1]) + 1 if last else 1
            self.rejection_no = f"{prefix}{num:05d}"
        super().save(*args, **kwargs)

    def get_total_rejected_value(self):
        from django.db.models import Sum, F
        return self.rejection_lines.aggregate(
            total=Sum(F('rejected_quantity') * F('unit_price'))
        )['total'] or Decimal('0.00')


class MaterialRejectionLine(BaseModel):
    """Individual line items in a material rejection."""

    REASON_CHOICES = (
        ('DAMAGED', _('Damaged')),
        ('EXPIRED', _('Expired')),
        ('WRONG_ITEM', _('Wrong Item')),
        ('QUALITY_ISSUE', _('Quality Issue')),
        ('SHORT_QUANTITY', _('Short Quantity')),
        ('OTHER', _('Other')),
    )

    rejection = models.ForeignKey(
        MaterialRejection, on_delete=models.CASCADE, related_name='rejection_lines'
    )
    line_no = models.PositiveIntegerField(default=1)
    product = models.ForeignKey(
        'master.Product', on_delete=models.PROTECT,
        null=True, blank=True,
        related_name='rejection_lines',
        help_text='Goods line: FK to master.Product. Mutually exclusive with service_catalogue.'
    )
    service_catalogue = models.ForeignKey(
        'master.ServiceCatalogue', on_delete=models.PROTECT,
        null=True, blank=True,
        related_name='rejection_lines',
        help_text='Service line: FK to master.ServiceCatalogue. Stock reversal is SKIPPED for these.'
    )
    receipt_line = models.ForeignKey(
        ReceiptLine, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='rejection_lines'
    )
    received_quantity = models.DecimalField(max_digits=18, decimal_places=4)
    accepted_quantity = models.DecimalField(max_digits=18, decimal_places=4)
    rejected_quantity = models.DecimalField(
        max_digits=18, decimal_places=4, validators=[MinValueValidator(Decimal('0.01'))]
    )
    uom = models.CharField(max_length=10)
    batch_no = models.CharField(max_length=100, blank=True, default='')
    unit_price = models.DecimalField(max_digits=18, decimal_places=4, default=0)
    rejection_reason = models.CharField(max_length=20, choices=REASON_CHOICES, default='QUALITY_ISSUE')
    remarks = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'purchase_material_rejection_line'
        ordering = ['rejection', 'line_no']
        unique_together = [['rejection', 'line_no']]
        verbose_name = _('Material Rejection Line')
        verbose_name_plural = _('Material Rejection Lines')

    def __str__(self):
        return f"{self.rejection.rejection_no} - Line {self.line_no}"

    @property
    def total_value(self):
        return self.rejected_quantity * self.unit_price


class ProductMismatchLog(BaseModel):
    """Audit log for product-name mismatches surfaced by the Quote Response
    Auto-Fill (AI) extraction flow.

    A row is written for every line that the mismatch modal resolved (i.e. the
    extracted product name didn't exactly match an RFQ product and the user
    had to pick between 'Use RFQ Product' / 'Create New' / 'Use Extracted').
    Silent auto-fills (exact name match, high-confidence fuzzy, or saved
    vendor alias) are NOT logged — this table focuses on real ambiguities.

    Access: Super-Admin only. Enforced both by the viewset's permission class
    and by the frontend route guard.
    """

    MATCH_STATUS_CHOICES = (
        ('MATCHED',           _('Matched')),
        ('MISMATCHED',        _('Mismatched')),
        ('MANUALLY_RESOLVED', _('Manually Resolved')),
    )

    USER_SELECTION_CHOICES = (
        ('RFQ_PRODUCT',    _('RFQ Product')),
        ('VENDOR_PRODUCT', _('Vendor Product')),
        ('NEW_PRODUCT',    _('New Product (Created)')),
        ('UNRESOLVED',     _('Unresolved')),
    )

    # ── Cross-document references (all nullable so a row survives if a
    #    related document is later deleted) ────────────────────────────────
    rfq = models.ForeignKey(
        RFQHeader, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='product_mismatch_logs',
    )
    vendor = models.ForeignKey(
        'master.Vendor', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='product_mismatch_logs',
    )
    quote_response = models.ForeignKey(
        QuoteResponse, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='product_mismatch_logs',
    )
    purchase_order = models.ForeignKey(
        'purchase.PurchaseOrder', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='product_mismatch_logs',
        help_text='Backfilled when a PO is later created from the quote.',
    )

    # ── Denormalised text snapshots (so display survives even if FKs
    #    are nulled by deletes) ───────────────────────────────────────────
    pr_no = models.CharField(
        max_length=200, blank=True, default='',
        help_text='Comma-separated PR numbers linked to the RFQ at log time.',
    )
    rfq_no = models.CharField(max_length=50, blank=True, default='')
    vendor_name = models.CharField(max_length=255, blank=True, default='')
    quote_response_no = models.CharField(max_length=50, blank=True, default='')
    po_number = models.CharField(max_length=50, blank=True, default='', db_index=True)

    # ── The actual mismatch payload ─────────────────────────────────────
    rfq_product = models.ForeignKey(
        'master.Product', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='rfq_mismatch_logs',
        help_text='The RFQ product the user picked (if any).',
    )
    rfq_product_name = models.CharField(max_length=255, blank=True, default='')
    vendor_product_name = models.CharField(
        max_length=255, db_index=True,
        help_text='Exact text Gemini extracted from the vendor document.',
    )
    user_selected = models.CharField(
        max_length=20, choices=USER_SELECTION_CHOICES, default='UNRESOLVED',
        db_index=True,
    )
    match_status = models.CharField(
        max_length=20, choices=MATCH_STATUS_CHOICES, default='MISMATCHED',
        db_index=True,
    )
    similarity_score = models.DecimalField(
        max_digits=4, decimal_places=3, null=True, blank=True,
        help_text='Fuzzy match score 0..1 between extracted text and best RFQ product, if computed.',
    )
    remarks = models.TextField(blank=True, default='')

    # ── Audit ───────────────────────────────────────────────────────────
    created_by = models.ForeignKey(
        'core.StakeholderUser', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='product_mismatches_created',
    )
    resolved_by = models.ForeignKey(
        'core.StakeholderUser', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='product_mismatches_resolved',
    )
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'purchase_product_mismatch_log'
        ordering = ['-created_at']
        verbose_name = _('Product Mismatch Log')
        verbose_name_plural = _('Product Mismatch Logs')
        constraints = [
            # Dedup key: (RFQ, Vendor, Vendor product wording, RFQ product).
            # Same vendor → same RFQ → same wording → same RFQ product picked
            # never produces a second row; it updates the existing one via
            # update_or_create in the Quote save handler.
            models.UniqueConstraint(
                fields=['rfq', 'vendor', 'vendor_product_name', 'rfq_product'],
                name='uniq_mismatch_rfq_vendor_product',
            ),
        ]
        indexes = [
            models.Index(fields=['rfq', 'vendor']),
            models.Index(fields=['match_status', '-created_at']),
            models.Index(fields=['vendor_product_name']),
        ]

    def __str__(self):
        return f"{self.vendor_product_name} ({self.match_status})"


class VendorProductMapping(BaseModel):
    """Maps a vendor's wording of a product (e.g. 'Azadirachtin Oil') to our
    product master row (e.g. 'Neem Oil'). Populated from the Quote Response
    extraction mismatch modal when the user clicks 'Use RFQ Product' AND ticks
    'Remember this mapping'. Next time the same vendor sends a quote with the
    same wording, the line auto-resolves silently.

    Doubles as an audit trail of every accepted mapping (who did it, when,
    what the original extracted text was, what product won).
    """

    vendor = models.ForeignKey(
        'master.Vendor',
        on_delete=models.CASCADE,
        related_name='product_mappings',
    )
    # Stored lowercase-trimmed so we can index/lookup case-insensitively. The
    # 'extracted_text_display' field keeps the original casing for UI.
    extracted_text = models.CharField(
        max_length=255,
        db_index=True,
        help_text='Lowercased product-name string as it appeared on the vendor doc.',
    )
    extracted_text_display = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text='Original-case extracted text for display.',
    )
    product = models.ForeignKey(
        'master.Product',
        on_delete=models.CASCADE,
        related_name='vendor_mappings',
    )
    created_by = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='vendor_product_mappings_created',
    )

    class Meta:
        db_table = 'purchase_vendor_product_mapping'
        constraints = [
            models.UniqueConstraint(
                fields=['vendor', 'extracted_text'],
                name='uniq_vendor_extracted_text',
            ),
        ]
        indexes = [
            models.Index(fields=['vendor', 'extracted_text']),
        ]
        verbose_name = _('Vendor Product Mapping')
        verbose_name_plural = _('Vendor Product Mappings')

    def __str__(self):
        return f"{self.vendor_id}: {self.extracted_text} → {self.product_id}"

    def save(self, *args, **kwargs):
        # Always store the lookup key in lowercase / trimmed form.
        if self.extracted_text:
            if not self.extracted_text_display:
                self.extracted_text_display = self.extracted_text
            self.extracted_text = self.extracted_text.strip().lower()
        super().save(*args, **kwargs)


class POAmendmentRequest(BaseModel):
    """A request to amend an already-APPROVED Purchase Order.

    The coordinator proposes new values (line prices / quantities and/or
    header fields) plus a reason; a manager/admin reviews the before→after
    and APPROVES to apply them (bumping the PO's revision_no) or REJECTS.
    Split permissions (can_request_amendment / can_approve_amendment) keep
    the raiser and the approver separate.
    """

    STATUS_CHOICES = (
        ('PENDING', _('Pending')),
        ('APPROVED', _('Approved')),
        ('REJECTED', _('Rejected')),
    )

    po = models.ForeignKey(
        'PurchaseOrder',
        on_delete=models.CASCADE,
        related_name='amendment_requests',
    )
    reason = models.TextField(help_text='Why the amendment is needed.')
    # Proposed new values, applied on approval. Shape:
    #   {"header": {field: value, ...},
    #    "lines":  [{"id": <poline_id>, "unit_price": .., "quantity_ordered": ..,
    #                "discount": .., "gst": ..}, ...]}
    proposed_changes = models.JSONField(default=dict, blank=True)
    status = models.CharField(
        max_length=10, choices=STATUS_CHOICES, default='PENDING', db_index=True,
    )
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='po_amendments_requested',
    )
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='po_amendments_reviewed',
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_remarks = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'purchase_po_amendment_request'
        ordering = ['-created_at']
        indexes = [models.Index(fields=['po', 'status'])]

    def __str__(self):
        return f'Amendment #{self.pk} · PO {self.po_id} · {self.status}'


class LocalFreight(BaseModel):
    """Standalone local-freight / charges bill — not tied to a receipt or DC.

    Captures ad-hoc freight, stock-transfer, unloading and in/out charges keyed
    in directly (mirrors the legacy 'Local Freight' Zoho form).
    """

    TYPE_CHOICES = [
        ('LOCAL_FREIGHT', 'Local Freight'),
        ('STOCK_TRANSFER', 'Stock Transfer'),
        ('UNLOADING_CHARGES', 'Unloading Charges'),
        ('INWARD_CHARGES', 'Inward Charges'),
        ('OUTWARD_CHARGES', 'Outward Charges'),
    ]
    PAYMENT_MODE_CHOICES = [
        ('CASH', 'Cash'),
        ('BANK', 'Bank Transfer'),
        ('UPI', 'UPI'),
        ('CHEQUE', 'Cheque'),
        ('CREDIT', 'Credit'),
    ]

    freight_no = models.CharField(max_length=50, unique=True, db_index=True,
                                  help_text='Auto-generated Local Freight number')
    date = models.DateField(db_index=True)
    received = models.CharField(max_length=100, blank=True, default='')
    company = models.ForeignKey('core.Company', on_delete=models.PROTECT, related_name='local_freights')
    factory = models.ForeignKey('core.Warehouse', on_delete=models.PROTECT, null=True, blank=True,
                                related_name='local_freights')
    freight_type = models.CharField(max_length=20, choices=TYPE_CHOICES, default='LOCAL_FREIGHT', db_index=True)
    total_quantity = models.DecimalField(max_digits=15, decimal_places=2, null=True, blank=True)
    bill_no = models.CharField(max_length=100, blank=True, default='')
    bill_date = models.DateField(null=True, blank=True)
    lorry_no = models.CharField(max_length=50)
    transporter = models.ForeignKey('master.Transporter', on_delete=models.SET_NULL, null=True, blank=True,
                                    related_name='local_freights')
    freight_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    amount_pay = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    payment_mode = models.CharField(max_length=20, choices=PAYMENT_MODE_CHOICES, blank=True, default='')
    remarks = models.TextField(blank=True, default='')
    additional_freight_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    less_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    tds_less = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # Source Tally voucher GUID when imported from a Day Book (LFR = local
    # freight). Makes the import idempotent (re-import updates in place) and ties
    # the record back to the payment that settled it.
    tally_guid = models.CharField(max_length=64, blank=True, default='', db_index=True)

    # Approval gate — mirrors VendorBill DRAFT→OPEN. A scan-created local freight
    # lands as DRAFT (pending review) and becomes a live payable only once an
    # operator approves it, so a raw OCR confirm (which can mis-read fields) never
    # records straight to the freight ledger. Rows created before this field
    # existed are migrated to APPROVED so historical totals are unchanged.
    STATUS_CHOICES = [('DRAFT', 'Draft'), ('APPROVED', 'Approved')]
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default='DRAFT', db_index=True)

    # Branch-transfer / Delivery-Challan details. A DC is an INTERNAL stock move
    # (e.g. SS Biochem -> United Agro), NOT a purchase or a sale — so the goods
    # value is recorded here for reference ONLY and is never booked. freight_amount
    # stays the only money on this record.
    is_dc = models.BooleanField(default=False)
    dc_no = models.CharField(max_length=100, blank=True, default='')
    dc_from = models.CharField(max_length=255, blank=True, default='')   # sending party / from warehouse
    dc_to = models.CharField(max_length=255, blank=True, default='')     # receiving party / to warehouse
    dc_material = models.CharField(max_length=255, blank=True, default='')
    dc_value = models.DecimalField(max_digits=18, decimal_places=2, default=0)   # goods value — reference only

    class Meta:
        db_table = 'purchase_local_freight'
        ordering = ['-date', '-created_at']
        indexes = [
            models.Index(fields=['company', '-date']),
            models.Index(fields=['freight_type', '-date']),
        ]

    def __str__(self):
        return self.freight_no

    def get_total_payable(self):
        """Net payable = freight + additional − less − TDS."""
        return ((self.freight_amount or Decimal('0'))
                + (self.additional_freight_amount or Decimal('0'))
                - (self.less_amount or Decimal('0'))
                - (self.tds_less or Decimal('0')))

    def get_total_paid(self):
        """Inline 'Amount Pay' captured on the bill + any ledger payments."""
        ledger = self.payments.aggregate(t=models.Sum('amount_paid'))['t'] or Decimal('0')
        return (self.amount_pay or Decimal('0')) + ledger

    @property
    def balance(self):
        return self.get_total_payable() - self.get_total_paid()


class LocalFreightPayment(BaseModel):
    """A payment recorded against a Local Freight bill (mirrors FreightPaymentInbound)."""

    PAYMENT_MODE_CHOICES = [
        ('CASH', 'Cash'),
        ('BANK', 'Bank Transfer'),
        ('UPI', 'UPI'),
        ('CHEQUE', 'Cheque'),
        ('NEFT', 'NEFT'),
        ('RTGS', 'RTGS'),
        ('OTHER', 'Other'),
    ]

    local_freight = models.ForeignKey(LocalFreight, on_delete=models.CASCADE, related_name='payments')
    payment_no = models.CharField(max_length=50, blank=True, default='', db_index=True)   # LFP-0001-2026 voucher
    payment_date = models.DateField(db_index=True)
    amount_paid = models.DecimalField(max_digits=18, decimal_places=2, validators=[MinValueValidator(Decimal('0.01'))])
    payment_mode = models.CharField(max_length=20, choices=PAYMENT_MODE_CHOICES, default='BANK')
    paid_to = models.CharField(max_length=200, blank=True, default='')
    reference_no = models.CharField(max_length=100, blank=True, default='')
    notes = models.TextField(blank=True, default='')
    created_by = models.ForeignKey('core.StakeholderUser', on_delete=models.SET_NULL, null=True, blank=True,
                                   related_name='local_freight_payments')

    class Meta:
        db_table = 'purchase_local_freight_payment'
        ordering = ['local_freight', 'payment_date']
        indexes = [models.Index(fields=['local_freight', 'payment_date'])]

    def __str__(self):
        return f"{self.local_freight.freight_no} - {self.amount_paid} on {self.payment_date}"


# ─────────────────────────── Zoho Creator import ───────────────────────────
# Purchase data imported (read-only mirror) from Zoho Creator, kept in its OWN
# tables so it never mixes with Tally-sourced VendorBills. Idempotent: each row
# is keyed by the Zoho record ID, so re-running the importer updates in place.
# Feeds the "Purchase Dashboard/Analytics (Zoho)" pages, tracked product-wise.

class ZohoPurchaseBill(BaseModel):
    """One SRA (Stock Receiving Advice) bill from Zoho's New_SRA_26_27_Report."""

    zoho_id = models.CharField(max_length=40, unique=True, db_index=True,
                               help_text='Zoho Creator record ID (import key).')
    sra_no = models.CharField(max_length=100, blank=True, default='', db_index=True)
    bill_no = models.CharField(max_length=100, blank=True, default='')   # supplier invoice no
    vendor_name = models.CharField(max_length=255, blank=True, default='', db_index=True)
    vendor_zoho_id = models.CharField(max_length=40, blank=True, default='')
    # Resolved ERP master (mapped or created via the import popup, like Tally).
    vendor = models.ForeignKey('master.Vendor', on_delete=models.SET_NULL,
                               null=True, blank=True, related_name='+')
    company = models.CharField(max_length=100, blank=True, default='')   # Zoho text (e.g. "SS Bio")
    factory = models.CharField(max_length=100, blank=True, default='')
    po_no = models.CharField(max_length=100, blank=True, default='')
    tax = models.CharField(max_length=30, blank=True, default='')
    lorry_no = models.CharField(max_length=50, blank=True, default='')
    bill_date = models.DateField(null=True, blank=True)          # supplier's bill date
    # Zoho "Date" = when the bill was entered/booked. Bills are imported, filtered
    # and displayed by THIS date (a late-March supplier bill can be booked in the
    # new FY), so the ERP matches Zoho exactly — same rule as freight.
    entry_date = models.DateField(null=True, blank=True, db_index=True)
    due_date = models.DateField(null=True, blank=True)
    total_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    gst_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    balance = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    status = models.CharField(max_length=50, blank=True, default='')
    remarks = models.TextField(blank=True, default='')
    raw = models.JSONField(null=True, blank=True)   # full Zoho record (audit)
    synced_at = models.DateTimeField(null=True, blank=True)
    # The REAL VendorBill this staging row was converted into (Option A). Lets the
    # conversion stay idempotent and lets Revert delete the produced bill — same
    # pattern as ZohoInwardFreight.created_advice.
    converted_bill = models.ForeignKey('purchase.VendorBill', on_delete=models.SET_NULL,
                                       null=True, blank=True, related_name='+')
    # Set once the operator has resolved this bill's Tally-vs-Zoho date difference
    # (Apply in the reconcile Date-differences tab). Bills flagged here are skipped
    # by future date-difference detection, so an already-handled month never keeps
    # re-appearing on every Check with Tally.
    date_reconciled = models.BooleanField(default=False, db_index=True)

    class Meta:
        db_table = 'purchase_zoho_bill'
        ordering = ['-bill_date', 'sra_no']
        indexes = [
            models.Index(fields=['vendor_name']),
            models.Index(fields=['bill_date']),
        ]

    def __str__(self):
        return f'{self.sra_no or self.zoho_id} · {self.vendor_name}'


class ZohoPurchaseBillLine(BaseModel):
    """One item line (from the SRA SubForm) — the product-wise detail."""

    bill = models.ForeignKey(ZohoPurchaseBill, on_delete=models.CASCADE, related_name='lines')
    zoho_line_id = models.CharField(max_length=40, blank=True, default='', db_index=True)
    product_name = models.CharField(max_length=255, blank=True, default='', db_index=True)
    product = models.ForeignKey('master.Product', on_delete=models.SET_NULL,
                                null=True, blank=True, related_name='+')
    quantity = models.DecimalField(max_digits=18, decimal_places=3, default=0)
    rate = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)

    class Meta:
        db_table = 'purchase_zoho_bill_line'
        ordering = ['bill', 'id']
        indexes = [models.Index(fields=['product_name'])]

    def __str__(self):
        return f'{self.product_name} · {self.quantity}'


class ZohoInwardFreight(BaseModel):
    """One freight record from Zoho's Inward_Freight_26_27_Report."""

    zoho_id = models.CharField(max_length=40, unique=True, db_index=True)
    freight_no = models.CharField(max_length=100, blank=True, default='', db_index=True)
    transport_name = models.CharField(max_length=255, blank=True, default='')   # the carrier
    vendor_name = models.CharField(max_length=255, blank=True, default='')      # goods supplier
    # Resolved ERP masters (mapped or created via the import popup).
    transporter = models.ForeignKey('master.Transporter', on_delete=models.SET_NULL,
                                    null=True, blank=True, related_name='+')
    vendor = models.ForeignKey('master.Vendor', on_delete=models.SET_NULL,
                               null=True, blank=True, related_name='+')
    # Real ERP Inward Freight (FreightAdviceInbound) created from this row on
    # import, so it shows in the Inward Freight page. Kept for idempotent re-sync
    # and revert.
    created_advice = models.ForeignKey('purchase.FreightAdviceInbound',
                                       on_delete=models.SET_NULL, null=True, blank=True,
                                       related_name='+')
    sra_no = models.CharField(max_length=100, blank=True, default='', db_index=True)  # links to the bill
    sra_zoho_id = models.CharField(max_length=40, blank=True, default='', db_index=True)
    company = models.CharField(max_length=100, blank=True, default='')
    factory = models.CharField(max_length=100, blank=True, default='')
    bill_no = models.CharField(max_length=100, blank=True, default='')
    bill_date = models.DateField(null=True, blank=True)          # supplier's bill date
    # Zoho "Date" = when the freight was entered/processed. Freight is imported,
    # filtered and displayed by THIS date (bill dates can fall in the prior month
    # for entries made in the new FY), so the ERP matches Zoho exactly.
    entry_date = models.DateField(null=True, blank=True, db_index=True)
    lorry_no = models.CharField(max_length=50, blank=True, default='')
    quantity = models.DecimalField(max_digits=18, decimal_places=3, default=0)
    freight_per_ton = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    freight_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    amount_pay = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    paid = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    payment_mode = models.CharField(max_length=50, blank=True, default='')
    status = models.CharField(max_length=50, blank=True, default='')
    remarks = models.TextField(blank=True, default='')
    raw = models.JSONField(null=True, blank=True)
    synced_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'purchase_zoho_freight'
        ordering = ['-bill_date', 'freight_no']
        indexes = [
            models.Index(fields=['vendor_name']),
            models.Index(fields=['sra_no']),
        ]

    def __str__(self):
        return f'{self.freight_no or self.zoho_id} · {self.transport_name}'


class CreditorBalance(BaseModel):
    """One row per Tally creditor LEDGER, so the purchase Creditors page can
    reproduce Tally's "Sundry Creditors" Group Summary exactly.

    Reporting-only and idempotent, exactly like TdsPayable: an import RESETS the
    company's rows and re-inserts them. It never touches bills or payables. The
    ERP's own bill-based Outstanding Payables is unreliable (payments are not
    linked to bills, and there are duplicate vendor masters), so this reads the
    figures from the ledger of record instead of deriving them.

        closing = opening + movements

    SIGNS — a CREDIT is positive, a DEBIT negative. That is Tally's own export
    convention, not a choice made here: in the ledger master a supplier who is
    owed money carries a POSITIVE opening ("Ameerdha Oil Productss - Slm - RM
    2025787.00") while an advance already paid carries a negative one ("Amazon -
    Advance -1095.32"). It is also the convention that makes TdsPayable tie. So
    a normal payable closing is positive and displays as "Cr"; a net-receivable
    closing is negative and displays as "Dr".

    `debit` and `credit` are the two unsigned columns Tally's Group Summary
    prints; `closing` is the signed figure. debit + credit do NOT equal closing —
    closing is opening + (credit - debit).

    GROUPING — Tally's Group Summary rows are the sub-groups sitting DIRECTLY
    under "Sundry Creditors", but ledgers frequently hang off a deeper group:
    "Farmer Purchase" and "Farmer Purchase - Retail Purchase" are children of
    "Sundry Creditors-Agent & Farmers", and the three MSME groups nest under
    "Sundry Creditors - MSME". Grouping by each ledger's immediate parent would
    therefore emit "Farmer Purchase" as its own summary row and split MSME into
    three, which does not match Tally. So two fields are kept:

        parent_group  the sub-group directly under Sundry Creditors — the
                      SUMMARY row, walked up the group tree
        ledger_parent the ledger's immediate parent — shown in the drill-down
    """

    company = models.ForeignKey(
        'core.Company', on_delete=models.CASCADE, related_name='creditor_balances')
    ledger_name = models.CharField(max_length=200, db_index=True)
    # The summary row: the sub-group directly under "Sundry Creditors".
    parent_group = models.CharField(max_length=200, blank=True, default='', db_index=True)
    # Where the ledger actually sits, which may be several levels deeper.
    ledger_parent = models.CharField(max_length=200, blank=True, default='')
    vendor = models.ForeignKey(
        'master.Vendor', null=True, blank=True, on_delete=models.SET_NULL,
        related_name='creditor_balances')
    # Signed: credit +, debit -.
    opening = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'))
    closing = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'))
    # The Group Summary's two unsigned movement columns, for the period imported.
    debit = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'))
    credit = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'))
    # The date the closing is stated as of — the end of the imported period.
    as_of = models.DateField(null=True, blank=True, db_index=True)

    class Meta:
        db_table = 'purchase_creditor_balance'
        ordering = ['parent_group', 'ledger_name']
        indexes = [
            models.Index(fields=['company', 'parent_group']),
        ]

    def __str__(self):
        return f'{self.ledger_name} {self.closing}'


class PurchaseAccountsTotal(BaseModel):
    """Tally's 'Purchase Accounts' GROUP total for one company + period, imported
    from a Trial Balance export. The dashboard's Ex-GST is built from BILLS, which
    can never equal this group total — Tally files freight/testing/packing in other
    groups, splits taxable per ledger, and sweeps in journals — so this stores the
    group figure verbatim, letting the Ex-GST tile show Tally's own number (the
    Purchase Accounts screen the boss reads) to the rupee. Reporting-only: it never
    touches a bill. Keyed on (company, from_date, to_date) so it lines up with the
    dashboard period, and RE-imported idempotently (update_or_create)."""
    company = models.ForeignKey(
        'core.Company', on_delete=models.CASCADE, related_name='purchase_accounts_totals')
    from_date = models.DateField(db_index=True)
    to_date = models.DateField(db_index=True)
    # Purchase Accounts net for the period, POSITIVE (Tally shows it Cr/negative).
    amount = models.DecimalField(max_digits=18, decimal_places=2, default=Decimal('0'))
    # Tally's OWN figures for the SAME period, so the dashboard tiles can show
    # Tally's number to the rupee instead of the Zoho/scan bill-derived value:
    #   gst    input GST on purchases (Duties & Taxes)
    #   gross  grand total incl GST (Purchase Register total)
    #   tds    194Q TDS on purchases
    # Ex-GST shown on the tile = gross − gst. All nullable (only shown when set).
    gst = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True)
    gross = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True)
    tds = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True)
    # Sub-group breakdown [{'name':..., 'amount':...}] for the drill / transparency.
    breakdown = models.JSONField(default=list, blank=True)

    class Meta:
        db_table = 'purchase_accounts_total'
        ordering = ['-to_date']
        unique_together = [['company', 'from_date', 'to_date']]
        indexes = [models.Index(fields=['company', 'from_date', 'to_date'])]

    def __str__(self):
        return f'Purchase Accounts {self.from_date}..{self.to_date} = {self.amount}'


class TallyCreditorsOutstanding(BaseModel):
    """Tally's 'Sundry Creditors' closing balance (total payables owed) as of a
    date, entered verbatim so the dashboard can show Tally's authoritative
    Outstanding to the rupee. The ERP's bill-by-bill payables CANNOT reconstruct
    it — proven 2026-09-15: of ~Rs 73.5 cr of Apr-Jul vendor payments only
    Rs 9.69 cr name a bill the ERP holds; the rest are advances or settle bills
    the ERP never imported (Tally bill-numbers vs Zoho numbering), and vendor
    masters are duplicated. So this stores Tally's own figure (the Sundry
    Creditors screen the boss reads). Reporting-only: it never touches a bill.
    Keyed on (company, as_of_date), re-imported idempotently (update_or_create)."""
    company = models.ForeignKey(
        'core.Company', on_delete=models.CASCADE, related_name='tally_creditors_outstandings')
    as_of_date = models.DateField(db_index=True)
    # Sundry Creditors closing, POSITIVE (Tally shows creditors as a Cr balance).
    amount = models.DecimalField(max_digits=18, decimal_places=2, default=Decimal('0'))
    opening_balance = models.DecimalField(max_digits=18, decimal_places=2, default=Decimal('0'))
    debit_total = models.DecimalField(max_digits=18, decimal_places=2, default=Decimal('0'))
    credit_total = models.DecimalField(max_digits=18, decimal_places=2, default=Decimal('0'))
    note = models.CharField(max_length=200, blank=True, default='')

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['company', 'as_of_date'],
                                    name='uniq_tally_creditors_company_asof')]
        indexes = [models.Index(fields=['company', 'as_of_date'])]

    def __str__(self):
        return f'Tally Creditors as of {self.as_of_date} = {self.amount}'


class VendorOpeningBalance(BaseModel):
    """A vendor's Tally OPENING balance as-of a date (Cr = we owe, Dr = advance),
    imported from Tally's ledger-wise Sundry Creditors export. The ERP holds no
    per-vendor opening of its own (it starts from the bills it imported), so a
    supplier whose balance predates the ERP's first bill reads short. Adding this
    opening on top of the ERP's own movements makes the per-vendor payable roll
    forward to Tally's closing (proven SS Biochem Apr: ERP net -6.80cr + openings
    5.18cr = -1.62cr vs Tally -1.42cr). Reporting-only, never touches a bill.
    `vendor` is nullable so an opening for a party the ERP has no master for yet
    (e.g. Bioscience) is still kept (by name) and shown as its own row. Imported
    idempotently per (company, as_of_date) by `import_vendor_openings`."""
    company = models.ForeignKey(
        'core.Company', on_delete=models.CASCADE, related_name='vendor_openings')
    vendor = models.ForeignKey(
        'master.Vendor', on_delete=models.CASCADE, null=True, blank=True,
        related_name='opening_balances',
        help_text='The ERP vendor this opening matched to; NULL if the ERP has no '
                  'master for this Tally party yet.')
    vendor_name = models.CharField(
        max_length=255,
        help_text='Tally ledger name (kept even when matched, for audit).')
    as_of_date = models.DateField(db_index=True, help_text='Opening as-of date (e.g. 1-Apr).')
    amount = models.DecimalField(
        max_digits=18, decimal_places=2, default=Decimal('0'),
        help_text='Opening; POSITIVE = Cr (we owe), NEGATIVE = Dr (advance).')
    note = models.CharField(max_length=200, blank=True, default='')

    class Meta:
        # Names spelled out to match what migration 0123 actually created in
        # the database. Without them Django auto-generates a different name,
        # sees a mismatch it can never settle, and every deploy warns that
        # purchase has unapplied model changes - for two index renames that
        # would gain nothing. Naming them here fixes it with no DB operation.
        indexes = [models.Index(fields=['company', 'as_of_date'],
                                name='purch_vob_company_asof_idx'),
                   models.Index(fields=['vendor', 'as_of_date'],
                                name='purch_vob_vendor_asof_idx')]

    def __str__(self):
        return f'Opening {self.vendor_name} as of {self.as_of_date} = {self.amount}'


class TdsPayable(BaseModel):
    """TDS the company DEDUCTS from vendors and owes the government (194C / 194Q /
    194J / 194I), imported from Tally's "TDS Payable" ledger group so the
    purchase-side TDS page mirrors Tally's Group Summary. Reporting-only: one row
    per Tally voucher leg that hits a TDS-Payable ledger; it never touches vendor
    bills or payables. Populated idempotently, per company, by the
    `import_tds_payable` management command from a Day Book + ledger Master."""

    SECTION_CHOICES = (
        ('194C', '194C - Contract / Freight'),
        ('194Q', '194Q - Purchase'),
        ('194J', '194J - Professional'),
        ('194I', '194I - Rent'),
        ('OTHER', 'Other'),
    )

    company = models.ForeignKey(
        'core.Company', on_delete=models.CASCADE, related_name='tds_payables')
    tally_guid = models.CharField(max_length=120, blank=True, default='', db_index=True)
    voucher_no = models.CharField(max_length=100, blank=True, default='')
    voucher_type = models.CharField(max_length=100, blank=True, default='')
    voucher_date = models.DateField(null=True, blank=True, db_index=True)
    ledger_name = models.CharField(max_length=200, db_index=True)
    section = models.CharField(
        max_length=10, choices=SECTION_CHOICES, default='OTHER', db_index=True)
    party_name = models.CharField(max_length=255, blank=True, default='')
    vendor = models.ForeignKey(
        'master.Vendor', null=True, blank=True, on_delete=models.SET_NULL,
        related_name='tds_payables')
    # The Tally bill reference (Agst Ref) the TDS is booked against, and the ERP
    # VendorBill it resolves to — so a bill can show its TDS deducted / net payable
    # and hyperlink to the deduction, and vice versa. Reporting-only: linking does
    # NOT change the bill's gross / total / payable.
    bill_ref = models.CharField(max_length=100, blank=True, default='', db_index=True)
    vendor_bill = models.ForeignKey(
        'purchase.VendorBill', null=True, blank=True, on_delete=models.SET_NULL,
        related_name='tds_deductions')
    # True when an operator linked the bill by hand (TDS page "Link to bill"). The
    # import RESETS + rebuilds these rows, so a manual link must survive: build_
    # and_store_tds_payable carries manual links across the rebuild, keyed by
    # tally_guid, and they WIN over the automatic vendor+ref match.
    manual_link = models.BooleanField(default=False, db_index=True)
    # Signed to match Tally: a CREDIT (TDS deducted -> payable rises) is positive,
    # a DEBIT (TDS paid to the govt) is negative, so summing a ledger's rows
    # equals its Tally closing balance.
    amount = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'))
    narration = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'purchase_tds_payable'
        ordering = ['-voucher_date', 'ledger_name']
        indexes = [
            models.Index(fields=['company', 'voucher_date']),
            models.Index(fields=['company', 'ledger_name']),
            models.Index(fields=['company', 'section']),
        ]

    def __str__(self):
        return f'{self.ledger_name} {self.voucher_no} {self.amount}'


class FreightInward(BaseModel):
    """Inward freight the company pays to bring goods in — mirrors Tally's
    "Freight Inward Charges" group so the purchase-side Freight page shows the
    SAME per-ledger breakdown (@18% / @18% TVP / @5% / RCM) and the same total.

    Reporting-only, exactly like TdsPayable: one row per Tally voucher leg that
    hits a Freight-Inward ledger; it never touches vendor bills, payables, or the
    Freight-Advice / Local-Freight operational records. Populated idempotently,
    per company, by the `import_freight_inward` management command (files or
    --live connector). Amount is stored so a DEBIT (the freight cost) is POSITIVE,
    so a ledger's rows sum to its Tally Group-Summary Debit/closing figure.
    """
    company = models.ForeignKey(
        'core.Company', on_delete=models.CASCADE, related_name='freight_inwards')
    tally_guid = models.CharField(max_length=120, blank=True, default='', db_index=True)
    voucher_no = models.CharField(max_length=100, blank=True, default='')
    voucher_type = models.CharField(max_length=100, blank=True, default='')
    voucher_date = models.DateField(null=True, blank=True, db_index=True)
    ledger_name = models.CharField(max_length=200, db_index=True)
    # Coarse kind derived from the ledger name, for at-a-glance grouping on top of
    # the exact per-ledger lines: RCM (reverse charge) / TVP (branch) / a GST rate.
    kind = models.CharField(max_length=20, blank=True, default='', db_index=True)
    party_name = models.CharField(max_length=255, blank=True, default='')
    narration = models.TextField(blank=True, default='')
    # Signed to match Tally: a DEBIT (freight incurred) is positive, a CREDIT
    # (reversal) negative, so summing a ledger's rows equals its Tally closing.
    amount = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'))

    class Meta:
        db_table = 'purchase_freight_inward'
        ordering = ['-voucher_date', 'ledger_name']
        indexes = [
            models.Index(fields=['company', 'voucher_date']),
            models.Index(fields=['company', 'ledger_name']),
            models.Index(fields=['company', 'kind']),
        ]

    def __str__(self):
        return f'{self.ledger_name} {self.voucher_no} {self.amount}'


class ExpenseLedgerBalance(BaseModel):
    """One row per Tally expense LEDGER, so the Purchase by-Category view's
    Expenses section can reproduce Tally's "Direct Expenses" and "Indirect
    Expenses" Group Summaries exactly — split into sub-categories (Electricity,
    Labour & Wages, Rent, Salary, Interest, Freight In/Out, Lab/R&D, ...).

    Reporting-only and idempotent, exactly like CreditorBalance / FreightInward:
    an import RESETS the company's rows and re-inserts them. It never touches
    bills or payables. The source is a Tally Group Summary export (DSPACCNAME /
    DSPCLAMTA, or the Dr/Cr columns), so there is one row per ledger with its
    opening and closing — not per voucher.

    SIGN — stored DEBIT-POSITIVE: an expense (a debit balance, shown negative in
    the export) is kept as a POSITIVE spend, so a ledger's `closing` is its spend
    and summing a sub-category gives the Tally figure. The PERIOD spend used for a
    date-ranged comparison is `closing - opening` (opening is 0 for a full-FY
    export, since P&L accounts reset each year).

    GROUPING — `group_type` is the Tally group the ledger sits under (DIRECT /
    INDIRECT), taken from the export, and is authoritative. `sub_category` is the
    finer bucket, derived from the ledger name with the shared _expense_subcategory
    rules."""

    GROUP_CHOICES = (
        ('DIRECT', 'Direct Expenses'),
        ('INDIRECT', 'Indirect Expenses'),
    )

    company = models.ForeignKey(
        'core.Company', on_delete=models.CASCADE, related_name='expense_ledger_balances')
    group_type = models.CharField(
        max_length=10, choices=GROUP_CHOICES, default='DIRECT', db_index=True)
    ledger_name = models.CharField(max_length=200, db_index=True)
    # Finer bucket the ledger rolls up to (Electricity, Rent, Salary, ...). Blank
    # when the ledger name didn't match a rule — shown under an "Other" row.
    sub_category = models.CharField(max_length=40, blank=True, default='', db_index=True)
    # Debit-positive spend. opening is the balance at period start (0 for a
    # full-FY export); closing is the balance at period end; period spend =
    # closing - opening.
    opening = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'))
    closing = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'))
    # The date the closing is stated as of — the end of the imported period.
    as_of = models.DateField(null=True, blank=True, db_index=True)
    # Which reporting period this snapshot is for: 'FY' = the full-year cumulative
    # (as-of) snapshot; 'YYYY-MM' = a single calendar month. Lets the by-Category
    # Month view tie to that month's Tally expenses, while FY uses the 'FY' rows.
    # A company can hold the FY snapshot AND per-month snapshots side by side.
    period_key = models.CharField(max_length=10, default='FY', db_index=True)

    class Meta:
        db_table = 'purchase_expense_ledger_balance'
        ordering = ['group_type', 'sub_category', 'ledger_name']
        indexes = [
            models.Index(fields=['company', 'group_type'], name='purch_exp_co_grp_idx'),
            models.Index(fields=['company', 'sub_category'], name='purch_exp_co_sub_idx'),
        ]

    def __str__(self):
        return f'{self.group_type} {self.ledger_name} {self.closing}'


class ExpenseVoucher(BaseModel):
    """Bill-wise expense line from the Tally Day Book — one row per expense-ledger
    debit in a voucher. Powers the voucher drill under the By-Category month view
    (date · voucher no · party · amount), so each month's expense figure opens to
    the individual bills behind it. Loaded by load_expense_vouchers, idempotent per
    (company, period_key)."""
    company = models.ForeignKey('core.Company', on_delete=models.CASCADE, related_name='expense_vouchers')
    period_key = models.CharField(max_length=10, db_index=True)        # 'YYYY-MM'
    group_type = models.CharField(max_length=10, db_index=True)        # DIRECT / INDIRECT
    sub_category = models.CharField(max_length=40, blank=True, default='', db_index=True)
    ledger_name = models.CharField(max_length=200, db_index=True)
    voucher_date = models.DateField(db_index=True)
    voucher_no = models.CharField(max_length=50, blank=True, default='')
    voucher_type = models.CharField(max_length=60, blank=True, default='')
    party = models.CharField(max_length=200, blank=True, default='')
    amount = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'))
    guid = models.CharField(max_length=80, blank=True, default='', db_index=True)   # Tally voucher GUID -> VendorBill.tally_guid

    class Meta:
        db_table = 'purchase_expense_voucher'
        ordering = ['-voucher_date', 'voucher_no']
        indexes = [
            models.Index(fields=['company', 'period_key', 'group_type']),
            models.Index(fields=['company', 'period_key', 'sub_category']),
        ]

    def __str__(self):
        return f'{self.voucher_no} {self.ledger_name} {self.amount}'


class TallyGroupsCache(models.Model):
    """Last successfully-fetched Tally chart-of-accounts group hierarchy,
    per Tally company (see tally_purchase.fetch_groups).

    That fetch is a live read against Tally's gateway and can fail on any
    given run for reasons that have nothing to do with the chart of
    accounts itself (timeout, the connector mid-cycle, Tally not yet
    reopened). tally_purchase_sync.sync_bills uses the result to decide
    which expense ledgers count as "purchase" vs "charges" on each
    voucher, and that split feeds voucher_hash() — so a run that silently
    falls back to "no group data" produces a DIFFERENT hash for a voucher
    that has not actually changed in Tally, which reads as an edit and
    rewrites the bill. Falling back to the last real answer instead of
    "no data" keeps the hash stable across a run where the live fetch
    merely hiccuped. Chart-of-accounts groups change on the order of
    "almost never," so a stale cache is a far smaller risk than that
    instability. Plain model, not BaseModel — this is a cache, not a
    business record, and is safe to delete/rebuild at any time.
    """
    tally_company = models.CharField(max_length=255, unique=True)
    groups = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.tally_company} ({len(self.groups)} groups, updated {self.updated_at:%Y-%m-%d %H:%M})'


class TallyPurchaseVoucherType(models.Model):
    """The voucher-type NAMES Tally files under the PURCHASE class, per company.

    is_purchase() decides "is this a purchase voucher?" and by default checks the
    word 'purchase' in the type name — which misses a purchase-class type that
    doesn't contain the word (e.g. "Stock Transfer Pur") and would wrongly catch
    "Purchase Order". Tally's own class is the truth. This table stores that class
    list, imported from a Voucher Type master or a (class-filtered) Purchase
    Vouchers report, so is_purchase() can test the real class. When a company has
    no rows here, is_purchase() falls back to the substring test — so this is a
    pure upgrade, never a regression. Plain model (a config/cache, not a business
    record) — safe to rebuild any time by re-importing.
    """
    company = models.ForeignKey('core.Company', on_delete=models.CASCADE,
                                related_name='purchase_vtypes')
    name = models.CharField(max_length=120)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('company', 'name')

    def __str__(self):
        return f'{self.company_id}: {self.name}'
