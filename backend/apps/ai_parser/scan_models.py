"""Invoice-scan pipeline models.

A bulk "Scan Inbox" for purchase invoices: the operator drops many PDFs at
once, each PDF may hold SEVERAL bills, Claude vision segments + reads them, we
match each to an existing Tally VendorBill (or create a new one), and — after
MANUAL review — write the item lines onto the bill so item-wise tracking,
item master and purchase analytics fill in.

Shape:
    InvoiceScanBatch    one upload session
      └─ InvoiceScanDocument   each uploaded PDF/image
           └─ InvoiceScanBill  each invoice detected inside it  ← review unit

Item lines live as JSON on the bill (editable during review); they are only
converted to real VendorBillLine rows on CONFIRM. Nothing writes to the
purchase ledger until the operator confirms — matching the zero-auto-post rule.
"""
from django.db import models

from common.models import BaseModel


class InvoiceScanBatch(BaseModel):
    """One bulk upload session (many PDFs dropped together)."""

    STATUS_CHOICES = (
        ('UPLOADED', 'Uploaded'),
        ('PROCESSING', 'Processing'),
        ('READY', 'Ready for review'),
        ('DONE', 'Done'),
        ('FAILED', 'Failed'),
    )

    company = models.ForeignKey(
        'core.Company', on_delete=models.CASCADE,
        related_name='invoice_scan_batches', null=True, blank=True,
        help_text='Company these scanned bills belong to (drives vendor/product matching).',
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='UPLOADED', db_index=True)
    note = models.CharField(max_length=255, blank=True, default='')
    doc_count = models.IntegerField(default=0)
    bill_count = models.IntegerField(default=0)
    error_message = models.TextField(blank=True, default='')

    class Meta:
        app_label = 'ai_parser'
        ordering = ['-created_at']

    def __str__(self):
        return f'ScanBatch {self.pk} ({self.status})'


class InvoiceScanDocument(BaseModel):
    """One uploaded file (PDF or image) within a batch."""

    STATUS_CHOICES = (
        ('PENDING', 'Pending'),
        ('SPLIT', 'Split'),
        ('EXTRACTED', 'Extracted'),
        ('FAILED', 'Failed'),
    )

    batch = models.ForeignKey(InvoiceScanBatch, on_delete=models.CASCADE, related_name='documents')
    file = models.FileField(upload_to='invoice_scans/%Y/%m/')
    original_name = models.CharField(max_length=255, blank=True, default='')
    content_type = models.CharField(max_length=100, blank=True, default='')
    page_count = models.IntegerField(default=0)
    # SHA-256 of the file bytes — an identical re-upload reuses the cached
    # extraction instead of calling the LLM again (OCR runs only once).
    file_hash = models.CharField(max_length=64, blank=True, default='', db_index=True)
    # Raw invoices list the LLM returned, cached so the same file (or an identical
    # re-upload) never has to be read again.
    extraction = models.JSONField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='PENDING', db_index=True)
    error_message = models.TextField(blank=True, default='')

    class Meta:
        app_label = 'ai_parser'
        ordering = ['created_at']

    def __str__(self):
        return self.original_name or f'ScanDoc {self.pk}'


class ScanInvoiceCache(BaseModel):
    """Per-invoice-number extraction cache.

    One row per (company, invoice_no): the last extracted data for that invoice,
    plus the file hash it came from. Lets us recognise an invoice we've already
    read — even if it arrives in a different file — and, with `file_hash`, skip
    re-reading an identical file entirely.
    """
    company = models.ForeignKey(
        'core.Company', on_delete=models.CASCADE,
        related_name='scan_invoice_cache', null=True, blank=True)
    invoice_no = models.CharField(max_length=100, db_index=True)
    vendor_name = models.CharField(max_length=255, blank=True, default='')
    file_hash = models.CharField(max_length=64, blank=True, default='', db_index=True)
    data = models.JSONField(null=True, blank=True)   # the single invoice dict

    class Meta:
        app_label = 'ai_parser'
        ordering = ['-updated_at']
        indexes = [models.Index(fields=['company', 'invoice_no'])]

    def __str__(self):
        return f'{self.invoice_no} ({self.vendor_name})'


class InvoiceScanBill(BaseModel):
    """One invoice detected inside a document (a PDF may hold many).

    The unit shown as a row in the Scan Inbox and reviewed/confirmed one by one.
    """

    STATUS_CHOICES = (
        ('EXTRACTED', 'Extracted'),        # read from scan, not yet matched
        ('MATCHED', 'Matched'),            # linked to an existing VendorBill
        ('UNMATCHED', 'Unmatched'),        # no Tally voucher — will create a new bill
        ('MISMATCH', 'Amount mismatch'),   # matched but items != bill total
        ('CONFIRMED', 'Confirmed'),        # item lines written
        ('SKIPPED', 'Skipped'),
        ('FAILED', 'Failed'),
    )

    document = models.ForeignKey(InvoiceScanDocument, on_delete=models.CASCADE, related_name='bills')
    batch = models.ForeignKey(InvoiceScanBatch, on_delete=models.CASCADE, related_name='bills')

    # PER-BILL company override. The batch is scanned under ONE company, but a stack
    # can hold a bill for another company (SS vs United Agro). Blank = use the batch
    # company; the reviewer can switch it, which re-scopes the vendor and drives the
    # created VendorBill's company. (Mirrors the Email Inbox's per-draft company.)
    company = models.ForeignKey(
        'core.Company', on_delete=models.SET_NULL, null=True, blank=True, related_name='+')

    # Which pages of the source PDF this invoice spans (for the review preview).
    page_start = models.IntegerField(default=1)
    page_end = models.IntegerField(default=1)

    # ── Extracted header (editable in review) ─────────────────────────────
    vendor_name = models.CharField(max_length=255, blank=True, default='')
    vendor_gstin = models.CharField(max_length=20, blank=True, default='')
    invoice_no = models.CharField(max_length=100, blank=True, default='')
    invoice_date = models.DateField(null=True, blank=True)
    # Payment due date for the bill this scan creates. Read from the invoice's
    # printed "Payment Due Date" when the AI finds one (B); otherwise computed at
    # confirm from the vendor's credit days (A). Editable in review (C).
    due_date = models.DateField(null=True, blank=True)
    # Operator-picked Tally voucher type (e.g. "GST Purchase", "Purchase-Bought
    # Note"); stamped onto the bill's tally_voucher_type on confirm so scanned
    # bills reconcile under the right type instead of "(no type)". Optional.
    voucher_type = models.CharField(max_length=100, blank=True, default='')
    subtotal = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    tax_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    total_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # TDS deducted on the bill, if the invoice shows one (read by the extractor).
    tds_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # Spend category the operator picks (RM / Packing / Freight / Expenses /
    # Machinery). Blank = let the auto-classifier decide on confirm; set = manual
    # override written straight to VendorBill.purchase_category.
    category = models.CharField(max_length=16, blank=True, default='')

    # Item lines as JSON — editable during review, converted to VendorBillLine
    # only on confirm. Each: {description, hsn, qty, uom, rate, amount, gst,
    # batch, expiry, discount, product_id}. product_id set once mapped.
    lines = models.JSONField(default=list, blank=True)

    # Raw model output + confidence, kept for audit / re-review.
    raw = models.JSONField(null=True, blank=True)
    confidence = models.DecimalField(max_digits=4, decimal_places=3, default=0)

    # ── Matching / reconciliation ─────────────────────────────────────────
    matched_bill = models.ForeignKey(
        'purchase.VendorBill', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='scan_matches',
        help_text='Existing Tally VendorBill this scan fills items onto.',
    )
    matched_vendor = models.ForeignKey(
        'master.Vendor', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='scan_bills',
    )
    reconciled = models.BooleanField(
        default=False, help_text='sum(line amounts) reconciles to the bill/total.',
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='EXTRACTED', db_index=True)

    # ── Stock intake (goods received) ─────────────────────────────────────
    # When on, confirming a NEW bill posts each item line's qty as a stock
    # RECEIPT into the inventory ledger at the chosen warehouse + godown.
    # Turned off for transport / service-only bills that carry no goods.
    update_stock = models.BooleanField(
        default=False,
        help_text='Post item quantities to the stock ledger on confirm (off = service/transport bill). Off by default — operator ticks it when goods were actually received.',
    )

    # ── Freight (Scenario 2: a standalone transporter freight bill) ───────
    # When bill_type == FREIGHT the lines are routes ("Virudhunagar to Salem"),
    # NOT products — no products are created. On confirm we create a freight
    # record (Local Freight for now) against the Transporter master.
    bill_type = models.CharField(
        max_length=12, default='GOODS', db_index=True,
        choices=(('GOODS', 'Goods'), ('FREIGHT', 'Freight')))
    # Operator chooses where a freight bill lands (NOT assumed).
    freight_target = models.CharField(
        max_length=8, default='LOCAL',
        choices=(('LOCAL', 'Local Freight'), ('INWARD', 'Inward Freight')))
    # Carrier name read FROM the bill ("Dispatched through" / "Transporter" /
    # "Lorry freight by") — the ACTUAL transporter, not the goods supplier.
    transporter_name = models.CharField(max_length=255, blank=True, default='')
    transporter = models.ForeignKey(
        'master.Transporter', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='scan_bills')
    lorry_no = models.CharField(max_length=50, blank=True, default='')
    # Freight payable — kept SEPARATE from total_amount (the goods total) so
    # toggling Goods<->Freight never mutates the goods figure. Defaults to 0 for a
    # goods bill toggled to freight (operator types the transporter's charge); a
    # freshly-scanned freight slip seeds it from the extracted total.
    freight_amount = models.DecimalField(max_digits=15, decimal_places=2, default=0)
    # GROSS model (mirrors the Email Inbox): freight_amount is GROSS; Payable =
    # freight − TDS − round-off. Kept separate so the card can show payable live and
    # the created freight record books exactly what the slip says.
    freight_tds = models.DecimalField(max_digits=15, decimal_places=2, default=0)
    freight_roundoff = models.DecimalField(max_digits=15, decimal_places=2, default=0)
    # An optional WEIGHT / weighment charge some transporter slips add on top of the
    # lorry hire (e.g. "Lorry Hire 17300 + Weight 150 = 17450"). Adds to the payable:
    # Payable = freight + weight − TDS − round-off. Lands on the record's additional /
    # other charges on confirm. 0 when the slip has none.
    freight_weight_charge = models.DecimalField(max_digits=15, decimal_places=2, default=0)
    # The freight bill's OWN invoice no / date — separate from the goods invoice
    # fields, so toggling a goods bill to Freight shows them BLANK (a freight slip
    # is a different document). A freshly-scanned freight bill seeds them.
    freight_invoice_no = models.CharField(max_length=100, blank=True, default='')
    freight_invoice_date = models.DateField(null=True, blank=True)
    # The GOODS bill/invoice number the freight is AGAINST — the transporter writes
    # it (by hand) on the slip. Auto-read from the freight bill, editable manually;
    # used to link the freight advice to that purchase bill (matched by number
    # across companies — the matched bill supplies the company).
    freight_ref_no = models.CharField(max_length=100, blank=True, default='')
    freight_linked_bill = models.ForeignKey(
        'purchase.VendorBill', on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    created_local_freight = models.ForeignKey(
        'purchase.LocalFreight', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='scan_bills')
    created_freight_advice = models.ForeignKey(
        'purchase.FreightAdviceInbound', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='scan_bills')
    # ── DC / branch transfer (mirrors the Email Inbox) ───────────────────
    # A LOCAL freight slip that carries an internal branch-transfer delivery challan
    # (e.g. SS Biochem -> United Agro). The goods details are kept for REFERENCE and
    # are NEVER booked — only freight_amount is money. On confirm these tag the
    # created LocalFreight. dc_value = goods value (reference only).
    is_dc = models.BooleanField(default=False)
    dc_no = models.CharField(max_length=100, blank=True, default='')
    dc_from = models.CharField(max_length=255, blank=True, default='')
    dc_to = models.CharField(max_length=255, blank=True, default='')
    dc_material = models.CharField(max_length=255, blank=True, default='')
    dc_value = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # An EXISTING inward-freight this scanned goods bill is linked to (one slip
    # covering several bills). On confirm the created/matched bill is added to that
    # freight's covered_bills — no new freight is made.
    link_freight = models.ForeignKey(
        'purchase.FreightAdviceInbound', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='+')
    warehouse = models.ForeignKey(
        'core.Warehouse', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='+', help_text='Warehouse the scanned goods are received into.',
    )
    godown = models.ForeignKey(
        'core.Godown', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='+', help_text='Godown (section within the warehouse) for the receipt.',
    )

    # Result of a confirmed commit (new bill created, if unmatched).
    created_bill = models.ForeignKey(
        'purchase.VendorBill', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='scan_created',
    )
    committed_at = models.DateTimeField(null=True, blank=True)
    error_message = models.TextField(blank=True, default='')

    class Meta:
        app_label = 'ai_parser'
        ordering = ['document_id', 'page_start', 'id']
        indexes = [
            models.Index(fields=['batch', 'status']),
        ]

    def __str__(self):
        return f'{self.vendor_name or "?"} / {self.invoice_no or "?"} ({self.status})'

    @property
    def target_bill(self):
        """The bill item lines are (or will be) written to."""
        return self.matched_bill or self.created_bill


class ScanTypeOption(BaseModel):
    """Operator-added options for the Scan Inbox dropdowns, saved on the SERVER so
    everyone sees the same list.

    Two dropdowns use it, told apart by ``kind``:
      * PURCHASE_TYPE — the Tally purchase/voucher type ("GST Purchase",
        "Journal", …). Built-ins live in the frontend; this holds the extras an
        operator adds with "+". (These used to be per-browser localStorage, so
        one user's addition never reached anyone else.)
      * CHARGE_TYPE  — the item-line charge kind (freight / other / …).

    De-dup is case-insensitive, enforced in the view; the DB constraint is the
    backstop. Adding is gated by the 'Scan Categories' RBAC module.
    """
    KIND_CHOICES = (('PURCHASE_TYPE', 'Purchase type'), ('CHARGE_TYPE', 'Charge type'))

    kind = models.CharField(max_length=20, choices=KIND_CHOICES, db_index=True)
    label = models.CharField(max_length=100)

    class Meta:
        app_label = 'ai_parser'
        ordering = ['kind', 'label']
        unique_together = [['kind', 'label']]

    def __str__(self):
        return f'{self.get_kind_display()}: {self.label}'
