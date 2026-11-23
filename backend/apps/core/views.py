"""
Views for core app models.
"""
from rest_framework import viewsets, filters, status, serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated
from django.utils import timezone
from django_filters.rest_framework import DjangoFilterBackend
from rbac.permissions import HasModulePermission
from .models import (
    Company, Warehouse, Godown, RoleDefinition,
    ApprovalLevel, StakeholderUser, DeviationAck
)
from .serializers import (
    CompanySerializer, WarehouseSerializer, WarehouseDetailSerializer,
    GodownSerializer, RoleDefinitionSerializer,
    RoleDefinitionWriteSerializer, StakeholderUserSerializer,
    StakeholderUserDetailSerializer
)
from .selectors import (
    get_warehouses_for_user, get_companies, warehouse_scope_filter
)
# Shared Excel-import mixin lives in the master app. Reused here so
# Company / Warehouse / Godown get the same /import/ and
# /import-template/ endpoints as every other master ViewSet — the
# user wants one consistent flow across the whole Master module.
from master.import_mixin import BulkImportMixin, SoftDeleteMixin


class CompanyViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for Company management."""

    serializer_class = CompanySerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Company'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['is_active', 'default_currency']
    search_fields = ['company_code', 'legal_name', 'gstin', 'pan']
    ordering_fields = ['company_code', 'legal_name', 'created_at']
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
    ordering = ['company_code', 'id']

    def get_queryset(self):
        """Hide soft-deleted companies from the default list. Admins can
        still see them by passing `?show_all=true` — matches the existing
        Customer / Vendor pattern."""
        qs = Company.objects.all()
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True)
        return qs

    import_columns = [
        ('Company Code',        'company_code'),
        ('Legal Name',          'legal_name'),
        ('Trade Name',          'trade_name'),
        ('GSTIN',               'gstin'),
        ('PAN',                 'pan'),
        ('CIN',                 'cin'),
        ('Registered Address',  'registered_address'),
        ('Billing Address',     'billing_address'),
        ('Contact Email',       'contact_email'),
        ('Contact Phone',       'contact_phone'),
        ('Default Currency',    'default_currency'),
        ('Books Export Flag',   'books_export_flag'),
        ('Active From',         'active_from'),
        ('Active To',           'active_to'),
        ('Notes',               'notes'),
    ]
    # Both JSONField address columns ship in the readable
    # "Line | City | State | Pincode | Country" format on export and
    # are parsed back into dicts on import.
    import_address_fields = ('registered_address', 'billing_address')

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['request'] = self.request
        return context

    @action(detail=False, methods=['get'])
    def active_companies(self, request):
        """Get all active companies."""
        companies = get_companies(is_active=True)
        serializer = self.get_serializer(companies, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def warehouses(self, request, pk=None):
        """Get all warehouses for a company."""
        company = self.get_object()
        warehouses = company.warehouses.filter(active_flag=True)
        serializer = WarehouseSerializer(warehouses, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['get'], url_path='msme-receivables')
    def msme_receivables(self, request, pk=None):
        """Receivables where WE are the MSME supplier (A8), aged past the MSMED
        Act §15 'appointed day' (invoice date + 45 days), with a compound-monthly
        interest estimate at 3× the notified bank rate.

        Only meaningful when the company is MSME-registered. `rate` (annual %,
        default 18 ≈ 3× a ~6% bank rate) is an estimate and clearly labelled —
        the statutory rate tracks the RBI bank rate over the delay period. The
        computation now lives in core.deviations so the unified Deviations report
        reuses the exact same figures."""
        from .deviations import msme_receivable_report
        company = self.get_object()
        return Response(msme_receivable_report(
            company, request.query_params.get('rate')))


class WarehouseViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for Warehouse management."""

    serializer_class = WarehouseSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Warehouse'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['company', 'warehouse_type', 'state', 'active_flag']
    search_fields = ['warehouse_code', 'name', 'city']
    ordering_fields = ['warehouse_code', 'city', 'created_at']
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
    ordering = ['warehouse_code', 'id']

    import_columns = [
        ('Warehouse Code',    'warehouse_code'),
        ('Name',              'name'),
        ('Company',           'company'),
        ('Warehouse Type',    'warehouse_type'),
        ('Address',           'address'),
        ('City',              'city'),
        ('State',             'state'),
        ('Pincode',           'pincode'),
        ('Country',           'country'),
        ('Default Currency',  'default_currency'),
        ('Time Zone',         'time_zone'),
        ('Geo Latitude',      'geo_latitude'),
        ('Geo Longitude',     'geo_longitude'),
        ('Notes',             'notes'),
        ('Active Flag',       'active_flag'),
    ]
    import_fk_resolvers = {
        'company': ('core.Company', ('company_code', 'legal_name', 'trade_name', 'gstin')),
    }
    # Address is a JSONField on the model — exported in the readable
    # "Line | City | State | Pincode | Country" format and parsed back
    # into a dict on import. Matches the Vendor / Customer pattern so
    # users don't have to remember different formats per master.
    import_address_fields = ('address',)

    def get_queryset(self):
        """Return active warehouses for the caller.

        By default returns every active warehouse — purchase / inventory /
        master pages all need a full picker, and applying scoping
        globally would break legacy admin flows.

        Pages opt-in to per-user warehouse scoping by appending either
        `?scope=true` (generic — used by Production and any module) or the
        legacy `?sales_scope=true` (kept for the Sales pages that already
        pass it). Both trigger the same per-user warehouse-scope
        resolution (StakeholderUser.warehouse_scope, plus the Sales
        Manager / Office Manager / IT Admin / Finance / Accounts bypass
        roles). The result: a user assigned only to TVP sees only TVP in
        the scoped dropdown, while an unscoped `/api/warehouses/` call
        (Purchase / Inventory / Master pages) still returns everything.
        Warehouse scope is user-level — it applies the same across Sales,
        Purchase and Production — so the resolver is shared.
        """
        # warehouse_managers and godowns are counted by the list serializer,
        # once per row. Without the prefetch each warehouse costs two extra
        # queries; with it, .count() is answered from the rows already in hand
        # (a prefetched related manager's count() reads its own cache rather
        # than going back to the database).
        qs = Warehouse.objects.select_related('company').prefetch_related(
            'warehouse_managers', 'godowns',
        ).filter(
            active_flag=True
        ).order_by('warehouse_code')

        params = self.request.query_params
        scoped = (
            (params.get('scope') or '').lower() == 'true'
            or (params.get('sales_scope') or '').lower() == 'true'
        )
        if scoped:
            # Imported lazily to avoid pulling the Sales mixin into core
            # at module import time — keeps the Sales↔core dependency
            # one-directional (Sales depends on core, never the reverse).
            # The resolver is warehouse-scope-generic, not sales-specific.
            from sales.mixins import _user_allowed_warehouse_ids

            allowed = _user_allowed_warehouse_ids(self.request.user)
            if allowed is None:
                return qs  # bypass-roled user / superuser / legacy
            if not allowed:
                return qs.none()
            return qs.filter(pk__in=allowed)

        return qs

    def get_serializer_class(self):
        """Use detailed serializer for retrieve action."""
        if self.action == 'retrieve':
            return WarehouseDetailSerializer
        return self.serializer_class

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['request'] = self.request
        return context

    @action(detail=True, methods=['get'])
    def godowns(self, request, pk=None):
        """Get all godowns in warehouse."""
        warehouse = self.get_object()
        godowns = warehouse.godowns.all()
        serializer = GodownSerializer(godowns, many=True)
        return Response(serializer.data)

    @action(
        detail=False, methods=['post'], url_path='ensure-office',
        # The HR Staff form calls this when the operator picks "Office"
        # as Primary Location. Anyone authenticated who can interact
        # with Staff records should be able to call it — we don't want
        # to force the org to also grant Warehouse.can_create just so
        # HR can create new employees. Bypass the module check; the
        # underlying logic is idempotent (get-or-create per company)
        # so it can't be abused to spam-create warehouses.
        permission_classes=[IsAuthenticated],
    )
    def ensure_office(self, request):
        """Get-or-create a Head Office warehouse for the given company.

        POST body: {"company": "<uuid>"}

        Used by the HR Staff form's "Office" Primary-Location shortcut —
        rather than asking the operator to first create a warehouse with
        type=HEAD_OFFICE through the Master UI, the form calls this
        endpoint the moment "Office" is picked. We return the existing
        HEAD_OFFICE warehouse if the company already has one (matched by
        warehouse_type, not name), or create a fresh one with sensible
        defaults (name='Office', warehouse_code derived from the
        company's company_code). Auto-numbering handles the warehouse
        code being unique across the system.
        """
        company_id = request.data.get('company')
        if not company_id:
            return Response(
                {'error': 'company is required'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            company = Company.objects.get(pk=company_id)
        except Company.DoesNotExist:
            return Response(
                {'error': 'Company not found'},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Existing Head Office? Reuse it — never create duplicates per
        # company. Older deployments may have one with a non-default
        # name; we still surface it as the Office option.
        existing = Warehouse.objects.filter(
            company=company,
            warehouse_type='HEAD_OFFICE',
            active_flag=True,
        ).order_by('created_at').first()
        if existing:
            return Response(WarehouseSerializer(existing).data)

        # warehouse_code is max_length=10 AND unique across the table.
        # Earlier version used 'OFFICE-<company_code>' which blew past
        # the 10-char limit for any non-trivial company code and
        # tripped a DB 500 on save. We compress to a short prefix
        # ('OFC' + last 4 chars of company code) and bump a numeric
        # suffix if the resulting code is somehow already taken.
        co_code = (company.company_code or 'CO').upper().replace(' ', '').replace('-', '')
        tail = co_code[-4:] if len(co_code) >= 4 else co_code
        proposed = f'OFC-{tail}'[:10]
        code = proposed
        n = 1
        while Warehouse.objects.filter(warehouse_code=code).exists():
            n += 1
            # Keep total length <= 10 even with the suffix.
            suffix = str(n)
            code = f'{proposed[:10 - 1 - len(suffix)]}-{suffix}'

        try:
            warehouse = Warehouse.objects.create(
                company=company,
                warehouse_code=code,
                name='Office',
                warehouse_type='HEAD_OFFICE',
                address={},
                city='',
                state='',
                pincode='',
                country='India',
                active_flag=True,
            )
        except Exception as exc:
            # Surface the real reason so the frontend toast isn't
            # generic. The Render 500 page hid the DataError /
            # IntegrityError that originally caused this regression.
            return Response(
                {'error': f'Failed to create Office warehouse: {exc}'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            WarehouseSerializer(warehouse).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=['post'])
    def assign_managers(self, request, pk=None):
        """Assign warehouse managers."""
        warehouse = self.get_object()
        user_ids = request.data.get('user_ids', [])
        warehouse.warehouse_managers.set(user_ids)
        return Response(
            {'message': 'Managers assigned successfully'},
            status=status.HTTP_200_OK
        )

    @action(detail=False, methods=['get'])
    def user_warehouses(self, request):
        """Get warehouses accessible to current user."""
        warehouses = get_warehouses_for_user(request.user)
        serializer = self.get_serializer(warehouses, many=True)
        return Response(serializer.data)


class GodownViewSet(SoftDeleteMixin, BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for Godown management."""

    serializer_class = GodownSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Godown'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    # `warehouse` is intentionally NOT in filterset_fields — we apply
    # a custom name-based resolution in get_queryset (see below) so
    # both warehouse-by-id and warehouse-by-name work, AND so two
    # warehouse records that share a name (one per owning company)
    # collapse into a single pool of godowns for any dropdown that
    # asks by id.
    filterset_fields = ['storage_condition', 'active_flag']
    search_fields = ['godown_code', 'godown_name']
    ordering_fields = ['godown_code', 'storage_condition', 'created_at']
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
    ordering = ['godown_code', 'id']

    def get_queryset(self):
        # select_related the warehouse + its parent company so the
        # list serializer can emit warehouse_company_name without
        # firing one company query per row (N+1 on long godown lists).
        qs = Godown.objects.select_related('warehouse', 'warehouse__company').all()
        if self.request.query_params.get('show_all') != 'true':
            qs = qs.filter(is_active=True, active_flag=True)

        # Warehouse filter — accepts either a UUID OR a name. The UUID
        # form is what the DC modal / DC form pass (they hold the SO's
        # `warehouse` FK). We resolve that UUID to the warehouse's
        # NAME first, then match every godown whose linked warehouse
        # shares that name. This makes the dropdown company-agnostic:
        # if a customer keeps two warehouse rows both named "NKP"
        # (one per owning company), the godowns linked to either
        # warehouse show up regardless of which company's SO is being
        # dispatched. Pure name-based, never company-based.
        warehouse_param = self.request.query_params.get('warehouse', '').strip()
        if warehouse_param:
            # `warehouse` now also accepts a comma-separated list of
            # UUIDs / names so multi-warehouse pickers (e.g. the new
            # Stock Ledger filter bar) can hydrate the godown dropdown
            # for their full selection in one round-trip. Single-value
            # callers (DC form, SO dispatch modal) keep working — the
            # parsing collapses to the original "one warehouse" path
            # when there's no comma.
            parts = [p.strip() for p in warehouse_param.split(',') if p.strip()]
            names = []
            unresolved = []
            for part in parts:
                looks_like_uuid = len(part) == 36 and part.count('-') == 4
                resolved_name = ''
                if looks_like_uuid:
                    wh = Warehouse.objects.filter(pk=part).only('name').first()
                    if wh:
                        resolved_name = wh.name
                if resolved_name:
                    names.append(resolved_name)
                else:
                    # Treat the value as a name directly (older callers)
                    # OR keep it as a raw fk fallback id when we can't
                    # resolve it to a name.
                    names.append(part)
                    if looks_like_uuid:
                        unresolved.append(part)
            # Name-based pool covers both "passed a name" and
            # "passed a UUID we resolved to its name", and folds in
            # the same-named warehouse rows that exist per company.
            from django.db.models import Q
            cond = Q()
            for n in names:
                cond |= Q(warehouse__name__iexact=n)
            for raw_id in unresolved:
                cond |= Q(warehouse_id=raw_id)
            qs = qs.filter(cond)
        return qs

    import_columns = [
        ('Godown Code',            'godown_code'),
        ('Godown Name',            'godown_name'),
        ('Warehouse',              'warehouse'),
        ('Storage Condition',      'storage_condition'),
        ('Capacity UOM',           'capacity_uom'),
        ('Capacity Value',         'capacity_value'),
        ('Batch Tracking Enabled', 'batch_tracking_enabled'),
        ('Default QC Hold Area',   'default_qc_hold_area'),
        ('Active Flag',            'active_flag'),
        ('Notes',                  'notes'),
    ]
    import_fk_resolvers = {
        'warehouse': ('core.Warehouse', ('warehouse_code', 'name')),
    }

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['request'] = self.request
        return context

    @action(detail=False, methods=['get'])
    def warehouse_godowns(self, request):
        """Get godowns for a specific warehouse."""
        warehouse_id = request.query_params.get('warehouse_id')
        if not warehouse_id:
            return Response(
                {'error': 'warehouse_id query parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        godowns = self.get_queryset().filter(warehouse_id=warehouse_id)
        serializer = self.get_serializer(godowns, many=True)
        return Response(serializer.data)


class RoleDefinitionViewSet(viewsets.ModelViewSet):
    """ViewSet for RoleDefinition management."""

    queryset = RoleDefinition.objects.prefetch_related('approval_levels')
    serializer_class = RoleDefinitionSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Role Management'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['data_scope', 'active_flag']
    search_fields = ['role_code', 'role_name']
    ordering_fields = ['role_code', 'data_scope', 'created_at']
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
    ordering = ['role_code', 'id']

    def get_serializer_class(self):
        """Use write serializer for create/update."""
        if self.action in ['create', 'update', 'partial_update']:
            return RoleDefinitionWriteSerializer
        return RoleDefinitionSerializer

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['request'] = self.request
        return context

    @action(detail=False, methods=['get'])
    def by_scope(self, request):
        """Get roles by data scope."""
        scope = request.query_params.get('scope')
        if not scope:
            return Response(
                {'error': 'scope query parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        roles = self.get_queryset().filter(data_scope=scope, active_flag=True)
        serializer = self.get_serializer(roles, many=True)
        return Response(serializer.data)


class StakeholderUserViewSet(viewsets.ModelViewSet):
    """ViewSet for StakeholderUser management."""

    queryset = StakeholderUser.objects.select_related(
        'user', 'default_warehouse', 'employee_record'
    ).prefetch_related('assigned_roles', 'warehouse_scope')
    serializer_class = StakeholderUserSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'User Management'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['status', 'is_active']
    search_fields = ['user__username', 'primary_email', 'user__first_name', 'user__last_name']
    ordering_fields = ['user__username', 'primary_email', 'created_at']
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
    ordering = ['user__username', 'id']

    def get_serializer_class(self):
        """Use detailed serializer for retrieve action."""
        if self.action == 'retrieve':
            return StakeholderUserDetailSerializer
        return self.serializer_class

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['request'] = self.request
        return context

    def list(self, request, *args, **kwargs):
        """Backfill StakeholderUser profiles for any Django Users that
        don't have one yet, then list normally.

        Background: the admin user-create flow (`/api/rbac/users/`) now
        provisions a StakeholderUser at creation time, but plenty of
        existing Django Users predate that — they would otherwise stay
        invisible to the Sales > Data Permissions tab. Backfilling on
        every list call keeps the page truthful with one DB round-trip
        and a cheap bulk_create. ignore_conflicts makes it safe to run
        concurrently.
        """
        from django.contrib.auth import get_user_model
        User = get_user_model()
        existing_user_ids = set(
            StakeholderUser.objects.values_list('user_id', flat=True)
        )
        missing = (
            User.objects
            .filter(is_active=True)
            .exclude(id__in=existing_user_ids)
            .only('id', 'email')
        )
        new_profiles = [
            StakeholderUser(user=u, primary_email=u.email or '', status='ACTIVE')
            for u in missing
        ]
        if new_profiles:
            StakeholderUser.objects.bulk_create(new_profiles, ignore_conflicts=True)
        return super().list(request, *args, **kwargs)

    @action(detail=True, methods=['post'])
    def assign_roles(self, request, pk=None):
        """Assign roles to user."""
        stakeholder = self.get_object()
        role_ids = request.data.get('role_ids', [])
        stakeholder.assigned_roles.set(role_ids)
        return Response(
            {'message': 'Roles assigned successfully'},
            status=status.HTTP_200_OK
        )

    @action(detail=True, methods=['post'])
    def assign_warehouse_scope(self, request, pk=None):
        """Assign warehouse scope to user."""
        stakeholder = self.get_object()
        warehouse_ids = request.data.get('warehouse_ids', [])
        stakeholder.warehouse_scope.set(warehouse_ids)
        return Response(
            {'message': 'Warehouse scope assigned successfully'},
            status=status.HTTP_200_OK
        )

    @action(detail=False, methods=['get'])
    def active_users(self, request):
        """Get all active users."""
        users = self.get_queryset().filter(status='ACTIVE', is_active=True)
        serializer = self.get_serializer(users, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def my_warehouses(self, request):
        """Get warehouses accessible to current user."""
        if not hasattr(request.user, 'stakeholder_profile'):
            return Response(
                {'error': 'User does not have stakeholder profile'},
                status=status.HTTP_400_BAD_REQUEST
            )
        warehouses = request.user.stakeholder_profile.warehouse_scope.all()
        from .serializers import WarehouseSerializer
        serializer = WarehouseSerializer(warehouses, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'], url_path='me', permission_classes=[IsAuthenticated])
    def me(self, request):
        """Return the current user's own profile summary.

        Used by entry forms (e.g. Production Entry) to prefill the
        operator's primary company + warehouse so they don't have to
        pick it every time.

        The "primary location" concept the HR module surfaces on the
        Staff card is authoritative — Staff.primary_location and
        Staff.company. StakeholderUser.default_warehouse is a legacy
        secondary path retained as a fallback for accounts that
        aren't linked to an HR Staff record. Falls back to nulls if
        neither is set — callers should treat every field as optional.
        """
        profile = getattr(request.user, 'stakeholder_profile', None)
        empty = {
            'id': None,
            'default_warehouse': None,
            'default_warehouse_name': '',
            'default_company': None,
            'default_company_name': '',
        }
        if profile is None:
            return Response(empty)
        # Prefer the HR primary location if the user is linked to a
        # Staff record — that's what the HR module treats as canonical.
        staff = profile.employee_record
        wh = getattr(staff, 'primary_location', None) if staff else None
        company = getattr(staff, 'company', None) if staff else None
        # Legacy fallback for accounts without an HR link.
        if wh is None:
            wh = profile.default_warehouse
            company = wh.company if wh else None
        return Response({
            'id': profile.id,
            'user_id': profile.user_id,
            'username': profile.user.username,
            'default_warehouse': wh.id if wh else None,
            'default_warehouse_name': wh.name if wh else '',
            'default_company': company.id if company else None,
            'default_company_name': (company.trade_name or company.legal_name) if company else '',
        })


class SyncStatusView(APIView):
    """GET /api/sync-status/[?company=<id>]

    The last run of every sync action, for the "Last synced …" line beside
    each sync button. Returns one entry per (kind, company); with ?company it
    narrows to that company plus the company-agnostic ones.

    Shape: {"runs": [{"kind", "company", "finished_at", "status", "detail"}]}
    — ISO timestamps; the frontend renders "2 hours ago".
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from .models import SyncRun
        qs = SyncRun.objects.select_related('company')
        company = request.query_params.get('company') or None
        if company:
            from django.db.models import Q
            qs = qs.filter(Q(company_id=company) | Q(company__isnull=True))
        runs = [{
            'kind': r.kind,
            'company': str(r.company_id) if r.company_id else None,
            'company_name': r.company.legal_name if r.company_id else '',
            'finished_at': r.finished_at.isoformat(),
            'status': r.status,
            'detail': r.detail,
        } for r in qs.order_by('kind', 'company__legal_name')]
        return Response({'runs': runs})


class AppSettingsView(APIView):
    """GET   /api/app-settings/              -> {"settings": {<key>: <value>}}
    PATCH /api/app-settings/  {"key": val}  -> set allowed keys, return settings

    GLOBAL settings — ONE value shared by every user, not per-user. By product
    decision any signed-in user may both read AND write (the top-bar Tally chip
    exposes the toggle to everyone). That's safe because only the keys in
    APP_SETTING_DEFAULTS are accepted — unknown keys are ignored, so the open
    write can't be used to stash arbitrary data.
    """
    permission_classes = [IsAuthenticated]

    def _all(self):
        from .models import APP_SETTING_DEFAULTS, get_app_setting
        return {k: get_app_setting(k) for k in APP_SETTING_DEFAULTS}

    def get(self, request):
        return Response({'settings': self._all()})

    def patch(self, request):
        from .models import APP_SETTING_DEFAULTS, set_app_setting
        data = request.data if isinstance(request.data, dict) else {}
        changed = {}
        for key, raw in data.items():
            if key not in APP_SETTING_DEFAULTS:
                continue  # ignore unknown keys — allow-list only
            default = APP_SETTING_DEFAULTS[key]
            if isinstance(default, bool):
                val = raw if isinstance(raw, bool) else str(raw).strip().lower() in ('1', 'true', 'yes', 'on')
            else:
                val = raw
            set_app_setting(key, val, user=request.user)
            changed[key] = val
        if not changed:
            return Response(
                {'error': 'No known settings in payload.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response({'settings': self._all(), 'changed': changed})


# ── Unified Deviations report ────────────────────────────────────────────────
class DeviationsView(APIView):
    """GET /api/deviations/?company=<id>&period=&from=&to=&category=<KEY>

    Aggregates every deviation category (MSME payable/receivable, GSTR-1/2B,
    ERP↔Tally, exceptions) into one {summary, tabs} payload, with each row's
    acknowledge/resolve state overlaid. Pass `category` to fetch one tab lazily.
    """
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Deviations'

    def get(self, request):
        from .deviations import build_report
        company_id = request.query_params.get('company') or None
        company = Company.objects.filter(id=company_id).first() if company_id else None
        dfrom = request.query_params.get('from') or None
        dto = request.query_params.get('to') or None
        category = request.query_params.get('category') or None
        data = build_report(company, dfrom, dto, only_category=category)
        data['company_id'] = str(company.id) if company else None
        return Response(data)


class DeviationAckSerializer(serializers.ModelSerializer):
    resolved_by_name = serializers.CharField(source='resolved_by.username', read_only=True)
    created_by_name = serializers.CharField(source='created_by.username', read_only=True)

    class Meta:
        model = DeviationAck
        fields = ['id', 'category', 'dedup_key', 'company', 'status', 'note',
                  'snapshot', 'acknowledged_at', 'resolved_at', 'created_at',
                  'created_by_name', 'resolved_by_name']
        read_only_fields = ['id', 'created_at', 'acknowledged_at', 'resolved_at',
                            'created_by_name', 'resolved_by_name']


class DeviationAckViewSet(viewsets.ModelViewSet):
    """CRUD for acknowledge/resolve marks. POST upserts by (category, dedup_key)
    so re-acting on the same deviation mutates the one row. DELETE soft-clears
    it back to 'open'."""
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Deviations'
    serializer_class = DeviationAckSerializer
    queryset = DeviationAck.objects.filter(is_active=True)

    def get_queryset(self):
        qs = DeviationAck.objects.filter(is_active=True)
        company = self.request.query_params.get('company')
        category = self.request.query_params.get('category')
        if company:
            qs = qs.filter(company_id=company)
        if category:
            qs = qs.filter(category=category)
        return qs

    def create(self, request, *args, **kwargs):
        data = request.data
        category = data.get('category')
        key = data.get('dedup_key')
        if not category or not key:
            return Response({'detail': 'category and dedup_key are required'},
                            status=status.HTTP_400_BAD_REQUEST)
        status_val = data.get('status') or 'acknowledged'
        user = request.user if getattr(request.user, 'is_authenticated', False) else None
        now = timezone.now()
        obj, created = DeviationAck.objects.get_or_create(
            category=category, dedup_key=key,
            defaults={
                'company_id': data.get('company') or None,
                'status': status_val,
                'note': data.get('note') or '',
                'snapshot': data.get('snapshot') or {},
                'created_by': user,
            },
        )
        if not created:
            obj.status = status_val
            if data.get('note') is not None:
                obj.note = data.get('note')
            if data.get('snapshot'):
                obj.snapshot = data.get('snapshot')
            if data.get('company'):
                obj.company_id = data.get('company')
            obj.is_active = True
        if status_val == 'acknowledged' and not obj.acknowledged_at:
            obj.acknowledged_at = now
        if status_val == 'resolved':
            obj.resolved_at = now
            obj.resolved_by = user
        obj.save()
        return Response(self.get_serializer(obj).data,
                        status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)

    def perform_destroy(self, instance):
        # Soft-clear → the deviation reads as 'open' again.
        instance.is_active = False
        instance.save(update_fields=['is_active', 'updated_at'])
