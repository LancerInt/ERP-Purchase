"""
Master data models for ERP system.
Defines products, services, vendors, customers, pricing, and tax configuration.
"""
from decimal import Decimal
from django.db import models
from django.core.validators import RegexValidator, MinValueValidator, MaxValueValidator
from common.models import BaseModel
from common.gst import pan_from_gstin
from .merge_utils import vkey


class Product(BaseModel):
    """Product/Service master data."""

    PRODUCT_TYPE_CHOICES = (
        ('GOODS', 'Goods'),
        ('SERVICES', 'Services'),
        ('MACHINERY', 'Machinery'),
    )

    GOODS_SUB_TYPE_CHOICES = (
        ('RAW_MATERIAL', 'Raw Material'),
        ('PACKING_MATERIAL', 'Packing Material'),
        ('FINISHED_GOOD', 'Finished Good'),
        ('SEMI_FINISHED', 'Semi Finished'),
        ('TRADED_PRODUCTS', 'Traded Products'),
        ('CAPITAL_GOOD', 'Capital Good'),
        ('MACHINE_SPARES', 'Machine Spares'),
        ('CONSUMABLES', 'Consumables'),
    )

    UOM_CHOICES = (
        ('PCS', 'Pieces'),
        ('KG', 'Kilogram'),
        ('LTR', 'Liters'),
        ('MTR', 'Meters'),
        ('SQM', 'Square Meter'),
        ('CUM', 'Cubic Meter'),
        ('BOX', 'Box'),
        ('PACK', 'Pack'),
        ('MTS', 'Metric Ton'),
    )

    QC_RESPONSIBILITY_CHOICES = (
        ('SUPPLIER', 'Supplier'),
        ('RECEIVER', 'Receiver'),
        ('NONE', 'No QC Required'),
    )

    sku_code = models.CharField(
        max_length=50,
        unique=True,
        db_index=True,
        help_text="Stock Keeping Unit code"
    )
    product_name = models.CharField(max_length=255, db_index=True)
    product_type = models.CharField(
        max_length=20,
        choices=PRODUCT_TYPE_CHOICES,
        db_index=True
    )
    goods_sub_type = models.CharField(
        max_length=30,
        choices=GOODS_SUB_TYPE_CHOICES,
        null=True,
        blank=True,
        help_text="Only for GOODS type products. Doubles as the Tally stock "
                  "group: FINISHED_GOOD / RAW_MATERIAL / PACKING_MATERIAL."
    )
    # Product family for grouping/analytics (e.g. Azadirachtin, Neem Oil, Plant
    # Growth Regulator, Organic Manure). Derived from the product name by the
    # `classify_products` command; lets the sales dashboard group/filter items
    # by family the way Tally's Stock Summary groups by stock group.
    product_family = models.CharField(
        max_length=60, blank=True, default='', db_index=True,
        help_text="Product family for grouping/analytics (derived from name)."
    )
    # Tally stock-group hierarchy, imported from the Stock Item master
    # (import_stock_groups). Unlike product_family (guessed from the name),
    # these are Tally's own tree, so the dashboard's By-Item view can nest
    # exactly like Tally's Stock Group Summary: root group -> family -> item.
    #   tally_stock_group = the ROOT group  (e.g. "FINISHED GOODS")
    #   tally_family      = the immediate sub-group / family
    #                       (e.g. "Azadirachtin 10000 PPM - TVP"); blank when
    #                       the item sits directly under the root group.
    tally_stock_group = models.CharField(
        max_length=80, blank=True, default='', db_index=True,
        help_text="Tally root stock group (from the Stock Item master)."
    )
    tally_family = models.CharField(
        max_length=80, blank=True, default='', db_index=True,
        help_text="Tally immediate sub-group / family (from the Stock Item master)."
    )
    # ── Finished-good-only attributes ─────────────────────────────────
    # These two fields are only meaningful when goods_sub_type ==
    # 'FINISHED_GOOD'. The form hides them for every other sub-type and
    # the serializer accepts NULL/empty for anything that isn't a
    # finished good, so they stay clean for raw materials / consumables
    # / etc. They identify the customer this finished good is produced
    # for and the trade name the customer markets it under (which can
    # differ from the internal product_name).
    finished_good_customer = models.ForeignKey(
        'Customer',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='finished_good_products',
        help_text="Customer this finished good is produced for "
                  "(only used when goods_sub_type=FINISHED_GOOD)."
    )
    # Optional self-FK linking a customer-branded finished good to the
    # internal bulk / semi-finished it's packed from. Example:
    #   "Empower Granules - 5 KG Bucket" (FINISHED_GOOD, customer = Greenstar)
    #     → parent_product = "Humic Granules - Bulk" (SEMI_FINISHED)
    # Lets reports roll customer-brand stock up to one "internal product
    # wise" view without walking BOM trees. Optional — leaving it blank
    # falls back to BOM-derived rollups.
    parent_product = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='packed_variants',
        help_text="Internal bulk / semi-finished product this finished "
                  "good is packed from. Same chemical, different brand "
                  "and packing per customer.",
    )
    product_trade_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text="Customer-facing trade name for the finished good. "
                  "Only used when goods_sub_type=FINISHED_GOOD."
    )
    service_sub_type = models.CharField(
        max_length=100,
        null=True,
        blank=True,
        help_text="Custom service subcategory for SERVICES type"
    )
    custom_service_category = models.ForeignKey(
        'ServiceCatalogue',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='products'
    )
    description = models.TextField(blank=True, default='')
    batch_tracking_required = models.BooleanField(
        default=False,
        help_text="Track by batch/lot number"
    )
    is_solvent = models.BooleanField(
        default=False,
        db_index=True,
        help_text="Marks this product as a solvent for extraction processes (S1/S2/S3). "
                  "S2/S3 rows drive Extraction Solvent Stock; S1 is untracked at inventory level.",
    )
    # Purchased as a mass (kg) but consumed in production as a volume
    # (litres). When true, the Purchase Receipt line surfaces a Specific
    # Gravity input; on save the receipt row also stores qty_litres =
    # qty_kg / SG so the Production Stock table (parallel to the main
    # Inventory Ledger) can hold both values. Production entries then
    # draw down from the litres column.
    sg_applicable = models.BooleanField(
        default=False,
        db_index=True,
        help_text='Product is purchased in kg but consumed in production as '
                  'litres. When set, the Purchase Receipt line asks for the '
                  'Specific Gravity and derives litres = kg / SG.',
    )
    shelf_life_days = models.IntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(1)]
    )
    qc_responsibility = models.CharField(
        max_length=20,
        choices=QC_RESPONSIBILITY_CHOICES,
        default='NONE'
    )
    qc_template = models.ForeignKey(
        'TemplateLibrary',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='products_with_qc',
        limit_choices_to={'template_type': 'QC_REPORT'}
    )
    uom = models.CharField(max_length=10, choices=UOM_CHOICES)
    # HSN/SAC code — optional; filled from Tally's stock-item master when a product
    # is created from the Reconcile flow, else left blank.
    hsn_code = models.CharField(max_length=20, blank=True, default='', db_index=True)
    specific_gravity = models.DecimalField(
        max_digits=8,
        decimal_places=4,
        null=True,
        blank=True,
        help_text="Weight per unit volume"
    )
    # ── Pack size (drives the packing-entry auto-fill) ──────────────
    # For packed-SKU products (e.g. "Humic Granules — 10 KG Bag",
    # "Neem Oil — 500 ML Bottle"). One of these carries the bulk
    # content per pack unit; the packing form multiplies output count
    # by this value to derive the expected bulk consumption on the
    # input line. Leave both at 0/NULL for products that aren't packed
    # SKUs (bulk products, raw materials, packaging like labels /
    # liners / pouches — those auto-fill 1:1 with the output count).
    pack_size_kg = models.DecimalField(
        max_digits=12, decimal_places=4,
        null=True, blank=True,
        help_text='KG of bulk per pack unit (e.g. 10 for a "10 KG Bag"). '
                  'Auto-fills the packing-entry bulk input as '
                  'output_count × pack_size_kg.',
    )
    pack_size_ltr = models.DecimalField(
        max_digits=12, decimal_places=4,
        null=True, blank=True,
        help_text='LTR of bulk per pack unit (e.g. 0.5 for a "500 ML Bottle"). '
                  'Auto-fills the packing-entry bulk input as '
                  'output_count × pack_size_ltr.',
    )
    conversion_notes = models.TextField(
        blank=True,
        default='',
        help_text="Notes on unit conversion"
    )
    packing_material_default = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='packed_products'
    )
    yield_tracking_required = models.BooleanField(default=False)
    yield_parameters = models.JSONField(
        default=dict,
        blank=True,
        help_text="Production yield tracking parameters"
    )
    # GST % is a property of the product (driven by its HSN), not of the
    # vendor — so when set it is the single source of truth: quote lines
    # auto-fill and lock to it, keeping the rate identical across every
    # vendor. Null = not configured yet (quote lines stay editable).
    gst_percentage = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True,
        validators=[MinValueValidator(Decimal('0')), MaxValueValidator(Decimal('100'))],
        help_text='GST %% for this product. When set, quote lines lock to it.',
    )
    # `wage_method` and `freight_class` were removed by user request —
    # neither was being read anywhere downstream (Production has its
    # own wage_method on WorkOrder/StageWorkOrder, sourced from the
    # work-order form, not from Product). See migration 0018.

    # Location fields, used by MACHINERY product type only.
    company = models.ForeignKey(
        'core.Company',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='machinery_products',
        help_text='For MACHINERY products: owning company',
    )
    warehouse = models.ForeignKey(
        'core.Warehouse',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='machinery_products',
        help_text='Primary warehouse this product belongs to. Retained '
                  'for legacy reads; new code should consult the '
                  '`warehouses` M2M below, which holds the full set of '
                  'warehouses a product is registered at.',
    )
    warehouses = models.ManyToManyField(
        'core.Warehouse',
        blank=True,
        related_name='products_registered',
        help_text='Every warehouse this product is registered at. A '
                  'Transfer auto-adds the destination warehouse here on '
                  'approve so the master stays current with zero manual '
                  'ticking. The single `warehouse` FK above stays in '
                  'sync with the first entry of this set for legacy '
                  'queries that still read the FK.',
    )
    godown = models.ForeignKey(
        'core.Godown',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='machinery_products',
        help_text='For MACHINERY products: specific godown',
    )
    division = models.ForeignKey(
        'MachineryDivision',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='products',
        help_text='For MACHINERY products: the Machinery Division this '
                  'product rolls up to.',
    )

    active_flag = models.BooleanField(default=True, db_index=True)

    # Many-to-many relationships
    preferred_vendors = models.ManyToManyField(
        'Vendor',
        blank=True,
        related_name='preferred_for_products',
        help_text="Preferred vendors for this product"
    )

    class Meta:
        db_table = 'master_product'
        ordering = ['sku_code']
        indexes = [
            models.Index(fields=['sku_code', 'is_active']),
            models.Index(fields=['product_type', 'active_flag']),
            models.Index(fields=['goods_sub_type']),
        ]

    def __str__(self):
        return f"{self.sku_code} - {self.product_name}"

    # ── Machinery compatibility shims ─────────────────────────────────
    # Machine spares now live here as MACHINERY products (the standalone
    # core.Machinery master is being retired). Purchase/production code that
    # historically read `machinery.machine_id` / `machinery.machine_name`
    # keeps working when its FK points at a Product instead of a Machinery.
    @property
    def machine_id(self):
        return self.sku_code

    @property
    def machine_name(self):
        return self.product_name

    @property
    def name(self):
        # Some readers use `.name` (matches core.Machinery having no `name`).
        return self.product_name


class ProductCustomerName(BaseModel):
    """A customer-specific trade name for a product.

    Different customers buy the same internal product under different brand
    names — e.g. "Sangamam - 40 KG" is printed as "SPIC SANGAMAM_40 Kg" on a
    Greenstar PO and something else on another customer's PO. Rather than
    one product_trade_name per product, this table lets a product carry many
    (customer, trade_name) pairs. The Customer-PO auto-extractor matches a PO
    line against these names so the correct product is filled even when the
    buyer prints their own brand.
    """

    product = models.ForeignKey(
        'Product', on_delete=models.CASCADE, related_name='customer_names',
    )
    customer = models.ForeignKey(
        'Customer', on_delete=models.CASCADE,
        related_name='product_trade_names', null=True, blank=True,
        help_text='The customer who buys this product under `trade_name`. '
                  'Blank = a generic alias usable for any customer.',
    )
    trade_name = models.CharField(
        max_length=255,
        help_text="The name this customer prints for the product on their PO.",
    )

    class Meta:
        db_table = 'master_product_customer_name'
        ordering = ['product', 'trade_name']
        indexes = [
            models.Index(fields=['trade_name']),
            models.Index(fields=['product', 'customer']),
        ]

    def __str__(self):
        return f"{self.trade_name} → {self.product_id}"


class SecondaryUOM(BaseModel):
    """Alternative units of measure for products."""

    product = models.ForeignKey(
        Product,
        on_delete=models.CASCADE,
        related_name='secondary_uoms'
    )
    to_uom = models.CharField(max_length=10, choices=Product.UOM_CHOICES)
    conversion_factor = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.0001'))]
    )
    specific_gravity_override = models.DecimalField(
        max_digits=8,
        decimal_places=4,
        null=True,
        blank=True
    )
    valid_from = models.DateField(null=True, blank=True)
    valid_to = models.DateField(null=True, blank=True)

    class Meta:
        db_table = 'master_secondary_uom'
        ordering = ['product', 'to_uom']
        unique_together = [['product', 'to_uom']]

    def __str__(self):
        return f"{self.product.sku_code} - {self.to_uom}"


class ServiceCatalogue(BaseModel):
    """Service catalog for job work and services."""

    DIRECTION_CHOICES = (
        ('INBOUND', 'Inbound'),
        ('OUTBOUND', 'Outbound'),
        ('BOTH', 'Inbound & Outbound'),
    )

    CATEGORY_CHOICES = (
        ('MAINTENANCE', 'Maintenance'),
        ('REPAIR', 'Repair'),
    )

    service_code = models.CharField(
        max_length=20,
        unique=True,
        db_index=True
    )
    name = models.CharField(max_length=255)
    category = models.CharField(max_length=20, choices=CATEGORY_CHOICES)
    direction = models.CharField(max_length=10, choices=DIRECTION_CHOICES)
    default_tds = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    default_tcs = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    description = models.TextField(blank=True, default='')
    active_flag = models.BooleanField(default=True, db_index=True)

    # ── Location (optional) ──────────────────────────────────────────
    # Mirrors Machinery's location fields so the front-end can render a
    # consistent "Location" section. Kept nullable so existing services
    # don't need backfill and so services that are global (e.g.
    # company-wide consulting) can leave them blank.
    company = models.ForeignKey(
        'core.Company',
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='services_offered',
    )
    warehouse = models.ForeignKey(
        'core.Warehouse',
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='services_provided_here',
    )
    godown = models.ForeignKey(
        'core.Godown',
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='services_provided_here',
    )
    division = models.CharField(
        max_length=100,
        blank=True,
        default='',
        help_text='Free-form division / department name.',
    )

    # Many-to-many relationship
    warehouse_availability = models.ManyToManyField(
        'core.Warehouse',
        related_name='available_services',
        blank=True
    )

    class Meta:
        db_table = 'master_service_catalogue'
        ordering = ['service_code']

    def __str__(self):
        return f"{self.service_code} - {self.name}"


class Vendor(BaseModel):
    """Vendor master data."""

    # Agreed shortlist — matches frontend/src/constants/purchaseTerms.js
    # so the vendor's saved payment_terms drops straight into the PO
    # payment-terms dropdown without a value-mapping layer. Legacy values
    # (NET_15 / NET_30 / CUSTOM) remain in the choices tuple so existing
    # vendors keep validating and their historical value stays editable.
    PAYMENT_TERM_CHOICES = (
        ('90 days', '90 days'),
        ('60 days', '60 days'),
        ('45 days', '45 days'),
        ('30 days', '30 days'),
        ('15 days', '15 days'),
        ('10 days', '10 days'),
        ('5 days', '5 days'),
        ('as agreed', 'As agreed'),
        # Legacy NET_15 / NET_30 / CUSTOM values were removed after the
        # 0045 data migration backfilled every existing vendor onto the
        # modern shortlist. The migration is a strict superset — no
        # data loss — so admin form validation is safe now.
    )

    # Vendor type choices. The legacy single 'MATERIAL' bucket was split per
    # user request into RAW_MATERIAL / PACKING_MATERIAL / EXPENSE so each
    # supplier role maps to its own default TDS section and purchase category.
    # A 0.x data migration rewrites existing 'MATERIAL' rows to 'RAW_MATERIAL';
    # the import serializer still ACCEPTS the old 'MATERIAL' string and aliases
    # it. If more roles are ever needed, extend this tuple AND the frontend
    # `vendor/new.jsx` dropdown AND VENDOR_TYPE_TDS_SECTION below.
    VENDOR_TYPE_CHOICES = (
        ('RAW_MATERIAL', 'Raw Material'),
        ('PACKING_MATERIAL', 'Packing Material'),
        ('EXPENSE', 'Expense'),
        # A transporter / freight vendor — the ONE canonical value (matches the
        # vendor-master UI and Tally import). Its on-account payments (no bill)
        # classify as Freight, not Purchase. Set via set_vendor_category
        # --category TRANSPORTER.
        ('TRANSPORTER', 'Transporter'),
        ('CONTRACTOR', 'Contractor'),
        # An individual we PAY but who isn't a trade supplier — a salaried
        # employee or a one-off payee on a bank statement (JEEVATHANGA,
        # MANIKANDAN...). Lets a salary/expense bank line record against a real
        # party instead of a fake vendor or a bare on-account dump; these are
        # booked as an Expense entry, not a goods bill.
        ('EMPLOYEE', 'Employee / Payee'),
    )

    # MSME registration category. Only MICRO and SMALL suppliers get the
    # MSMED Act §15 45-day payment protection — MEDIUM is deliberately
    # excluded, so the payment-term cap (see validate_msme_payment_terms)
    # keys off this, not a plain is_msme boolean.
    MSME_CATEGORY_CHOICES = (
        ('MICRO', 'Micro'),
        ('SMALL', 'Small'),
        ('MEDIUM', 'Medium'),
    )

    # GSTIN portal verification status (from the GST-portal lookup adapter).
    # Blank = never verified. CANCELLED / SUSPENDED only WARN (per decision),
    # they never block the save.
    GSTIN_PORTAL_STATUS_CHOICES = (
        ('ACTIVE', 'Active'),
        ('CANCELLED', 'Cancelled'),
        ('SUSPENDED', 'Suspended'),
        ('PROVISIONAL', 'Provisional'),
        ('INACTIVE', 'Inactive'),
    )

    # GST type — drives the per-vendor tax-rate fields below. Same
    # CGST+SGST / IGST split the rest of the ERP uses (see PriceList).
    GST_TYPE_CHOICES = (
        ('CGST_SGST', 'CGST + SGST (Intra-State)'),
        ('IGST',      'IGST (Inter-State)'),
    )

    vendor_code = models.CharField(
        max_length=20,
        unique=True,
        db_index=True
    )
    vendor_name = models.CharField(max_length=255, db_index=True)
    # JSONField (multi-select) for forward compatibility — the form
    # currently exposes a single-pick dropdown limited to
    # VENDOR_TYPE_CHOICES (MATERIAL / CONTRACTOR).
    vendor_type = models.JSONField(
        default=list,
        blank=True,
        help_text="One or more of: MATERIAL, CONTRACTOR.",
    )
    company = models.ForeignKey(
        'core.Company',
        on_delete=models.PROTECT,
        related_name='vendors'
    )
    # GSTIN — promoted to mandatory at the form level per user
    # request. We keep `null=True` at the DB layer so legacy rows
    # imported without a GSTIN remain valid; new rows enforce
    # presence via the serializer's `required=True`. Removing
    # null=True would force a backfill migration on every existing
    # GSTIN-less vendor, which we don't want.
    gstin = models.CharField(
        max_length=15,
        validators=[RegexValidator(
            regex=r'^(\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1})?$',
            message='Invalid GSTIN format'
        )],
        # Uniqueness is enforced PER COMPANY in the serializer (the same
        # vendor GSTIN can legitimately be registered under two of our
        # companies), NOT globally — mirroring Customer.gstin.
        db_index=True,
        blank=True,
        null=True,
        default=None,
    )
    # ── How this supplier is settled, as Tally's own books say ────────────
    #
    # `tally_bill_wise` mirrors ISBILLWISEON ("Maintain balances bill-by-bill")
    # on the matching Tally ledger. Yes -> a payment names the supplier invoice
    # it settles, so it can be attached to one bill. No -> the party is run on
    # account (farmers settled in cash, agents), and a payment settles the
    # RUNNING BALANCE, not a numbered document; attaching it to a bill would be
    # inventing a link the books don't make.
    #
    # NULL means "not known yet" — the vendor has never been matched to a Tally
    # ledger — and must never be read as False.
    #
    # It is stored rather than looked up per payment because the flag comes from
    # a 1,500-ledger export that takes ~40s through the connector.
    tally_bill_wise = models.BooleanField(
        null=True, blank=True, default=None,
        help_text="Tally's 'Maintain balances bill-by-bill' for this party. "
                  "True = payments settle a named invoice; False = on account; "
                  "NULL = never matched to a Tally ledger.")
    # This "vendor" is really the company's OWN branch / sister entity (e.g. the
    # Bangalore unit). Its bills are internal stock transfers, NOT purchases, so
    # they are excluded from purchase figures the same way DC/-prefixed transfer
    # challans are. See purchase.branch_transfer.
    is_branch = models.BooleanField(
        default=False, db_index=True,
        help_text="A branch / sister entity of the company — its bills are internal "
                  "transfers, excluded from purchase totals (like DC/ transfers).")
    # The Tally ledger this vendor resolved to, and how. Kept so the match is
    # auditable and so later runs don't re-derive it: ERP and Tally spell the
    # same firm differently ("Arun cans private limited - Unit I -Madu" is
    # Tally's "Arun Canns (P) Ltd - Madurai"), and 59 of 275 SS vendors match
    # only through their GSTIN.
    tally_ledger_name = models.CharField(
        max_length=255, blank=True, default='',
        help_text="Exact Tally ledger name this vendor maps to.")
    TALLY_MATCH_CHOICES = (('GSTIN', 'Matched on GSTIN'),
                           ('NAME', 'Matched on exact name'),
                           ('MANUAL', 'Set by hand'))
    tally_match_by = models.CharField(
        max_length=10, blank=True, default='', choices=TALLY_MATCH_CHOICES,
        help_text="How tally_ledger_name was resolved.")

    pan = models.CharField(
        max_length=10,
        validators=[RegexValidator(
            regex=r'^([A-Z]{5}[0-9]{4}[A-Z]{1})?$',
            message='Invalid PAN format'
        )],
        blank=True,
        default='',
    )
    # Vendor's GST registration type ("Taxpayer Type" on the GST portal /
    # Tally). Full choice set (mirrors Customer) so the Tally party import can
    # store any of them; the manual vendor form offers only the supplier-
    # relevant subset (VENDOR_GST_TREATMENT_OPTIONS on the frontend).
    GST_TREATMENT_CHOICES = (
        ('REGISTERED_REGULAR', 'Registered Business - Regular'),
        ('REGISTERED_COMPOSITION', 'Registered Business - Composition'),
        ('UNREGISTERED', 'Unregistered Business'),
        ('CONSUMER', 'Consumer'),
        ('OVERSEAS', 'Overseas'),
        ('SEZ', 'Special Economic Zone (SEZ)'),
        ('DEEMED_EXPORT', 'Deemed Export'),
    )
    gst_treatment = models.CharField(
        max_length=30,
        choices=GST_TREATMENT_CHOICES,
        blank=True,
        default='',
        help_text="Vendor's GST registration type (from Tally).",
    )
    address = models.JSONField(default=dict, blank=True)
    city = models.CharField(max_length=100, db_index=True, blank=True, default='')
    state = models.CharField(max_length=100, blank=True, default='')
    country = models.CharField(max_length=100, default='India')
    pincode = models.CharField(max_length=10, blank=True, default='')
    contact_person = models.CharField(max_length=255, blank=True, default='')
    contact_email = models.EmailField(blank=True, default='')
    contact_phone = models.CharField(max_length=20, blank=True, default='')
    payment_terms = models.CharField(
        max_length=20,
        choices=PAYMENT_TERM_CHOICES,
        default='30 days',
    )
    custom_payment_days = models.IntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(0)],
        help_text='Only used with the legacy CUSTOM value; new vendors '
                  'pick a specific day count from the payment_terms list.',
    )
    # GST type + per-rate fields. UI rule (enforced in
    # vendor/new.jsx + [id].jsx):
    #   • gst_type == 'CGST_SGST' → admin enters `gst` (combined %),
    #     the form auto-fills sgst_rate = cgst_rate = gst / 2.
    #   • gst_type == 'IGST'      → admin enters `igst_rate` only;
    #     sgst_rate / cgst_rate stay 0.
    # `freight_terms` lived here previously; removed per user
    # request (vendor freight is now driven from the PO / receipt
    # documents, not the master).
    gst_type = models.CharField(
        max_length=20,
        choices=GST_TYPE_CHOICES,
        blank=True,
        default='',
        help_text='CGST+SGST for intra-state, IGST for inter-state.',
    )
    gst = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0), MaxValueValidator(100)],
        help_text='Combined GST % for the CGST+SGST case (auto-split 50/50 into sgst_rate + cgst_rate).',
    )
    sgst_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        validators=[MinValueValidator(0), MaxValueValidator(100)],
    )
    cgst_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        validators=[MinValueValidator(0), MaxValueValidator(100)],
    )
    igst_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        validators=[MinValueValidator(0), MaxValueValidator(100)],
    )
    freight_split_notes = models.TextField(blank=True, default='')
    credit_limit = models.DecimalField(
        max_digits=15,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)]
    )
    credit_days = models.IntegerField(
        default=0,
        validators=[MinValueValidator(0)]
    )
    tds_rate = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    tcs_rate = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    # ── TDS engine inputs (Phase 1) — read by purchase/tds_engine.py ────
    # All default to a safe value so existing rows need no backfill; a one-time
    # tagging pass (recompute_tds / vendor edit) refines them.
    PAN_STATUS_CHOICES = (
        ('VALID', 'Valid'), ('INVALID', 'Invalid'),
        ('MISSING', 'Missing'), ('INOPERATIVE', 'Inoperative'),
    )
    pan_status = models.CharField(
        max_length=12, blank=True, default='', choices=PAN_STATUS_CHOICES,
        help_text="PAN validity for TDS. Blank = derive from the PAN field "
                  "(valid 10-char PAN -> VALID, else MISSING -> 20%/5% rate).")
    DEDUCTEE_CHOICES = (
        ('INDIVIDUAL_HUF', 'Individual / HUF'),
        ('COMPANY_FIRM_LLP', 'Company / Firm / LLP'),
    )
    deductee_category = models.CharField(
        max_length=20, blank=True, default='', choices=DEDUCTEE_CHOICES,
        help_text="Picks the TDS rate column. Blank -> treated as "
                  "Company/Firm/LLP (the common registered-supplier case).")
    is_resident = models.BooleanField(
        default=True,
        help_text="Resident (Sec 194 rates). Non-resident = Sec 195, not handled yet.")
    is_206ab_specified = models.BooleanField(
        default=False, db_index=True,
        help_text="Sec 206AB specified person (non-filer) -> higher TDS rate.")
    default_tds_section = models.ForeignKey(
        'master.TdsSection', null=True, blank=True, on_delete=models.SET_NULL,
        related_name='vendors',
        help_text="TDS section this vendor's bills usually fall under "
                  "(transporter -> 194C, goods supplier -> 194Q).")
    tds_exempt_194q = models.BooleanField(
        default=False, db_index=True,
        help_text="Skip 194Q for this vendor — a TCS seller (collects 206C(1H), "
                  "so the buyer does not deduct) or agri produce (exempt).")
    tds_exempt_reason = models.CharField(
        max_length=60, blank=True, default='',
        help_text="Why 194Q is skipped, e.g. 'TCS 206C(1H)' or 'Agri produce'.")

    # ── Duplicate guard ──────────────────────────────────────────────────
    # Normalised identity key (merge_utils.vkey of vendor_name): lowercase,
    # legal-suffix / punctuation / spacing stripped. Kept in a stored column so
    # a UNIQUE (company, vendor_name_key) constraint can hard-block duplicates
    # that differ only by case / spacing / 'Pvt Ltd' vs 'Private Limited'.
    # Recomputed on every save() from vendor_name. Blank keys are NOT unique-
    # constrained (handled via a conditional constraint) so a nameless legacy
    # row can't collide.
    vendor_name_key = models.CharField(
        max_length=255, blank=True, default='', db_index=True,
        help_text="Normalised vendor_name for duplicate detection (auto-filled).")

    # ── MSME (supplier is MSME-registered) ───────────────────────────────
    is_msme = models.BooleanField(
        default=False, db_index=True,
        help_text="Vendor is registered under MSMED Act (Udyam).")
    msme_category = models.CharField(
        max_length=10, blank=True, default='', choices=MSME_CATEGORY_CHOICES,
        help_text="Micro / Small / Medium. Only Micro & Small get the 45-day "
                  "payment protection (§15); Medium does not.")
    msme_udyam_no = models.CharField(
        max_length=30, blank=True, default='',
        help_text="Udyam / UAM registration number.")
    msme_certificate = models.FileField(
        upload_to='vendors/msme/%Y/%m/', blank=True, null=True,
        help_text="Udyam registration certificate.")
    # A written agreement with an MSME supplier is what lets the payment term
    # legally extend to 45 days; without it the cap is 15 days.
    has_written_agreement = models.BooleanField(
        default=False,
        help_text="A written supply agreement exists with this MSME vendor "
                  "(required to allow payment terms beyond 15 days, up to 45).")
    written_agreement_doc = models.FileField(
        upload_to='vendors/agreements/%Y/%m/', blank=True, null=True,
        help_text="Signed written agreement (required when has_written_agreement).")

    # ── GST compliance ───────────────────────────────────────────────────
    gstin_certificate = models.FileField(
        upload_to='vendors/gstin/%Y/%m/', blank=True, null=True,
        help_text="GST registration certificate (for registered vendors).")
    is_rcm = models.BooleanField(
        default=False, db_index=True,
        help_text="Reverse Charge Mechanism applies to this vendor's supplies.")

    # ── GSTIN portal verification (A5 adapter) ───────────────────────────
    gstin_verified_at = models.DateTimeField(
        null=True, blank=True,
        help_text="When the GSTIN was last verified against the GST portal.")
    gstin_portal_status = models.CharField(
        max_length=12, blank=True, default='', choices=GSTIN_PORTAL_STATUS_CHOICES,
        help_text="Taxpayer status returned by the GST portal. "
                  "CANCELLED/SUSPENDED warn but do not block.")
    gstin_snapshot = models.JSONField(
        default=dict, blank=True,
        help_text="Raw GST-portal response captured at verification time (audit).")

    active_flag = models.BooleanField(default=True, db_index=True)

    # Manual "Group" tag for the Ledger / Creditors category filter. The filter's
    # named buckets (RM / Packing / …) are auto-derived from each vendor's Tally
    # group, which depends on name-matching that often misses; this checkbox lets
    # a vendor be put in the catch-all "Group" bucket by hand, independent of that
    # matching. Default off.
    is_group = models.BooleanField(
        default=False, db_index=True,
        help_text="Show this vendor under the 'Group' filter on the Ledger "
                  "(Creditors) page.")

    # ── Also-a-customer link ─────────────────────────────────────────────
    # This supplier is ALSO a customer of ours (a party we both buy from and
    # sell to). Checking the box on the vendor form creates-or-matches a
    # Customer master in the same company and links both ways (see
    # master.party_linking.ensure_customer_for_vendor). Unchecking never
    # deletes the counterpart — it is a real record.
    is_also_customer = models.BooleanField(
        default=False, db_index=True,
        help_text="This party is also a customer — a linked Customer master exists.")
    linked_customer = models.ForeignKey(
        'master.Customer', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='+')

    # Many-to-many relationships
    preferred_transporters = models.ManyToManyField(
        'Transporter',
        related_name='preferred_by_vendors',
        blank=True
    )
    allowed_warehouses = models.ManyToManyField(
        'core.Warehouse',
        related_name='allowed_vendors',
        blank=True
    )

    class Meta:
        db_table = 'master_vendor'
        ordering = ['vendor_code']
        indexes = [
            models.Index(fields=['vendor_code', 'active_flag']),
            models.Index(fields=['company', 'active_flag']),
        ]
        constraints = [
            # Hard duplicate guard at the DB layer: no two ACTIVE vendors in the
            # same company may share a normalised name key. Partial (active +
            # non-blank key) so soft-deleted/merged namesakes and keyless legacy
            # rows don't collide. Backs up the serializer check against writes
            # that bypass it (admin, scripts, races). Existing duplicates were
            # merged before this landed (see 0066 migration note).
            models.UniqueConstraint(
                fields=['company', 'vendor_name_key'],
                condition=models.Q(is_active=True) & ~models.Q(vendor_name_key=''),
                name='uniq_active_vendor_name_key_per_company',
            ),
        ]

    def __str__(self):
        return f"{self.vendor_code} - {self.vendor_name}"

    # Re-verify a GSTIN after this many days — a status (CANCELLED/SUSPENDED)
    # can change after a stale "verified" snapshot, so the UI prompts a refresh.
    GSTIN_VERIFY_STALE_DAYS = 90

    @property
    def is_gstin_verified(self):
        """True once the GSTIN has been verified against the portal (a snapshot
        exists). A convenience marker so the UI/filters don't infer it from the
        timestamp. Independent of the resulting status — see gstin_status_ok."""
        return self.gstin_verified_at is not None

    @property
    def gstin_verification_stale(self):
        """True when a verified GSTIN is older than GSTIN_VERIFY_STALE_DAYS, so
        the status may have changed since. False when never verified (nothing to
        be stale) — call is_gstin_verified first."""
        if not self.gstin_verified_at:
            return False
        from django.utils import timezone
        from datetime import timedelta
        return timezone.now() - self.gstin_verified_at > timedelta(days=self.GSTIN_VERIFY_STALE_DAYS)

    @property
    def gstin_status_ok(self):
        """True only when verified AND the portal status is ACTIVE. CANCELLED /
        SUSPENDED verified vendors return False so callers can warn before
        transacting (the status never BLOCKS, per decision)."""
        return self.is_gstin_verified and self.gstin_portal_status == 'ACTIVE'

    def save(self, *args, **kwargs):
        if not self.vendor_code:
            self.vendor_code = self._generate_vendor_code()
        # Keep the normalised duplicate-guard key in step with the name. One
        # definition (merge_utils.vkey) shared with vendor_audit and the Tally/
        # Zoho importers, so a pair that reads as the same vendor there cannot
        # read as two here.
        self.vendor_name_key = vkey(self.vendor_name)
        # Derive PAN from the GSTIN (PAN is embedded as chars 3–12) when PAN is
        # blank, so it's filled automatically wherever a GSTIN is present.
        if self.gstin and not (self.pan or '').strip():
            derived = pan_from_gstin(self.gstin)
            if derived:
                self.pan = derived
        # A "vendor" that carries our OWN company's PAN IS the same legal entity —
        # you cannot purchase from yourself, so its bills are internal stock /
        # warehouse moves, never a purchase. Match on PAN (not the full GSTIN): one
        # company shares a single PAN across every state registration, so a sister
        # UNIT in another state — same PAN, different state GSTIN, e.g. the Bangalore
        # "- Blre" unit — is caught too, which a GSTIN match would miss. Auto-flag
        # is_branch so branch_transfer_q()/classification keep those bills OUT of RM/
        # Packing/purchase totals (what let the Neem-Husk TVP move land in RM). Exact
        # + data-driven (PANs identical; PAN is derived from the GSTIN just above),
        # no hard-coded names; only ever SETS the flag (never clears a hand-set one).
        if not self.is_branch and self.company_id and (self.pan or '').strip():
            comp_pan = (getattr(self.company, 'pan', '') or '').strip()
            if comp_pan and self.pan.strip().upper() == comp_pan.upper():
                self.is_branch = True
        # Auto-flag MSME: a vendor carrying a Udyam registration number OR an MSME
        # category IS an MSME supplier, so set is_msme — the §15 / 43B(h) payable
        # deviation picks it up without a separate tick. Only ever SETS the flag
        # (never clears a hand-set one). The payable tile needs MICRO/SMALL, so the
        # category still drives whether a 15/45-day limit applies.
        if (self.msme_udyam_no or '').strip() or (self.msme_category or '').strip():
            self.is_msme = True
        super().save(*args, **kwargs)

    def _generate_vendor_code(self):
        """Auto vendor code: <COMPANY_CODE>-VEN-### with a per-company sequence
        that continues from the highest number already used for the SAME
        company (company_code is unique, so the prefix scopes it)."""
        # Use the company's alphabetic prefix only, to match the existing codes
        # (company_code "SSB-002" → "SSB", so vendors read SSB-VEN-###).
        cc = (getattr(self.company, 'company_code', '') or 'GEN').strip().upper().split('-')[0]
        prefix = f'{cc}-VEN-'
        nums = []
        for code in (Vendor.objects
                     .filter(vendor_code__startswith=prefix)
                     .values_list('vendor_code', flat=True)):
            try:
                nums.append(int(str(code).rsplit('-', 1)[-1]))
            except (ValueError, TypeError):
                continue
        return f'{prefix}{(max(nums) + 1) if nums else 1:03d}'


class VendorBankDetail(BaseModel):
    """Bank account details for vendors."""

    vendor = models.ForeignKey(
        Vendor,
        on_delete=models.CASCADE,
        related_name='bank_details'
    )
    account_holder_name = models.CharField(max_length=255, blank=True, default='')
    account_number = models.CharField(max_length=20, blank=True, default='')
    ifsc_code = models.CharField(
        max_length=11,
        validators=[RegexValidator(
            regex=r'^([A-Z]{4}0[A-Z0-9]{6})?$',
            message='Invalid IFSC code'
        )],
        blank=True,
        default='',
    )
    bank_name = models.CharField(max_length=255, blank=True, default='')
    branch_name = models.CharField(max_length=255, blank=True, default='')
    is_primary = models.BooleanField(default=False)

    class Meta:
        db_table = 'master_vendor_bank_detail'
        ordering = ['vendor', 'is_primary']

    def __str__(self):
        return f"{self.vendor.vendor_code} - {self.bank_name}"


class Customer(BaseModel):
    """Customer master data."""

    CREDIT_TERM_CHOICES = (
        ('CASH', 'Cash'),
        ('NET_15', 'Net 15'),
        ('NET_30', 'Net 30'),
        ('NET_45', 'Net 45'),
        ('NET_60', 'Net 60'),
        ('CUSTOM', 'Custom Days'),
    )

    FREIGHT_TERM_CHOICES = (
        ('PAID', 'Freight Paid'),
        ('TO_COLLECT', 'Freight To Collect'),
        ('MIXED', 'Mixed'),
    )

    # GST registration type of the customer — mirrors Tally / Zoho "GST
    # Treatment". Drives how tax is applied on their invoices.
    GST_TREATMENT_CHOICES = (
        ('REGISTERED_REGULAR', 'Registered Business - Regular'),
        ('REGISTERED_COMPOSITION', 'Registered Business - Composition'),
        ('UNREGISTERED', 'Unregistered Business'),
        ('CONSUMER', 'Consumer'),
        ('OVERSEAS', 'Overseas'),
        ('SEZ', 'Special Economic Zone (SEZ)'),
        ('DEEMED_EXPORT', 'Deemed Export'),
    )

    customer_code = models.CharField(
        max_length=20,
        unique=True,
        db_index=True
    )
    customer_name = models.CharField(max_length=255, db_index=True)
    company = models.ForeignKey(
        'core.Company',
        on_delete=models.PROTECT,
        related_name='customers'
    )
    gstin = models.CharField(
        max_length=15,
        validators=[RegexValidator(
            regex=r'^(\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1})?$',
            message='Invalid GSTIN format'
        )],
        # Uniqueness is enforced PER COMPANY in the serializer (a customer
        # billed under two of our companies legitimately shares one GSTIN),
        # not globally — mirroring the (company, customer_name) rule.
        db_index=True,
        blank=True,
        null=True,
        default=None,
    )
    pan = models.CharField(
        max_length=10,
        validators=[RegexValidator(
            regex=r'^([A-Z]{5}[0-9]{4}[A-Z]{1})?$',
            message='Invalid PAN format'
        )],
        blank=True,
        default='',
    )
    gst_treatment = models.CharField(
        max_length=30,
        choices=GST_TREATMENT_CHOICES,
        blank=True,
        default='',
        help_text="Customer's GST registration type (drives tax treatment on invoices).",
    )
    # Which Tally GROUP this party's ledger sits in, verbatim from Tally's
    # ledger master. Filled by the sales import; blank means we have never
    # seen the party in Tally and it is treated as an ordinary debtor.
    #
    # It exists because some parties are BOTH customer and supplier. Tally
    # keeps ONE ledger each and files them under Sundry Creditors, so its
    # Sundry Debtors closing excludes them entirely while the ERP's sales
    # module still holds the sale. SS Biochem has six such parties and United
    # Agro three; between them they put Rs 93,48,590 into Outstanding that
    # Tally's debtors figure has never contained.
    #
    # Knowing the group used to mean asking Tally live, which is what
    # `settle_creditor_sales` did on every run — and that command is retired
    # because it wrote set-offs sized to the whole sale rather than to what
    # the party actually still owed. Storing the group lets the dashboard make
    # the same split Tally does, from data, for parties nobody has listed by
    # hand and for ones that appear in future.
    tally_group = models.CharField(
        max_length=120, blank=True, default='', db_index=True,
        help_text="Tally group holding this party's ledger, e.g. 'Sundry "
                  "Creditors'. Blank = treat as an ordinary Sundry Debtor.")
    billing_address = models.JSONField(default=dict, blank=True)
    credit_terms = models.CharField(
        max_length=20,
        choices=CREDIT_TERM_CHOICES,
        default='NET_30'
    )
    custom_credit_days = models.IntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(0)]
    )
    credit_terms_effective_from = models.DateField(
        null=True, blank=True, db_index=True,
        help_text="The date these credit terms start applying. Invoices dated "
                  "on or after it take their due date from the terms above; "
                  "earlier invoices keep whatever they already had. BLANK "
                  "MEANS THE TERMS ARE NOT IN FORCE at all — see "
                  "master.credit_terms.credit_days_for for why that matters.",
    )
    # `freight_terms` and `default_warehouse` were removed from the
    # Customer master per user request — freight is captured per-PO /
    # per-SO now (Sales Order's `freight_terms` is the source of truth),
    # and the default-warehouse picker was unused in practice (every
    # SO already explicitly picks a warehouse). The FREIGHT_TERM_CHOICES
    # class constant is intentionally retained because PriceList still
    # references it for `default_freight_terms`.
    freight_split_notes = models.TextField(blank=True, default='')
    contact_person = models.CharField(max_length=255, blank=True, default='')
    contact_email = models.EmailField(blank=True, default='')
    contact_phone = models.CharField(max_length=20, blank=True, default='')
    active_flag = models.BooleanField(default=True, db_index=True)

    # ── Export customer ──────────────────────────────────────────────────
    # Set manually on the customer master. ON = export customer (overseas /
    # out-of-India place of supply); OFF (default) = domestic. GSTIN presence
    # is NOT used to infer this — many domestic farmers / small buyers have no
    # GSTIN yet are plainly domestic. Drives the Domestic / Export filter in
    # Sales Analytics > Customer Details.
    is_export = models.BooleanField(
        default=False, db_index=True,
        help_text="Export customer (overseas / out-of-India). Off = domestic. "
                  "Kept in sync with customer_type == 'EXPORT'.")

    # Customer classification shown as a single dropdown on the master (replaces
    # the old Export-only checkbox): Direct (domestic, default), Export, or
    # Maize. Drives the Debtors category filter on the Ledger page. is_export is
    # derived from this in save() so existing export logic keeps working.
    CUSTOMER_TYPE_CHOICES = (
        ('DIRECT', 'Direct Customer'),
        ('EXPORT', 'Export Customer'),
        ('MAIZE', 'Maize'),
    )
    customer_type = models.CharField(
        max_length=10, choices=CUSTOMER_TYPE_CHOICES, default='DIRECT', db_index=True,
        help_text="Direct (domestic) / Export (overseas) / Maize.")

    # ── Also-a-vendor link ───────────────────────────────────────────────
    # This customer is ALSO a vendor of ours. Checking the box on the
    # customer form creates-or-matches a Vendor master in the same company
    # and links both ways (see master.party_linking.ensure_vendor_for_customer).
    # Unchecking never deletes the counterpart — it is a real record.
    is_also_vendor = models.BooleanField(
        default=False, db_index=True,
        help_text="This party is also a vendor — a linked Vendor master exists.")
    linked_vendor = models.ForeignKey(
        'master.Vendor', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='+')
    # Exception flow: when set, this customer's Create-SO screen offers the
    # multi-PO line picker (club selected lines from several POs into one SO).
    # Off for everyone else, so the normal 1-PO -> 1-SO flow is untouched.
    allow_multi_po_consolidation = models.BooleanField(default=False)

    # Many-to-many relationships
    allowed_price_lists = models.ManyToManyField(
        'PriceList',
        related_name='customers',
        blank=True
    )
    overdue_notification_recipients = models.ManyToManyField(
        'core.StakeholderUser',
        related_name='customer_notifications',
        blank=True
    )

    class Meta:
        db_table = 'master_customer'
        ordering = ['customer_code']
        indexes = [
            models.Index(fields=['customer_code', 'active_flag']),
            models.Index(fields=['company', 'active_flag']),
        ]

    def __str__(self):
        return f"{self.customer_code} - {self.customer_name}"

    def save(self, *args, **kwargs):
        if not self.customer_code:
            self.customer_code = self._generate_customer_code()
        # Keep the legacy is_export boolean in lock-step with customer_type, so
        # the Sales-Analytics export filter and GST logic that read is_export
        # stay correct while the master exposes the richer dropdown. A save with
        # update_fields that touches customer_type must also write is_export.
        self.is_export = (self.customer_type == 'EXPORT')
        uf = kwargs.get('update_fields')
        if uf is not None and 'customer_type' in uf and 'is_export' not in uf:
            kwargs['update_fields'] = list(uf) + ['is_export']
        # Derive PAN from the GSTIN (embedded as chars 3–12) when PAN is blank.
        if self.gstin and not (self.pan or '').strip():
            derived = pan_from_gstin(self.gstin)
            if derived:
                self.pan = derived
        super().save(*args, **kwargs)

    def _generate_customer_code(self):
        """Auto customer code: simple global CUS-### sequence continuing from
        the highest existing number."""
        prefix = 'CUS-'
        nums = []
        for code in (Customer.objects
                     .filter(customer_code__startswith=prefix)
                     .values_list('customer_code', flat=True)):
            try:
                nums.append(int(str(code).rsplit('-', 1)[-1]))
            except (ValueError, TypeError):
                continue
        return f'{prefix}{(max(nums) + 1) if nums else 1:03d}'


class ShippingAddress(BaseModel):
    """Shipping addresses for customers."""

    customer = models.ForeignKey(
        Customer,
        on_delete=models.CASCADE,
        related_name='shipping_addresses'
    )
    address_label = models.CharField(max_length=100, blank=True, default='')
    address = models.JSONField(default=dict, blank=True)
    delivery_region = models.CharField(max_length=100, blank=True, default='')
    default_price_list = models.ForeignKey(
        'PriceList',
        on_delete=models.SET_NULL,
        null=True,
        blank=True
    )
    contact_person = models.CharField(max_length=255, blank=True, default='')
    contact_phone = models.CharField(max_length=20, blank=True, default='')

    class Meta:
        db_table = 'master_shipping_address'
        ordering = ['customer', 'address_label']

    def __str__(self):
        return f"{self.customer.customer_code} - {self.address_label}"


class Transporter(BaseModel):
    """Logistics transporter master data."""

    RATING_CHOICES = (
        (1, '1 - Poor'),
        (2, '2 - Fair'),
        (3, '3 - Good'),
        (4, '4 - Very Good'),
        (5, '5 - Excellent'),
    )

    transporter_code = models.CharField(
        max_length=20,
        unique=True,
        db_index=True
    )
    # Company this transporter belongs to. Nullable for legacy shared records
    # (created before this field); the Zoho import sets it per-company.
    company = models.ForeignKey(
        'core.Company', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='transporters', db_index=True,
    )
    name = models.CharField(max_length=255)
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
    )
    contact_person = models.CharField(max_length=255, blank=True, default='')
    contact_email = models.EmailField(blank=True, default='')
    contact_phone = models.CharField(max_length=20, blank=True, default='')
    # Beneficiary bank details — saved per transporter and reused when paying
    # them via freight (auto-filled on the freight form, editable per freight).
    bank_name = models.CharField(max_length=255, blank=True, default='')
    ifsc_code = models.CharField(max_length=20, blank=True, default='')
    beneficiary_name = models.CharField(max_length=255, blank=True, default='')
    account_no = models.CharField(max_length=50, blank=True, default='')
    # Removed per user request: freight_modes, coverage_routes,
    # tds_rate, payment_terms, rating. None of these were being read
    # by any downstream module — the Transporter master is now scoped
    # to identity + contact only. The RATING_CHOICES class constant
    # above is kept intentionally to avoid breaking any in-flight
    # migrations that reference it; safe to drop in a future cleanup.

    # ── Tax / compliance (freight, road-only shipper) ──────────────────
    # These feed the freight tax engine in purchase/freight_rules.py. The
    # model only STORES the inputs; every rule (RCM / TDS / MSME / FCM) is
    # computed by that tested module, never duplicated here.

    # Constitution — drives §194C rate (1% individual/HUF vs 2% company/firm).
    CONSTITUTION_CHOICES = (
        ('INDIVIDUAL', 'Individual / HUF'),
        ('COMPANY', 'Company / Firm / AOP'),
    )
    constitution = models.CharField(
        max_length=12, blank=True, default='', choices=CONSTITUTION_CHOICES,
        help_text='Individual/HUF → 194C 1%; Company/Firm → 2%.')
    pan = models.CharField(
        max_length=10, blank=True, default='',
        help_text='PAN — absence forces §206AA 20% TDS.')
    # §194C(6): a goods-transport operator owning ≤10 carriages who furnishes
    # PAN + a declaration is fully TDS-exempt.
    owns_10_or_fewer_carriages = models.BooleanField(default=False)
    has_194c_declaration = models.BooleanField(
        default=False,
        help_text='Valid §194C(6) small-carrier declaration on file.')

    # GTA / RCM. A GTA issuing a consignment note is RCM-eligible; a GTA that
    # filed Annexure V for an FY charges forward (FCM) instead.
    is_gta = models.BooleanField(
        default=True, help_text='Goods Transport Agency (issues consignment notes).')
    gst_registered = models.BooleanField(
        default=True, help_text='GST-registered — an unregistered GTA under RCM '
                                'needs a self-invoice (§31(3)(f)).')
    annexure_v_opted_fy = models.CharField(
        max_length=7, blank=True, default='',
        help_text="FY (e.g. '2026-27') the GTA opted for forward charge via "
                  "Annexure V. Blank = reverse charge (RCM).")
    FCM_SLAB_CHOICES = (('5', '5% (no ITC to GTA)'), ('12', '12% (with ITC)'))
    fcm_slab = models.CharField(
        max_length=2, blank=True, default='', choices=FCM_SLAB_CHOICES,
        help_text='Forward-charge slab when Annexure V opted.')

    # ── MSME (transporter is MSME-registered under Udyam) ──────────────
    # Mirrors Vendor's MSME block: only MICRO/SMALL get §15 45-day protection.
    MSME_CATEGORY_CHOICES = (
        ('MICRO', 'Micro'),
        ('SMALL', 'Small'),
        ('MEDIUM', 'Medium'),
    )
    is_msme = models.BooleanField(
        default=False, help_text='Registered under MSMED Act (Udyam).')
    msme_category = models.CharField(
        max_length=10, blank=True, default='', choices=MSME_CATEGORY_CHOICES,
        help_text='Micro/Small get §15 45-day protection; Medium does not.')
    msme_udyam_no = models.CharField(max_length=25, blank=True, default='')
    has_msme_agreement = models.BooleanField(
        default=False,
        help_text='Written supply agreement — allows 45-day terms; without it 15.')

    active_flag = models.BooleanField(default=True, db_index=True)

    class Meta:
        db_table = 'master_transporter'
        ordering = ['transporter_code']

    def save(self, *args, **kwargs):
        # Auto-flag MSME when a Udyam number or category is present — mirrors
        # Vendor.save (master/models.py ~945). The category still governs
        # whether the 15/45-day cap applies.
        if (self.msme_udyam_no or '').strip() or (self.msme_category or '').strip():
            self.is_msme = True
        if self.pan:
            self.pan = self.pan.upper().strip()
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.transporter_code} - {self.name}"


class StateGroup(BaseModel):
    """Named grouping of Indian states used for state-wise pricing.

    Some customers (e.g. UAI) publish one price list whose rates vary by
    region — see "Tamilnadu, Pondicherry & Karnataka" vs. "South States"
    in the UAI Price Details sheet. Modelling each cluster as a row here
    keeps PriceLine simple (a single FK) while letting an admin maintain
    the membership list once and reuse it across customers.

    `member_states` stores ISO 3166-2:IN style codes (TN, KA, PY, KL, MH,
    UP, …). We keep it as JSONField rather than a M2M table so the
    membership can be edited inline from a single dropdown on the price
    line form, and so the resolver can do a single contains lookup.

    `region` is purely cosmetic — drives the "South" / "North" section
    header on the price-list print template. The resolver doesn't use
    it.
    """

    REGION_CHOICES = [
        ('SOUTH',     'South'),
        ('NORTH',     'North'),
        ('EAST',      'East'),
        ('WEST',      'West'),
        ('NORTHEAST', 'North-East'),
        ('CENTRAL',   'Central'),
        ('PAN_INDIA', 'Pan India'),
    ]

    name = models.CharField(
        max_length=200,
        unique=True,
        db_index=True,
        help_text='Display label, e.g. "Tamilnadu, Pondicherry & Karnataka".',
    )
    member_states = models.JSONField(
        default=list,
        help_text='List of ISO 3166-2:IN state codes (e.g. ["TN", "PY", "KA"]).',
    )
    region = models.CharField(
        max_length=20,
        choices=REGION_CHOICES,
        blank=True,
        default='',
        help_text='Cosmetic grouping for print sections. Resolver ignores this.',
    )
    notes = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'master_state_group'
        ordering = ['name']

    def __str__(self):
        return self.name

    @property
    def specificity(self):
        """Number of member states. Used by the resolver to prefer the
        more specific group when multiple groups contain the buyer's
        state (e.g. "TN+PY+KA" wins over "South States")."""
        return len(self.member_states or [])


class PriceList(BaseModel):
    """Price list master."""

    STATUS_CHOICES = (
        ('DRAFT', 'Draft'),
        ('ACTIVE', 'Active'),
        ('ARCHIVED', 'Archived'),
    )

    price_list_id = models.CharField(
        max_length=30,
        unique=True,
        db_index=True
    )
    company = models.ForeignKey(
        'core.Company',
        on_delete=models.PROTECT,
        related_name='price_lists'
    )
    customer = models.ForeignKey(
        Customer,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='price_lists'
    )
    delivery_region = models.CharField(max_length=100, blank=True, default='')
    currency = models.CharField(max_length=10, default='INR')
    effective_from = models.DateField(null=True, blank=True)
    effective_to = models.DateField(null=True, blank=True)
    default_freight_terms = models.CharField(
        max_length=20,
        choices=Customer.FREIGHT_TERM_CHOICES,
        blank=True,
        default=''
    )
    payment_terms = models.CharField(max_length=50, blank=True, default='')
    delivery_terms = models.CharField(max_length=50, blank=True, default='')
    gst_type = models.CharField(max_length=20, blank=True, default='', help_text='CGST_SGST or IGST')
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='DRAFT',
        db_index=True
    )
    notes = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'master_price_list'
        ordering = ['-effective_from', 'price_list_id']
        indexes = [
            models.Index(fields=['price_list_id', 'status']),
            models.Index(fields=['company', 'status']),
        ]

    def __str__(self):
        return f"{self.price_list_id} - {self.status}"


class PriceLine(BaseModel):
    """Individual price lines in a price list."""

    price_list = models.ForeignKey(
        PriceList,
        on_delete=models.CASCADE,
        related_name='price_lines'
    )
    product = models.ForeignKey(
        Product,
        on_delete=models.PROTECT,
        related_name='price_lines'
    )
    uom = models.CharField(max_length=10, choices=Product.UOM_CHOICES)
    # Customer-specific brand / trade name override.
    #
    # Same chemical, multiple buyers, different brands: Azadirachtin
    # 0.03% may be sold to Customer A as "Nimbecidine 0.03 %" and to
    # Customer B as "Neem Gold 0.03 %". Rather than duplicating the
    # Product master per brand, we keep ONE internal Product row and
    # let each customer's price list carry the brand name they buy
    # under. Falls back to product.product_trade_name (and then
    # product_name) on invoice templates / dispatch challans when this
    # is blank.
    customer_trade_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        help_text="Customer-specific brand name for this product. "
                  "Blank = use the master product_trade_name / product_name.",
    )
    rate = models.DecimalField(
        max_digits=15,
        decimal_places=2,
        validators=[MinValueValidator(Decimal('0.01'))]
    )
    discount = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    gst = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    sgst_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    cgst_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    igst_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    freight_component = models.DecimalField(
        max_digits=15,
        decimal_places=2,
        null=True,
        blank=True,
        validators=[MinValueValidator(0)]
    )
    valid_from = models.DateField(null=True, blank=True)
    valid_to = models.DateField(null=True, blank=True)
    # State-wise pricing. NULL state_group = the customer-wide default
    # rate that's used when (a) the buyer's state isn't covered by any
    # group on this price list, or (b) the price list isn't state-aware
    # at all. The CPO→SO resolver prefers a state-specific line and
    # only falls through to the default when nothing matches.
    state_group = models.ForeignKey(
        StateGroup,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='price_lines',
        help_text='Region this rate applies to. Leave blank for the default rate.',
    )
    # Per-line packing label. Free text so composite values like
    # "20 KG & 40 KG" round-trip cleanly. Same (product, state) can
    # appear multiple times with different packings.
    packing = models.CharField(
        max_length=50,
        blank=True,
        default='',
        help_text='Pack size, e.g. "20 KG", "40 KG", "20 KG & 40 KG".',
    )
    # HSN/SAC classification for the priced product. Kept on the price
    # line (not the Product master) so it rides the same import/export
    # sheet the sales team maintains. Blank = not recorded.
    hsn_code = models.CharField(
        max_length=20,
        blank=True,
        default='',
        help_text='HSN/SAC code. Leave blank if not known.',
    )

    class Meta:
        db_table = 'master_price_line'
        ordering = ['price_list', 'product', 'state_group', 'packing']
        # The same (price_list, product, state_group, packing) cannot
        # be priced twice. Two rows that differ ONLY in packing (or
        # state_group) are intentional — that's the whole point of
        # state-wise / packing-wise pricing.
        unique_together = [['price_list', 'product', 'uom', 'state_group', 'packing']]
        indexes = [
            models.Index(fields=['price_list', 'product']),
            models.Index(fields=['price_list', 'product', 'state_group']),
        ]

    def __str__(self):
        return f"{self.price_list.price_list_id} - {self.product.sku_code}"


class TaxMaster(BaseModel):
    """Tax configuration master."""

    TAX_TYPE_CHOICES = (
        ('GST', 'Goods & Services Tax'),
        ('TDS', 'Tax Deducted at Source'),
        ('TCS', 'Tax Collected at Source'),
    )

    tax_type = models.CharField(max_length=10, choices=TAX_TYPE_CHOICES, db_index=True)
    section_reference = models.CharField(max_length=50, blank=True, default='')
    rate = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    effective_from = models.DateField(null=True, blank=True)
    effective_to = models.DateField(null=True, blank=True)
    applicable_on = models.JSONField(
        default=list,
        blank=True,
        help_text="Product categories, service types, or transaction types"
    )
    threshold_amount = models.DecimalField(
        max_digits=15,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Minimum transaction amount for applicability"
    )
    company_scope = models.ForeignKey(
        'core.Company',
        on_delete=models.CASCADE,
        related_name='tax_masters'
    )
    notes = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'master_tax_master'
        ordering = ['tax_type', '-effective_from']
        indexes = [
            models.Index(fields=['tax_type', 'effective_from']),
            models.Index(fields=['company_scope']),
        ]

    def __str__(self):
        return f"{self.tax_type} - {self.rate}% - {self.section_reference}"


class TemplateLibrary(BaseModel):
    """Document templates for reports and documents."""

    TEMPLATE_TYPE_CHOICES = (
        ('PRODUCTION', 'Production Template'),
        ('QC_REPORT', 'QC Report Template'),
        ('JOB_WORK', 'Job Work Template'),
        ('PACKING', 'Packing Template'),
        ('INVOICE', 'Invoice Template'),
    )

    STATUS_CHOICES = (
        ('DRAFT', 'Draft'),
        ('ACTIVE', 'Active'),
        ('RETIRED', 'Retired'),
    )

    template_id = models.CharField(
        max_length=30,
        unique=True,
        db_index=True
    )
    template_type = models.CharField(
        max_length=20,
        choices=TEMPLATE_TYPE_CHOICES,
        db_index=True
    )
    name = models.CharField(max_length=255)
    revision_no = models.IntegerField(default=1)
    effective_from = models.DateField(null=True, blank=True)
    effective_to = models.DateField(null=True, blank=True)
    layout_json = models.JSONField(
        default=dict,
        blank=True,
        help_text="Template layout and field configuration"
    )
    requires_digital_signature = models.BooleanField(default=False)
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='DRAFT',
        db_index=True
    )

    # Many-to-many relationship
    warehouse_scope = models.ManyToManyField(
        'core.Warehouse',
        related_name='templates',
        blank=True,
        help_text="Warehouses where this template is applicable"
    )

    class Meta:
        db_table = 'master_template_library'
        ordering = ['template_type', '-revision_no']
        indexes = [
            models.Index(fields=['template_id', 'status']),
            models.Index(fields=['template_type', 'status']),
        ]

    def __str__(self):
        return f"{self.template_id} v{self.revision_no} - {self.name}"


class TemplateApprovalLog(BaseModel):
    """Approval and version history for templates."""

    APPROVAL_STATUS_CHOICES = (
        ('PENDING', 'Pending Approval'),
        ('APPROVED', 'Approved'),
        ('REJECTED', 'Rejected'),
    )

    template = models.ForeignKey(
        TemplateLibrary,
        on_delete=models.CASCADE,
        related_name='approval_logs'
    )
    approved_by = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='template_approvals'
    )
    approval_status = models.CharField(
        max_length=20,
        choices=APPROVAL_STATUS_CHOICES,
        default='PENDING'
    )
    approval_date = models.DateTimeField(null=True, blank=True)
    comments = models.TextField(blank=True, default='')
    change_summary = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'master_template_approval_log'
        ordering = ['template', '-created_at']

    def __str__(self):
        return f"{self.template.template_id} - {self.approval_status}"


class Broker(BaseModel):
    """Broker / agent master — purchase brokers, sales brokers, freight
    agents, commission agents etc. The broker can later be linked to
    Purchase Requests, RFQs, POs and Bills to track commission payable.
    """

    BROKER_TYPE_CHOICES = (
        ('PURCHASE',   'Purchase Broker'),
        ('SALES',      'Sales Broker'),
        ('FREIGHT',    'Freight Broker'),
        ('EXPORT',     'Export Agent'),
        ('IMPORT',     'Import Agent'),
        ('COMMISSION', 'Commission Agent'),
    )

    COMMISSION_TYPE_CHOICES = (
        ('PERCENTAGE', 'Percentage'),
        ('FIXED',      'Fixed Amount'),
    )

    STATUS_CHOICES = (
        ('ACTIVE', 'Active'),
        ('INACTIVE', 'Inactive'),
    )

    # ── Basic ────────────────────────────────────────────────────────
    broker_code = models.CharField(
        max_length=30,
        unique=True,
        db_index=True,
        editable=False,
        help_text='Auto-generated identifier (BRK-YYYY-NNNN).',
    )
    broker_name = models.CharField(max_length=200, db_index=True)
    broker_type = models.CharField(
        max_length=20,
        choices=BROKER_TYPE_CHOICES,
        default='PURCHASE',
        db_index=True,
    )
    contact_person = models.CharField(max_length=150, blank=True, default='')
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='ACTIVE',
        db_index=True,
    )

    # ── Contact ──────────────────────────────────────────────────────
    mobile_number = models.CharField(max_length=20, blank=True, default='')
    alternate_mobile = models.CharField(max_length=20, blank=True, default='')
    whatsapp_number = models.CharField(max_length=20, blank=True, default='')
    email = models.EmailField(blank=True, default='')
    website = models.URLField(blank=True, default='')

    # ── Address ──────────────────────────────────────────────────────
    address_line1 = models.CharField(max_length=255, blank=True, default='')
    address_line2 = models.CharField(max_length=255, blank=True, default='')
    city = models.CharField(max_length=100, blank=True, default='')
    state = models.CharField(max_length=100, blank=True, default='')
    country = models.CharField(max_length=100, blank=True, default='India')
    pincode = models.CharField(max_length=10, blank=True, default='')

    # ── Commission ───────────────────────────────────────────────────
    commission_type = models.CharField(
        max_length=20,
        choices=COMMISSION_TYPE_CHOICES,
        default='PERCENTAGE',
    )
    commission_value = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        default=Decimal('0.00'),
        validators=[MinValueValidator(Decimal('0.00'))],
        help_text='%% when commission_type=PERCENTAGE, ₹ when FIXED.',
    )
    gst_applicable = models.BooleanField(default=False)
    gst_number = models.CharField(max_length=15, blank=True, default='')
    pan_number = models.CharField(max_length=10, blank=True, default='')
    tds_applicable = models.BooleanField(default=False)

    # ── Banking ──────────────────────────────────────────────────────
    bank_account_holder = models.CharField(max_length=150, blank=True, default='')
    bank_name = models.CharField(max_length=150, blank=True, default='')
    bank_account_number = models.CharField(max_length=30, blank=True, default='')
    bank_ifsc_code = models.CharField(max_length=15, blank=True, default='')
    bank_branch_name = models.CharField(max_length=150, blank=True, default='')
    upi_id = models.CharField(max_length=100, blank=True, default='')

    # ── Business linkage ─────────────────────────────────────────────
    preferred_vendors = models.ManyToManyField(
        'master.Vendor',
        blank=True,
        related_name='brokers',
        help_text='Vendors this broker typically deals with.',
    )
    preferred_categories = models.CharField(
        max_length=300, blank=True, default='',
        help_text='Goods sub-type codes the broker handles, comma-separated.',
    )
    assigned_purchase_manager = models.ForeignKey(
        'core.StakeholderUser',
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='brokers_assigned',
    )
    operating_regions = models.CharField(
        max_length=300, blank=True, default='',
        help_text='States / cities the broker covers, comma-separated.',
    )

    # ── Attachments ──────────────────────────────────────────────────
    gst_certificate = models.FileField(upload_to='brokers/gst/', blank=True, null=True)
    pan_copy = models.FileField(upload_to='brokers/pan/', blank=True, null=True)
    agreement = models.FileField(upload_to='brokers/agreement/', blank=True, null=True)

    # ── Notes ────────────────────────────────────────────────────────
    remarks = models.TextField(blank=True, default='')
    internal_notes = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'master_broker'
        ordering = ['broker_name']
        indexes = [
            models.Index(fields=['broker_type', 'status']),
        ]

    def __str__(self):
        return f"{self.broker_code} — {self.broker_name}"

    def save(self, *args, **kwargs):
        # Auto-generate broker_code on first save: BRK-YYYY-NNNN
        if not self.broker_code:
            from datetime import datetime
            year = datetime.now().year
            prefix = f"BRK-{year}-"
            last = (
                Broker.objects
                .filter(broker_code__startswith=prefix)
                .order_by('-broker_code')
                .first()
            )
            seq = 1
            if last:
                try:
                    seq = int(last.broker_code.split('-')[-1]) + 1
                except (ValueError, IndexError):
                    seq = 1
            self.broker_code = f"{prefix}{seq:04d}"
        super().save(*args, **kwargs)


class MachineryDivision(BaseModel):
    """Machinery Division — a department / production line / region tag
    attached to a (Company, Warehouse) and optionally pinned to a Godown.

    Surfaced as a filter on the Machinery master + BOM/PO routing rules.
    Kept deliberately separate from MachineryExpense (per user request);
    the two masters share no row data, only a category reference: every
    Expense optionally picks a Division as its *category* so finance
    reports can roll expenses up by production line.
    """

    name = models.CharField(max_length=255, db_index=True)
    company = models.ForeignKey(
        'core.Company',
        on_delete=models.PROTECT,
        related_name='machinery_divisions',
    )
    warehouse = models.ForeignKey(
        'core.Warehouse',
        on_delete=models.PROTECT,
        related_name='machinery_divisions',
    )
    godown = models.ForeignKey(
        'core.Godown',
        on_delete=models.PROTECT,
        related_name='machinery_divisions',
        null=True,
        blank=True,
        help_text='Optional — a Division can span the whole warehouse.',
    )
    notes = models.TextField(blank=True, default='')
    active_flag = models.BooleanField(default=True, db_index=True)

    class Meta:
        db_table = 'master_machinery_division'
        ordering = ['name']
        indexes = [
            models.Index(fields=['company', 'warehouse']),
            models.Index(fields=['active_flag']),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['company', 'warehouse', 'godown', 'name'],
                name='uniq_machinery_division_per_location',
            ),
        ]

    def __str__(self):
        return f"Division: {self.name}"


class ExpenseCategory(BaseModel):
    """Standalone category master used to tag Machinery Expenses.

    Lives independently of MachineryDivision because the operator wanted
    Expense categories curated by a superuser (via Django admin) rather
    than auto-populated from existing Divisions. The Expense create
    form on the frontend renders these as a checkbox list — there is
    no inline "Add" button and the API is read-only for non-admin
    users (see `ExpenseCategoryViewSet`).
    """

    name = models.CharField(max_length=255, unique=True, db_index=True)
    description = models.TextField(blank=True, default='')
    active_flag = models.BooleanField(default=True, db_index=True)

    class Meta:
        db_table = 'master_expense_category'
        ordering = ['name']
        verbose_name = 'Expense Category'
        verbose_name_plural = 'Expense Categories'
        indexes = [
            models.Index(fields=['active_flag', 'name']),
        ]

    def __str__(self):
        return self.name


class MachineryExpense(BaseModel):
    """Machinery Expense — an expense bucket attached to a (Company,
    Warehouse) and a single ExpenseCategory.

    Differences vs Division (per user request):
      - `category` FK → ExpenseCategory  (curated admin-only list; the
                                          frontend renders this as a
                                          single dropdown — one category
                                          per expense, no multi-select)
      - no `godowns` field — godown attachment is owned by the Division
        and inherited transitively.
    """

    name = models.CharField(max_length=255, db_index=True)
    company = models.ForeignKey(
        'core.Company',
        on_delete=models.PROTECT,
        related_name='machinery_expenses',
    )
    warehouse = models.ForeignKey(
        'core.Warehouse',
        on_delete=models.PROTECT,
        related_name='machinery_expenses',
    )
    category = models.ForeignKey(
        'ExpenseCategory',
        on_delete=models.PROTECT,
        related_name='machinery_expenses',
        null=True,
        blank=True,
        help_text='Expense category this row rolls up to. Categories are '
                  'curated by a superuser from the Django admin panel.',
    )
    notes = models.TextField(blank=True, default='')
    active_flag = models.BooleanField(default=True, db_index=True)

    class Meta:
        db_table = 'master_machinery_expense'
        ordering = ['name']
        indexes = [
            models.Index(fields=['company', 'warehouse']),
            models.Index(fields=['active_flag']),
        ]
        constraints = [
            # M2M can't participate in a unique constraint, so we only
            # guard the (company, warehouse, name) combo. Two expenses
            # called "Diesel" at different warehouses are fine; two at
            # the same warehouse aren't.
            models.UniqueConstraint(
                fields=['company', 'warehouse', 'name'],
                name='uniq_machinery_expense_per_warehouse',
            ),
        ]

    def __str__(self):
        return f"Expense: {self.name}"


class MasterAttachment(BaseModel):
    """File attachments (images / documents) for master records.

    Generic module + record_id shape (mirrors sales.SalesAttachment) so one
    endpoint + one frontend component serves every master. Currently used for
    Product reference images; extend MODULE_CHOICES to cover other masters.
    """

    MODULE_CHOICES = (
        ('PRODUCT', 'Product'),
        ('VENDOR', 'Vendor'),
        ('CUSTOMER', 'Customer'),
    )

    module = models.CharField(max_length=30, choices=MODULE_CHOICES, db_index=True)
    record_id = models.UUIDField(db_index=True, help_text="ID of the related master record")
    file = models.FileField(upload_to='master/attachments/%Y/%m/')
    file_name = models.CharField(max_length=255)
    file_size = models.PositiveIntegerField(default=0, help_text="File size in bytes")
    file_type = models.CharField(max_length=100, blank=True, default='')
    uploaded_by = models.ForeignKey(
        'auth.User',
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='master_attachments',
    )

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['module', 'record_id']),
        ]

    def __str__(self):
        return f"{self.module} - {self.file_name}"


class TdsSection(BaseModel):
    """Statutory TDS section master (the rate + threshold matrix from the Income
    Tax Act). The TDS engine (purchase/tds_engine.py) validates every bill
    against these rows. Seeded from a data migration (seed_tds_sections) and
    editable in admin, so rate/threshold changes are data, not code.

    `code` is the public section label (194C, 194Q, …). `single_bill_limit` is the
    per-transaction floor; `annual_limit` the cumulative FY floor (0 = none). The
    two rate columns pick by the vendor's deductee category; `rate_no_pan` is the
    206AA override when PAN is missing/invalid. `is_194q` flips on the special
    "tax only the amount over the annual limit" behaviour."""

    code = models.CharField(max_length=12, unique=True, db_index=True,
                            help_text="e.g. 194C, 194J-b, 194Q.")
    nature = models.CharField(max_length=120, blank=True, default='',
                              help_text="Nature of payment / service.")
    single_bill_limit = models.DecimalField(
        max_digits=15, decimal_places=2, default=Decimal('0'),
        help_text="Per-bill floor; 0 = no single-bill test.")
    annual_limit = models.DecimalField(
        max_digits=15, decimal_places=2, default=Decimal('0'),
        help_text="Cumulative FY floor; 0 = no annual test.")
    rate_ind_huf = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0'))
    rate_others = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0'))
    rate_no_pan = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('20'))
    is_194q = models.BooleanField(
        default=False,
        help_text="194Q: tax only the cumulative amount exceeding annual_limit.")
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = 'master_tds_section'
        ordering = ['code']

    def __str__(self):
        return f"{self.code} ({self.nature})"


class ExpenseParty(BaseModel):
    """Expense party master — Tally ledgers that appear as the creditor
    in expense journals (rent, electricity, professional services, etc.)."""

    name = models.CharField(max_length=255, db_index=True)
    company = models.ForeignKey(
        'core.Company', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='expense_parties', db_index=True,
    )
    tally_group = models.CharField(max_length=120, blank=True, default='')
    gstin = models.CharField(
        max_length=15,
        blank=True, null=True, default=None,
        validators=[RegexValidator(
            regex=r'^(\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1})?$',
            message='Invalid GSTIN format'
        )],
    )
    active_flag = models.BooleanField(default=True, db_index=True)

    class Meta:
        db_table = 'master_expense_party'
        ordering = ['name']

    def __str__(self):
        return self.name


class Tds197Certificate(BaseModel):
    """Section 197 lower/nil-rate certificate for a vendor — a concessional rate
    valid for a date window up to a monetary cap. The engine applies the lower
    rate while the bill date is in the window and the cumulative utilisation is
    under `cap_limit`, then splits the overflow at the standard section rate."""

    vendor = models.ForeignKey('master.Vendor', on_delete=models.CASCADE,
                               related_name='tds_197_certificates')
    section = models.ForeignKey('master.TdsSection', null=True, blank=True,
                                on_delete=models.SET_NULL, related_name='certificates_197')
    certificate_no = models.CharField(max_length=20, db_index=True)
    concessional_rate = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0'))
    valid_from = models.DateField()
    valid_to = models.DateField()
    cap_limit = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'),
                                    help_text="Cumulative amount the lower rate applies to; 0 = no cap.")
    utilized_amount = models.DecimalField(max_digits=15, decimal_places=2, default=Decimal('0'))
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = 'master_tds_197_certificate'
        ordering = ['-valid_from']

    def __str__(self):
        return f"197 {self.certificate_no} ({self.concessional_rate}%)"
