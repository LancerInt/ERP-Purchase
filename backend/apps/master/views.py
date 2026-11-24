"""
Views for master app models.
"""
from django.utils import timezone
from django.db.models import Count, Q
from rest_framework import viewsets, filters, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django_filters.rest_framework import DjangoFilterBackend
from rbac.permissions import HasModulePermission
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.exceptions import ValidationError
from .models import (
    Product, SecondaryUOM, ServiceCatalogue, Vendor, VendorBankDetail,
    Customer, ShippingAddress, Transporter, PriceList, PriceLine, TaxMaster,
    TemplateLibrary, TemplateApprovalLog, Broker, StateGroup,
    MachineryDivision, MachineryExpense, ExpenseCategory, MasterAttachment,
    ExpenseParty,
)
from .serializers import (
    ProductSerializer, SecondaryUOMSerializer, ServiceCatalogueSerializer,
    VendorSerializer, VendorDetailSerializer, VendorImportSerializer, VendorBankDetailSerializer,
    CustomerSerializer, CustomerDetailSerializer, ShippingAddressSerializer,
    TransporterSerializer, ExpensePartySerializer, PriceListSerializer, PriceListListSerializer,
    PriceListDetailSerializer,
    PriceLineSerializer, TaxMasterSerializer, TemplateLibrarySerializer,
    TemplateLibraryDetailSerializer, TemplateApprovalLogSerializer,
    BrokerSerializer, StateGroupSerializer,
    MachineryDivisionSerializer, MachineryExpenseSerializer,
    ExpenseCategorySerializer, MasterAttachmentSerializer,
)
from .selectors import (
    get_products, get_active_vendors, get_active_customers,
    get_price_lists_for_customer, get_templates_by_type
)
from .import_mixin import BulkImportMixin, SoftDeleteMixin


class ProductViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for Product management."""

    serializer_class = ProductSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Product'

    def get_serializer_class(self):
        """?slim=1 on a LIST returns only the dropdown fields.

        Opt-in, list-only, and never the default: without the flag every
        caller gets exactly the payload it gets today. A page that only fills
        an "All products" <select> was downloading 45 fields a row - 4.6 MB,
        ~3s, of which 0.5s was the database and the rest was building JSON it
        threw away.
        """
        if (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes')):
            from .serializers import ProductLookupSerializer
            return ProductLookupSerializer
        return super().get_serializer_class()
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['product_type', 'goods_sub_type', 'active_flag']
    search_fields = ['sku_code', 'product_name']
    ordering_fields = ['sku_code', 'product_name', 'created_at']
    # 'id' is a TIE-BREAK, not a sort anyone asked for. Ordering by a single
    # column leaves rows that share a value in no defined order, and
    # LIMIT/OFFSET over an undefined order can hand the same row back on two
    # pages and never hand back another - so a list page that walks its pages
    # to collect every row may silently duplicate some and miss others. Seen
    # on Bills: a July window and the July slice of a full walk both returned
    # 884 rows, and they were not the same 884.
    #
    # It changes no value and no filter. Where rows tie, it fixes the order
    # they come back in instead of leaving it to chance.
    ordering = ['sku_code', 'id']

    def get_queryset(self):
        """Hide soft-deleted products from the default list. Admins can
        opt back in with `?show_all=true` (matches Customer / Vendor).
        Without this filter, the SoftDeleteMixin marked the row inactive
        but the list still showed it — the bug the user reported.

        prefetch_related on `secondary_uoms` and `preferred_vendors` is
        what keeps the list endpoint inside the 30s axios timeout — the
        ProductSerializer pulls both per row, and without prefetch the
        list query goes O(N) on round-trips. On Render free Postgres
        (~30ms RTT) that was busting the timeout once the product
        catalog grew past ~150 rows.
        """
        qs = Product.objects.select_related(
            'qc_template', 'custom_service_category',
            # Location FKs — the serializer emits warehouse/godown/division/
            # company names (now shown as list columns); joining them here
            # avoids an N+1 across the catalog.
            'warehouse', 'godown', 'division', 'company',
        ).prefetch_related(
            'secondary_uoms', 'preferred_vendors',
            # `warehouses` is the M2M behind get_warehouses_detail, which walks
            # obj.warehouses.all() for EVERY row. It was the one relation the
            # note above missed, and it cost one round trip per product - 500
            # of them on a single page, before the rest of the serializer.
            'warehouses',
            # Same story: the serializer emits customer_names per row, so
            # without this it was a second round trip for every product.
            'customer_names',
        )
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True, active_flag=True)
        return qs

    # Excel import. Tuple-of-tuples per column lets us accept multiple
    # header labels — important because the existing Export uses short
    # names ("Type", "Sub Type") whereas the downloaded Import template
    # uses the more descriptive form ("Product Type", "Goods Sub Type").
    # Both round-trip cleanly.
    #
    # Location columns (Company / Warehouse / Godown / Division)
    # carry MACHINERY-row data. They stay blank for GOODS and SERVICES.
    import_columns = [
        ('SKU Code',                                  'sku_code'),
        ('Product Name',                              'product_name'),
        (('Product Type', 'Type'),                    'product_type'),
        (('Goods Sub Type', 'Sub Type'),              'goods_sub_type'),
        ('UOM',                                       'uom'),
        ('HSN Code',                                  'hsn_code'),
        ('Description',                               'description'),
        ('Product Trade Name',                        'product_trade_name'),
        (('Finished Good Customer', 'Customer'),      'finished_good_customer'),
        (('Parent Product', 'Parent SKU', 'Bulk SKU'),'parent_product'),
        ('Shelf Life Days',                           'shelf_life_days'),
        ('Specific Gravity',                          'specific_gravity'),
        (('Batch Tracking', 'Batch Tracking Required'), 'batch_tracking_required'),
        ('Company',                                   'company'),
        ('Warehouse',                                 'warehouse'),
        ('Godown',                                    'godown'),
        ('Division',                                  'division'),
    ]
    import_fk_resolvers = {
        'finished_good_customer': (
            'master.Customer',
            ('customer_code', 'customer_name', 'gstin'),
        ),
        'parent_product': (
            'master.Product',
            ('sku_code', 'product_name'),
        ),
        'company':   ('core.Company',           ('company_code', 'legal_name', 'trade_name', 'gstin')),
        'warehouse': ('core.Warehouse',         ('warehouse_code', 'name')),
        'godown':    ('core.Godown',            ('godown_code', 'godown_name')),
        'division':  ('master.MachineryDivision', 'name'),
    }
    # When the user's exported sheet omits product_type, fall back to
    # the most common value ("GOODS") so the import doesn't fail with
    # "This field is required" on every row.
    import_defaults = {
        'product_type': 'GOODS',
    }
    # Soft-deleted products keep their sku_code (unique=True), so a
    # re-import of the same SKU would normally trip the unique
    # constraint. Opt the importer into restore-on-match: when an
    # incoming row's sku_code matches a soft-deleted product, the
    # row is reactivated + updated instead of failing.
    import_restore_on_match = 'sku_code'

    @action(detail=False, methods=['get'])
    def active_products(self, request):
        """Get all active products."""
        products = get_products(active_flag=True)
        serializer = self.get_serializer(products, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'], url_path='search')
    def search(self, request):
        """Lightweight product search for the dashboard product picker.

        Returns up to 50 matching products plus category counts, in a
        single ~2 KB response instead of the 4.6 MB full-catalog download
        that was causing OOM on 512 MB instances.

        ?q=bentonite           — name/SKU icontains search
        ?category=RAW_MATERIAL — narrow to one goods_sub_type
        ?ids=uuid1,uuid2       — fetch specific products (for "recent" list)
        ?families=1            — include product family groups
        """
        base = Product.objects.filter(is_active=True, active_flag=True)

        cat_counts = dict(
            base.exclude(goods_sub_type__isnull=True)
                .exclude(goods_sub_type='')
                .values_list('goods_sub_type')
                .annotate(n=Count('id'))
                .values_list('goods_sub_type', 'n')
        )

        def _serialize(qs):
            return [
                {'id': str(p.id), 'product_name': p.product_name,
                 'sku_code': p.sku_code or '', 'goods_sub_type': p.goods_sub_type or ''}
                for p in qs
            ]

        resp = {'category_counts': cat_counts}

        if request.query_params.get('families') in ('1', 'true'):
            from sales.dashboard_views import product_group
            fams = {}
            for pid, pname in base.values_list('id', 'product_name'):
                fam = product_group(pname)
                if fam:
                    fams.setdefault(fam, []).append(str(pid))
            resp['families'] = [
                {'label': label, 'value': ','.join(ids)}
                for label, ids in fams.items()
            ]

        ids_param = request.query_params.get('ids', '').strip()
        if ids_param:
            id_list = [x.strip() for x in ids_param.split(',') if x.strip()]
            rows = base.filter(id__in=id_list).only(
                'id', 'product_name', 'sku_code', 'goods_sub_type',
            )[:50]
            resp['results'] = _serialize(rows)
            return Response(resp)

        q = request.query_params.get('q', '').strip()
        category = request.query_params.get('category', '').strip()

        qs = base
        if category:
            qs = qs.filter(goods_sub_type=category)
        if q:
            qs = qs.filter(
                Q(product_name__icontains=q) | Q(sku_code__icontains=q)
            )

        rows = qs.only(
            'id', 'product_name', 'sku_code', 'goods_sub_type',
        ).order_by('product_name')[:50]
        resp['results'] = _serialize(rows)
        return Response(resp)

    @action(detail=False, methods=['get'], url_path='next-sku')
    def next_sku(self, request):
        """Preview the next auto-generated SKU for a category. The real code is
        generated server-side on create (this is just what the form shows).

        ?product_type=GOODS&goods_sub_type=RAW_MATERIAL         -> {"sku": "RAW-145"}
        ?product_type=MACHINERY&machine_base=BU-001              -> {"sku": "BU-001/015"}
        ?product_type=GOODS&goods_sub_type=PACKING_MATERIAL&pack_base=SSB-002
                                                                -> {"sku": "SSB-002-PACK-684"}
        Returns {"sku": null} when the category has no auto scheme / needs a pick.
        """
        from .sku_gen import next_sku as _next
        sku = _next(
            request.query_params.get('product_type'),
            request.query_params.get('goods_sub_type'),
            request.query_params.get('machine_base'),
            request.query_params.get('pack_base'),
        )
        return Response({'sku': sku})

    @action(detail=False, methods=['get'], url_path='machine-bases')
    def machine_bases(self, request):
        """Distinct machine bases in use (for the 'pick an existing base'
        dropdown), each with its godown and part count."""
        from .sku_gen import machine_bases as _bases
        return Response(_bases())

    @action(detail=False, methods=['get'], url_path='pack-bases')
    def pack_bases(self, request):
        """Distinct packing series in use (for the 'pick a series' dropdown),
        each with its company and count."""
        from .sku_gen import pack_bases as _bases
        return Response(_bases())

    @action(detail=False, methods=['get'])
    def by_type(self, request):
        """Get products by type."""
        product_type = request.query_params.get('type')
        if not product_type:
            return Response(
                {'error': 'type query parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        products = get_products(product_type=product_type)
        serializer = self.get_serializer(products, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def with_secondary_uoms(self, request, pk=None):
        """Get product with secondary UOMs."""
        product = self.get_object()
        uoms = product.secondary_uoms.all()
        serializer = SecondaryUOMSerializer(uoms, many=True)
        return Response(serializer.data)


class ServiceCatalogueViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for ServiceCatalogue management."""

    serializer_class = ServiceCatalogueSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Service Catalogue'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['category', 'direction', 'active_flag']
    search_fields = ['service_code', 'name']
    ordering_fields = ['service_code', 'name', 'created_at']
    # 'id' is a TIE-BREAK, not a sort anyone asked for. Ordering by a single
    # column leaves rows that share a value in no defined order, and
    # LIMIT/OFFSET over an undefined order can hand the same row back on two
    # pages and never hand back another - so a list page that walks its pages
    # to collect every row may silently duplicate some and miss others. Seen
    # on Bills: a July window and the July slice of a full walk both returned
    # 884 rows, and they were not the same 884.
    #
    # It changes no value and no filter. Where rows tie, it fixes the order
    # they come back in instead of leaving it to chance.
    ordering = ['service_code', 'id']

    def get_queryset(self):
        qs = ServiceCatalogue.objects.prefetch_related('warehouse_availability')
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True, active_flag=True)
        return qs

    import_columns = [
        ('Service Code', 'service_code'),
        ('Name',         'name'),
        ('Category',     'category'),
        ('Direction',    'direction'),       # INWARD / OUTWARD / BOTH
        ('Description',  'description'),
        ('Default TDS',  'default_tds'),
        ('Default TCS',  'default_tcs'),
    ]

    @action(detail=False, methods=['get'])
    def by_warehouse(self, request):
        """Get services available at warehouse."""
        warehouse_id = request.query_params.get('warehouse_id')
        if not warehouse_id:
            return Response(
                {'error': 'warehouse_id query parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        services = self.get_queryset().filter(
            warehouse_availability__id=warehouse_id,
            active_flag=True
        ).distinct()
        serializer = self.get_serializer(services, many=True)
        return Response(serializer.data)


class VendorViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for Vendor management."""

    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Vendor'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['company', 'active_flag', 'payment_terms', 'is_msme', 'msme_category', 'is_rcm']
    search_fields = ['vendor_code', 'vendor_name', 'gstin']
    ordering_fields = ['vendor_code', 'vendor_name', 'created_at']
    # 'id' is a TIE-BREAK, not a sort anyone asked for. Ordering by a single
    # column leaves rows that share a value in no defined order, and
    # LIMIT/OFFSET over an undefined order can hand the same row back on two
    # pages and never hand back another - so a list page that walks its pages
    # to collect every row may silently duplicate some and miss others. Seen
    # on Bills: a July window and the July slice of a full walk both returned
    # 884 rows, and they were not the same 884.
    #
    # It changes no value and no filter. Where rows tie, it fixes the order
    # they come back in instead of leaving it to chance.
    ordering = ['vendor_code', 'id']

    # The "Company" column is a Company FK — the importer resolves it by
    # legal_name, case-insensitive, so the user can type the company name
    # they see in the Companies master.
    import_columns = [
        ('Vendor Code',     'vendor_code'),
        ('Vendor Name',     'vendor_name'),
        ('Vendor Type',     'vendor_type'),
        ('Company',         'company'),
        ('GSTIN',           'gstin'),
        ('PAN',             'pan'),
        ('GST Treatment',   'gst_treatment'),
        ('Address',         'address'),
        ('City',            'city'),
        ('State',           'state'),
        ('Country',         'country'),
        ('Pincode',         'pincode'),
        ('Contact Person',  'contact_person'),
        ('Contact Email',   'contact_email'),
        ('Contact Phone',   'contact_phone'),
        ('Payment Terms',   'payment_terms'),
        ('Credit Limit',    'credit_limit'),
        ('Credit Days',     'credit_days'),
        ('TDS Rate',        'tds_rate'),
        ('TCS Rate',        'tcs_rate'),
    ]
    # Company can be referenced by any of these fields — codes
    # (UAI / SSB / BTPL) appear in the existing Export, while a
    # downloaded Import template hints at legal_name.
    import_fk_resolvers = {
        'company': ('core.Company', ('company_code', 'legal_name', 'trade_name', 'gstin')),
    }
    # Address columns are exported in the readable
    # "Line | City | State | Pincode | Country" format. The mixin parses
    # them back into the JSONField dict shape the serializer expects.
    import_address_fields = ('address',)

    def get_queryset(self):
        qs = Vendor.objects.select_related('company').prefetch_related(
            'bank_details', 'preferred_transporters', 'allowed_warehouses'
        )
        # Hide deactivated unless ?show_all=true
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True)
        # Multi-value vendor_type filter — JSONField stores a list like
        # ["MATERIAL", "CONTRACTOR"]. PostgreSQL supports `__contains` on
        # JSONField but SQLite (dev) does not, so we match against the
        # raw JSON text using `__icontains` with the value wrapped in
        # quotes (`"CONTRACTOR"`). The known vendor_type values have no
        # substring collisions so the quoted match is exact. Accepts a
        # comma-separated list — OR semantics. Used by the wage-payments
        # workflow to restrict the contractor picker to CONTRACTOR /
        # WAGES vendors only.
        vendor_type = self.request.query_params.get('vendor_type')
        if vendor_type:
            wanted = [v.strip().upper() for v in vendor_type.split(',') if v.strip()]
            if wanted:
                from django.db.models import Q
                q = Q()
                for v in wanted:
                    q |= Q(vendor_type__icontains=f'"{v}"')
                qs = qs.filter(q)
        # Inverse of the above — drop vendors tagged with these types. The
        # purchase analytics vendor filter uses ?exclude_vendor_type=EXPENSE,
        # TRANSPORTER so expense vendors and transporters stay out of the goods
        # vendor dropdown. Vendors with no type set are KEPT (exclude only
        # removes rows that positively carry an unwanted type).
        exclude_vt = self.request.query_params.get('exclude_vendor_type')
        if exclude_vt:
            unwanted = [v.strip().upper() for v in exclude_vt.split(',') if v.strip()]
            if unwanted:
                from django.db.models import Q
                qx = Q()
                for v in unwanted:
                    qx |= Q(vendor_type__icontains=f'"{v}"')
                qs = qs.exclude(qx)
                # Transporters live in their OWN master (master.Transporter), not
                # as a vendor_type tag — so excluding by vendor_type alone leaves
                # freight/transport parties (which carry purchase bills) in the
                # goods-vendor dropdown. Also drop any Vendor that matches a
                # Transporter by GSTIN or exact name (deterministic, no fuzzy).
                if 'TRANSPORTER' in unwanted:
                    from master.models import Transporter
                    tvals = Transporter.objects.values_list('gstin', 'name')
                    gstins = {g for g, _ in tvals if g}
                    names = {n for _, n in tvals if n}
                    tex = Q()
                    if gstins:
                        tex |= Q(gstin__in=gstins)
                    for n in names:
                        tex |= Q(vendor_name__iexact=n)
                    if tex:
                        qs = qs.exclude(tex)
        # Dashboards use ?has_purchases=true so the vendor dropdown lists only
        # parties we've actually billed — the master carries 2700+ vendors
        # (many mirrored across companies as dead namesakes); this trims it to
        # the ~265 with real bills so the filter isn't flooded with duplicates.
        if self.request.query_params.get('has_purchases') == 'true':
            from purchase.models import VendorBill
            qs = qs.filter(id__in=VendorBill.objects.filter(
                is_active=True).values('vendor_id'))
        return qs

    def perform_create(self, serializer):
        vendor = serializer.save()
        from notifications.services import notify_approvers
        notify_approvers(
            'Vendor',
            title=f'New vendor created: {vendor.vendor_name}',
            message=f'{vendor.vendor_name} ({vendor.vendor_code}) was created by {self.request.user.get_full_name() or self.request.user.username}.',
            link=f'/masters/vendor/{vendor.id}',
            category='vendor',
            level='info',
            actor=self.request.user,
        )

    def get_serializer_class(self):
        # ?slim=1 on a LIST returns only the dropdown fields. Opt-in and
        # list-only: without the flag every caller gets today's payload.
        if (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes')):
            from .serializers import VendorLookupSerializer
            return VendorLookupSerializer
        if self.action == 'retrieve':
            return VendorDetailSerializer
        # Bulk import uses a lenient serializer that allows blank GSTIN.
        # See VendorImportSerializer + Vendor.gstin field comment for the
        # rationale (legacy rows often lack a GSTIN; we want them to
        # import without manually editing every row).
        if self.action == 'import_bulk':
            return VendorImportSerializer
        return VendorSerializer

    @action(detail=False, methods=['get'])
    def active_vendors(self, request):
        """Get all active vendors."""
        vendors = get_active_vendors()
        serializer = self.get_serializer(vendors, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def add_bank_account(self, request, pk=None):
        """Add bank account to vendor."""
        vendor = self.get_object()
        serializer = VendorBankDetailSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save(vendor=vendor)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['get'])
    def bank_accounts(self, request, pk=None):
        """Get vendor's bank accounts."""
        vendor = self.get_object()
        accounts = vendor.bank_details.all()
        serializer = VendorBankDetailSerializer(accounts, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'], url_path='next-code')
    def next_code(self, request):
        """Preview the vendor code that will be assigned for a company
        (<COMPANY_CODE>-VEN-###). Indicative only — the authoritative code is
        assigned on save, so a concurrent create can shift it by one."""
        company_id = request.query_params.get('company')
        if not company_id:
            return Response({'code': ''})
        from core.models import Company
        company = Company.objects.filter(id=company_id).first()
        if not company:
            return Response({'code': ''})
        return Response({'code': Vendor(company=company)._generate_vendor_code()})

    @action(detail=False, methods=['get'], url_path='suggest-tds')
    def suggest_tds_view(self, request):
        """Suggested TDS for the vendor form (A2): vendor_type + PAN →
        {deductee_category, section_code, rate}. Rate is null when no matching
        TdsSection exists. Read-only; the operator can override the field."""
        from purchase.tds_engine import suggest_tds
        vendor_type = request.query_params.get('vendor_type') or ''
        pan = request.query_params.get('pan') or ''
        result = suggest_tds(vendor_type, pan)
        rate = result.get('rate')
        return Response({
            'deductee_category': result.get('deductee_category'),
            'section_code': result.get('section_code'),
            'rate': (str(rate) if rate is not None else None),
        })

    @action(detail=False, methods=['get'], url_path='check-duplicate')
    def check_duplicate(self, request):
        """Live duplicate suggester for the vendor form (A3). Given a name +
        company (and/or a GSTIN), returns active vendors that clash, so the form
        can warn BEFORE the operator submits — mirroring the serializer's hard
        guards so the inline alert and the save-time error always agree.

        Response:
          matches        → name-key clashes within the chosen company (blocking)
          gstin_matches  → GSTIN clashes; each row carries same_company. A
                           same-company hit is blocking (one active vendor per
                           GSTIN per company); a cross-company hit is allowed
                           (the same GSTIN may be reused under another company)
                           and surfaced only as information.
        Pass `exclude` (a vendor id) on the edit flow so the row doesn't flag
        itself. Empty lists = no clash."""
        from .merge_utils import vkey
        name = (request.query_params.get('name') or '').strip()
        gstin = (request.query_params.get('gstin') or '').strip()
        company_id = request.query_params.get('company')
        exclude_id = request.query_params.get('exclude')
        resp = {'matches': [], 'gstin_matches': []}

        # Name-key clash — scoped to the chosen company.
        key = vkey(name) if name else ''
        if key and company_id:
            qs = Vendor.objects.filter(company_id=company_id, vendor_name_key=key,
                                       is_active=True)
            if exclude_id:
                qs = qs.exclude(id=exclude_id)
            resp['matches'] = list(
                qs.values('id', 'vendor_code', 'vendor_name', 'gstin')[:5])

        # GSTIN clash — a GSTIN identifies one legal entity. Match the
        # serializer: active + case-insensitive. We don't scope the query to
        # the company (so we can tell the operator about cross-company reuse),
        # but we tag each row with same_company so the UI knows which ones block.
        norm = gstin.replace(' ', '').upper()
        if len(norm) == 15:
            gqs = Vendor.objects.filter(gstin__iexact=norm, is_active=True)
            if exclude_id:
                gqs = gqs.exclude(id=exclude_id)
            rows = list(gqs.values('id', 'vendor_code', 'vendor_name',
                                   'company_id', 'company__legal_name')[:5])
            for r in rows:
                r['same_company'] = bool(
                    company_id and str(r['company_id']) == str(company_id))
            resp['gstin_matches'] = rows
        return Response(resp)

    @action(detail=False, methods=['get'], url_path='gst-verify-status')
    def gst_verify_status(self, request):
        """Whether GSTIN portal verification is configured — the form hides the
        Verify button when it is not, so the feature degrades gracefully."""
        from .gst_verify import is_configured
        return Response({'enabled': is_configured()})

    @action(detail=False, methods=['post'], url_path='verify-gstin')
    def verify_gstin(self, request):
        """Verify a GSTIN against the GST portal (A5). Body: {gstin, vendor_id?}.
        Returns normalised details to pre-fill the form. When vendor_id is
        given (edit flow), also persists the verification snapshot + status on
        that vendor. A CANCELLED/SUSPENDED status is returned as a warning — it
        never blocks (per decision)."""
        from django.utils import timezone
        from .gst_verify import verify, GstVerifyError
        gstin = (request.data.get('gstin') or '').strip()
        try:
            data = verify(gstin)
        except GstVerifyError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        vendor_id = request.data.get('vendor_id')
        if vendor_id:
            vendor = Vendor.objects.filter(id=vendor_id).first()
            if vendor:
                vendor.gstin_portal_status = data.get('status') or ''
                vendor.gstin_snapshot = data.get('raw') or {}
                vendor.gstin_verified_at = timezone.now()
                vendor.save(update_fields=['gstin_portal_status', 'gstin_snapshot',
                                           'gstin_verified_at', 'updated_at'])

        warning = ''
        if data.get('status') in ('CANCELLED', 'SUSPENDED'):
            warning = (f'This GSTIN is {data["status"].title()} on the GST portal. '
                       f'You can still save the vendor, but verify before transacting.')
        payload = {k: v for k, v in data.items() if k != 'raw'}
        payload['warning'] = warning
        return Response(payload)


class VendorBankDetailViewSet(viewsets.ModelViewSet):
    """ViewSet for VendorBankDetail management."""

    queryset = VendorBankDetail.objects.select_related('vendor')
    serializer_class = VendorBankDetailSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['vendor', 'is_primary']


class CustomerViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for Customer management."""

    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Customer'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['company', 'active_flag', 'credit_terms']
    search_fields = ['customer_code', 'customer_name', 'gstin']
    ordering_fields = ['customer_code', 'customer_name', 'created_at']
    # 'id' is a TIE-BREAK, not a sort anyone asked for. Ordering by a single
    # column leaves rows that share a value in no defined order, and
    # LIMIT/OFFSET over an undefined order can hand the same row back on two
    # pages and never hand back another - so a list page that walks its pages
    # to collect every row may silently duplicate some and miss others. Seen
    # on Bills: a July window and the July slice of a full walk both returned
    # 884 rows, and they were not the same 884.
    #
    # It changes no value and no filter. Where rows tie, it fixes the order
    # they come back in instead of leaving it to chance.
    ordering = ['customer_code', 'id']

    import_columns = [
        ('Customer Code',        'customer_code'),
        ('Customer Name',        'customer_name'),
        ('Company',              'company'),
        ('GSTIN',                'gstin'),
        ('PAN',                  'pan'),
        ('GST Treatment',        'gst_treatment'),
        ('Billing Address',      'billing_address'),
        # Shipping Address is consumed by CustomerSerializer.shipping_address
        # (singular, write-only). When filled the importer creates a
        # ShippingAddress record alongside the Customer; when blank
        # the row imports as customer-only with no shipping rows. The
        # adjacent "Shipping Address Label" column lets the operator
        # name each row (e.g. "Head Office", "Yercaud Branch"); falls
        # back to "Default" when blank.
        ('Shipping Address',       'shipping_address'),
        ('Shipping Address Label', 'shipping_address_label'),
        ('Contact Person',       'contact_person'),
        ('Contact Email',        'contact_email'),
        ('Contact Phone',        'contact_phone'),
        ('Credit Terms',         'credit_terms'),
        ('Custom Credit Days',   'custom_credit_days'),
        ('Active Flag',          'active_flag'),
    ]
    import_fk_resolvers = {
        'company': ('core.Company', ('company_code', 'legal_name', 'trade_name', 'gstin')),
    }
    import_address_fields = ('billing_address', 'shipping_address')

    def perform_update(self, serializer):
        """Saving changed credit terms re-ages the invoices they govern.

        Two things happen here that a plain save would not do:

        1. Changing the terms without naming a date defaults the effective
           date to the start of the current financial year. The terms are
           useless without one — credit_days_for ignores an undated term on
           purpose — so silently leaving it blank would look like the edit
           did nothing.
        2. The invoices are re-derived immediately. Ageing reads a stored
           due_date on ReceivableLedger; without this the master would say
           one thing and every bucket on the dashboard another until the
           next Tally import happened to rewrite them.

        Only invoices Tally gave no due date of its own are touched — see
        sales.credit_terms_apply for why that line is drawn there.
        """
        from datetime import date as _date

        from master.credit_terms import fy_start_for
        from sales.credit_terms_apply import apply_credit_terms

        before = Customer.objects.filter(pk=serializer.instance.pk).values(
            'credit_terms', 'custom_credit_days', 'credit_terms_effective_from',
        ).first() or {}
        customer = serializer.save()

        terms_changed = (
            before.get('credit_terms') != customer.credit_terms
            or before.get('custom_credit_days') != customer.custom_credit_days
        )
        date_changed = (
            before.get('credit_terms_effective_from') != customer.credit_terms_effective_from
        )
        if not (terms_changed or date_changed):
            return

        if terms_changed and not customer.credit_terms_effective_from:
            customer.credit_terms_effective_from = fy_start_for(_date.today())
            customer.save(update_fields=['credit_terms_effective_from', 'updated_at'])

        try:
            apply_credit_terms(customer, user=self.request.user)
        except Exception:  # noqa: BLE001 — the master edit itself must stand
            import logging
            logging.getLogger(__name__).exception(
                'Re-applying credit terms failed for customer %s', customer.pk)

    def get_queryset(self):
        qs = Customer.objects.select_related('company')
        # `allowed_price_lists` is only rendered by CustomerDetailSerializer
        # (retrieve). Prefetching it on the list wasted a query + memory for
        # every request since the list serializer never reads it. Keep it on
        # retrieve; the list only needs shipping_addresses (used for the
        # nested payload AND the address count).
        if self.action == 'retrieve':
            qs = qs.prefetch_related('shipping_addresses', 'allowed_price_lists')
        else:
            qs = qs.prefetch_related('shipping_addresses')
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True)
        # Dashboards use ?has_sales=true so the customer dropdown lists only
        # parties we've actually transacted with (invoices) — otherwise the
        # full 300+ master (including test-company & other-company namesakes
        # that share a name, e.g. three "T.Stanes … Coimbatore") floods the
        # filter with dead duplicates.
        #
        # A party can carry a balance with no invoice at all, and it must still
        # be findable: SS Biochem's Tropical Agro System (India) Pvt.Ltd -
        # Chennai is a pure opening credit (Rs 49,94,668 Cr), Horti Research
        # Centre only a purchase credit. Both sit in Tally's Sundry Debtors and
        # in the Outstanding tile, yet were missing from the dropdown. So a
        # non-zero opening carrier or a live outstanding adjustment counts too —
        # both only exist for parties Tally actually holds, so no dead masters.
        if self.request.query_params.get('has_sales') == 'true':
            from sales.models import (SalesInvoiceCheck, ReceivableLedger,
                                      ReceivableAdjustment)
            qs = qs.filter(
                Q(id__in=SalesInvoiceCheck.objects.filter(is_active=True)
                  .exclude(tally_invoice_no='OPENING').values('customer_id'))
                | Q(id__in=ReceivableLedger.objects.filter(
                    is_active=True, invoice_reference__tally_invoice_no='OPENING')
                    .exclude(amount=0).values('customer_id'))
                | Q(id__in=ReceivableAdjustment.objects.filter(
                    is_active=True, counts_in_outstanding=True).values('customer_id')))
        return qs

    def get_serializer_class(self):
        if self.action == 'retrieve':
            return CustomerDetailSerializer
        return CustomerSerializer

    @action(detail=False, methods=['get'])
    def active_customers(self, request):
        """Get all active customers."""
        customers = get_active_customers()
        serializer = self.get_serializer(customers, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'], url_path='next-code')
    def next_code(self, request):
        """Preview the next customer code (CUS-###). Indicative only — the
        authoritative code is assigned on save."""
        return Response({'code': Customer()._generate_customer_code()})

    @action(detail=True, methods=['post'])
    def add_shipping_address(self, request, pk=None):
        """Add shipping address to customer."""
        customer = self.get_object()
        serializer = ShippingAddressSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save(customer=customer)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['get'])
    def shipping_addresses(self, request, pk=None):
        """Get customer's shipping addresses."""
        customer = self.get_object()
        addresses = customer.shipping_addresses.all()
        serializer = ShippingAddressSerializer(addresses, many=True)
        return Response(serializer.data)


class ShippingAddressViewSet(viewsets.ModelViewSet):
    """ViewSet for ShippingAddress management."""

    queryset = ShippingAddress.objects.select_related('customer', 'default_price_list')
    serializer_class = ShippingAddressSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['customer', 'delivery_region']


class TransporterViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for Transporter management."""

    serializer_class = TransporterSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Transporter'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    # `rating` removed from filterset/ordering — the field no longer
    # exists on the model.
    filterset_fields = ['active_flag']
    search_fields = ['transporter_code', 'name']
    ordering_fields = ['transporter_code', 'name', 'created_at']
    # 'id' is a TIE-BREAK, not a sort anyone asked for. Ordering by a single
    # column leaves rows that share a value in no defined order, and
    # LIMIT/OFFSET over an undefined order can hand the same row back on two
    # pages and never hand back another - so a list page that walks its pages
    # to collect every row may silently duplicate some and miss others. Seen
    # on Bills: a July window and the July slice of a full walk both returned
    # 884 rows, and they were not the same 884.
    #
    # It changes no value and no filter. Where rows tie, it fixes the order
    # they come back in instead of leaving it to chance.
    ordering = ['transporter_code', 'id']

    def get_queryset(self):
        qs = Transporter.objects.all()
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True, active_flag=True)
        return qs

    import_columns = [
        ('Transporter Code', 'transporter_code'),
        ('Name',             'name'),
        ('GSTIN',            'gstin'),
        ('Contact Person',   'contact_person'),
        ('Contact Email',    'contact_email'),
        ('Contact Phone',    'contact_phone'),
    ]


class ExpensePartyViewSet(SoftDeleteMixin, viewsets.ModelViewSet):
    """ViewSet for ExpenseParty master — parties in expense journals."""

    serializer_class = ExpensePartySerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Expense Party'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['active_flag', 'company']
    search_fields = ['name', 'tally_group']
    ordering_fields = ['name', 'created_at']
    ordering = ['name', 'id']

    def get_queryset(self):
        qs = ExpenseParty.objects.all()
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True, active_flag=True)
        company_id = self.request.query_params.get('company')
        if company_id:
            qs = qs.filter(company_id=company_id)
        return qs


class PriceListViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for PriceList management."""

    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Price List'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['company', 'customer', 'status']
    search_fields = ['price_list_id', 'delivery_region']
    ordering_fields = ['price_list_id', 'effective_from', 'status', 'created_at']
    ordering = ['-effective_from', 'price_list_id']

    # Only the HEADER row of a price list is bulk-imported here. The
    # line items are uploaded separately against /api/price-lines/ —
    # users typically prepare two sheets in one workbook.
    import_columns = [
        ('Price List ID',  'price_list_id'),
        ('Company',        'company'),
        ('Customer',       'customer'),
        ('Effective From', 'effective_from'),
        ('Effective To',   'effective_to'),
        ('Currency',       'currency'),
        ('GST Type',       'gst_type'),
        ('Status',         'status'),
    ]
    import_fk_resolvers = {
        'company':  ('core.Company',    ('company_code', 'legal_name', 'trade_name', 'gstin')),
        # Customer resolves WITHIN the row's company — the same customer
        # name legitimately exists under two companies (e.g. Greenstar
        # North under UAI and SSB), and an unscoped .first() would
        # attach both companies' price lists to whichever record sorts
        # first.
        'customer': ('master.Customer', ('customer_code', 'customer_name', 'gstin'),
                     {'scope_field': 'company', 'scope_attr': 'company_id'}),
    }
    # A blank Status column defaults to ACTIVE, not the model's DRAFT.
    # Imported price lists are meant to be used immediately; leaving them
    # DRAFT made them invisible to for_customer (which serves only ACTIVE
    # lists) while the list badge still showed "Active" — a silent trap.
    import_defaults = {'status': 'ACTIVE'}

    # Flatten price-list line items into the export sheet. Each parent
    # row produces N rows (one per line, parent cells repeated); parents
    # with no lines emit one row so they don't disappear from the file.
    _price_line_columns = [
        ('Product',             'product'),
        ('Customer Brand Name', 'customer_trade_name'),
        ('UOM',                 'uom'),
        ('State Group',         'state_group'),
        ('Packing',             'packing'),
        ('HSN Code',            'hsn_code'),
        ('Rate',                'rate'),
        ('Discount %',          'discount'),
        ('GST %',               'gst'),
        ('SGST %',              'sgst_rate'),
        ('CGST %',              'cgst_rate'),
        ('IGST %',              'igst_rate'),
    ]
    _price_line_fk_resolvers = {
        'product':     ('master.Product',    ('sku_code', 'product_name')),
        'state_group': ('master.StateGroup', ('name',)),
    }
    export_line_relation = 'price_lines'
    export_line_columns = _price_line_columns
    export_line_fk_resolvers = _price_line_fk_resolvers
    # Mirror the export shape on import — the upload sheet may carry
    # one row per line (parent cells repeated), matching the file the
    # export endpoint produces. Rows are grouped by `price_list_id`
    # so consecutive rows for the same price list collapse into ONE
    # parent + nested `price_lines` payload that PriceListSerializer
    # already accepts as a nested write.
    import_line_relation = 'price_lines'
    import_line_columns = _price_line_columns
    import_line_fk_resolvers = _price_line_fk_resolvers
    import_parent_unique_field = 'price_list_id'
    # Re-importing a corrected sheet UPDATES an existing price list (by
    # price_list_id) — header overwritten, lines fully replaced — instead
    # of failing "already exists". Makes the import idempotent and repairs
    # price lists created by earlier buggy runs (e.g. wrong customer link).
    import_upsert_field = 'price_list_id'

    def get_queryset(self):
        qs = PriceList.objects.select_related('company', 'customer')
        if self.action == 'list':
            # The list view renders header columns only (no nested lines),
            # so skip the heavy price_lines prefetch and get the count in
            # one grouped query instead of a per-row .count().
            qs = qs.annotate(line_count=Count('price_lines'))
        else:
            # Detail / create / update / for_customer serialize the nested
            # lines — prefetch product AND state_group so PriceLineSerializer
            # doesn't N+1 on `state_group_name`.
            qs = qs.prefetch_related(
                'price_lines', 'price_lines__product', 'price_lines__state_group',
            )
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True)
        return qs

    def get_serializer_class(self):
        if self.action == 'retrieve':
            return PriceListDetailSerializer
        if self.action == 'list':
            return PriceListListSerializer
        return PriceListSerializer

    @action(detail=False, methods=['get'])
    def for_customer(self, request):
        """Get price lists for a customer.

        Optional `company_id` query param scopes the result to that
        company's price lists (plus company-agnostic ones), so the
        Customer PO auto-extractor can pick the right list when the
        same customer has lists under multiple companies.
        """
        customer_id = request.query_params.get('customer_id')
        if not customer_id:
            return Response(
                {'error': 'customer_id query parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        company_id = request.query_params.get('company_id') or None
        price_lists = get_price_lists_for_customer(customer_id, company=company_id)
        serializer = self.get_serializer(price_lists, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def add_line(self, request, pk=None):
        """Add price line to price list."""
        price_list = self.get_object()
        serializer = PriceLineSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save(price_list=price_list)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['get'])
    def lines(self, request, pk=None):
        """Get price lines in price list."""
        price_list = self.get_object()
        lines = price_list.price_lines.all()
        serializer = PriceLineSerializer(lines, many=True)
        return Response(serializer.data)


class PriceLineViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for PriceLine management."""

    serializer_class = PriceLineSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['price_list', 'product']

    def get_queryset(self):
        qs = PriceLine.objects.select_related('price_list', 'product')
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True)
        return qs

    # Lines reference an existing price list (by price_list_id) and an
    # existing product (by sku_code) — both resolved to UUIDs before
    # validation. The Customer Trade Name column lets one internal
    # Product be sold to many customers under their own brand names
    # (e.g. Azadirachtin 0.03 % → "Nimbecidine" for Customer A,
    # "Neem Gold" for Customer B).
    import_columns = [
        ('Price List ID',                                  'price_list'),
        (('SKU Code', 'Internal SKU'),                     'product'),
        (('Customer Trade Name', 'Brand Name', 'Sold As'), 'customer_trade_name'),
        ('UOM',                                            'uom'),
        ('Rate',                                           'rate'),
        ('Discount',                                       'discount'),
        ('GST',                                            'gst'),
        ('SGST Rate',                                      'sgst_rate'),
        ('CGST Rate',                                      'cgst_rate'),
        ('IGST Rate',                                      'igst_rate'),
        ('Valid From',                                     'valid_from'),
        ('Valid To',                                       'valid_to'),
    ]
    import_fk_resolvers = {
        'price_list': ('master.PriceList', 'price_list_id'),
        'product':    ('master.Product',   'sku_code'),
    }


class TaxMasterViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for TaxMaster management."""

    serializer_class = TaxMasterSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Tax Master'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['tax_type', 'company_scope']
    search_fields = ['section_reference', 'tax_type']
    ordering_fields = ['tax_type', 'rate', 'effective_from', 'created_at']
    ordering = ['-effective_from', 'tax_type']

    def get_queryset(self):
        qs = TaxMaster.objects.select_related('company_scope')
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True)
        return qs

    import_columns = [
        ('Tax Type',          'tax_type'),
        ('Rate',              'rate'),
        ('Company',           'company_scope'),
        ('Section Reference', 'section_reference'),
        ('Effective From',    'effective_from'),
        ('Effective To',      'effective_to'),
        ('Threshold Amount',  'threshold_amount'),
    ]
    import_fk_resolvers = {
        'company_scope': ('core.Company', ('company_code', 'legal_name', 'trade_name', 'gstin')),
    }

    @action(detail=False, methods=['get'])
    def by_company(self, request):
        """Get tax masters for a company."""
        company_id = request.query_params.get('company_id')
        if not company_id:
            return Response(
                {'error': 'company_id query parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        tax_masters = self.get_queryset().filter(company_scope_id=company_id)
        serializer = self.get_serializer(tax_masters, many=True)
        return Response(serializer.data)


class TemplateLibraryViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for TemplateLibrary management."""

    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Template'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['template_type', 'status']
    search_fields = ['template_id', 'name']
    ordering_fields = ['template_id', 'template_type', 'revision_no', 'created_at']
    ordering = ['template_type', '-revision_no']

    import_columns = [
        ('Template ID',     'template_id'),
        ('Template Type',   'template_type'),
        ('Name',            'name'),
        ('Revision No',     'revision_no'),
        ('Effective From',  'effective_from'),
        ('Effective To',    'effective_to'),
        ('Status',          'status'),
    ]

    def get_queryset(self):
        qs = TemplateLibrary.objects.prefetch_related(
            'warehouse_scope', 'approval_logs'
        )
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True)
        return qs

    def get_serializer_class(self):
        if self.action == 'retrieve':
            return TemplateLibraryDetailSerializer
        return TemplateLibrarySerializer

    @action(detail=False, methods=['get'])
    def by_type(self, request):
        """Get templates by type."""
        template_type = request.query_params.get('type')
        if not template_type:
            return Response(
                {'error': 'type query parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        templates = get_templates_by_type(template_type)
        serializer = self.get_serializer(templates, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def request_approval(self, request, pk=None):
        """Request approval for template."""
        template = self.get_object()
        approval_log = TemplateApprovalLog.objects.create(
            template=template,
            approval_status='PENDING',
            change_summary=request.data.get('change_summary', '')
        )

        # Alert everyone who can approve Templates that one is waiting.
        from notifications.services import notify_approvers
        template_label = getattr(template, 'name', None) or template.id
        notify_approvers(
            'Template',
            title=f'Template "{template_label}" awaiting approval',
            message=f'Template "{template_label}" was submitted for approval.',
            link=f'/masters/templates/{template.id}',
            exclude_user=request.user,
            actor=request.user,
        )

        serializer = TemplateApprovalLogSerializer(approval_log)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        """Approve template."""
        template = self.get_object()
        approval_log = template.approval_logs.filter(
            approval_status='PENDING'
        ).first()

        if not approval_log:
            return Response(
                {'error': 'No pending approval for this template'},
                status=status.HTTP_400_BAD_REQUEST
            )

        approval_log.approval_status = 'APPROVED'
        approval_log.approved_by_id = request.user.stakeholder_profile.id
        approval_log.approval_date = timezone.now()
        approval_log.save()

        template.status = 'ACTIVE'
        template.save()

        serializer = TemplateApprovalLogSerializer(approval_log)
        return Response(serializer.data)


class TemplateApprovalLogViewSet(viewsets.ModelViewSet):
    """ViewSet for TemplateApprovalLog management."""

    queryset = TemplateApprovalLog.objects.select_related('template', 'approved_by')
    serializer_class = TemplateApprovalLogSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['template', 'approval_status']


class BrokerViewSet(viewsets.ModelViewSet):
    """ViewSet for Broker master.

    Standard REST endpoints:
      list/create/retrieve/update/partial_update/destroy

    Filterable by ?broker_type=... and ?status=... and ?search=...
    Supports multipart upload for GST certificate / PAN copy / agreement
    attachments alongside JSON form data.
    """

    serializer_class = BrokerSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Broker'
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['broker_type', 'status', 'gst_applicable', 'tds_applicable']
    search_fields = [
        'broker_code', 'broker_name', 'contact_person',
        'mobile_number', 'email', 'gst_number', 'pan_number',
    ]
    ordering_fields = ['broker_name', 'broker_code', 'created_at']
    # 'id' is a TIE-BREAK, not a sort anyone asked for. Ordering by a single
    # column leaves rows that share a value in no defined order, and
    # LIMIT/OFFSET over an undefined order can hand the same row back on two
    # pages and never hand back another - so a list page that walks its pages
    # to collect every row may silently duplicate some and miss others. Seen
    # on Bills: a July window and the July slice of a full walk both returned
    # 884 rows, and they were not the same 884.
    #
    # It changes no value and no filter. Where rows tie, it fixes the order
    # they come back in instead of leaving it to chance.
    ordering = ['broker_name', 'id']

    def get_queryset(self):
        return Broker.objects.all().prefetch_related('preferred_vendors').select_related('assigned_purchase_manager')


class StateGroupViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for the StateGroup master used by state-wise pricing.

    Holds reusable named clusters of Indian states ("Tamilnadu,
    Pondicherry & Karnataka", "South States", "Rajasthan, UP, Haryana
    & Punjab", etc.). Referenced from PriceLine; the CPO→SO resolver
    picks the most specific group containing the buyer's state and
    falls back to the customer-wide default line when no group matches.
    """

    serializer_class = StateGroupSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'State Group'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['region', 'is_active']
    search_fields = ['name']
    ordering_fields = ['name', 'region']
    # 'id' is a TIE-BREAK, not a sort anyone asked for. Ordering by a single
    # column leaves rows that share a value in no defined order, and
    # LIMIT/OFFSET over an undefined order can hand the same row back on two
    # pages and never hand back another - so a list page that walks its pages
    # to collect every row may silently duplicate some and miss others. Seen
    # on Bills: a July window and the July slice of a full walk both returned
    # 884 rows, and they were not the same 884.
    #
    # It changes no value and no filter. Where rows tie, it fixes the order
    # they come back in instead of leaving it to chance.
    ordering = ['name', 'id']

    import_columns = [
        ('Name',          'name'),
        ('Member States', 'member_states'),  # comma- or JSON-list cell
        ('Region',        'region'),
        ('Notes',         'notes'),
    ]

    def get_queryset(self):
        qs = StateGroup.objects.all()
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True)
        return qs

    # POST /api/state-groups/resolve-from-address/
    # Convenience endpoint for the CPO form. Body: {address: "<text>"}.
    # Returns the resolved state code + the best matching state group
    # (most-specific membership wins). Same logic the auto-extractor
    # uses, surfaced here so the manual-entry flow can re-resolve when
    # the user edits the consignee address — keeping the dropdown in
    # sync without duplicating the address-parsing dictionary in JS.
    @action(detail=False, methods=['post'], url_path='resolve-from-address')
    def resolve_from_address(self, request):
        from .state_resolver import resolve_state_code, best_state_group_for
        addr = request.data.get('address') or ''
        code = resolve_state_code(addr)
        group = best_state_group_for(code) if code else None
        return Response({
            'state_code': code,
            'state_group_id': str(group.id) if group else '',
            'state_group_name': group.name if group else '',
        })


# ── Machinery Division ─────────────────────────────────────────────────
class MachineryDivisionViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for the Machinery Division master.

    Supports `?company=<id>&warehouse=<id>&godown=<id>` for cascading
    dropdowns on the create form.
    """

    serializer_class = MachineryDivisionSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Machinery Division'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['company', 'warehouse', 'godown', 'active_flag']
    search_fields = ['name']
    ordering_fields = ['name', 'created_at']
    # 'id' is a TIE-BREAK, not a sort anyone asked for. Ordering by a single
    # column leaves rows that share a value in no defined order, and
    # LIMIT/OFFSET over an undefined order can hand the same row back on two
    # pages and never hand back another - so a list page that walks its pages
    # to collect every row may silently duplicate some and miss others. Seen
    # on Bills: a July window and the July slice of a full walk both returned
    # 884 rows, and they were not the same 884.
    #
    # It changes no value and no filter. Where rows tie, it fixes the order
    # they come back in instead of leaving it to chance.
    ordering = ['name', 'id']

    # Importable columns. Godown is optional (a Division can span the
    # whole warehouse). FKs are resolved by the human-friendly code/name
    # so the operator works with labels instead of UUIDs.
    import_columns = [
        ('Company',   'company'),
        ('Warehouse', 'warehouse'),
        ('Godown',    'godown'),
        ('Name',      'name'),
        ('Notes',     'notes'),
    ]
    import_fk_resolvers = {
        'company':   ('core.Company',   ('company_code', 'legal_name', 'trade_name', 'gstin')),
        'warehouse': ('core.Warehouse', ('warehouse_code', 'name')),
        'godown':    ('core.Godown',    ('godown_code', 'godown_name')),
    }

    def get_queryset(self):
        qs = MachineryDivision.objects.select_related('company', 'warehouse', 'godown')
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True, active_flag=True)
        return qs


# ── Machinery Expense ──────────────────────────────────────────────────
class MachineryExpenseViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for the Machinery Expense master.

    Cascading filters: `?company=<id>&warehouse=<id>&category=<id>` so
    the operator can list expenses scoped to a location or rolled up
    under a single Expense Category.
    """

    serializer_class = MachineryExpenseSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Machinery Expense'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['company', 'warehouse', 'category', 'active_flag']
    search_fields = ['name']
    ordering_fields = ['name', 'created_at']
    # 'id' is a TIE-BREAK, not a sort anyone asked for. Ordering by a single
    # column leaves rows that share a value in no defined order, and
    # LIMIT/OFFSET over an undefined order can hand the same row back on two
    # pages and never hand back another - so a list page that walks its pages
    # to collect every row may silently duplicate some and miss others. Seen
    # on Bills: a July window and the July slice of a full walk both returned
    # 884 rows, and they were not the same 884.
    #
    # It changes no value and no filter. Where rows tie, it fixes the order
    # they come back in instead of leaving it to chance.
    ordering = ['name', 'id']

    # Importable columns. `Category` is a single FK to ExpenseCategory
    # — the importer resolves it case-insensitively against
    # ExpenseCategory.name, then stores the FK directly.
    import_columns = [
        ('Company',   'company'),
        ('Warehouse', 'warehouse'),
        ('Name',      'name'),
        ('Category',  'category'),
        ('Notes',     'notes'),
    ]
    import_fk_resolvers = {
        'company':   ('core.Company',         ('company_code', 'legal_name', 'trade_name', 'gstin')),
        'warehouse': ('core.Warehouse',       ('warehouse_code', 'name')),
        'category':  ('master.ExpenseCategory', 'name'),
    }

    def get_queryset(self):
        qs = (
            MachineryExpense.objects
            .select_related('company', 'warehouse', 'category')
        )
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True, active_flag=True)
        return qs


# ── Expense Category (read-only API; managed via Django admin) ────────
class ExpenseCategoryViewSet(viewsets.ReadOnlyModelViewSet):
    """List + retrieve only — categories are created / edited / deleted
    only from the Django admin panel per user request. Any non-GET
    request lands on a 405 Method Not Allowed via DRF's ReadOnlyModel
    ViewSet base class.

    Lookup-allowed (the matching module is added to LOOKUP_MODULES) so
    every authenticated user can fetch the list for the Machinery
    Expense form's checkbox panel without a per-role grant.
    """

    serializer_class = ExpenseCategorySerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Expense Category'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['active_flag']
    search_fields = ['name']
    ordering_fields = ['name', 'created_at']
    # 'id' is a TIE-BREAK, not a sort anyone asked for. Ordering by a single
    # column leaves rows that share a value in no defined order, and
    # LIMIT/OFFSET over an undefined order can hand the same row back on two
    # pages and never hand back another - so a list page that walks its pages
    # to collect every row may silently duplicate some and miss others. Seen
    # on Bills: a July window and the July slice of a full walk both returned
    # 884 rows, and they were not the same 884.
    #
    # It changes no value and no filter. Where rows tie, it fixes the order
    # they come back in instead of leaving it to chance.
    ordering = ['name', 'id']

    def get_queryset(self):
        qs = ExpenseCategory.objects.all()
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(active_flag=True, is_active=True)
        return qs


class MasterAttachmentViewSet(viewsets.ModelViewSet):
    """Manage file attachments (images / documents) for master records.

    Filtered by ?module=&record_id= like the sales attachment endpoint.
    Access piggybacks on authentication — anyone who can open the master
    form can attach reference images to it.
    """
    serializer_class = MasterAttachmentSerializer
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        qs = MasterAttachment.objects.filter(is_active=True)
        module = self.request.query_params.get('module')
        record_id = self.request.query_params.get('record_id')
        if module:
            qs = qs.filter(module=module)
        if record_id:
            qs = qs.filter(record_id=record_id)
        return qs

    def perform_create(self, serializer):
        uploaded_file = self.request.FILES.get('file')
        if not uploaded_file:
            raise ValidationError({'file': 'No file was uploaded.'})
        module = serializer.validated_data.get('module')
        record_id = serializer.validated_data.get('record_id')
        if MasterAttachment.objects.filter(
            is_active=True,
            module=module,
            record_id=record_id,
            file_name=uploaded_file.name,
            file_size=uploaded_file.size,
        ).exists():
            raise ValidationError({'file': f'"{uploaded_file.name}" is already attached to this record.'})
        serializer.save(
            uploaded_by=self.request.user,
            file_name=uploaded_file.name,
            file_size=uploaded_file.size,
            file_type=uploaded_file.content_type or '',
        )

    def perform_destroy(self, instance):
        instance.is_active = False
        instance.save(update_fields=['is_active', 'updated_at'])



# ── Party match preview ──────────────────────────────────────────────────────
# Read-only lookup used by the vendor/customer forms' "Also a customer / Also a
# vendor" checkbox: before the confirm popup, the form asks whether ticking the
# box will LINK to an existing counterpart master or CREATE a new one, and on
# what basis. It reuses the SAME precedence (GSTIN → PAN → name, within the
# given company) as master.party_linking so the preview and the real link agree.
from rest_framework.decorators import api_view, permission_classes as _permission_classes
from core.models import Company


@api_view(['GET'])
@_permission_classes([IsAuthenticated])
def party_match_preview(request):
    """GET /api/master/party-match/?role=<customer|vendor>&company=<id>&gstin=&pan=&name=

    ``role`` is the COUNTERPART to search for: role=customer searches Customer
    masters (used by the vendor form), role=vendor searches Vendor masters
    (used by the customer form). Returns
    {"matched": bool, "basis": "GSTIN"|"PAN"|"NAME"|None, "id": ..., "name": ...,
     "suggestions": [{"id","name","code"}, ...]}.

    ``matched`` is a deterministic (GSTIN / derived-PAN / exact-name) hit — the
    only thing eligible for an auto-create fallback. ``suggestions`` are LOOSE
    name candidates (spelling variants, role suffixes) offered for a HUMAN pick;
    they never auto-link.
    """
    from .party_linking import (
        find_matching_customer, find_matching_vendor,
        suggest_customers, suggest_vendors,
    )

    role = (request.query_params.get('role') or '').strip().lower()
    company_id = (request.query_params.get('company') or '').strip()
    gstin = request.query_params.get('gstin') or ''
    pan = request.query_params.get('pan') or ''
    name = request.query_params.get('name') or ''

    if role not in ('customer', 'vendor'):
        return Response({'detail': "role must be 'customer' or 'vendor'."},
                        status=status.HTTP_400_BAD_REQUEST)

    company = None
    if company_id:
        company = Company.objects.filter(pk=company_id).first()
    if company is None:
        # Without a company we cannot scope the search — report "no match"
        # rather than erroring, so the form falls back to the create message.
        return Response({'matched': False, 'basis': None, 'id': None,
                         'name': None, 'suggestions': []})

    if role == 'customer':
        hit, basis = find_matching_customer(company, gstin, pan, name)
        hit_name = hit.customer_name if hit else None
        suggestions = suggest_customers(
            company, name, limit=5, exclude_id=hit.pk if hit else None)
    else:
        hit, basis = find_matching_vendor(company, gstin, pan, name)
        hit_name = hit.vendor_name if hit else None
        suggestions = suggest_vendors(
            company, name, limit=5, exclude_id=hit.pk if hit else None)

    return Response({
        'matched': hit is not None,
        'basis': basis,
        'id': str(hit.pk) if hit else None,
        'name': hit_name,
        'suggestions': suggestions,
    })
