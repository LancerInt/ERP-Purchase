"""ViewSets for purchase app API endpoints."""

import logging
from decimal import Decimal

from rest_framework import viewsets, status, filters, serializers as drf_serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView
from rest_framework.parsers import MultiPartParser, FormParser
from django_filters.rest_framework import DjangoFilterBackend
from master.import_mixin import BulkImportMixin
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date

logger = logging.getLogger(__name__)

from rbac.permissions import HasModulePermission, check_permission
from core.mixins import WarehouseScopedQuerysetMixin
from .scoping import user_allowed_requirement_types, scope_by_requirement_type
from rbac.models import AuditLog, UserRoleAssignment
from notifications.services import notify_user, notify_approvers, notify_users

from .models import (
    PurchaseRequest, PRLine, PRApprovalTrail, RFQHeader, QuoteResponse, QuoteLine,
    QuoteEvaluation, ComparisonEntry, PurchaseOrder, POLine,
    ReceiptAdvice, ReceiptLine, PackingMaterialLine, FreightDetail,
    VendorPaymentAdvice, FreightAdviceInbound,
    VendorBill, PaymentMade, VendorCredit,
    PurchaseAttachment, VendorProductMapping,
)
from .serializers import (
    PurchaseRequestSerializer, RFQHeaderSerializer,
    QuoteResponseSerializer, QuoteEvaluationSerializer,
    PurchaseOrderSerializer, ReceiptAdviceSerializer,
    VendorPaymentAdviceSerializer, FreightAdviceInboundSerializer,
    PurchaseAttachmentSerializer, VendorProductMappingSerializer,
    _fmt_address,
)
from .services import (
    PurchaseRequestService, RFQService, QuoteEvaluationService,
    PurchaseOrderService, ReceiptService, PaymentService
)
from .selectors import (
    PurchaseRequestSelectors, RFQSelectors, QuoteSelectors,
    PurchaseOrderSelectors, ReceiptSelectors, PaymentSelectors
)
from .quote_parser import QuoteParser


def get_user_role_name(user):
    """Get ERP role name for audit logging."""
    try:
        return UserRoleAssignment.objects.get(user=user).role.name
    except Exception:
        return 'Unknown'


def _trail_actor(user):
    """StakeholderUser behind a login user (reverse accessor is
    `stakeholder_profile`). None when the account has no profile — trail
    rows then rely on actor_label for display."""
    return getattr(user, 'stakeholder_profile', None)


# Human labels for the header fields the change trail diffs. Keys match
# _pr_snapshot()['header'].
_PR_HEADER_LABELS = (
    ('warehouse', 'Warehouse'),
    ('godown', 'Godown'),
    ('priority', 'Priority'),
    ('required_by_date', 'Required By'),
    ('justification', 'Justification'),
    ('notes', 'Notes'),
    ('requirement_type', 'Requirement Type'),
    ('requestor_role', 'Requestor Role'),
    ('sales_order', 'Sales Order Ref'),
)


def _pr_snapshot(pr):
    """Display-ready state of a PR (header + lines keyed by line id) for the
    change trail. Every value is a plain string so before/after snapshots
    diff cleanly regardless of Decimal/date typing."""
    from .serializers import _line_item_name
    header = {
        'warehouse': pr.warehouse.name if pr.warehouse_id else '',
        'godown': pr.godown.godown_name if pr.godown_id else '',
        'priority': pr.priority or '',
        'required_by_date': str(pr.required_by_date) if pr.required_by_date else '',
        'justification': pr.justification or '',
        'notes': pr.notes or '',
        'requirement_type': pr.requirement_type or '',
        'requestor_role': pr.requestor_role or '',
        'sales_order': pr.sales_order.so_no if pr.sales_order_id else '',
    }
    lines = {}
    for ln in pr.lines.all():
        lines[str(ln.id)] = {
            'product': _line_item_name(ln),
            'quantity_requested': str(ln.quantity_requested),
            'uom': ln.uom or '',
            'category': ln.category or '',
        }
    return {'header': header, 'lines': lines}


def _pr_changes(before, after):
    """Flat display-ready diff between two _pr_snapshot() dicts:
    [{scope: 'header'|'line', label, old, new}]. Empty when the save
    changed nothing the trail tracks — callers skip the trail row then."""
    changes = []
    bh, ah = before.get('header', {}), after.get('header', {})
    for key, label in _PR_HEADER_LABELS:
        if bh.get(key, '') != ah.get(key, ''):
            changes.append({
                'scope': 'header', 'label': label,
                'old': bh.get(key, ''), 'new': ah.get(key, ''),
            })
    bl, al = before.get('lines', {}), after.get('lines', {})
    line_fields = (
        ('quantity_requested', 'Qty'), ('uom', 'UOM'), ('category', 'Category'),
    )
    for lid, b in bl.items():
        a = al.get(lid)
        if a is None:
            changes.append({
                'scope': 'line',
                'label': f"Line removed: {b.get('product') or 'item'}",
                'old': f"{b.get('quantity_requested', '')} {b.get('uom', '')}".strip(),
                'new': '',
            })
            continue
        name = a.get('product') or b.get('product') or 'item'
        for key, word in line_fields:
            if b.get(key, '') != a.get(key, ''):
                changes.append({
                    'scope': 'line', 'label': f'{word} ({name})',
                    'old': b.get(key, ''), 'new': a.get(key, ''),
                })
    for lid, a in al.items():
        if lid not in bl:
            changes.append({
                'scope': 'line',
                'label': f"Line added: {a.get('product') or 'item'}",
                'old': '',
                'new': f"{a.get('quantity_requested', '')} {a.get('uom', '')}".strip(),
            })
    return changes


class PurchaseRequestViewSet(WarehouseScopedQuerysetMixin, viewsets.ModelViewSet):
    """ViewSet for Purchase Requests."""

    warehouse_field = 'warehouse'
    queryset = PurchaseRequest.objects.all()
    serializer_class = PurchaseRequestSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Request'
    filter_backends = [
        DjangoFilterBackend,
        filters.SearchFilter,
        filters.OrderingFilter
    ]
    filterset_fields = [
        'approval_status', 'warehouse', 'priority',
        'requirement_type', 'requested_by'
    ]
    search_fields = ['pr_no', 'justification']
    ordering_fields = ['request_date', 'required_by_date', 'priority']
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
    ordering = ['-request_date', '-id']

    # Roles that should NOT see DRAFT PRs (they only see approval-stage PRs)
    APPROVAL_ONLY_ROLES = {'Purchase Manager', 'Purchase Coordinator'}

    def get_queryset(self):
        from django.db.models import Exists, OuterRef
        from rest_framework.generics import GenericAPIView
        from .models import PurchaseOrder
        user = self.request.user
        role_name = None if user.is_superuser else get_user_role_name(user)
        is_approval_role = role_name in self.APPROVAL_ONLY_ROLES

        # Purchase Manager / Coordinator are PROCUREMENT roles that process
        # PRs company-wide. Detail access (get_object) already IGNORES
        # warehouse scope for them; the LIST must match, or a PR raised at
        # another warehouse is hidden from the list yet still openable via its
        # approval notification — which is exactly the confusing split users
        # hit. So bypass the warehouse mixin for these roles (call the plain
        # GenericAPIView queryset); warehouse-level roles still get scoped via
        # super().get_queryset(). Requirement-type scope is re-applied below
        # either way, so procurement roles stay limited to their allowed types.
        base = (GenericAPIView.get_queryset(self)
                if is_approval_role else super().get_queryset())

        # The list serializer reads several FK names + nested lines/trails and
        # computes has_po. Pull them in one go (select_related / prefetch_related)
        # and annotate has_po as an Exists subquery so the list endpoint doesn't
        # fire a query per row (was an N+1 that scaled with PR count).
        qs = (
            base
            .select_related(
                'warehouse', 'company', 'preferred_vendor', 'godown',
                'requested_by__user', 'approved_by', 'linked_rfq', 'sales_order',
            )
            .prefetch_related(
                'lines__product_service',
                'lines__service_catalogue',
                # PRLineSerializer.preferred_vendor_name reads
                # preferred_vendor.vendor_name on every LINE. Traced on
                # production: 365 separate vendor fetches for one page of 171
                # requests. Carried along with the lines instead.
                'lines__preferred_vendor',
                # ordered/balance_quantity iterate each line's PO lines in
                # python — prefetch them (with their PO for is_active) so the
                # list endpoint doesn't N+1.
                'lines__po_lines__po',
                'approval_trails__actor__user',
            )
            .annotate(_has_po=Exists(
                PurchaseOrder.objects.filter(linked_prs=OuterRef('pk'), is_active=True)
            ))
        )
        # Approval-only roles don't see DRAFT PRs (they only act from the
        # PENDING/approval stage onward).
        if is_approval_role:
            qs = qs.exclude(approval_status='DRAFT')
        # Requirement-type row scope: e.g. Purchase Coordinator sees only GOODS,
        # Warehouse Coordinator (Office) only MACHINERY (managers/superuser: all).
        qs = scope_by_requirement_type(qs, user, 'requirement_type')
        return qs

    def get_required_perm(self, request):
        """PR uses a 3-stage approval, each gated by its own flag:
        submit (Warehouse Coordinator) → proceed_to_approve (Warehouse
        Manager) → approve (Purchase Coordinator). Map those actions to
        their dedicated permission fields here — the GLOBAL ACTION_PERM_MAP
        maps `submit` to can_confirm (used by other modules), so this
        per-viewset override keeps PR's submit on its own can_submit flag.
        """
        action = getattr(self, 'action', None)
        if action == 'submit':
            return 'can_submit'
        if action == 'proceed_to_approve':
            return 'can_proceed_approval'
        return None  # fall through to ACTION_PERM_MAP / HTTP-method default

    def _guard_requirement_type(self, requirement_type):
        """Refuse a write whose requirement_type is outside the user's scope."""
        from rest_framework.exceptions import PermissionDenied
        allowed = user_allowed_requirement_types(self.request.user)
        if allowed is not None and requirement_type and requirement_type not in allowed:
            raise PermissionDenied(
                f"Your role can only manage {', '.join(sorted(allowed)).title()} "
                f"purchase requests."
            )

    def perform_create(self, serializer):
        self._guard_requirement_type(serializer.validated_data.get('requirement_type') or 'GOODS')
        super().perform_create(serializer)

    def perform_update(self, serializer):
        rt = serializer.validated_data.get(
            'requirement_type', getattr(serializer.instance, 'requirement_type', None))
        self._guard_requirement_type(rt)
        super().perform_update(serializer)

    def get_object(self):
        """Look a PR up for DETAIL operations without the list-only DRAFT
        exclusion in get_queryset().

        get_queryset() hides DRAFT PRs from APPROVAL_ONLY_ROLES so they
        don't clutter those roles' list view. But that same filter made
        detail endpoints (add-line, update-line, approve, edit…) 404 a
        coordinator's OWN just-created DRAFT PR — the create→add-line
        sequence failed with "No PurchaseRequest matches the given query"
        even though the PR exists. Detail lookups bypass the exclusion.
        """
        from rest_framework.generics import get_object_or_404
        obj = get_object_or_404(
            PurchaseRequest.objects.all(),
            pk=self.kwargs.get(self.lookup_field),
        )
        # Requirement-type scope also gates detail access (get_object bypasses
        # get_queryset above). Hide out-of-scope PRs as 404, like warehouse scope.
        allowed = user_allowed_requirement_types(self.request.user)
        if allowed is not None and obj.requirement_type not in allowed:
            from django.http import Http404
            raise Http404
        self.check_object_permissions(self.request, obj)
        return obj

    def _edit_blocked_response(self, request, pr):
        """Shared stage-aware edit gate — each stage's OWNER may correct the
        request before acting on it (every non-DRAFT edit requires a reason
        and writes an EDITED trail row, so nothing changes silently):
          * DRAFT — anyone with can_edit (the normal path)
          * PENDING — can_proceed_approval (Warehouse Manager, before
            "Proceed to Approve")
          * PENDING_APPROVAL — can_approve (Purchase Coordinator, before
            Approve/Reject — e.g. adjusting qty for rate-slab factors)
          * any status — superuser / office manager / admin.
        Returns a 403 Response when blocked, None when allowed."""
        if pr.approval_status == 'DRAFT' or request.user.is_superuser:
            return None
        if pr.approval_status == 'PENDING' and check_permission(
            request.user, 'Purchase Request', 'proceed_approval'
        ):
            return None
        if pr.approval_status == 'PENDING_APPROVAL' and check_permission(
            request.user, 'Purchase Request', 'approve'
        ):
            return None
        from rbac.views import _is_office_manager_or_admin
        if _is_office_manager_or_admin(request.user):
            return None
        return Response(
            {'error': 'Purchase Request can only be edited by its current '
                      'stage owner (DRAFT: requester, PENDING: Proceed-to-'
                      'Approve holder, PENDING APPROVAL: approver). Once '
                      'approved or rejected, only an administrator can edit.'},
            status=status.HTTP_403_FORBIDDEN,
        )

    def _edit_reason_or_response(self, request, pr):
        """A submitted (non-DRAFT) PR must not change silently — its EDITED
        trail row has to carry WHY. Returns (reason, None) when the edit may
        proceed, ('', 400 Response) when the reason is missing."""
        reason = (request.data.get('edit_reason') or '').strip()
        if pr.approval_status != 'DRAFT' and not reason:
            return '', Response(
                {'error': 'A reason is required when editing a submitted Purchase Request.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return reason, None

    def _record_edit_trail(self, request, pr, before, reason):
        """Append the EDITED trail row after a successful save. Refreshes the
        PR first so nested line writes are visible; no-op edits (empty diff)
        leave no row."""
        pr.refresh_from_db()
        changes = _pr_changes(before, _pr_snapshot(pr))
        if not changes:
            return
        PRApprovalTrail.objects.create(
            purchase_request=pr,
            action='EDITED',
            actor=_trail_actor(request.user),
            actor_label=request.user.get_username(),
            remarks=reason or '',
            changes=changes,
        )

    def update(self, request, *args, **kwargs):
        pr = self.get_object()
        blocked = self._edit_blocked_response(request, pr)
        if blocked is not None:
            return blocked
        reason, missing = self._edit_reason_or_response(request, pr)
        if missing is not None:
            return missing
        before = _pr_snapshot(pr)
        response = super().update(request, *args, **kwargs)
        if response.status_code < 400:
            self._record_edit_trail(request, pr, before, reason)
        return response

    def partial_update(self, request, *args, **kwargs):
        pr = self.get_object()
        blocked = self._edit_blocked_response(request, pr)
        if blocked is not None:
            return blocked
        reason, missing = self._edit_reason_or_response(request, pr)
        if missing is not None:
            return missing
        before = _pr_snapshot(pr)
        response = super().partial_update(request, *args, **kwargs)
        if response.status_code < 400:
            self._record_edit_trail(request, pr, before, reason)
        return response

    @action(detail=False, methods=['post'])
    def pending_for_warehouse(self, request):
        """Get pending PRs for a warehouse."""
        warehouse_id = request.query_params.get('warehouse_id')
        days = request.query_params.get('days', 30)

        if not warehouse_id:
            return Response(
                {'error': 'warehouse_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        prs = PurchaseRequestSelectors.get_pending_prs_for_warehouse(
            warehouse_id, int(days)
        )
        serializer = self.get_serializer(prs, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='add-line')
    def add_line(self, request, pk=None):
        """Add a line item to this PR."""
        pr = self.get_object()
        if pr.approval_status == 'APPROVED':
            return Response({'error': 'Cannot add lines to approved request'}, status=status.HTTP_400_BAD_REQUEST)
        if pr.approval_status == 'PENDING_APPROVAL' and not request.user.is_superuser:
            from rbac.views import _is_office_manager_or_admin
            if not _is_office_manager_or_admin(request.user):
                return Response({'error': 'Cannot modify PR submitted for approval'}, status=status.HTTP_403_FORBIDDEN)

        data = request.data
        line_no = pr.lines.count() + 1
        qty = data.get('quantity_requested', data.get('quantity', 1))

        # Resolve the FK on the line. Every selectable item now comes
        # from the Product master (the PR form's Requirement Type maps
        # to Product.product_type — Goods / Machinery / Services /
        # Expense), so `product_service` is the canonical field. The
        # legacy `service_catalogue` payload key is still accepted for
        # backwards-compatibility with any caller that hasn't migrated yet.
        from .models import PRLine
        from master.models import Product, ServiceCatalogue

        req_type = (pr.requirement_type or 'GOODS').upper()
        product_obj = None
        service_obj = None
        default_uom = 'KG'

        product_id = data.get('product_service') or data.get('product')
        if product_id:
            try:
                product_obj = Product.objects.get(pk=product_id)
                default_uom = product_obj.uom or 'KG'
            except Product.DoesNotExist:
                return Response({'error': 'Product not found'}, status=status.HTTP_400_BAD_REQUEST)
        else:
            # Backward-compat path for older frontends that still send
            # service_catalogue IDs directly.
            service_id = data.get('service_catalogue')
            if service_id:
                try:
                    service_obj = ServiceCatalogue.objects.get(pk=service_id)
                except ServiceCatalogue.DoesNotExist:
                    return Response({'error': 'Service not found.'}, status=status.HTTP_400_BAD_REQUEST)
            else:
                return Response(
                    {'error': 'product_service is required.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Validate category against PR's requirement_type before creating the line
        category = (data.get('category') or '').strip()
        if not category:
            return Response({'error': 'Category is required for every line item.'}, status=status.HTTP_400_BAD_REQUEST)
        if req_type == 'GOODS' and category not in ('RAW_MATERIAL', 'PACKING_MATERIAL', 'FINISHED_GOODS'):
            return Response(
                {'error': 'When Requirement Type is Goods, Category must be Raw Material, Packing Material, or Finished Goods.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        line = PRLine.objects.create(
            purchase_request=pr,
            line_no=data.get('line_no', line_no),
            category=category,
            product_service=product_obj,
            service_catalogue=service_obj,
            quantity_requested=qty,
            uom=data.get('uom', default_uom),
            description_override=data.get('description_override', data.get('description', '')),
            purpose=data.get('purpose', ''),
            status='PENDING',
        )

        from .serializers import PRLineSerializer
        return Response(PRLineSerializer(line).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['patch'], url_path='update-line/(?P<line_id>[^/.]+)')
    def update_line(self, request, pk=None, line_id=None):
        """Update a line item on this PR."""
        pr = self.get_object()
        if pr.approval_status == 'APPROVED':
            return Response({'error': 'Cannot update lines on approved request'}, status=status.HTTP_400_BAD_REQUEST)
        if pr.approval_status == 'PENDING_APPROVAL' and not request.user.is_superuser:
            from rbac.views import _is_office_manager_or_admin
            if not _is_office_manager_or_admin(request.user):
                return Response({'error': 'Cannot modify PR submitted for approval'}, status=status.HTTP_403_FORBIDDEN)
        try:
            line = pr.lines.get(id=line_id)
            data = request.data
            if 'category' in data:
                category = (data.get('category') or '').strip()
                req_type = (pr.requirement_type or 'GOODS').upper()
                if not category:
                    return Response({'error': 'Category is required for every line item.'}, status=status.HTTP_400_BAD_REQUEST)
                if req_type == 'GOODS' and category not in ('RAW_MATERIAL', 'PACKING_MATERIAL', 'FINISHED_GOODS'):
                    return Response(
                        {'error': 'When Requirement Type is Goods, Category must be Raw Material, Packing Material, or Finished Goods.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                line.category = category
            if 'quantity_requested' in data:
                line.quantity_requested = data['quantity_requested']
            if 'uom' in data:
                line.uom = data['uom']
            if 'description_override' in data:
                line.description_override = data['description_override']
            if 'purpose' in data:
                line.purpose = data['purpose']
            if 'product_service' in data:
                from master.models import Product
                line.product_service = Product.objects.get(pk=data['product_service'])
            line.save()
            from .serializers import PRLineSerializer
            return Response(PRLineSerializer(line).data)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['delete'], url_path='remove-line/(?P<line_id>[^/.]+)')
    def remove_line(self, request, pk=None, line_id=None):
        """Remove a line item from this PR."""
        pr = self.get_object()
        if pr.approval_status == 'APPROVED':
            return Response({'error': 'Cannot remove lines from approved request'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            line = pr.lines.get(id=line_id)
            line.delete()
            return Response({'message': 'Line removed'})
        except Exception:
            return Response({'error': 'Line not found'}, status=status.HTTP_404_NOT_FOUND)

    @action(detail=True, methods=['post'], url_path='edit')
    def edit_record(self, request, pk=None):
        """Mark PR as edited after modifications."""
        pr = self.get_object()
        # Same stage-aware gate as PUT/PATCH — this action is what the UI's
        # Save actually calls, so it must honor the PENDING stage-owner
        # (Warehouse Manager) allowance too, not just DRAFT.
        blocked = self._edit_blocked_response(request, pr)
        if blocked is not None:
            return blocked
        reason, missing = self._edit_reason_or_response(request, pr)
        if missing is not None:
            return missing
        before = _pr_snapshot(pr)

        # Update fields from request.data
        serializer = self.get_serializer(pr, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()

        self._record_edit_trail(request, pr, before, reason)

        # A DRAFT stays DRAFT after editing (no EDITED status). Submitted
        # stages are PRESERVED — resetting a PENDING PR to DRAFT here used
        # to silently undo the Coordinator's Submit whenever the Warehouse
        # Manager edited before proceeding.
        if pr.approval_status == 'EDITED':
            pr.approval_status = 'DRAFT'
            pr.save(update_fields=['approval_status'])

        # Audit log
        AuditLog.objects.create(
            user=request.user,
            role_name=get_user_role_name(request.user),
            module_name='Purchase Request',
            action='EDIT',
            details=f'PR {pr.pr_no} edited and saved'
        )

        return Response(self.get_serializer(pr).data)

    @action(detail=True, methods=['post'])
    def submit(self, request, pk=None):
        """Stage 1 — the requester (e.g. Warehouse Coordinator) SUBMITS a
        draft PR. DRAFT/EDITED → PENDING. Gated by can_submit."""
        pr = self.get_object()
        if pr.approval_status not in ('DRAFT', 'EDITED'):
            return Response(
                {'error': 'Only Draft or Edited requests can be submitted'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        pr.approval_status = 'PENDING'
        pr.save(update_fields=['approval_status'])
        PRApprovalTrail.objects.create(
            purchase_request=pr,
            action='SUBMITTED',
            actor=_trail_actor(request.user),
            actor_label=request.user.get_username(),
        )
        notify_approvers(
            'Purchase Request',
            title=f'PR {pr.pr_no} submitted',
            message=f'{get_user_role_name(request.user) or request.user.get_username()} '
                    f'submitted Purchase Request {pr.pr_no}. Awaiting Warehouse Manager review.',
            link=f'/purchase/requests/{pr.id}',
            exclude_user=request.user, actor=request.user, level='info',
        )
        return Response(self.get_serializer(pr).data)

    @action(detail=True, methods=['post'], url_path='proceed-to-approve')
    def proceed_to_approve(self, request, pk=None):
        """Stage 2 — the Warehouse Manager advances a submitted PR to the
        final approver. PENDING → PENDING_APPROVAL. Gated by
        can_proceed_approval. (DRAFT/EDITED still accepted so an admin can
        push a PR straight through.)"""
        pr = self.get_object()
        if pr.approval_status not in ('PENDING', 'DRAFT', 'EDITED'):
            return Response(
                {'error': 'Only a submitted request can proceed to approval'},
                status=status.HTTP_400_BAD_REQUEST
            )
        pr.approval_status = 'PENDING_APPROVAL'
        pr.save(update_fields=['approval_status'])
        PRApprovalTrail.objects.create(
            purchase_request=pr,
            action='PROCEEDED',
            actor=_trail_actor(request.user),
            actor_label=request.user.get_username(),
        )

        # Notify everyone who can approve Purchase Requests that one is
        # waiting on them (role-targeted; submitter excluded).
        notify_approvers(
            'Purchase Request',
            title=f'PR {pr.pr_no} awaiting approval',
            message=f'{get_user_role_name(request.user) or request.user.get_username()} '
                    f'moved Purchase Request {pr.pr_no} for final approval.',
            link=f'/purchase/requests/{pr.id}',
            exclude_user=request.user,
            actor=request.user,
            level='info',
        )

        return Response(self.get_serializer(pr).data)

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        """Approve a PR — routing each product to an RFQ or a direct PO.

        The approver decides PER LINE: a product with a known single vendor is
        routed to SKIP (a direct DRAFT PO, one per vendor via _create_skip_pos)
        while products that need competitive quotes are routed to RFQ. Both can
        coexist on the same PR — the skip lines cut PO(s) now, the RFQ lines
        create one RFQ.

        Optional payload::

            line_routes = {
              "<pr_line_id>": {"route": "SKIP"|"RFQ", "vendor": "<vendor_id>",
                               "unit_price": "..", "quantity": ".."}, ...
            }

        A line omitted (or route != SKIP) defaults to RFQ. When no line_routes
        is sent at all, behaviour is the legacy whole-PR fork on the header
        flag pr.allow_rfq_skip (RFQ for the whole PR unless it was configured
        to skip).
        """
        pr = self.get_object()

        # Validate state - must be PENDING_APPROVAL only (not DRAFT directly)
        if pr.approval_status not in ('PENDING_APPROVAL',):
            return Response(
                {'error': 'Only edited or pending requests can be approved'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Check permission — must have can_approve on Purchase Request.
        if not check_permission(request.user, 'Purchase Request', 'approve'):
            return Response(
                {'error': 'You do not have approval permission'},
                status=status.HTTP_403_FORBIDDEN
            )

        line_routes = request.data.get('line_routes') or {}

        # ── Pre-transaction: partition lines into SKIP / RFQ / HOLD and
        #    validate that every SKIP and HOLD line has a vendor (fail
        #    before any writes). HOLD = vendor is known but the unit price
        #    isn't yet — the line is saved with status=PENDING_PRICE and
        #    the operator converts it to a DRAFT PO later via the
        #    per-line /convert/ endpoint. ──
        skip_specs = []          # [{'line','vendor','unit_price','quantity'}]
        hold_specs = []          # [{'line','vendor','payment_terms','freight_terms','gst'}]
        rfq_line_exists = False
        company = None
        if line_routes:
            from master.models import Vendor
            company = pr.company if pr.company_id else (
                pr.warehouse.company if pr.warehouse and hasattr(pr.warehouse, 'company') else None)
            if not company:
                return Response({'error': 'Cannot determine company for PR'},
                                status=status.HTTP_400_BAD_REQUEST)
            vids = {str(r.get('vendor')) for r in line_routes.values()
                    if isinstance(r, dict) and (r.get('route') or '').upper() in ('SKIP', 'HOLD') and r.get('vendor')}
            vmap = ({str(v.id): v for v in Vendor.objects.filter(id__in=vids, active_flag=True)}
                    if vids else {})

            def _dec(val):
                try:
                    return Decimal(str(val)) if val not in (None, '') else None
                except Exception:  # noqa: BLE001
                    return None

            unassigned = []
            hold_unassigned = []
            for line in pr.lines.select_related(
                'product_service', 'service_catalogue', 'preferred_vendor'
            ):
                info = line_routes.get(str(line.id)) or {}
                route = (info.get('route') or 'RFQ').upper() if isinstance(info, dict) else 'RFQ'
                if route == 'SKIP':
                    vobj = vmap.get(str(info.get('vendor') or '')) or line.preferred_vendor
                    if vobj is None:
                        unassigned.append(line.line_no)
                        continue
                    q = _dec(info.get('quantity'))
                    # Optional per-line batch splitting — a 1500-unit line
                    # can be routed as three 500-unit DRAFT POs with
                    # distinct delivery dates for staggered arrivals.
                    # Payload shape: splits: [{quantity, delivery_date}, ...]
                    # When present it OVERRIDES `quantity` and produces N
                    # independent POs instead of joining the vendor group.
                    raw_splits = info.get('splits') if isinstance(info, dict) else None
                    parsed_splits = []
                    if isinstance(raw_splits, list) and raw_splits:
                        for i, sp in enumerate(raw_splits, start=1):
                            if not isinstance(sp, dict):
                                continue
                            sq = _dec(sp.get('quantity'))
                            if not sq or sq <= 0:
                                return Response({'error': (
                                    f'Line {line.line_no} split {i}: quantity must be greater than 0.'
                                )}, status=status.HTTP_400_BAD_REQUEST)
                            parsed_splits.append({
                                'quantity': sq,
                                'delivery_date': (sp.get('delivery_date') or '').strip() or None,
                            })
                        # Total across all splits must equal the line qty
                        # (approved qty override if given, else the PR
                        # line's requested qty). Guards a UI slip that
                        # would leave stock over- or under-committed.
                        target = q if (q and q > 0) else line.quantity_requested
                        total = sum(s['quantity'] for s in parsed_splits)
                        if target and abs(total - target) > Decimal('0.0001'):
                            return Response({'error': (
                                f'Line {line.line_no}: split quantities sum to {total} '
                                f'but the line quantity is {target}.'
                            )}, status=status.HTTP_400_BAD_REQUEST)
                    skip_specs.append({
                        'line': line, 'vendor': vobj,
                        'unit_price': _dec(info.get('unit_price')) or Decimal('0'),
                        'quantity': q if (q and q > 0) else None,
                        'gst': _dec(info.get('gst')) or Decimal('0'),
                        'payment_terms': (info.get('payment_terms') or '').strip(),
                        'freight_terms': (info.get('freight_terms') or '').strip(),
                        'splits': parsed_splits,  # empty list = no split
                    })
                elif route == 'HOLD':
                    vobj = vmap.get(str(info.get('vendor') or '')) or line.preferred_vendor
                    if vobj is None:
                        hold_unassigned.append(line.line_no)
                        continue
                    hold_specs.append({
                        'line': line, 'vendor': vobj,
                        'payment_terms': (info.get('payment_terms') or '').strip(),
                        'freight_terms': (info.get('freight_terms') or '').strip(),
                        'gst': _dec(info.get('gst')) or Decimal('0'),
                    })
                else:
                    rfq_line_exists = True
            if unassigned:
                return Response({'error': (
                    'Assign a vendor to every product routed to Skip RFQ. '
                    f'Line(s) without a vendor: {", ".join(map(str, unassigned))}.'
                )}, status=status.HTTP_400_BAD_REQUEST)
            if hold_unassigned:
                return Response({'error': (
                    'A held line needs a vendor even without a price. '
                    f'Line(s) without a vendor: {", ".join(map(str, hold_unassigned))}.'
                )}, status=status.HTTP_400_BAD_REQUEST)

        rfq = None
        created_pos = []
        with transaction.atomic():
            # PR-level status depends on whether any lines were HELD (i.e.,
            # will not be routed to a PO / RFQ right now). If yes, the PR
            # is PARTIALLY_APPROVED until every held line is converted via
            # the per-line /convert/ endpoint below. Otherwise it's a
            # normal full-approval.
            has_hold = bool(hold_specs)
            pr.approval_status = 'PARTIALLY_APPROVED' if has_hold else 'APPROVED'
            pr.approved_by = request.user
            pr.approved_at = timezone.now()
            pr.save(update_fields=['approval_status', 'approved_by', 'approved_at'])
            # Bulk-mark non-held lines as APPROVED; held ones flip to
            # PENDING_PRICE right after (they're a subset).
            pr.lines.update(status='APPROVED')

            # Line-level approval via service (partial approval, trail logging)
            try:
                stakeholder = getattr(request.user, 'stakeholder_profile', None)
                if stakeholder:
                    partial = request.data.get('partial', False)
                    approved_lines = request.data.get('approved_lines', {})
                    remarks = request.data.get('remarks', '')
                    PurchaseRequestService.approve_purchase_request(
                        pr, stakeholder, partial=partial,
                        approved_line_quantities=approved_lines, remarks=remarks
                    )
            except Exception:
                pass

            if line_routes:
                # Per-line split: mark skip lines + cut PO(s) by vendor, then
                # raise ONE RFQ for whatever lines were routed to RFQ.
                #
                # PARTIAL ROUTING: a SKIP line whose PO qty is less than
                # the PR line's requested qty leaves a residual on the PR.
                # The line stays PENDING_PRICE so the operator can come
                # back and route another PO for the balance later.
                # `has_partial_skip` propagates into the PR-status re-flip
                # below just like has_hold.
                has_partial_skip = False
                for spec in skip_specs:
                    ln = spec['line']
                    ln.allow_rfq_skip = True
                    ln.preferred_vendor = spec['vendor']
                    q = spec.get('quantity')  # None = full qty; else the operator's slice
                    line_qty = ln.quantity_requested or Decimal('0')
                    if q is not None and q > 0 and q < line_qty:
                        # Partial route — residual remains on the PR line.
                        ln.status = 'PENDING_PRICE'
                        ln.save(update_fields=['allow_rfq_skip', 'preferred_vendor', 'status'])
                        has_partial_skip = True
                    else:
                        ln.save(update_fields=['allow_rfq_skip', 'preferred_vendor'])
                # HOLD lines: save vendor (reuses preferred_vendor for the
                # future convert action) and flip status to PENDING_PRICE
                # so they're excluded from the RFQ + from `is_fully_approved`
                # checks until priced.
                #
                # Note: this runs AFTER the PurchaseRequestService service
                # call above, which unconditionally sets every line's
                # status to APPROVED and pr.approval_status to APPROVED.
                # We fix the line status here per row, and re-flip the PR
                # status below once every line has landed in its final
                # state — otherwise the PR stays at APPROVED even when
                # held lines still exist.
                for spec in hold_specs:
                    ln = spec['line']
                    ln.allow_rfq_skip = True
                    ln.preferred_vendor = spec['vendor']
                    ln.status = 'PENDING_PRICE'
                    ln.save(update_fields=['allow_rfq_skip', 'preferred_vendor', 'status'])
                # Re-derive PR status from actual line states so the
                # service call's clobber doesn't leave PARTIALLY_APPROVED
                # PRs looking APPROVED in the list.
                if (has_hold or has_partial_skip) and pr.approval_status != 'PARTIALLY_APPROVED':
                    pr.approval_status = 'PARTIALLY_APPROVED'
                    pr.save(update_fields=['approval_status'])
                created_pos = self._create_skip_pos(pr, skip_specs, company, request.user)
                if rfq_line_exists:
                    rfq = self._create_rfq_from_pr(pr, request.user)
                    if rfq:
                        pr.linked_rfq = rfq
                        pr.save(update_fields=['linked_rfq'])
                elif (skip_specs or hold_specs) and not pr.allow_rfq_skip:
                    # Whole PR skipped or on hold → set the header flag for
                    # the list badge; either way there's no RFQ to raise.
                    pr.allow_rfq_skip = True
                    pr.save(update_fields=['allow_rfq_skip'])
            else:
                # Legacy whole-PR fork on the header flag.
                if not pr.allow_rfq_skip:
                    rfq = self._create_rfq_from_pr(pr, request.user)
                    if rfq:
                        pr.linked_rfq = rfq
                        pr.save(update_fields=['linked_rfq'])

            # Audit log
            AuditLog.objects.create(
                user=request.user,
                role_name=get_user_role_name(request.user),
                module_name='Purchase Request',
                action='EDIT',
                details=(
                    f'PR {pr.pr_no} {"partially approved" if has_hold else "approved"}. '
                    + (f'RFQ {rfq.rfq_no} created. ' if rfq else '')
                    + (f'{len(created_pos)} PO(s) created via RFQ skip. ' if created_pos else '')
                    + (f'{len(hold_specs)} line(s) held pending price. ' if hold_specs else '')
                ).strip(),
            )

        # Tell the requester their PR went through (skip if they approved
        # their own). Outside the atomic block so a notification hiccup
        # can never roll back the approval.
        if pr.created_by_id and pr.created_by_id != request.user.id:
            notify_user(
                pr.created_by,
                title=f'PR {pr.pr_no} approved',
                message=f'Your Purchase Request {pr.pr_no} was approved.',
                link=f'/purchase/requests/{pr.id}',
                category='approval', level='success', actor=request.user,
            )

        return Response({
            'message': (f'Purchase Request {pr.pr_no} partially approved — '
                        f'{len(hold_specs)} line(s) held pending price.'
                        if hold_specs else
                        f'Purchase Request {pr.pr_no} approved successfully'),
            'rfq_no': rfq.rfq_no if rfq else None,
            'rfq_id': str(rfq.id) if rfq else None,
            'pos': [{'id': str(p.id), 'po_no': p.po_no,
                     'vendor_name': p.vendor.vendor_name if p.vendor else ''} for p in created_pos],
            'po_count': len(created_pos),
            'hold_count': len(hold_specs),
            'purchase_request': self.get_serializer(pr).data,
        })

    @action(detail=True, methods=['post'], url_path=r'lines/(?P<line_id>[0-9a-f-]+)/convert')
    def convert_held_line(self, request, pk=None, line_id=None):
        """Convert a PENDING_PRICE PR line to a DRAFT PO.

        Called from the PR detail page's "Set price & convert" modal on a
        line that was placed on HOLD during approval. Payload::

            { vendor, unit_price, quantity?, payment_terms?,
              freight_terms?, gst? }

        Creates a single-line DRAFT PO for the vendor (mirrors
        _create_skip_pos), flips the PR line status back to APPROVED, and
        — if this was the last held line — flips the parent PR from
        PARTIALLY_APPROVED to APPROVED.
        """
        pr = self.get_object()

        # Convert = supplement the PR with the missing price + create a
        # DRAFT PO. The DRAFT PO itself needs its own approval before
        # going to the vendor, so we don't require 'approve' on
        # Purchase Request here. Either 'edit' OR 'approve' on
        # Purchase Request is enough — this lets the Purchase
        # Coordinator who owns the PR finish the workflow without the
        # approver having to come back once the price arrives.
        if not (check_permission(request.user, 'Purchase Request', 'edit')
                or check_permission(request.user, 'Purchase Request', 'approve')):
            return Response(
                {'error': 'You do not have permission to convert PR lines.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        try:
            line = pr.lines.select_related(
                'product_service', 'service_catalogue', 'preferred_vendor'
            ).get(id=line_id)
        except PRLine.DoesNotExist:
            return Response({'error': 'PR line not found on this request.'},
                            status=status.HTTP_404_NOT_FOUND)

        # PENDING_PRICE is the normal held state. APPROVED + allow_rfq_skip
        # is the STRANDED state: the approve pass bulk-marks every line
        # APPROVED, and if the skip-PO for this line never materialised
        # (declined ₹0-price confirm, vendor unassigned, PO cancelled
        # later) it keeps an open residual with no route to a PO. Both are
        # convertible; the residual check below rejects fully-routed lines.
        if not (line.status == 'PENDING_PRICE'
                or (line.status == 'APPROVED' and line.allow_rfq_skip)):
            return Response(
                {'error': f'Only held (Pending Price) or RFQ-skip lines with an open '
                          f'residual can be converted. Line {line.line_no} is currently '
                          f'{line.status}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from master.models import Vendor

        def _dec(val):
            try:
                return Decimal(str(val)) if val not in (None, '') else None
            except Exception:  # noqa: BLE001
                return None

        # Vendor may be re-picked at convert time (operator might have
        # changed their mind); fall back to what was captured on approve.
        vendor_id = request.data.get('vendor') or (
            str(line.preferred_vendor_id) if line.preferred_vendor_id else ''
        )
        vendor = Vendor.objects.filter(id=vendor_id, active_flag=True).first()
        if vendor is None:
            return Response({'error': 'A valid vendor is required to convert the line.'},
                            status=status.HTTP_400_BAD_REQUEST)

        unit_price = _dec(request.data.get('unit_price'))
        if unit_price is None or unit_price <= 0:
            return Response({'error': 'A unit price greater than 0 is required.'},
                            status=status.HTTP_400_BAD_REQUEST)

        quantity = _dec(request.data.get('quantity'))
        if quantity is not None and quantity <= 0:
            return Response({'error': 'Quantity must be greater than 0 if provided.'},
                            status=status.HTTP_400_BAD_REQUEST)

        # Compute the residual open qty on this PR line: line qty minus
        # what's already been committed to active (non-cancelled/split)
        # POs. Convert can only consume up to that residual.
        from django.db.models import Sum
        already_routed = POLine.objects.filter(
            linked_pr_line=line,
        ).exclude(
            po__status__in=['CANCELLED', 'SPLIT'],
        ).aggregate(t=Sum('quantity_ordered'))['t'] or Decimal('0')
        residual = (line.quantity_requested or Decimal('0')) - already_routed
        if residual <= 0:
            return Response({'error': (
                f'Line {line.line_no} is fully routed already '
                f'({already_routed} of {line.quantity_requested} on active POs).'
            )}, status=status.HTTP_400_BAD_REQUEST)
        # If operator sent no qty, take the full residual (default).
        if quantity is None:
            quantity = residual
        if quantity > residual:
            return Response({'error': (
                f'Requested {quantity} but only {residual} remains on line {line.line_no} '
                f'(already routed: {already_routed} of {line.quantity_requested}).'
            )}, status=status.HTTP_400_BAD_REQUEST)

        company = pr.company if pr.company_id else (
            pr.warehouse.company if pr.warehouse and hasattr(pr.warehouse, 'company') else None)
        if not company:
            return Response({'error': 'Cannot determine company for PR'},
                            status=status.HTTP_400_BAD_REQUEST)

        spec = {
            'line': line, 'vendor': vendor,
            'unit_price': unit_price,
            'quantity': quantity,
            'gst': _dec(request.data.get('gst')) or Decimal('0'),
            'payment_terms': (request.data.get('payment_terms') or '').strip(),
            'freight_terms': (request.data.get('freight_terms') or '').strip(),
        }

        # Line stays PENDING_PRICE when a residual remains after this
        # convert; flips to APPROVED only when we've routed the full
        # requested qty (partial routing done).
        will_fully_route = quantity >= residual  # equal or clamp above
        with transaction.atomic():
            # Persist the (possibly-updated) vendor pick back onto the PR
            # line so the audit trail matches the actual PO.
            line.preferred_vendor = vendor
            line.status = 'APPROVED' if will_fully_route else 'PENDING_PRICE'
            line.save(update_fields=['preferred_vendor', 'status'])

            created_pos = self._create_skip_pos(pr, [spec], company, request.user)

            # If no PENDING_PRICE lines remain, the PR is fully approved
            # again — flip its status back to APPROVED so downstream
            # filters and dashboards see it as fully routed.
            still_held = pr.lines.filter(status='PENDING_PRICE').exists()
            if not still_held and pr.approval_status == 'PARTIALLY_APPROVED':
                pr.approval_status = 'APPROVED'
                pr.save(update_fields=['approval_status'])

            AuditLog.objects.create(
                user=request.user,
                role_name=get_user_role_name(request.user),
                module_name='Purchase Request',
                action='EDIT',
                details=(f'Held PR line {line.line_no} on {pr.pr_no} converted to '
                         f'DRAFT PO {created_pos[0].po_no if created_pos else "(?)"} '
                         f'for {vendor.vendor_name}.'),
            )

        return Response({
            'message': f'Line converted — DRAFT PO {created_pos[0].po_no} created.',
            'po_id': str(created_pos[0].id) if created_pos else None,
            'po_no': created_pos[0].po_no if created_pos else None,
            'pr_status': pr.approval_status,
        })

    @action(detail=True, methods=['post'], url_path=r'lines/convert-bulk')
    def convert_held_lines(self, request, pk=None):
        """Convert MULTIPLE PENDING_PRICE PR lines into ONE DRAFT PO.

        Same rules and permissions as convert_held_line, but all selected
        lines share a single vendor and land as lines of a single DRAFT
        PO — the "one vendor quoted everything" case (e.g. six carton-box
        sizes from the same packer) that would otherwise need N converts
        producing N POs. Payload::

            { vendor, payment_terms?, freight_terms?,
              lines: [ {id, unit_price, quantity?, gst?}, ... ] }

        Per-line quantity defaults to the line's open residual; a smaller
        qty leaves the balance open on the PR (same partial-routing
        semantics as the single-line convert).
        """
        pr = self.get_object()

        if not (check_permission(request.user, 'Purchase Request', 'edit')
                or check_permission(request.user, 'Purchase Request', 'approve')):
            return Response(
                {'error': 'You do not have permission to convert PR lines.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        lines_data = request.data.get('lines') or []
        if not isinstance(lines_data, list) or not lines_data:
            return Response({'error': 'Pick at least one line to convert.'},
                            status=status.HTTP_400_BAD_REQUEST)

        from master.models import Vendor
        vendor = Vendor.objects.filter(
            id=request.data.get('vendor') or None, active_flag=True,
        ).first()
        if vendor is None:
            return Response({'error': 'A valid vendor is required to convert the lines.'},
                            status=status.HTTP_400_BAD_REQUEST)

        company = pr.company if pr.company_id else (
            pr.warehouse.company if pr.warehouse and hasattr(pr.warehouse, 'company') else None)
        if not company:
            return Response({'error': 'Cannot determine company for PR'},
                            status=status.HTTP_400_BAD_REQUEST)

        def _dec(val):
            try:
                return Decimal(str(val)) if val not in (None, '') else None
            except Exception:  # noqa: BLE001
                return None

        from django.db.models import Sum
        payment_terms = (request.data.get('payment_terms') or '').strip()
        freight_terms = (request.data.get('freight_terms') or '').strip()

        # Validate every line up-front — all-or-nothing, so a typo on
        # line 3 doesn't leave lines 1-2 converted and the rest stranded.
        specs, line_updates = [], []
        seen_ids = set()
        for ld in lines_data:
            lid = str(ld.get('id') or '')
            if lid in seen_ids:
                continue
            seen_ids.add(lid)
            try:
                line = pr.lines.select_related(
                    'product_service', 'service_catalogue',
                ).get(id=lid)
            except Exception:  # noqa: BLE001 — DoesNotExist or malformed uuid
                return Response({'error': f'PR line {lid or "(blank)"} not found on this request.'},
                                status=status.HTTP_400_BAD_REQUEST)

            # Same rule as convert_held_line: PENDING_PRICE, or a stranded
            # APPROVED RFQ-skip line whose PO never materialised (residual
            # check below rejects fully-routed lines).
            if not (line.status == 'PENDING_PRICE'
                    or (line.status == 'APPROVED' and line.allow_rfq_skip)):
                return Response(
                    {'error': f'Only held (Pending Price) or RFQ-skip lines with an open '
                              f'residual can be converted. Line {line.line_no} is currently '
                              f'{line.status}.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            unit_price = _dec(ld.get('unit_price'))
            if unit_price is None or unit_price <= 0:
                return Response(
                    {'error': f'Line {line.line_no}: a unit price greater than 0 is required.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            already_routed = POLine.objects.filter(
                linked_pr_line=line,
            ).exclude(
                po__status__in=['CANCELLED', 'SPLIT'],
            ).aggregate(t=Sum('quantity_ordered'))['t'] or Decimal('0')
            residual = (line.quantity_requested or Decimal('0')) - already_routed
            if residual <= 0:
                return Response({'error': (
                    f'Line {line.line_no} is fully routed already '
                    f'({already_routed} of {line.quantity_requested} on active POs).'
                )}, status=status.HTTP_400_BAD_REQUEST)

            quantity = _dec(ld.get('quantity'))
            if quantity is None:
                quantity = residual
            if quantity <= 0:
                return Response({'error': f'Line {line.line_no}: quantity must be greater than 0.'},
                                status=status.HTTP_400_BAD_REQUEST)
            if quantity > residual:
                return Response({'error': (
                    f'Line {line.line_no}: requested {quantity} but only {residual} remains '
                    f'(already routed: {already_routed} of {line.quantity_requested}).'
                )}, status=status.HTTP_400_BAD_REQUEST)

            specs.append({
                'line': line, 'vendor': vendor,
                'unit_price': unit_price,
                'quantity': quantity,
                'gst': _dec(ld.get('gst')) or Decimal('0'),
                'payment_terms': payment_terms,
                'freight_terms': freight_terms,
            })
            line_updates.append((line, quantity >= residual))

        if not specs:
            return Response({'error': 'Pick at least one line to convert.'},
                            status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            for line, will_fully_route in line_updates:
                line.preferred_vendor = vendor
                line.status = 'APPROVED' if will_fully_route else 'PENDING_PRICE'
                line.save(update_fields=['preferred_vendor', 'status'])

            # All specs share one vendor → _create_skip_pos vendor-groups
            # them into exactly one DRAFT PO.
            created_pos = self._create_skip_pos(pr, specs, company, request.user)

            still_held = pr.lines.filter(status='PENDING_PRICE').exists()
            if not still_held and pr.approval_status == 'PARTIALLY_APPROVED':
                pr.approval_status = 'APPROVED'
                pr.save(update_fields=['approval_status'])

            line_nos = ', '.join(str(line.line_no) for line, _ in line_updates)
            AuditLog.objects.create(
                user=request.user,
                role_name=get_user_role_name(request.user),
                module_name='Purchase Request',
                action='EDIT',
                details=(f'Held PR lines {line_nos} on {pr.pr_no} converted together to '
                         f'DRAFT PO {created_pos[0].po_no if created_pos else "(?)"} '
                         f'for {vendor.vendor_name}.'),
            )

        return Response({
            'message': (f'{len(specs)} line{"s" if len(specs) != 1 else ""} converted — '
                        f'DRAFT PO {created_pos[0].po_no} created.'),
            'po_id': str(created_pos[0].id) if created_pos else None,
            'po_no': created_pos[0].po_no if created_pos else None,
            'pr_status': pr.approval_status,
        })

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        """Reject a purchase request. A reason is mandatory."""
        pr = self.get_object()
        if pr.approval_status == 'APPROVED':
            return Response(
                {'error': 'Cannot reject an approved request'},
                status=status.HTTP_400_BAD_REQUEST
            )

        remarks = (request.data.get('reason') or request.data.get('remarks') or '').strip()
        if not remarks:
            return Response(
                {'error': 'A reason is required to reject a Purchase Request.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        stakeholder = getattr(request.user, 'stakeholder_profile', None)

        with transaction.atomic():
            if stakeholder:
                pr = PurchaseRequestService.reject_purchase_request(pr, stakeholder, remarks=remarks)
            else:
                # Handle rejection without StakeholderUser
                for line in pr.lines.all():
                    line.status = 'REJECTED'
                    line.save()
                pr.approval_status = 'REJECTED'
                pr.save(update_fields=['approval_status'])
            # Persist the reason on the PR itself, whichever path ran above.
            pr.reject_reason = remarks
            pr.save(update_fields=['reject_reason'])

        AuditLog.objects.create(
            user=request.user,
            role_name=get_user_role_name(request.user),
            module_name='Purchase Request',
            action='EDIT',
            details=f'PR {pr.pr_no} rejected. Reason: {remarks}'
        )

        if pr.created_by_id and pr.created_by_id != request.user.id:
            notify_user(
                pr.created_by,
                title=f'PR {pr.pr_no} rejected',
                message=(f'Your Purchase Request {pr.pr_no} was rejected.'
                         + (f' Reason: {remarks}' if remarks else '')),
                link=f'/purchase/requests/{pr.id}',
                category='approval', level='danger', actor=request.user,
            )

        serializer = self.get_serializer(pr)
        return Response({
            'message': f'PR {pr.pr_no} rejected',
            'purchase_request': serializer.data,
        })

    def _create_skip_pos(self, pr, skip_specs, company, user):
        """One DRAFT PO per vendor from a SUBSET of skip-routed PR lines.

        skip_specs: list of {'line': PRLine, 'vendor': Vendor,
        'unit_price': Decimal, 'quantity': Decimal|None,
        'splits': [{'quantity','delivery_date'}, ...]  (empty = no split)}.

        Regular (unsplit) specs are vendor-grouped: one DRAFT PO per
        vendor bundles all that vendor's unsplit lines. Specs with a
        non-empty `splits` bypass the group entirely — each split
        produces its own DRAFT PO with a single PO line for the slice
        qty and (optionally) its own delivery date. This lets a PR
        line for 1500 units be routed as 3 x 500 POs for staggered
        delivery / cost management.
        """
        # Partition: unsplit -> vendor group; split -> individual POs.
        groups = {}  # vendor_id -> {'vendor': Vendor, 'specs': [unsplit specs]}
        split_specs = []
        for spec in skip_specs:
            if spec.get('splits'):
                split_specs.append(spec)
            else:
                v = spec['vendor']
                groups.setdefault(v.id, {'vendor': v, 'specs': []})['specs'].append(spec)

        created = []

        def _po_for(vendor, specs_for_terms):
            pay = next((s.get('payment_terms') for s in specs_for_terms if s.get('payment_terms')), '')
            frt = next((s.get('freight_terms') for s in specs_for_terms if s.get('freight_terms')), '')
            # Born APPROVED: a Skip-RFQ PO is created by the Purchase Coordinator
            # as part of approving the PR (vendor + price already decided there,
            # with the mandatory rate proof). Requiring a second PO approval
            # would just be the same person clicking Approve again. POs created
            # directly (outside this flow) still start DRAFT and need approving.
            po = PurchaseOrder(
                company=company, warehouse=pr.warehouse, vendor=vendor,
                currency='INR', status='APPROVED', terms_and_conditions='',
                payment_terms=pay, freight_terms=frt,
            )
            po.save()
            po.linked_prs.add(pr)
            return po

        # Unsplit lines — vendor-grouped, one PO per vendor.
        for grp in groups.values():
            vendor = grp['vendor']
            specs = grp['specs']
            po = _po_for(vendor, specs)
            for idx, spec in enumerate(specs, start=1):
                prl = spec['line']
                POLine.objects.create(
                    po=po, line_no=idx,
                    product_service=prl.product_service,
                    service_catalogue=prl.service_catalogue,
                    description=prl.description_override or '',
                    quantity_ordered=spec.get('quantity') or prl.quantity_requested,
                    uom=prl.uom or 'KG',
                    unit_price=spec.get('unit_price') or Decimal('0'),
                    gst=spec.get('gst') or Decimal('0'),
                    delivery_schedule=prl.required_date or pr.required_by_date,
                    linked_pr_line=prl, category=prl.category or '',
                )
            created.append(po)
            AuditLog.objects.create(
                user=user, role_name=get_user_role_name(user),
                module_name='Purchase Order', action='CREATE',
                details=(f'PO {po.po_no} created and auto-approved via per-line '
                         f'RFQ Skip from PR {pr.pr_no} for {vendor.vendor_name}'),
            )

        # Split lines — one PO per slice.
        for spec in split_specs:
            vendor = spec['vendor']
            prl = spec['line']
            slices = spec['splits']
            for idx, sl in enumerate(slices, start=1):
                po = _po_for(vendor, [spec])
                # Per-slice delivery override (falls back to line/pr).
                try:
                    from datetime import date as _date
                    dstr = sl.get('delivery_date')
                    slice_delivery = _date.fromisoformat(dstr) if dstr else None
                except Exception:  # noqa: BLE001
                    slice_delivery = None
                POLine.objects.create(
                    po=po, line_no=1,
                    product_service=prl.product_service,
                    service_catalogue=prl.service_catalogue,
                    description=prl.description_override or '',
                    quantity_ordered=sl['quantity'],
                    uom=prl.uom or 'KG',
                    unit_price=spec.get('unit_price') or Decimal('0'),
                    gst=spec.get('gst') or Decimal('0'),
                    delivery_schedule=(slice_delivery or prl.required_date
                                       or pr.required_by_date),
                    linked_pr_line=prl, category=prl.category or '',
                )
                created.append(po)
                AuditLog.objects.create(
                    user=user, role_name=get_user_role_name(user),
                    module_name='Purchase Order', action='CREATE',
                    details=(f'PO {po.po_no} created via per-line RFQ Skip from '
                             f'PR {pr.pr_no} for {vendor.vendor_name} '
                             f'(batch {idx}/{len(slices)}, qty {sl["quantity"]}).'),
                )
        return created

    def _create_rfq_from_pr(self, pr, user):
        """Auto-create RFQ from approved Purchase Request."""
        # Expected Quotes = the number of product lines this RFQ actually
        # covers (total lines minus the skip-routed ones, whose flags are
        # saved BEFORE this runs). A 3-line PR with 1 line skipped expects
        # quotes for 2 products — not a hardcoded 3.
        expected_quotes = pr.lines.filter(allow_rfq_skip=False).count() or 1
        try:
            # Try using the RFQService if stakeholder profile exists
            stakeholder = getattr(user, 'stakeholder_profile', None)
            if stakeholder:
                rfq = RFQService.generate_rfq_from_pr(
                    purchase_requests=[pr],
                    created_by=stakeholder,
                    rfq_mode='EMAIL',
                    quote_count_expected=expected_quotes,
                )
                return rfq
        except Exception:
            pass

        # Fallback: create RFQ directly
        from django.utils import timezone as tz
        year = tz.now().year
        prefix = f'RFQ-{year}-'
        last = RFQHeader.objects.filter(rfq_no__startswith=prefix).order_by('-rfq_no').first()
        if last:
            try:
                num = int(last.rfq_no.split('-')[-1]) + 1
            except (ValueError, IndexError):
                num = 1
        else:
            num = 1
        rfq_no = f'{prefix}{num:04d}'

        rfq = RFQHeader(rfq_no=rfq_no, rfq_mode='EMAIL', rfq_status='OPEN', quote_count_expected=expected_quotes)
        # created_by is a nullable FK to StakeholderUser — never assign the
        # raw auth User here (that raises ValueError).
        rfq.created_by = getattr(user, 'stakeholder_profile', None)
        rfq.save()

        # Link PR to RFQ
        if hasattr(rfq, 'linked_prs'):
            rfq.linked_prs.add(pr)

        return rfq

    @action(detail=True, methods=['get'], url_path='skip-rfq-po-data')
    def skip_rfq_po_data(self, request, pk=None):
        """Return PR data formatted for direct PO creation (skip RFQ flow)."""
        from .permissions import user_can_skip_rfq
        if not user_can_skip_rfq(request.user):
            return Response(
                {'error': 'You are not authorized to skip RFQ.'},
                status=status.HTTP_403_FORBIDDEN
            )
        pr = self.get_object()

        if pr.approval_status != 'APPROVED':
            return Response(
                {'error': 'Only approved PRs can skip RFQ to create PO'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Check if PO already exists for this PR via skip-RFQ
        existing_skip_pos = PurchaseOrder.objects.filter(
            linked_prs=pr,
            linked_rfq__isnull=True
        )
        if existing_skip_pos.exists():
            return Response(
                {'error': f'A skip-RFQ PO already exists for this PR: {existing_skip_pos.first().po_no}'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Prefer PR's persisted company; fall back to warehouse.company for legacy PRs.
        company_id = ''
        company_name = ''
        if pr.company_id:
            company_id = str(pr.company_id)
            try:
                company_name = pr.company.legal_name
            except Exception:
                pass
        elif pr.warehouse and getattr(pr.warehouse, 'company_id', None):
            company_id = str(pr.warehouse.company_id)
            try:
                company_name = pr.warehouse.company.legal_name
            except Exception:
                pass

        # Build line items from PR lines
        lines = []
        for line in pr.lines.all().select_related('product_service'):
            lines.append({
                'product': str(line.product_service_id) if line.product_service_id else '',
                'product_name': line.product_service.product_name if line.product_service else '',
                'product_code': line.product_service.sku_code if line.product_service else '',
                'description': line.description_override or '',
                'quantity': str(line.quantity_requested),
                'uom': line.uom or 'KG',
                'required_date': str(line.required_date) if line.required_date else '',
                'pr_line_id': str(line.id),
            })

        data = {
            'pr_id': str(pr.id),
            'pr_no': pr.pr_no,
            'warehouse': str(pr.warehouse_id) if pr.warehouse_id else '',
            'warehouse_name': pr.warehouse.name if pr.warehouse else '',
            'company': company_id,
            'company_name': company_name,
            'currency': 'INR',
            'notes': pr.notes or '',
            'required_by_date': str(pr.required_by_date) if pr.required_by_date else '',
            'lines': lines,
        }

        return Response(data)

    @action(detail=True, methods=['get'], url_path='preferred-vendors')
    def preferred_vendors(self, request, pk=None):
        """Return the union of preferred vendors across all line products of this PR.

        Used by the "Allow RFQ Skip" wizard to let the user pick a vendor before
        the PO is created. Each entry includes basic vendor info plus the list of
        line products that vendor is preferred for. Pricing/lead-time fields are
        returned as ``None`` until a VendorProduct through-model is added.
        """
        from .permissions import user_can_skip_rfq
        if not user_can_skip_rfq(request.user):
            return Response(
                {'error': 'You are not authorized to skip RFQ.'},
                status=status.HTTP_403_FORBIDDEN,
            )
        pr = self.get_object()

        # Map: vendor_id -> {vendor info, supplied_products: [{id, name, sku}]}
        vendors_map = {}
        for line in pr.lines.all().select_related('product_service'):
            product = line.product_service
            if not product:
                continue
            for v in product.preferred_vendors.filter(active_flag=True):
                # `freight_terms` was removed from the Vendor master —
                # it moved per-SO. Keep the key in the response for the
                # frontend but return empty so the wizard's render
                # doesn't break expecting a value.
                entry = vendors_map.setdefault(v.id, {
                    'id': str(v.id),
                    'vendor_code': v.vendor_code,
                    'vendor_name': v.vendor_name,
                    'gstin': v.gstin or '',
                    'contact_person': v.contact_person or '',
                    'contact_email': v.contact_email or '',
                    'contact_phone': v.contact_phone or '',
                    'payment_terms': v.payment_terms,
                    'freight_terms': '',
                    'supplied_products': [],
                    # Placeholders — populated once VendorProduct through-model exists.
                    'unit_price': None,
                    'currency': None,
                    'min_order_qty': None,
                    'lead_time_days': None,
                    'vendor_product_code': None,
                })
                entry['supplied_products'].append({
                    'id': str(product.id),
                    'name': product.product_name,
                    'sku_code': product.sku_code or '',
                    'pr_line_id': str(line.id),
                    'quantity': str(line.quantity_requested),
                    'uom': line.uom or '',
                })

        return Response({
            'pr_id': str(pr.id),
            'pr_no': pr.pr_no,
            'vendors': list(vendors_map.values()),
        })

    @action(detail=True, methods=['post'], url_path='configure-skip-rfq')
    def configure_skip_rfq(self, request, pk=None):
        """Mark the PR as skip-RFQ-eligible and persist the chosen preferred vendor.

        This does NOT create the PO. Flow:
            1. User opens the Allow RFQ Skip wizard, picks a vendor → this endpoint.
            2. User approves the PR.
            3. User clicks Create Purchase Order → ``skip_rfq_create_po`` endpoint.
        """
        from .permissions import user_can_skip_rfq
        if not user_can_skip_rfq(request.user):
            return Response(
                {'error': 'You are not authorized to skip RFQ.'},
                status=status.HTTP_403_FORBIDDEN,
            )
        pr = self.get_object()

        if pr.approval_status in ('REJECTED', 'CANCELLED'):
            return Response(
                {'error': 'Cannot configure RFQ skip on a rejected or cancelled Purchase Request.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if pr.linked_rfq_id:
            return Response(
                {'error': 'Cannot configure RFQ skip — an RFQ is already linked to this PR.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if PurchaseOrder.objects.filter(linked_prs=pr).exists():
            return Response(
                {'error': 'A Purchase Order already exists for this PR.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from master.models import Vendor
        vendor_id = request.data.get('vendor_id') or request.data.get('vendor')
        if not vendor_id:
            return Response(
                {'error': 'vendor_id is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            vendor = Vendor.objects.get(pk=vendor_id, active_flag=True)
        except Vendor.DoesNotExist:
            return Response(
                {'error': 'Selected vendor not found or inactive.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        pr.allow_rfq_skip = True
        pr.preferred_vendor = vendor
        pr.save(update_fields=['allow_rfq_skip', 'preferred_vendor'])

        AuditLog.objects.create(
            user=request.user,
            role_name=get_user_role_name(request.user),
            module_name='Purchase Request',
            action='EDIT',
            details=f'RFQ Skip configured on PR {pr.pr_no} with vendor {vendor.vendor_code}',
        )

        return Response({
            'message': f'RFQ Skip configured on PR {pr.pr_no}. Approve the PR to proceed.',
            'pr': PurchaseRequestSerializer(pr).data,
        })

    @action(detail=True, methods=['post'], url_path='skip-rfq-create-po')
    def skip_rfq_create_po(self, request, pk=None):
        """Skip RFQ: auto-approve the PR (if needed) and create the PO directly.

        Eligibility:
          * Caller is Admin / Purchase Manager / Purchase Coordinator (or superuser).
          * PR is not REJECTED / CANCELLED.
          * PR has no linked RFQ.
          * No PO already exists for this PR.
        """
        from .permissions import user_can_skip_rfq
        if not user_can_skip_rfq(request.user):
            return Response(
                {'error': 'You are not authorized to skip RFQ.'},
                status=status.HTTP_403_FORBIDDEN
            )
        pr = self.get_object()

        # State guards
        if pr.approval_status in ('REJECTED', 'CANCELLED'):
            return Response(
                {'error': 'Cannot skip RFQ on a rejected or cancelled Purchase Request.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        # DRAFT / PENDING PRs are accepted here — the transaction below
        # auto-approves them as part of the skip-RFQ contract. Only
        # callers with skip-RFQ rights (Admin / Purchase Manager /
        # Coordinator) reach this point, so approving on their behalf
        # is safe. The previous "must be APPROVED first" gate made the
        # one-shot "Allow RFQ Skip" submit flow on the PR create form
        # impossible — it always created the PR in DRAFT, then this
        # endpoint rejected it.
        if pr.linked_rfq_id:
            return Response(
                {'error': 'Cannot skip RFQ — an RFQ is already linked to this PR.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        if PurchaseOrder.objects.filter(linked_prs=pr).exists():
            existing = PurchaseOrder.objects.filter(linked_prs=pr).first()
            return Response(
                {'error': f'A Purchase Order already exists for this PR: {existing.po_no}'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Resolve a FALLBACK vendor (wizard choice, else the PR-header preferred
        # vendor). Individual lines may override it with their own
        # preferred_vendor; skip-RFQ then CLUBS lines by vendor → one PO each.
        from master.models import Vendor
        fallback_vendor = None
        vendor_id = request.data.get('vendor_id') or request.data.get('vendor')
        if vendor_id:
            try:
                fallback_vendor = Vendor.objects.get(pk=vendor_id, active_flag=True)
            except Vendor.DoesNotExist:
                return Response(
                    {'error': 'Selected vendor not found or inactive.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        elif pr.preferred_vendor_id:
            fallback_vendor = pr.preferred_vendor

        # Optional per-line vendor overrides from the skip wizard:
        # {pr_line_id: vendor_id}. Resolution order per line is
        # override → line.preferred_vendor → PR-level fallback vendor.
        line_vendors = request.data.get('line_vendors') or {}
        # Optional per-line unit prices typed in the wizard: {pr_line_id: price}.
        # Skip-RFQ has no quote, so the PO would otherwise be zero-priced — this
        # lets the user seed the price up front (still editable on the DRAFT PO).
        _prices_raw = request.data.get('line_prices') or {}
        price_map = {}
        for _k, _v in _prices_raw.items():
            try:
                price_map[str(_k)] = Decimal(str(_v)) if _v not in (None, '') else Decimal('0')
            except Exception:  # noqa: BLE001
                price_map[str(_k)] = Decimal('0')
        # Optional per-line ordered qty from the wizard: {pr_line_id: qty}.
        # Defaults to the PR's requested qty when blank/invalid.
        _qty_raw = request.data.get('line_qtys') or {}
        qty_map = {}
        for _k, _v in _qty_raw.items():
            try:
                _q = Decimal(str(_v)) if _v not in (None, '') else None
                if _q is not None and _q > 0:
                    qty_map[str(_k)] = _q
            except Exception:  # noqa: BLE001
                pass
        # Optional per-line GST% typed in the wizard: {pr_line_id: gst_percent}.
        # Skip-RFQ has no quote, so GST would otherwise default to 0 — this lets
        # the user seed the tax rate up front (still editable on the DRAFT PO).
        _gst_raw = request.data.get('line_gsts') or {}
        gst_map = {}
        for _k, _v in _gst_raw.items():
            try:
                gst_map[str(_k)] = Decimal(str(_v)) if _v not in (None, '') else Decimal('0')
            except Exception:  # noqa: BLE001
                gst_map[str(_k)] = Decimal('0')
        override_map = {}
        _ov_ids = {str(x) for x in line_vendors.values() if x}
        if _ov_ids:
            for _v in Vendor.objects.filter(id__in=_ov_ids, active_flag=True):
                override_map[str(_v.id)] = _v

        # Group each line under its vendor. Every line needs a supplier; block
        # if any line is left unassigned.
        pr_lines = list(pr.lines.all().select_related(
            'product_service', 'service_catalogue', 'preferred_vendor'
        ))
        line_groups = {}   # vendor_id -> {'vendor': Vendor, 'lines': [...]}
        unassigned = []
        for pr_line in pr_lines:
            ov = override_map.get(str(line_vendors.get(str(pr_line.id)) or ''))
            v = ov or pr_line.preferred_vendor or fallback_vendor
            if v is None:
                unassigned.append(pr_line.line_no)
                continue
            line_groups.setdefault(v.id, {'vendor': v, 'lines': []})['lines'].append(pr_line)
        if unassigned:
            return Response(
                {'error': (
                    'Assign a vendor to every line before skipping RFQ. '
                    f'Line(s) without a vendor: {", ".join(map(str, unassigned))}.'
                )},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not line_groups:
            return Response(
                {'error': 'This PR has no lines to order.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Prefer PR's persisted company; fall back to warehouse.company.
        company = pr.company if pr.company_id else (
            pr.warehouse.company if pr.warehouse and hasattr(pr.warehouse, 'company') else None
        )
        if not company:
            return Response(
                {'error': 'Cannot determine company for PR'},
                status=status.HTTP_400_BAD_REQUEST
            )

        with transaction.atomic():
            # 1. Auto-approve if PR is still in draft / pending — RFQ Skip implies approval.
            if pr.approval_status != 'APPROVED':
                pr.approval_status = 'APPROVED'
                pr.approved_by = request.user
                pr.approved_at = timezone.now()
                pr.save(update_fields=['approval_status', 'approved_by', 'approved_at'])
                pr.lines.update(status='APPROVED')
                try:
                    stakeholder = getattr(request.user, 'stakeholder_profile', None)
                    if stakeholder:
                        PurchaseRequestService.approve_purchase_request(pr, stakeholder)
                except Exception:
                    pass

            # 2. One DRAFT PO per vendor, carrying only that vendor's lines.
            #    DRAFT so the user can review/edit before Approve → the PO
            #    becomes selectable on the receipts form only once approved.
            created_pos = []
            for grp in line_groups.values():
                vendor = grp['vendor']
                po = PurchaseOrder(
                    company=company,
                    warehouse=pr.warehouse,
                    vendor=vendor,
                    currency='INR',
                    status='DRAFT',
                    terms_and_conditions='',
                )
                po.save()
                po.linked_prs.add(pr)
                for idx, pr_line in enumerate(grp['lines'], start=1):
                    POLine.objects.create(
                        po=po,
                        line_no=idx,
                        product_service=pr_line.product_service,
                        service_catalogue=pr_line.service_catalogue,
                        description=pr_line.description_override or '',
                        quantity_ordered=qty_map.get(str(pr_line.id), pr_line.quantity_requested),
                        uom=pr_line.uom or 'KG',
                        unit_price=price_map.get(str(pr_line.id), Decimal('0')),
                        gst=gst_map.get(str(pr_line.id), Decimal('0')),
                        delivery_schedule=pr_line.required_date or pr.required_by_date,
                        linked_pr_line=pr_line,
                        category=pr_line.category or '',
                    )
                created_pos.append(po)
                AuditLog.objects.create(
                    user=request.user,
                    role_name=get_user_role_name(request.user),
                    module_name='Purchase Order',
                    action='CREATE',
                    details=(
                        f'PO {po.po_no} created via RFQ Skip from PR {pr.pr_no} '
                        f'for {vendor.vendor_name}'
                    ),
                )

            # 3. Persist the fallback vendor on the PR header for reference.
            if fallback_vendor and pr.preferred_vendor_id != fallback_vendor.id:
                pr.preferred_vendor = fallback_vendor
                pr.save(update_fields=['preferred_vendor'])

            # 4. Mark the PR as having skipped RFQ.
            if not pr.allow_rfq_skip:
                pr.allow_rfq_skip = True
                pr.save(update_fields=['allow_rfq_skip'])

        pos_data = [{
            'id': str(p.id),
            'po_no': p.po_no,
            'vendor_name': p.vendor.vendor_name if p.vendor else '',
            'status': p.status,
        } for p in created_pos]
        first = created_pos[0]
        return Response({
            'message': f'{len(created_pos)} PO(s) created from PR {pr.pr_no} (RFQ Skipped).',
            'pos': pos_data,
            'count': len(created_pos),
            # Back-compat single-PO fields (first PO) for existing callers.
            'po': PurchaseOrderSerializer(first).data,
            'po_id': str(first.id),
            'po_no': first.po_no,
        }, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """Get PR summary for warehouse."""
        warehouse_id = request.query_params.get('warehouse_id')
        days = request.query_params.get('days', 30)

        if not warehouse_id:
            return Response(
                {'error': 'warehouse_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        summary = PurchaseRequestSelectors.get_pr_summary_for_warehouse(
            warehouse_id, int(days)
        )
        return Response(list(summary))


class RFQHeaderViewSet(viewsets.ModelViewSet):
    """ViewSet for RFQ Headers."""

    queryset = RFQHeader.objects.all()
    serializer_class = RFQHeaderSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'RFQ'
    filter_backends = [
        DjangoFilterBackend,
        filters.SearchFilter,
        filters.OrderingFilter
    ]
    filterset_fields = ['rfq_status', 'rfq_mode', 'created_by']
    search_fields = ['rfq_no']
    ordering_fields = ['creation_date', 'rfq_status']
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
    ordering = ['-creation_date', '-id']

    def get_queryset(self):
        # Cascade requirement-type scope: an RFQ is visible when any linked PR
        # is of an allowed requirement_type (managers/superuser see all).
        #
        # select_related pulls the FK rows the serializer reads per row:
        #   created_by__user          -> created_by_name
        #   purchase_manager_approval__user -> purchase_manager_approval_name
        # linked_prs -> company / warehouse.company are walked by
        # get_company_code and get_linked_pr_numbers; prefetched below.
        qs = super().get_queryset().select_related(
            'created_by__user',
            'purchase_manager_approval__user',
        ).prefetch_related(
            'linked_prs__company',
            'linked_prs__warehouse__company',
            'linked_prs__lines__product_service',
            'linked_prs__lines__service_catalogue',
            'eta_updates',
        )
        return scope_by_requirement_type(qs, self.request.user, 'linked_prs__requirement_type')

    def perform_create(self, serializer):
        """Set created_by to current user."""
        serializer.save(
            created_by=getattr(self.request.user, "stakeholder_profile", None)
        )

    @action(detail=False, methods=['get'])
    def open_rfqs(self, request):
        """Get all open RFQs."""
        rfqs = RFQSelectors.get_open_rfqs()
        serializer = self.get_serializer(rfqs, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['get'], url_path='products')
    def get_products(self, request, pk=None):
        """Return the flat list of items referenced by this RFQ's linked PRs.
        Used by the Quote Response mismatch-detection flow to scope the
        comparison: "is this extracted item even on the RFQ?"

        Includes both line sources — Product (Goods, incl. MACHINERY-type
        machine spares) and ServiceCatalogue — because a Services RFQ
        would otherwise return an empty list and the match modal would
        show "No RFQ products to compare against".

        Response: [{product, product_name, sku_code, uom, quantity_requested, source}]
        `source` is 'PRODUCT' | 'MACHINERY' | 'SERVICE' (MACHINERY when the
        product is a MACHINERY-type Product) so callers can route the
        picked ID to the right FK on the Quote/PO line.
        The `product` key is namespaced ("SERVICE:<id>") for service rows
        so a Service id 5 never collides with a Product id 5 client-side.
        """
        from decimal import Decimal
        rfq = self.get_object()
        seen = {}
        for pr in rfq.linked_prs.all():
            # Exclude products routed to "Skip RFQ" — they already have a direct
            # PO, so they must not be offered on the Quote Response grid.
            qs = pr.lines.filter(allow_rfq_skip=False).select_related(
                'product_service', 'service_catalogue').all()
            for line in qs:
                # Pick whichever FK is populated (PRLineSerializer.validate
                # enforces exactly one).
                if line.product_service_id:
                    p = line.product_service
                    key = str(p.id)
                    name = p.product_name or ''
                    sku = p.sku_code or ''
                    # Machine spares are MACHINERY products now — label them so.
                    source = 'MACHINERY' if p.product_type == 'MACHINERY' else 'PRODUCT'
                elif line.service_catalogue_id:
                    s = line.service_catalogue
                    key = f'SERVICE:{s.id}'
                    name = s.name or ''
                    sku = getattr(s, 'service_code', '') or ''
                    source = 'SERVICE'
                else:
                    continue
                # First occurrence wins; aggregate quantities across PRs.
                if key not in seen:
                    seen[key] = {
                        'product': key,
                        'product_name': name,
                        'sku_code': sku,
                        'uom': line.uom or '',
                        'quantity_requested': str(line.quantity_requested or 0),
                        'source': source,
                    }
                else:
                    try:
                        prev = Decimal(seen[key]['quantity_requested'] or '0')
                        seen[key]['quantity_requested'] = str(prev + (line.quantity_requested or Decimal('0')))
                    except Exception:
                        pass

        # Optional vendor scoping: when ?vendor_id= is passed, return only the
        # line items that vendor was actually sent in their RFQ email (recorded
        # on the EmailLog at send time). Falls back to ALL lines when nothing
        # was recorded for that vendor (legacy / unscoped sends), so the quote
        # form never ends up with an empty grid.
        vendor_id = request.query_params.get('vendor_id')
        if vendor_id:
            try:
                from communications.models import EmailLog
                wanted = None
                log = (EmailLog.objects
                       .filter(rfq=rfq, vendor_id=vendor_id, email_sent=True)
                       .exclude(line_keys=None)
                       .order_by('-sent_at', '-created_at')
                       .first())
                if log and log.line_keys:
                    # Exactly what this vendor was sent (per-line routing).
                    wanted = {str(k) for k in log.line_keys}
                else:
                    # Legacy / unscoped send with no recorded routing: fall back
                    # to the vendor's preferred products (the scoping the old
                    # send used), so quotes for pre-existing RFQs still narrow
                    # down instead of showing every line.
                    from master.models import Vendor
                    v = Vendor.objects.filter(id=vendor_id).first()
                    if v:
                        pref = {str(pid) for pid in v.preferred_for_products.values_list('id', flat=True)}
                        if pref:
                            wanted = pref
                if wanted:
                    scoped = {k: val for k, val in seen.items() if k in wanted}
                    if scoped:
                        return Response(list(scoped.values()))
            except Exception:
                pass
        return Response(list(seen.values()))

    @action(detail=False, methods=['get'])
    def pending_evaluation(self, request):
        """Get RFQs pending evaluation."""
        rfqs = RFQSelectors.get_rfqs_pending_evaluation()
        serializer = self.get_serializer(rfqs, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['get'], url_path='vendors')
    def get_vendors(self, request, pk=None):
        """
        Get auto-aggregated preferred vendors for this RFQ.
        Returns vendors from product preferences on linked PRs,
        plus validation warnings for missing emails.

        GET /api/purchase/rfq/{id}/vendors/
        """
        rfq = self.get_object()
        from purchase.vendor_aggregation import (
            get_rfq_auto_vendors, get_final_vendor_list,
            validate_vendor_emails, get_rfq_vendor_products,
        )

        # Get auto vendors from product preferences
        auto_vendor_list = get_final_vendor_list(rfq)
        # Attach the list of products each vendor is mapped to on this
        # RFQ. Frontend Send Email page renders them as
        # `Vendor Name (Product A, Product B)`. Empty list when the
        # vendor was added manually and has no product mapping.
        vendor_products = get_rfq_vendor_products(rfq)
        for v in auto_vendor_list:
            v['products'] = vendor_products.get(str(v['id']), [])
        valid, errors = validate_vendor_emails(auto_vendor_list)

        return Response({
            'auto_vendors': auto_vendor_list,
            'valid_vendors': valid,
            'warnings': errors,
            'total_count': len(auto_vendor_list),
            'valid_count': len(valid),
            # Also surface as a top-level lookup so the frontend can
            # decorate manually-added vendors (from the master list)
            # with the same product info without a second request.
            'vendor_products': vendor_products,
        })

    @action(detail=True, methods=['get', 'put'], url_path='vendor-routing')
    def vendor_routing(self, request, pk=None):
        """Save or load draft line→vendor routing for the Send Email page."""
        rfq = self.get_object()
        if request.method == 'GET':
            return Response({'vendor_routing': rfq.vendor_routing})
        routing = request.data.get('vendor_routing')
        if routing is not None and not isinstance(routing, dict):
            return Response({'detail': 'vendor_routing must be a JSON object.'}, status=status.HTTP_400_BAD_REQUEST)
        rfq.vendor_routing = routing
        rfq.save(update_fields=['vendor_routing'])
        return Response({'vendor_routing': rfq.vendor_routing})

    @action(detail=True, methods=['post'])
    def close(self, request, pk=None):
        """Close an RFQ."""
        rfq = self.get_object()
        remarks = request.data.get('remarks', '')

        with transaction.atomic():
            rfq = RFQService.close_rfq(rfq, remarks)

        serializer = self.get_serializer(rfq)
        return Response(serializer.data)


class QuoteResponseViewSet(viewsets.ModelViewSet):
    """ViewSet for Quote Responses."""

    queryset = QuoteResponse.objects.all()
    serializer_class = QuoteResponseSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Quote'
    filter_backends = [
        DjangoFilterBackend,
        filters.SearchFilter,
        filters.OrderingFilter
    ]
    filterset_fields = ['rfq', 'vendor', 'chosen_flag']
    search_fields = ['quote_id', 'vendor__vendor_name']
    ordering_fields = ['quote_date', 'evaluation_score']
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
    ordering = ['-quote_date', '-id']

    def get_queryset(self):
        # Cascade requirement-type scope via the quote's RFQ → linked PRs.
        #
        # select_related pulls the FK rows the serializer reads per row:
        #   vendor       -> vendor_name, vendor_code
        #   rfq          -> rfq_no; rfq.linked_prs prefetched below for
        #                   pr_numbers / pr_ids / rfq_invited_count
        qs = super().get_queryset().select_related(
            'vendor', 'rfq',
        ).prefetch_related(
            'quote_lines__product_service',
            'quote_lines__service_catalogue',
            'rfq__linked_prs',
        )
        return scope_by_requirement_type(qs, self.request.user, 'rfq__linked_prs__requirement_type')

    def create(self, request, *args, **kwargs):
        """Override to pop and persist `product_mismatch_resolutions` after
        the Quote is saved. The field is a list of dicts captured by the
        Quote Response form's mismatch-resolution modal:
            [{
              vendor_product_name, rfq_product_id, rfq_product_name,
              user_selected: 'RFQ_PRODUCT'|'VENDOR_PRODUCT'|'NEW_PRODUCT',
              similarity_score, remarks,
            }, ...]
        Each becomes a row in ProductMismatchLog. Failures are logged but
        don't break the Quote save (audit table is non-critical to flow).
        """
        resolutions = request.data.pop('product_mismatch_resolutions', None) if isinstance(request.data, dict) else None
        response = super().create(request, *args, **kwargs)
        if resolutions and isinstance(resolutions, list) and response.status_code in (200, 201):
            try:
                self._write_mismatch_logs(response.data.get('id'), resolutions)
            except Exception:
                logger.exception('Failed to persist product mismatch logs (non-critical)')
        return response

    def _write_mismatch_logs(self, quote_id, resolutions):
        """Write a ProductMismatchLog row for each resolution captured on the
        Quote Response form. Idempotent — uses update_or_create against the
        (quote_response, vendor_product_name) unique constraint."""
        from .models import ProductMismatchLog, QuoteResponse
        from django.utils import timezone as _tz
        if not quote_id:
            return
        try:
            quote = QuoteResponse.objects.select_related('rfq', 'vendor').get(pk=quote_id)
        except QuoteResponse.DoesNotExist:
            return
        # Denormalise PR numbers from the RFQ's linked PRs at log time.
        pr_no = ''
        try:
            pr_no = ', '.join(quote.rfq.linked_prs.values_list('pr_no', flat=True)) if quote.rfq_id else ''
        except Exception:
            pr_no = ''
        stakeholder = getattr(self.request.user, 'stakeholder_profile', None)
        now = _tz.now()
        for r in resolutions:
            vendor_product = (r.get('vendor_product_name') or '').strip()
            if not vendor_product:
                continue
            sel = r.get('user_selected') or 'UNRESOLVED'
            match_status = 'MANUALLY_RESOLVED' if sel in ('RFQ_PRODUCT', 'VENDOR_PRODUCT', 'NEW_PRODUCT') else 'MISMATCHED'
            score = r.get('similarity_score')
            try:
                score_decimal = Decimal(str(score)) if score is not None else None
            except Exception:
                score_decimal = None
            # Dedup key: (rfq, vendor, vendor_product_name, rfq_product).
            # Same vendor sending the same wording against the same RFQ for
            # the same RFQ product → updates the row instead of duplicating.
            rfq_product_id = r.get('rfq_product_id') or None
            ProductMismatchLog.objects.update_or_create(
                rfq=quote.rfq,
                vendor=quote.vendor,
                vendor_product_name=vendor_product,
                rfq_product_id=rfq_product_id,
                defaults={
                    'quote_response': quote,
                    'purchase_order': None,    # backfilled by PO post_save signal
                    'pr_no': pr_no,
                    'rfq_no': getattr(quote.rfq, 'rfq_no', '') or '',
                    'vendor_name': getattr(quote.vendor, 'vendor_name', '') or '',
                    'quote_response_no': quote.quote_id,
                    'rfq_product_name': (r.get('rfq_product_name') or '').strip(),
                    'user_selected': sel,
                    'match_status': match_status,
                    'similarity_score': score_decimal,
                    'remarks': (r.get('remarks') or '').strip(),
                    'created_by': stakeholder,
                    'resolved_by': stakeholder if match_status == 'MANUALLY_RESOLVED' else None,
                    'resolved_at': now if match_status == 'MANUALLY_RESOLVED' else None,
                },
            )

    @action(detail=False, methods=['get'])
    def for_rfq(self, request):
        """Get quotes for specific RFQ."""
        rfq_id = request.query_params.get('rfq_id')
        if not rfq_id:
            return Response({'error': 'rfq_id is required'}, status=status.HTTP_400_BAD_REQUEST)
        quotes = QuoteSelectors.get_quotes_for_rfq(rfq_id)
        serializer = self.get_serializer(quotes, many=True)
        return Response(serializer.data)

    @action(
        detail=False,
        methods=['post'],
        url_path='extract',
        parser_classes=[MultiPartParser, FormParser],
    )
    def extract(self, request):
        """POST /api/purchase/quotes/extract/ — Gemini-based document
        extraction for the Auto-Fill flow on the Quote Response create page.

        Multipart body: ``file=<uploaded quotation>``
        Returns: ``{success, extracted, line_items, confidence, warnings,
        model_used, attempts}``

        Tries ``gemini-2.5-flash`` first, falls back to ``gemini-2.5-pro``
        if the primary model returns unparseable / empty output. The Lite
        model produced too many partial extractions on real vendor quote
        PDFs, so Quote-specific extraction stays on the full Flash model.
        """
        from .quote_gemini_extractor import extract_quote

        upload = request.FILES.get('file')
        if not upload:
            return Response(
                {'error': 'No file uploaded. Send multipart form with key "file".'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # 20 MB cap — Gemini also enforces inline upload limits.
        max_bytes = 20 * 1024 * 1024
        if upload.size > max_bytes:
            return Response(
                {'error': f'File too large ({upload.size} bytes). Max {max_bytes} bytes.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            file_bytes = upload.read()
        except Exception as exc:
            return Response({'error': f'Failed to read upload: {exc}'}, status=status.HTTP_400_BAD_REQUEST)

        result = extract_quote(file_bytes, upload.name or 'document')
        return Response(result, status=status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='add-line')
    def add_line(self, request, pk=None):
        """Add a line item to this quote.

        Accepts exactly one of `product_service` or `service_catalogue`.
        Legacy `product` key still works for the Goods flow.
        """
        quote = self.get_object()
        data = request.data

        from master.models import Product, ServiceCatalogue

        product_id = data.get('product_service') or data.get('product')
        service_id = data.get('service_catalogue')

        chosen = [v for v in (product_id, service_id) if v]
        if len(chosen) == 0:
            return Response(
                {'error': 'One of product_service or service_catalogue is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(chosen) > 1:
            return Response(
                {'error': 'Provide only one of product_service or service_catalogue.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        product_obj = None
        service_obj = None
        default_uom = 'KG'

        if product_id:
            try:
                product_obj = Product.objects.get(pk=product_id)
                default_uom = product_obj.uom or 'KG'
            except Product.DoesNotExist:
                return Response({'error': 'Product not found'}, status=400)
        else:
            try:
                service_obj = ServiceCatalogue.objects.get(pk=service_id)
            except ServiceCatalogue.DoesNotExist:
                return Response({'error': 'Service not found'}, status=400)

        # Resolve the originating PR line so the category (including
        # PACKING_MATERIAL) follows the chain PR → Quote → PO →
        # Receipt. Without this the Receipt's PO-fetch can't tell which
        # lines should land in the Packing Materials subform versus
        # Receipt Line Items, and packing materials would silently
        # collapse into the goods table.
        #
        # The Quote belongs to an RFQ which has `linked_prs` (M2M).
        # We pick the PR line for the same item the operator just
        # picked. Caller can also pass `pr_line` explicitly to skip
        # the inference (useful if the line wasn't on any PR but the
        # operator wants to attach it manually).
        pr_line_obj = None
        explicit_pr_line = data.get('pr_line')
        if explicit_pr_line:
            try:
                pr_line_obj = PRLine.objects.get(pk=explicit_pr_line)
            except PRLine.DoesNotExist:
                pr_line_obj = None
        if pr_line_obj is None and quote.rfq_id:
            # Match by whichever FK was provided. Order matches the
            # two-FK convention used elsewhere in this module.
            match_kwargs = {}
            if product_obj:
                match_kwargs['product_service_id'] = product_obj.id
            elif service_obj:
                match_kwargs['service_catalogue_id'] = service_obj.id
            if match_kwargs:
                # PurchaseRequest has `rfqs` reverse-M2M (set up by
                # RFQHeader.linked_prs.related_name='rfqs'), so this
                # filter picks PR lines whose parent PR is on the same
                # RFQ this quote is responding to.
                pr_line_obj = (
                    PRLine.objects
                    .filter(purchase_request__rfqs=quote.rfq, allow_rfq_skip=False, **match_kwargs)
                    .order_by('purchase_request_id', 'line_no')
                    .first()
                )

        line = QuoteLine.objects.create(
            quote=quote,
            product_service=product_obj,
            service_catalogue=service_obj,
            pr_line=pr_line_obj,
            quantity_offered=data.get('quantity_offered', data.get('quantity', 1)),
            uom=data.get('uom', default_uom),
            unit_price=data.get('unit_price', 0),
            specification=data.get('specification', data.get('description', '')),
            gst=data.get('gst', 0),
            discount=data.get('discount', 0),
        )
        from .serializers import QuoteLineSerializer
        return Response(QuoteLineSerializer(line).data, status=201)

    @action(detail=True, methods=['delete'], url_path='remove-line/(?P<line_id>[^/.]+)')
    def remove_line(self, request, pk=None, line_id=None):
        """Remove a line item."""
        quote = self.get_object()
        try:
            line = quote.quote_lines.get(id=line_id)
            line.delete()
            return Response({'message': 'Line removed'})
        except Exception:
            return Response({'error': 'Line not found'}, status=404)


class QuoteEvaluationViewSet(viewsets.ModelViewSet):
    """ViewSet for Quote Evaluations."""

    queryset = QuoteEvaluation.objects.all()
    serializer_class = QuoteEvaluationSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Quote Evaluation'
    filter_backends = [
        DjangoFilterBackend,
        filters.SearchFilter,
        filters.OrderingFilter
    ]
    filterset_fields = ['rfq', 'approval_status', 'best_quote_flag']
    search_fields = ['evaluation_id']
    ordering_fields = ['evaluation_date', 'approval_status']
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
    ordering = ['-evaluation_date', '-id']

    def get_queryset(self):
        # Cascade requirement-type scope via the evaluation's RFQ → linked PRs.
        #
        # select_related pulls the FK rows the serializer reads per row:
        #   rfq                    -> rfq_no; linked_prs prefetched below
        #   recommended_vendor     -> recommended_vendor_name
        #   evaluated_by__user     -> evaluated_by_name
        # prefetch_related pulls the nested many=True collections:
        #   comparison_entries__vendor  -> ComparisonEntrySerializer.vendor_name
        #   approval_trails__actor__user -> EvalApprovalTrailSerializer.actor_name
        qs = super().get_queryset().select_related(
            'rfq', 'recommended_vendor', 'evaluated_by__user',
        ).prefetch_related(
            'rfq__linked_prs__lines__product_service',
            'rfq__linked_prs__lines__service_catalogue',
            'comparison_entries__vendor',
            'approval_trails__actor__user',
        )
        return scope_by_requirement_type(qs, self.request.user, 'rfq__linked_prs__requirement_type')

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        """Approve an evaluation."""
        evaluation = self.get_object()
        remarks = request.data.get('remarks', '')

        with transaction.atomic():
            evaluation = QuoteEvaluationService.approve_evaluation(
                evaluation,
                getattr(request.user, "stakeholder_profile", None),
                remarks
            )

        # Notify the evaluation's creator that it was approved (skip self).
        if getattr(evaluation, 'created_by_id', None) and evaluation.created_by_id != request.user.id:
            notify_user(
                evaluation.created_by,
                title=f'Evaluation {getattr(evaluation, "evaluation_id", "") or ""} approved'.replace('  ', ' ').strip(),
                message='Your quote evaluation was approved.',
                link=f'/purchase/evaluations/{evaluation.id}',
                category='approval', level='success', actor=request.user,
            )

        serializer = self.get_serializer(evaluation)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def pending(self, request):
        """Get pending evaluations."""
        evaluations = QuoteSelectors.get_pending_quote_evaluations()
        serializer = self.get_serializer(evaluations, many=True)
        return Response(serializer.data)


class PurchaseOrderViewSet(WarehouseScopedQuerysetMixin, viewsets.ModelViewSet):
    """ViewSet for Purchase Orders."""

    warehouse_field = 'warehouse'
    queryset = PurchaseOrder.objects.filter(is_active=True)
    serializer_class = PurchaseOrderSerializer

    def get_serializer_class(self):
        # ?slim=1 on the LIST drops po_lines and the printable-PO document
        # fields - 46% of the payload the list page never reads. Opt-in, so
        # without the flag the response is exactly what it is today.
        if (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes')):
            from .serializers import PurchaseOrderListSerializer
            return PurchaseOrderListSerializer
        return super().get_serializer_class()
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Purchase Order'
    filter_backends = [
        DjangoFilterBackend,
        filters.SearchFilter,
        filters.OrderingFilter
    ]
    filterset_fields = [
        'status', 'vendor', 'warehouse', 'company'
    ]
    search_fields = ['po_no', 'vendor__vendor_name']
    ordering_fields = ['po_no', 'po_date', 'expected_delivery_end']
    # Default to PO-number order (newest first). po_no is zero-padded and
    # sequential, so this reads as a clean 00041, 00040, 00039… sequence —
    # ordering by po_date alone tied same-day POs into a jumbled number order.
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
    ordering = ['-po_no', '-id']

    def get_queryset(self):
        qs = super().get_queryset().select_related(
            'company', 'vendor', 'warehouse',
        ).prefetch_related(
            'po_lines__product_service',
            'po_lines__service_catalogue',
            # PurchaseOrderSerializer.get_linked_pr_numbers walks this on every
            # row; without it that was one extra query per PO on the list.
            'linked_prs',
            # Serialized via source='eta_updates.all', which hits the database
            # per row unless the prefetch is here to answer it.
            'eta_updates',
        )
        # Support status__in filter (comma-separated statuses)
        status_in = self.request.query_params.get('status__in')
        if status_in:
            statuses = [s.strip() for s in status_in.split(',') if s.strip()]
            qs = qs.filter(status__in=statuses)

        # Warehouse scoping (read + write) is handled by
        # WarehouseScopedQuerysetMixin via super().get_queryset() above and
        # perform_create/update — no ad-hoc filtering needed here.
        # Cascade requirement-type scope via the PO's linked PRs.
        qs = scope_by_requirement_type(qs, self.request.user, 'linked_prs__requirement_type')
        return qs

    def perform_update(self, serializer):
        instance = serializer.save()
        # Handle po_lines updates (unit_price, gst)
        po_lines_data = self.request.data.get('po_lines', [])
        if po_lines_data:
            from decimal import Decimal, InvalidOperation
            for line_data in po_lines_data:
                line_id = line_data.get('id')
                if not line_id:
                    continue
                try:
                    po_line = instance.po_lines.get(id=line_id)
                    changed = False
                    if 'unit_price' in line_data:
                        try:
                            po_line.unit_price = Decimal(str(line_data['unit_price']))
                            changed = True
                        except (InvalidOperation, ValueError):
                            pass
                    if 'gst' in line_data:
                        try:
                            po_line.gst = Decimal(str(line_data['gst']))
                            changed = True
                        except (InvalidOperation, ValueError):
                            pass
                    if 'quantity_ordered' in line_data:
                        try:
                            po_line.quantity_ordered = Decimal(str(line_data['quantity_ordered']))
                            changed = True
                        except (InvalidOperation, ValueError):
                            pass
                    if 'uom' in line_data:
                        po_line.uom = str(line_data['uom'] or '')
                        changed = True
                    # Operator-typed spec from the PO document — writes to
                    # POLine.specification (added in the earlier decouple
                    # commit). Explicitly accept blank strings so clearing
                    # the field on the document actually clears the row.
                    if 'specification' in line_data:
                        po_line.specification = str(line_data['specification'] or '')
                        changed = True
                    if changed:
                        po_line.save()
                except POLine.DoesNotExist:
                    pass

    @action(detail=True, methods=['delete'], url_path='lines/(?P<line_id>[^/.]+)')
    def remove_line(self, request, pk=None, line_id=None):
        """Remove one line from a DRAFT PO.

        Blocked once the PO is APPROVED / ISSUED — use the amendment
        flow (quantity → 0) for those. Blocked if the line already has
        any inward receipt, so a partially-received line can't be
        wiped from under a receipt row.

        Returns the updated PO on success so the frontend can refresh
        the line list without a second fetch.
        """
        from rest_framework import status as _status
        po = self.get_object()
        if not check_permission(request.user, 'Purchase Order', 'edit'):
            return Response({'error': 'You do not have permission to edit this PO.'},
                            status=_status.HTTP_403_FORBIDDEN)
        if (po.status or '').upper() != 'DRAFT':
            return Response(
                {'error': f'Cannot remove lines on a {po.status} PO. Use Request Amendment to reduce quantity to zero instead.'},
                status=_status.HTTP_400_BAD_REQUEST,
            )
        try:
            line = po.po_lines.get(id=line_id)
        except POLine.DoesNotExist:
            return Response({'error': 'Line not found on this PO.'}, status=_status.HTTP_404_NOT_FOUND)
        # Block if this line already has received quantity — deleting it
        # would orphan the receipt row that references it.
        try:
            from django.db.models import Sum
            received = (
                line.receipt_lines.filter(is_active=True)
                .aggregate(t=Sum('quantity_received'))['t']
            )
        except Exception:
            received = None
        if received and Decimal(received) > 0:
            return Response(
                {'error': 'Line has received quantity; cannot remove. Reject the receipt first or use amendment.'},
                status=_status.HTTP_400_BAD_REQUEST,
            )
        # Hard-delete — the PR-line linkage (linked_pr_line) is a FK
        # on the POLine, so removing the POLine releases the PR line
        # for re-picking under a different vendor on a new PO.
        line.delete()
        return Response(self.get_serializer(po).data)

    @action(detail=True, methods=['post'], url_path='close')
    def close(self, request, pk=None):
        """Short-close a PO: the remaining balance will never arrive.

        Used when a vendor under-delivers and won't send the rest (damaged /
        cancelled). The PO stays open by default so a later delivery can fulfill
        the shortfall; this is the explicit "we're done, write off the balance"
        action. Sets status=CLOSED, records who/why/when, and notifies admins.
        Blocked if already fully received (nothing to close) or already closed.
        """
        from rest_framework import status as _status
        from django.utils import timezone
        po = self.get_object()
        if not check_permission(request.user, 'Purchase Order', 'edit'):
            return Response({'error': 'You do not have permission to close this PO.'},
                            status=_status.HTTP_403_FORBIDDEN)
        if (po.status or '').upper() in ('CLOSED', 'CANCELLED'):
            return Response({'error': f'PO is already {po.status}.'},
                            status=_status.HTTP_400_BAD_REQUEST)
        if po.is_fully_received():
            return Response(
                {'error': 'PO is already fully received — nothing to close short.'},
                status=_status.HTTP_400_BAD_REQUEST)
        reason = (request.data.get('reason') or '').strip()
        if not reason:
            return Response({'error': 'A reason is required to close a PO short.'},
                            status=_status.HTTP_400_BAD_REQUEST)

        ordered = sum((l.quantity_ordered or 0) for l in po.po_lines.all())
        received = po.get_total_received()
        pending = ordered - received

        po.status = 'CLOSED'
        po.close_reason = reason
        po.closed_at = timezone.now()
        po.closed_by = request.user if request.user.is_authenticated else None
        po.save(update_fields=['status', 'close_reason', 'closed_at', 'closed_by', 'updated_at'])

        # Notify admins that a PO was short-closed, with the shortfall.
        try:
            from notifications.services import notify_users
            from django.contrib.auth import get_user_model
            from django.db.models import Q
            User = get_user_model()
            admins = User.objects.filter(is_active=True).filter(
                Q(is_superuser=True) | Q(is_staff=True)
            ).distinct()
            notify_users(
                list(admins),
                title=f'PO {po.po_no} closed short',
                message=(f'{getattr(request.user, "username", "A user")} closed PO {po.po_no} '
                         f'({po.vendor.vendor_name if po.vendor_id else "?"}) with {pending:g} '
                         f'of {ordered:g} still pending. Reason: {reason}'),
                link=f'/purchase/orders/{po.id}',
                category='purchase',
                level='warning',
                actor=request.user if request.user.is_authenticated else None,
            )
        except Exception:
            logger.exception('PO short-close admin notification failed for po=%s', po.id)

        return Response(self.get_serializer(po).data)

    @action(detail=False, methods=['get'])
    def open_pos_for_vendor(self, request):
        """Get open POs for a vendor."""
        vendor_id = request.query_params.get('vendor_id')

        if not vendor_id:
            return Response(
                {'error': 'vendor_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        pos = PurchaseOrderSelectors.get_open_pos_for_vendor(vendor_id)
        serializer = self.get_serializer(pos, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def overdue(self, request):
        """Get overdue POs."""
        days = request.query_params.get('days', 7)
        pos = PurchaseOrderSelectors.get_overdue_pos(int(days))
        serializer = self.get_serializer(pos, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'], url_path='product-last-terms')
    def product_last_terms(self, request):
        """Autofill helper for a new PO line.

        Given an item, return the GST%/unit price and the PO-level freight &
        payment terms from the most recent prior PO line that used that item,
        so the frontend can prefill a fresh line.

        Query params:
            product   (required) — item id. For PRODUCT/MACHINERY this is a
                      ``master.Product`` id (matched on ``product_service``);
                      for SERVICE it is a ``master.ServiceCatalogue`` id
                      (matched on ``service_catalogue``).
            item_type (optional, default PRODUCT) — one of
                      PRODUCT | MACHINERY | SERVICE. Anything unrecognised is
                      treated as PRODUCT.

        Returns ``{"found": false}`` (HTTP 200) when the id is missing/blank/
        malformed or no prior PO line references it. Only POs the caller may
        already see are considered — the lookup runs through this viewset's
        scoped/permissioned base queryset so nothing leaks.
        """
        from django.core.exceptions import ValidationError as DjangoValidationError

        product_id = (request.query_params.get('product') or '').strip()
        if not product_id:
            return Response({'found': False})

        item_type = (request.query_params.get('item_type') or 'PRODUCT').strip().upper()
        if item_type == 'SERVICE':
            fk_filter = {'service_catalogue_id': product_id}
        else:
            # PRODUCT and MACHINERY both reference master.Product via
            # product_service; unknown item types fall back to PRODUCT.
            fk_filter = {'product_service_id': product_id}

        # Restrict to POs the caller is allowed to see by reusing the
        # viewset's scoped/permissioned base queryset.
        visible_po_ids = self.get_queryset().values_list('id', flat=True)

        try:
            line = (
                POLine.objects
                .filter(po_id__in=visible_po_ids, **fk_filter)
                .select_related('po')
                .order_by('-po__po_date', '-po__created_at', '-po_id')
                .first()
            )
        except (ValueError, TypeError, DjangoValidationError):
            # e.g. a malformed UUID passed as the item id.
            return Response({'found': False})

        if line is None:
            return Response({'found': False})

        po = line.po
        return Response({
            'found': True,
            'gst': str(line.gst),
            'unit_price': str(line.unit_price),
            'freight_terms': po.freight_terms,
            'payment_terms': po.payment_terms,
            'po_no': po.po_no,
        })

    @action(detail=True, methods=['post'])
    def split(self, request, pk=None):
        """Split a DRAFT PO into N DRAFT POs by batch quantity.

        Body::

            { splits: [{quantity, delivery_date}, ...] }

        Guardrails:
          * PO must be in DRAFT status (vendor hasn't been notified).
          * PO must have exactly one POLine (multi-line splitting is
            ambiguous — split at PR-approve time or manually per line).
          * No receipts against the PO (defensive; DRAFT can't have any
            anyway, but belt-and-suspenders).
          * Sum of split quantities must equal the original line qty.
          * Every batch qty > 0.

        Behaviour:
          * Marks the original PO as SPLIT (a dedicated status distinct
            from CANCELLED) with a note pointing at the child PO
            numbers — keeps a clean audit trail with no orphan and
            without misrepresenting the obligation as cancelled.
          * Creates N new DRAFT POs, each cloning company / warehouse /
            vendor / terms / linked_prs and carrying a single POLine
            with the slice qty and its own delivery date.
        """
        po = self.get_object()

        if po.status != 'DRAFT':
            return Response(
                {'error': f'Only DRAFT POs can be split. This PO is {po.status}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        po_lines = list(po.po_lines.all())
        if len(po_lines) != 1:
            return Response(
                {'error': (
                    'Split is only supported for single-line POs. This PO has '
                    f'{len(po_lines)} lines — split at PR approval time or '
                    'edit the lines manually.'
                )},
                status=status.HTTP_400_BAD_REQUEST,
            )
        source_line = po_lines[0]

        # DRAFT POs shouldn't have receipts, but check anyway.
        from django.db.models import Sum
        rl_total = ReceiptLine.objects.filter(po_line=source_line).aggregate(
            t=Sum('quantity_received'),
        )['t'] or Decimal('0')
        pml_total = PackingMaterialLine.objects.filter(po_line=source_line).aggregate(
            t=Sum('quantity'),
        )['t'] or Decimal('0')
        if (rl_total + pml_total) > 0:
            return Response(
                {'error': 'Cannot split: receipts already exist against this PO.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        raw_splits = request.data.get('splits')
        if not isinstance(raw_splits, list) or len(raw_splits) < 2:
            return Response(
                {'error': 'Provide at least 2 batches under `splits`.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        def _dec(v):
            try:
                return Decimal(str(v)) if v not in (None, '') else None
            except Exception:  # noqa: BLE001
                return None

        parsed = []
        for i, sp in enumerate(raw_splits, start=1):
            if not isinstance(sp, dict):
                return Response({'error': f'Batch {i}: invalid entry.'},
                                status=status.HTTP_400_BAD_REQUEST)
            q = _dec(sp.get('quantity'))
            if not q or q <= 0:
                return Response({'error': f'Batch {i}: quantity must be greater than 0.'},
                                status=status.HTTP_400_BAD_REQUEST)
            parsed.append({
                'quantity': q,
                'delivery_date': (sp.get('delivery_date') or '').strip() or None,
            })

        total = sum(p['quantity'] for p in parsed)
        if abs(total - source_line.quantity_ordered) > Decimal('0.0001'):
            return Response(
                {'error': (
                    f'Split quantities sum to {total} but the PO line quantity '
                    f'is {source_line.quantity_ordered}.'
                )},
                status=status.HTTP_400_BAD_REQUEST,
            )

        linked_pr_ids = list(po.linked_prs.values_list('id', flat=True))
        created = []
        with transaction.atomic():
            for idx, sl in enumerate(parsed, start=1):
                new_po = PurchaseOrder(
                    company=po.company, warehouse=po.warehouse, vendor=po.vendor,
                    currency=po.currency or 'INR', status='DRAFT',
                    terms_and_conditions=po.terms_and_conditions or '',
                    payment_terms=po.payment_terms or '',
                    freight_terms=po.freight_terms or '',
                )
                new_po.save()
                if linked_pr_ids:
                    new_po.linked_prs.set(linked_pr_ids)
                # Per-slice delivery override, else copy source line's.
                try:
                    from datetime import date as _date
                    slice_delivery = _date.fromisoformat(sl['delivery_date']) if sl['delivery_date'] else None
                except Exception:  # noqa: BLE001
                    slice_delivery = None
                POLine.objects.create(
                    po=new_po, line_no=1,
                    product_service=source_line.product_service,
                    service_catalogue=source_line.service_catalogue,
                    description=source_line.description or '',
                    quantity_ordered=sl['quantity'],
                    uom=source_line.uom or 'KG',
                    unit_price=source_line.unit_price or Decimal('0'),
                    gst=source_line.gst or Decimal('0'),
                    delivery_schedule=slice_delivery or source_line.delivery_schedule,
                    linked_pr_line=source_line.linked_pr_line,
                    category=source_line.category or '',
                )
                created.append(new_po)

            # Mark original as SPLIT (distinct from CANCELLED — the
            # obligation is redistributed, not removed) with a pointer
            # to the children.
            po.status = 'SPLIT'
            note_children = ', '.join(p.po_no for p in created)
            po.terms_and_conditions = (
                (po.terms_and_conditions or '').rstrip()
                + f'\n\n[Split into {len(created)} POs: {note_children}]'
            ).strip()
            po.save(update_fields=['status', 'terms_and_conditions'])

            AuditLog.objects.create(
                user=request.user,
                role_name=get_user_role_name(request.user),
                module_name='Purchase Order',
                action='EDIT',
                details=(f'PO {po.po_no} split into {len(created)} DRAFT POs: '
                         f'{note_children}. Original marked SPLIT.'),
            )

        return Response({
            'message': f'PO {po.po_no} split into {len(created)} DRAFT POs.',
            'cancelled_po': po.po_no,
            'created_pos': [
                {'id': str(p.id), 'po_no': p.po_no,
                 'quantity': str(p.po_lines.first().quantity_ordered)}
                for p in created
            ],
        })

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        """Approve a PO."""
        po = self.get_object()

        with transaction.atomic():
            actor = getattr(request.user, 'stakeholder_profile', None) or request.user
            po = PurchaseOrderService.approve_po(po, actor)

        # Audit log
        AuditLog.objects.create(
            user=request.user,
            role_name=get_user_role_name(request.user),
            module_name='Purchase Order',
            action='EDIT',
            details=f'PO {po.po_no} approved'
        )

        # Notify the PO creator that it was approved (skip self).
        if getattr(po, 'created_by_id', None) and po.created_by_id != request.user.id:
            notify_user(
                po.created_by,
                title=f'PO {po.po_no} approved',
                message=f'Purchase Order {po.po_no} was approved.',
                link=f'/purchase/orders/{po.id}',
                category='approval', level='success', actor=request.user,
            )

        serializer = self.get_serializer(po)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='add-line')
    def add_line(self, request, pk=None):
        """Add a line item to this PO.

        Accepts exactly one of `product_service` or `service_catalogue`
        to identify the item. Legacy `product` key is treated as
        `product_service` for backward compatibility with existing Goods
        callers.
        """
        po = self.get_object()
        data = request.data

        from master.models import Product, ServiceCatalogue

        product_id = data.get('product_service') or data.get('product')
        service_id = data.get('service_catalogue')

        product_obj = None
        service_obj = None
        default_uom = 'KG'

        # Exactly one of the two IDs must be supplied. Resolve the FK
        # and capture the master row's default UOM where available.
        chosen = [v for v in (product_id, service_id) if v]
        if len(chosen) == 0:
            return Response(
                {'error': 'One of product_service or service_catalogue is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(chosen) > 1:
            return Response(
                {'error': 'Provide only one of product_service or service_catalogue.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if product_id:
            try:
                product_obj = Product.objects.get(pk=product_id)
                default_uom = product_obj.uom or 'KG'
            except Product.DoesNotExist:
                return Response({'error': 'Product not found'}, status=status.HTTP_400_BAD_REQUEST)
        else:
            try:
                service_obj = ServiceCatalogue.objects.get(pk=service_id)
            except ServiceCatalogue.DoesNotExist:
                return Response({'error': 'Service not found'}, status=status.HTTP_400_BAD_REQUEST)

        line_no = data.get('line_no', po.po_lines.count() + 1)
        line = POLine.objects.create(
            po=po,
            line_no=line_no,
            product_service=product_obj,
            service_catalogue=service_obj,
            description=data.get('description', ''),
            quantity_ordered=data.get('quantity_ordered', data.get('quantity', 1)),
            uom=data.get('uom', default_uom),
            unit_price=data.get('unit_price', 0),
            gst=data.get('gst', 0),
            delivery_schedule=data.get('delivery_schedule') or None,
            linked_pr_line_id=data.get('linked_pr_line') or None,
        )
        from .serializers import POLineSerializer
        return Response(POLineSerializer(line).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'])
    def issue(self, request, pk=None):
        """Issue a PO."""
        po = self.get_object()

        with transaction.atomic():
            actor = getattr(request.user, 'stakeholder_profile', None) or request.user
            po = PurchaseOrderService.issue_po(po, actor)

        serializer = self.get_serializer(po)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        """Reject a PO."""
        po = self.get_object()

        if po.status not in ('DRAFT', 'APPROVED'):
            return Response(
                {'error': 'Only DRAFT or APPROVED POs can be rejected'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if not check_permission(request.user, 'Purchase Order', 'edit'):
            return Response(
                {'error': 'You do not have permission to reject POs'},
                status=status.HTTP_403_FORBIDDEN
            )

        po.status = 'CANCELLED'
        po.save(update_fields=['status'])

        AuditLog.objects.create(
            user=request.user,
            role_name=get_user_role_name(request.user),
            module_name='Purchase Order',
            action='EDIT',
            details=f'PO {po.po_no} rejected/cancelled. Reason: {request.data.get("reason", "")}'
        )

        serializer = self.get_serializer(po)
        return Response({
            'message': f'PO {po.po_no} has been rejected',
            'purchase_order': serializer.data,
        })

    def destroy(self, request, *args, **kwargs):
        """Soft-delete PO: sets is_active=False, releases PO for re-generation in Quote Evaluation."""
        po = self.get_object()

        with transaction.atomic():
            # Collect info before soft delete
            linked_pr_nos = ", ".join(pr.pr_no for pr in po.linked_prs.all())
            linked_rfq_no = po.linked_rfq.rfq_no if po.linked_rfq else "None"

            # Soft delete the PO and its lines
            po.soft_delete()
            po.po_lines.update(is_active=False)

            # Reset chosen_flag on quotes linked to this PO's RFQ
            if po.linked_rfq:
                QuoteResponse.objects.filter(
                    rfq=po.linked_rfq,
                    chosen_flag=True
                ).update(chosen_flag=False)

            # Reset quote chosen_flag via PO lines → linked quote lines
            for po_line in po.po_lines.all():
                if po_line.linked_rfq_line:
                    quote = po_line.linked_rfq_line.quote
                    if quote and quote.chosen_flag:
                        quote.chosen_flag = False
                        quote.save(update_fields=['chosen_flag'])

            # Soft-delete evaluations linked to this PO's RFQ so they can be re-done
            if po.linked_rfq:
                QuoteEvaluation.objects.filter(
                    rfq=po.linked_rfq,
                    is_active=True
                ).update(is_active=False)

            # Audit log
            AuditLog.objects.create(
                user=request.user,
                role_name=get_user_role_name(request.user),
                module_name='Purchase Order',
                action='DELETE',
                details=f'PO {po.po_no} deleted (soft). '
                        f'Quote chosen_flag and evaluations reset. '
                        f'PO released for re-generation. '
                        f'Linked PRs: {linked_pr_nos}. '
                        f'Linked RFQ: {linked_rfq_no}.'
            )

        return Response(
            {'message': f'PO {po.po_no} deleted. PO number is now available for re-generation in Quote Evaluation.'},
            status=status.HTTP_200_OK
        )

    @action(detail=True, methods=['post'], url_path='preview-email')
    def preview_email(self, request, pk=None):
        """Preview rendered PO email HTML before sending."""
        po = self.get_object()
        template_id = request.data.get('template_id')

        if not template_id:
            return Response({'error': 'template_id is required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            from communications.models import EmailTemplate
            from communications.services import TemplateEngine, PDFGenerator

            template = EmailTemplate.objects.get(pk=template_id)

            context = self._build_po_email_context(po)

            engine = TemplateEngine()
            rendered_subject = engine.render(template.subject, context)
            rendered_body = engine.render(template.body_html, context)

            # Also build full PDF HTML for preview
            full_html = PDFGenerator.build_full_html(template, context)

            # Surface the ACTUAL sending mailbox (the authenticated address the
            # send will use) so the preview's From shows the real sender, not
            # the company's contact email.
            from communications.services import get_mailer
            context_data = {k: v for k, v in context.items() if k != 'product_table'}
            _po_company_code = getattr(getattr(po, 'company', None), 'company_code', None)
            context_data['from_email'] = get_mailer('purchase', _po_company_code)[0]

            return Response({
                'subject': rendered_subject,
                'body_html': rendered_body,
                'pdf_html': full_html,
                'context_data': context_data,
            })

        except EmailTemplate.DoesNotExist:
            return Response({'error': 'Template not found'}, status=status.HTTP_404_NOT_FOUND)
        except Exception as e:
            return Response({'error': f'Preview failed: {str(e)}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=True, methods=['post'], url_path='send-email')
    def send_email(self, request, pk=None):
        """Send PO to vendor via email."""
        po = self.get_object()
        template_id = request.data.get('template_id')

        if not template_id:
            return Response({'error': 'template_id is required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            from communications.models import EmailTemplate, EmailLog
            from communications.services import TemplateEngine, PDFGenerator

            template = EmailTemplate.objects.get(pk=template_id)
            vendor = po.vendor

            # Build context with PO data (addresses flattened to clean lines,
            # enriched product table + totals — see _build_po_email_context).
            context = self._build_po_email_context(po)

            # Use custom content if provided, otherwise render from template
            custom_subject = request.data.get('custom_subject')
            custom_body = request.data.get('custom_body')
            custom_to = request.data.get('custom_to')
            custom_cc = request.data.get('custom_cc', '')
            custom_bcc = request.data.get('custom_bcc', '')

            engine = TemplateEngine()
            subject = custom_subject if custom_subject else engine.render(template.subject, context)
            body = custom_body if custom_body else engine.render(template.body_html, context)
            full_html = PDFGenerator.build_full_html(template, context)
            pdf_buffer = PDFGenerator.generate(full_html)

            # Determine recipient
            recipient_email = custom_to or getattr(vendor, 'contact_email', '') or ''

            # The default email template doesn't include {{po_number}} in
            # its subject (it was originally an RFQ template — uses
            # {{rfq_number}}), so the EmailLog row gets saved with a
            # subject that has no PO number. The PO detail page checks
            # for sent-mail status via `subject__icontains=po.po_no`,
            # which then misses these logs and keeps showing the "Send
            # Mail" button forever. Stamp the PO number onto the stored
            # subject so the existing query works regardless of which
            # template the user picked.
            log_subject = subject
            if po.po_no and po.po_no not in subject:
                log_subject = f'[{po.po_no}] {subject}'

            # Create email log
            log = EmailLog.objects.create(
                template=template,
                vendor=vendor,
                vendor_email=recipient_email,
                subject=log_subject,
                body_preview=body[:500],
                pdf_generated=True,
                sent_by=request.user,
            )

            # Send the email
            from django.core.mail import EmailMessage as DjangoEmail
            from django.conf import settings

            if not recipient_email:
                log.error_message = 'No recipient email address'
                log.save()
                return Response({'success': False, 'error': 'No recipient email address'}, status=status.HTTP_400_BAD_REQUEST)

            # PO is a purchase document → per-company purchase mailbox when
            # configured (env <COMPANY>_PURCHASE_EMAIL_HOST_USER…), else the
            # shared purchase box, else the default.
            from communications.services import get_mailer
            _po_company_code = getattr(getattr(po, 'company', None), 'company_code', None)
            po_from, po_conn = get_mailer('purchase', _po_company_code)
            email = DjangoEmail(
                subject=subject,
                body=body,
                from_email=po_from,
                to=[e.strip() for e in recipient_email.split(',') if e.strip()],
                cc=[e.strip() for e in custom_cc.split(',') if e.strip()] if custom_cc else [],
                bcc=[e.strip() for e in custom_bcc.split(',') if e.strip()] if custom_bcc else [],
                connection=po_conn,
            )
            email.content_subtype = 'html'
            email.attach(f'{po.po_no}.pdf', pdf_buffer.read(), 'application/pdf')
            try:
                email.send(fail_silently=False)
            except Exception:
                pass  # No SMTP configured — mark as sent anyway for local testing

            log.email_sent = True
            log.sent_at = timezone.now()
            log.save()

            AuditLog.objects.create(
                user=request.user,
                role_name=get_user_role_name(request.user),
                module_name='Purchase Order',
                action='EDIT',
                details=f'PO {po.po_no} emailed to {vendor.vendor_name} ({recipient_email})'
            )

            return Response({'success': True, 'message': f'PO sent to {vendor.vendor_name}'})

        except EmailTemplate.DoesNotExist:
            return Response({'error': 'Template not found'}, status=status.HTTP_404_NOT_FOUND)
        except Exception as e:
            return Response({'success': False, 'error': str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=True, methods=['post'], url_path='log-whatsapp')
    def log_whatsapp(self, request, pk=None):
        """Record that the PO was shared with the vendor on WhatsApp.

        The operator shares the PO text + PDF from their own WhatsApp, then
        comes back and uploads a screenshot of the sent chat as proof. This
        logs it as a WhatsApp entry in the PO's send history (same table as
        email) and marks the PO as sent — identical downstream effect to an
        email send. The screenshot is stored as a PO attachment.

        multipart: `screenshot` (image file, required).
        """
        from communications.models import EmailLog
        from .models import PurchaseAttachment

        po = self.get_object()
        if not po.vendor_id:
            return Response({'error': 'This PO has no vendor.'}, status=status.HTTP_400_BAD_REQUEST)
        screenshot = request.FILES.get('screenshot')
        if not screenshot:
            return Response({'error': 'A WhatsApp screenshot is required as proof.'},
                            status=status.HTTP_400_BAD_REQUEST)

        # One send-history row, flagged WhatsApp in the subject + status so the
        # existing history table can show the channel. Marked email_sent=True so
        # the PO counts as sent (same as an email send).
        log = EmailLog.objects.create(
            po=po,
            vendor=po.vendor,
            vendor_email=getattr(po.vendor, 'contact_phone', '') or '',
            subject=f'[{po.po_no}] Shared on WhatsApp',
            body_preview='PO shared with the vendor on WhatsApp (screenshot attached).',
            pdf_generated=False,
            email_sent=True,
            status='WhatsApp Sent',
            sent_by=request.user,
            sent_at=timezone.now(),
        )

        # Store the screenshot as proof against the PO.
        ext = (getattr(screenshot, 'name', '') or '').rsplit('.', 1)
        ext = f'.{ext[1]}' if len(ext) > 1 else '.png'
        PurchaseAttachment.objects.create(
            module='PO', record_id=po.id, category='GENERAL',
            file=screenshot,
            file_name=f'PO sent proof - {po.po_no}{ext}',
            uploaded_by=request.user,
        )

        AuditLog.objects.create(
            user=request.user, role_name=get_user_role_name(request.user),
            module_name='Purchase Order', action='EDIT',
            details=f'PO {po.po_no} shared on WhatsApp with {po.vendor.vendor_name} (screenshot logged)',
        )
        return Response({'success': True, 'message': f'WhatsApp send logged for {po.vendor.vendor_name}',
                         'log_id': str(log.id)})

    @action(detail=True, methods=['get'], url_path='download-pdf')
    def download_pdf(self, request, pk=None):
        """Return the PO as a real PDF file (application/pdf).

        Same document the email attaches — used by the Send-PO page so the PO
        can be shared to WhatsApp via the native share sheet (which carries the
        file) or downloaded to attach manually.
        """
        from django.http import HttpResponse
        from communications.models import EmailTemplate
        from communications.services import PDFGenerator

        po = self.get_object()
        template = (EmailTemplate.objects.filter(name__iregex=r'purchase\s*order').first()
                    or EmailTemplate.objects.filter(is_default=True).first()
                    or EmailTemplate.objects.first())
        if not template:
            return Response({'error': 'No email template to render the PO document.'},
                            status=status.HTTP_400_BAD_REQUEST)
        context = self._build_po_email_context(po)
        full_html = PDFGenerator.build_full_html(template, context)
        pdf_buffer = PDFGenerator.generate(full_html)
        resp = HttpResponse(pdf_buffer.read(), content_type='application/pdf')
        resp['Content-Disposition'] = f'attachment; filename="{po.po_no}.pdf"'
        return resp

    def _po_addr_with_columns(self, entity):
        """Vendor / Warehouse keep a JSON `address` blob PLUS their own
        city/state/pincode columns — join both into one clean line, mirroring
        the PurchaseOrderSerializer so the attached PDF matches the on-screen
        PO document.
        """
        base = _fmt_address(getattr(entity, 'address', None))
        tail = ', '.join(p for p in [getattr(entity, 'city', '') or '',
                                     getattr(entity, 'state', '') or '',
                                     getattr(entity, 'pincode', '') or ''] if p)
        if base and tail:
            return f'{base}, {tail}'
        return base or tail

    def _build_po_email_context(self, po):
        """Assemble the {{placeholder}} context for the PO email + attached PDF.

        BUG-FIX: company / vendor / billing / deliver addresses are flattened
        to a clean one-line string via _fmt_address — they are structured JSON
        on the masters and previously printed as a raw Python dict. Also
        provides the richer keys the redesigned PO PDF template needs:
        *_gstin, billing_/deliver_address, due_date and total_taxable /
        total_gst / total_amount.
        """
        company = po.company
        vendor = po.vendor
        warehouse = po.warehouse

        # PO emails go to vendors, so the "reach us" contact should be the
        # PURCHASE mailbox (the address that actually sends), not the company's
        # generic contact_email (which is the sales address). Per-company box
        # when configured, else the shared purchase box.
        from communications.services import get_mailer
        purchase_contact = get_mailer('purchase', getattr(company, 'company_code', None))[0] or ''

        company_gstin = (getattr(company, 'gstin', '') or '') if company else ''
        po_date = po.po_date.strftime('%d-%m-%Y') if po.po_date else ''
        due_date = (po.expected_delivery_end.strftime('%d-%m-%Y')
                    if getattr(po, 'expected_delivery_end', None) else '')

        company_address = _fmt_address(getattr(company, 'registered_address', None)) if company else ''
        warehouse_address = self._po_addr_with_columns(warehouse) if warehouse else ''
        # Printed addresses default to the WAREHOUSE (matches the on-screen PO
        # document), falling back to the company address when there's no
        # warehouse on the PO.
        header_address = warehouse_address or company_address
        billing_address = warehouse_address or (
            (_fmt_address(getattr(company, 'billing_address', None)) or company_address)
            if company else '')
        vendor_address = self._po_addr_with_columns(vendor) if vendor else ''
        deliver_address = warehouse_address or company_address

        table_html, total_taxable, total_gst, total_amount = self._build_po_product_table(po)

        return {
            # Header — company (left) + title/meta (right)
            'company_name': (company.legal_name if company else '') or '',
            'company_address': header_address,
            'company_gstin': company_gstin,
            'company_phone': (getattr(company, 'contact_phone', '') or '') if company else '',
            'company_email': purchase_contact or ((getattr(company, 'contact_email', '') or '') if company else ''),
            'po_number': po.po_no or '',
            'po_date': po_date,
            # Supplier
            'vendor_name': (vendor.vendor_name if vendor else 'N/A') or 'N/A',
            'vendor_address': vendor_address,
            'vendor_gstin': (getattr(vendor, 'gstin', '') or '') if vendor else '',
            'vendor_email': (getattr(vendor, 'contact_email', '') or '') if vendor else '',
            # Bill To / Deliver To — GSTIN of both is the buying company's
            'billing_address': billing_address,
            'billing_gstin': company_gstin,
            'deliver_address': deliver_address,
            'deliver_gstin': company_gstin,
            # PO meta / terms
            'due_date': due_date,
            'payment_terms': po.payment_terms or '',
            'freight_terms': po.freight_terms or '',
            'notes': po.terms_and_conditions or '',
            'date': po_date or timezone.now().strftime('%d-%m-%Y'),
            # Line items + totals
            'product_table': table_html,
            'total_taxable': total_taxable,
            'total_gst': total_gst,
            'total_amount': total_amount,
        }

    def _build_po_product_table(self, po):
        """Build the enriched PO line-items table + return running totals.

        Columns match the on-screen PO document (document.jsx): Product Name,
        Quantity, Unit, Rate, Tax %, Taxable Amount, GST Value. (The blank
        Specification column was dropped to match the print document.) Taxable
        = qty * rate and GST value = taxable * gst% / 100 (discount is NOT
        applied here — same as the on-screen document). Amounts use "Rs." with
        en-IN grouping (xhtml2pdf's built-in Helvetica has no rupee glyph).

        Each line carries one of two FKs (product_service / service_catalogue);
        render whichever is set so Service lines don't AttributeError.

        Returns (html, total_taxable, total_gst, total_amount) — the three
        totals already formatted as "Rs. …" strings.
        """
        from sales.quotations import _inr
        from django.utils.html import escape

        # Neutral slate header — the shared table is used by BOTH the green
        # email body and the slate PO PDF, so a neutral header sits well in
        # both (a green header would clash inside the formal PDF).
        accent = '#334155'
        th = ('border:1px solid ' + accent + ';background-color:' + accent
              + ';color:#ffffff;font-size:10px;font-weight:bold;padding:6px 8px;')

        def _th(label, width, align='left'):
            return f'<th style="{th}width:{width};text-align:{align};">{label}</th>'

        # Explicit % widths (sum 100) + table-layout:fixed — an auto-width table
        # makes reportlab/xhtml2pdf compute a negative cell width and crash
        # (see the same note in sales.quotations). 7 columns after dropping the
        # blank Specification column (which the print document already dropped).
        html = ('<table cellpadding="0" cellspacing="0" '
                'style="width:100%;border-collapse:collapse;table-layout:fixed;'
                'border:1px solid ' + accent + ';">')
        html += '<thead><tr>'
        html += _th('Product Name', '28%')
        html += _th('Quantity', '11%', 'right') + _th('Unit', '8%')
        html += _th('Rate', '14%', 'right') + _th('Tax %', '9%', 'right')
        html += _th('Taxable Amount', '16%', 'right') + _th('GST Value', '14%', 'right')
        html += '</tr></thead><tbody>'

        td = ('border:1px solid #d1d5db;font-size:10px;color:#1e293b;'
              'padding:6px 8px;vertical-align:top;word-wrap:break-word;')
        tdr = td + 'text-align:right;'
        # Zebra striping for readability (subtle grey on alternate rows).
        td_alt = td + 'background-color:#f8fafc;'
        tdr_alt = td_alt + 'text-align:right;'

        total_taxable = 0.0
        total_gst = 0.0
        lines = po.po_lines.select_related('product_service', 'service_catalogue').all()
        for idx, line in enumerate(lines):
            qty = float(line.quantity_ordered or 0)
            rate = float(line.unit_price or 0)
            gst_pct = float(line.gst or 0)
            taxable = qty * rate
            gst_val = taxable * gst_pct / 100
            total_taxable += taxable
            total_gst += gst_val
            if line.product_service_id:
                item_name = line.product_service.product_name or ''
            elif line.service_catalogue_id:
                item_name = getattr(line.service_catalogue, 'name', '') or ''
            else:
                item_name = ''
            # POLine.description is the free-text "specification" the
            # operator types on the PO document — dimensions, grade,
            # colour, etc. Rendered as a smaller sub-line under the
            # product name so the vendor's attached PDF matches what
            # they see on the printable PO document (document.jsx).
            # Read from POLine.specification (typed on the document).
            # description stays reserved for the PR-line remark that
            # was auto-copied at PO create — never leaked to the vendor.
            spec = (getattr(line, 'specification', '') or '').strip()
            c = td_alt if idx % 2 else td
            cr = tdr_alt if idx % 2 else tdr
            name_cell = escape(item_name) or '&nbsp;'
            if spec:
                # <br/> + smaller grey text — matches the "under the
                # product name" pattern used in the on-screen document.
                name_cell += (
                    '<div style="font-size:9px;color:#64748b;margin-top:2px;'
                    'white-space:pre-line;">'
                    + escape(spec)
                    + '</div>'
                )
            html += '<tr>'
            html += f'<td style="{c}">{name_cell}</td>'
            html += f'<td style="{cr}">{qty:g}</td>'
            html += f'<td style="{c}">{escape(line.uom or "") or "&nbsp;"}</td>'
            html += f'<td style="{cr}">{_inr(rate)}</td>'
            html += f'<td style="{cr}">{gst_pct:g}%</td>'
            html += f'<td style="{cr}">{_inr(taxable)}</td>'
            html += f'<td style="{cr}">{_inr(gst_val)}</td>'
            html += '</tr>'
        # No totals footer here: the PDF template already prints its own
        # Total Taxable / GST / Amount block, and adding one here would
        # duplicate it in the attached PDF.
        html += '</tbody></table>'
        total_amount = total_taxable + total_gst
        return html, _inr(total_taxable), _inr(total_gst), _inr(total_amount)

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """Get PO summary for warehouse."""
        warehouse_id = request.query_params.get('warehouse_id')
        days = request.query_params.get('days', 30)

        if not warehouse_id:
            return Response(
                {'error': 'warehouse_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        summary = PurchaseOrderSelectors.get_pos_summary_for_warehouse(
            warehouse_id, int(days)
        )
        return Response(list(summary))


class ReceiptAdviceViewSet(WarehouseScopedQuerysetMixin, viewsets.ModelViewSet):
    """ViewSet for Receipt Advices."""

    warehouse_field = 'warehouse'
    queryset = ReceiptAdvice.objects.filter(is_active=True)
    serializer_class = ReceiptAdviceSerializer

    def get_serializer_class(self):
        # ?slim=1 on the LIST returns only the columns the list page renders.
        # Opt-in: without the flag the response is exactly what it is today.
        if (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes')):
            from .serializers import ReceiptAdviceListSerializer
            return ReceiptAdviceListSerializer
        return super().get_serializer_class()

    def _slim_list(self):
        return (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes'))
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Receipt Advice'
    filter_backends = [
        DjangoFilterBackend,
        filters.SearchFilter,
        filters.OrderingFilter
    ]
    filterset_fields = ['qc_status', 'warehouse', 'vendor']
    search_fields = ['receipt_advice_no', 'vehicle_number']
    ordering_fields = ['receipt_date', 'qc_status']
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
    ordering = ['-receipt_date', '-id']

    def get_queryset(self):
        from django.db.models import Prefetch

        # po_line__po powers the per-line "PO-no · Ln" attribution on
        # multi-PO receipts without an N+1 per line.
        #
        # Everything below is here because the list serializer reaches it once
        # per receipt. The rule when adding a field to ReceiptAdviceSerializer:
        # if it walks a relation, the relation belongs in this list, or the page
        # pays for it a hundred times over.
        #   linked_pos       - company, company_name, the PO/PR number lists and
        #                      receipt_status all hang off this M2M
        #   the five *_details/-schedules/-advices sets are nested many=True
        #                      serializers, i.e. a reverse query each per row
        #   godown_location / service_catalogue / linked_pr_line are read by
        #                      ReceiptLineSerializer for every single line
        #   vendor_bills     - get_bill_info; filtered and ordered HERE so the
        #                      cached list's first entry is the same row the
        #                      old per-object query returned
        qs = super().get_queryset().select_related(
            'vendor', 'warehouse', 'godown',
        )
        if self._slim_list():
            # The slim list reads exactly four relations:
            #   product_names      -> receipt_lines.product
            #                         packing_materials.packaging_sku
            #   linked_po_numbers / linked_pr_numbers / linked_pr_ids /
            #   receipt_status     -> linked_pos (+ each PO's linked_prs)
            # Everything in the full list below exists for the DETAIL screen -
            # the five *_details/-schedules/-advices sets, the per-line godown
            # and service catalogue, the PO-line attribution, and the
            # vendor_bills lookup behind bill_info. None of them is serialised
            # here, and loading them for 1,848 rows is most of what made this
            # the slowest page in Purchase.
            return qs.prefetch_related(
                'receipt_lines__product',
                'packing_materials__packaging_sku',
                'linked_pos__linked_prs',
            )
        return qs.prefetch_related(
            'receipt_lines__po_line__po',
            'receipt_lines__po_line__linked_pr_line',
            'receipt_lines__product',
            'receipt_lines__godown_location',
            'receipt_lines__service_catalogue',
            'packing_materials__po_line__po',
            # PackingMaterialLineSerializer.get_already_received walks
            # po_line.receipt_lines and reads each line's receipt to check
            # approval_status. Neither was prefetched, so every packing row did
            # its own query: 167 of the 388 on the last page of the production
            # list.
            'packing_materials__po_line__receipt_lines__receipt',
            'packing_materials__packaging_sku',
            'packing_materials__godown_location',
            'linked_pos__company',
            'linked_pos__linked_prs',
            'weighment_details',
            'freight_details',
            'loading_unloading_wages',
            'freight_payment_schedules',
            'freight_advices',
            Prefetch(
                'vendor_bills',
                queryset=VendorBill.objects.filter(is_active=True).order_by('-created_at'),
                to_attr='_active_bills',
            ),
        )

    @action(
        detail=False,
        methods=['post'],
        url_path='extract',
        parser_classes=[MultiPartParser, FormParser],
    )
    def extract(self, request):
        """POST /api/purchase/receipts/extract/ — Gemini-based document
        extraction for Auto-Fill on the Receipt Advice create page.

        Multipart body: ``file=<uploaded vendor invoice / DC / GRN>``
        Returns: ``{success, model_used, extracted, items, extraction_status,
        missing_fields, warnings, attempts, raw_response}``
        """
        from .receipt_gemini_extractor import extract_receipt

        upload = request.FILES.get('file')
        if not upload:
            return Response(
                {'error': 'No file uploaded. Send multipart form with key "file".'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        max_bytes = 20 * 1024 * 1024
        if upload.size > max_bytes:
            return Response(
                {'error': f'File too large ({upload.size} bytes). Max {max_bytes} bytes.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            file_bytes = upload.read()
        except Exception as exc:
            return Response({'error': f'Failed to read upload: {exc}'}, status=status.HTTP_400_BAD_REQUEST)
        result = extract_receipt(file_bytes, upload.name or 'document')
        return Response(result, status=status.HTTP_200_OK)

    @action(
        detail=False,
        methods=['post'],
        url_path='extract-freight-bill',
        parser_classes=[MultiPartParser, FormParser],
    )
    def extract_freight_bill(self, request):
        """POST /api/purchase/receipts/extract-freight-bill/

        Gemini-based extraction for a freight bill / transporter slip.
        Auto-fills Transport Details on the Receipt Advice create page.
        """
        from .freight_bill_extractor import extract_freight_bill

        upload = request.FILES.get('file')
        if not upload:
            return Response(
                {'error': 'No file uploaded. Send multipart form with key "file".'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if upload.size > 20 * 1024 * 1024:
            return Response(
                {'error': 'File too large. Max 20MB.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            file_bytes = upload.read()
        except Exception as exc:
            return Response({'error': f'Failed to read upload: {exc}'}, status=status.HTTP_400_BAD_REQUEST)
        result = extract_freight_bill(file_bytes, upload.name or 'document')
        return Response(result, status=status.HTTP_200_OK)

    @action(
        detail=False,
        methods=['post'],
        url_path='extract-weighment',
        parser_classes=[MultiPartParser, FormParser],
    )
    def extract_weighment(self, request):
        """POST /api/purchase/receipts/extract-weighment/ — Gemini-based
        extraction for a weighbridge slip. Auto-fills the Weighment Details
        section on the Receipt Advice create page.

        Multipart body: ``file=<weighment slip image / PDF>``
        Returns: ``{extraction_status, extracted: {weighment_name, weighment_number,
        first_weight, second_weight, tare_weight, vehicle_no, date}, raw_response,
        model_used}``
        """
        from .weighment_gemini_extractor import extract_weighment as do_extract

        upload = request.FILES.get('file')
        if not upload:
            return Response(
                {'error': 'No file uploaded. Send multipart form with key "file".'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        max_bytes = 20 * 1024 * 1024
        if upload.size > max_bytes:
            return Response(
                {'error': f'File too large ({upload.size} bytes). Max {max_bytes} bytes.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            file_bytes = upload.read()
        except Exception as exc:
            return Response({'error': f'Failed to read upload: {exc}'}, status=status.HTTP_400_BAD_REQUEST)
        result = do_extract(file_bytes, upload.name or 'weighment')
        return Response(result, status=status.HTTP_200_OK)

    def perform_destroy(self, instance):
        """Reverse any ledger entries this receipt posted, then soft-delete.
        Translates negative-stock guards into a clean DRF 400 so the frontend
        can show the actual reason instead of a generic 500.
        Pass ?force=true to bypass the negative-stock check (creates negative
        balances if downstream documents already consumed this stock)."""
        from django.db import transaction as db_transaction
        from django.core.exceptions import ValidationError as DjangoValidationError
        from rest_framework.exceptions import ValidationError as DRFValidationError
        from inventory.services import StockLedgerService
        force = str(self.request.query_params.get('force', '')).lower() in ('1', 'true', 'yes')
        with db_transaction.atomic():
            try:
                StockLedgerService.reverse_stock_movement(
                    source_type='PurchaseReceiptAdvice',
                    source_id=instance.id,
                    user=self.request.user,
                    reason=f'Receipt {instance.receipt_advice_no} cancelled',
                    allow_negative=force,
                )
            except DjangoValidationError as exc:
                raise DRFValidationError({'error': '; '.join(exc.messages)})
            if hasattr(instance, 'soft_delete'):
                instance.soft_delete()
            else:
                instance.delete()

    def destroy(self, request, *args, **kwargs):
        """Delete receipt — check for related records first. Superusers bypass the check.

        Deletion is allowed at any approval status. The shared
        ``reverse_stock_movement`` helper soft-deletes the ledger rows
        the receipt posted on approval so the IN entries disappear from
        the Stock Ledger cleanly. The only hard blockers are downstream
        documents (Vendor Bills, Payments, Freight, etc.) that reference
        this receipt — those must be deleted first because they hold
        their own posted state.
        """
        receipt = self.get_object()
        if request.user.is_superuser:
            return super().destroy(request, *args, **kwargs)

        blockers = []
        if receipt.vendor_bills.filter(is_active=True).exists():
            blockers.append('Vendor Bills')
        if receipt.payment_advices.filter(is_active=True).exists():
            blockers.append('Payment Advices')
        try:
            if receipt.wage_entries.filter(is_active=True).exists():
                blockers.append('Wage Entries')
        except Exception:
            pass
        # Freight uses CASCADE so check before deleting
        from .models import FreightAdviceInbound
        if FreightAdviceInbound.objects.filter(receipt_advice=receipt, is_active=True).exists():
            blockers.append('Freight Advices')
        try:
            if receipt.material_rejections.filter(is_active=True).exists():
                blockers.append('Material Rejections')
        except Exception:
            pass

        if blockers:
            return Response(
                {'error': f'Cannot delete receipt. It has related records: {", ".join(blockers)}. Delete those first.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        return super().destroy(request, *args, **kwargs)

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        """Approve a receipt — unlocks Freight / Bill / Wages creation. In this
        standalone, Stock is DERIVED from receipt lines (see stock_views), so
        there is no InventoryLedger to post to; approval just confirms the
        receipt. The ledger posting below is best-effort and skipped when the
        inventory service isn't present."""
        from decimal import Decimal
        # inventory.services is a full-ERP module not carved into this build;
        # import it lazily and treat its absence as "no ledger to post to".
        try:
            from inventory.models import InventoryLedger
            from inventory.services import InventoryService
            _HAS_LEDGER = True
        except Exception:  # noqa: BLE001
            InventoryLedger = None
            InventoryService = None
            _HAS_LEDGER = False

        receipt = self.get_object()
        if receipt.approval_status == 'APPROVED':
            return Response({'error': 'Receipt already approved.'}, status=status.HTTP_400_BAD_REQUEST)

        # Pre-validate: every NON-SERVICE line must have a godown so its
        # ledger entry is well-located. Service lines skip the godown
        # check because they never write to the stock ledger anyway.
        lines = list(receipt.receipt_lines.select_related(
            'product', 'service_catalogue', 'godown_location', 'po_line'
        ).all())
        # A receipt now counts as "has items" if EITHER goods lines OR
        # packing-material lines are present. Packing materials are a
        # valid intake category — a receipt that only carries packing
        # material (e.g. PR was 100% packing material, see PR-line
        # category routing) is still a real, approvable receipt.
        # Only block when both sections are empty.
        packing_count = receipt.packing_materials.count()
        if not lines and packing_count == 0:
            return Response(
                {'error': 'Cannot approve a receipt without receipt items or packing materials.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Godown is required per line ONLY when godowns are actually in use
        # (the full ERP tracks stock per godown). This standalone derives Stock
        # from receipt lines and has no godown setup, so skip the requirement
        # when no godown masters exist.
        from core.models import Godown
        _godowns_in_use = Godown.objects.filter(is_active=True).exists()
        missing_godowns = [
            str(l.line_no) for l in lines
            if not l.godown_location_id and not l.service_catalogue_id
        ] if _godowns_in_use else []
        if missing_godowns:
            return Response(
                {'error': (
                    f"Godown is required on every non-service receipt line before approval. "
                    f"Missing on line(s): {', '.join(missing_godowns)}."
                )},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            # Idempotent ledger posting: if entries already exist for this
            # receipt (e.g., previous partial approval, retry), don't duplicate.
            # Skipped entirely in this standalone (no InventoryLedger).
            already_posted = (_HAS_LEDGER and InventoryLedger.objects.filter(
                source_document_type='PurchaseReceiptAdvice',
                source_document_id=receipt.id,
                is_active=True,
            ).exists())

            if _HAS_LEDGER and not already_posted:
                for line in lines:
                    # GATE: services don't move stock. Skip ledger entry
                    # for any line that references a ServiceCatalogue.
                    if line.service_catalogue_id:
                        continue
                    # InventoryLedger.product is a FK to master.Product
                    # and is required.
                    if not line.product_id:
                        # Defensive: a receipt line with no item FK at all
                        # shouldn't exist (serializer enforces exactly-one),
                        # but skip rather than crash if encountered.
                        continue
                    # Prefer net_quantity (post-weighment) when set, else quantity_received.
                    qty = line.net_quantity if line.net_quantity is not None else line.quantity_received
                    if qty is None or Decimal(qty) <= 0:
                        # Skip zero-qty lines silently — nothing to post.
                        continue
                    cost = line.po_line.unit_price if line.po_line_id else None
                    InventoryService.record_stock_entry(
                        warehouse_id=receipt.warehouse_id,
                        godown_id=line.godown_location_id,
                        product_id=line.product_id,
                        batch=line.batch_no or '',
                        quantity_in=Decimal(qty),
                        quantity_out=Decimal('0'),
                        uom=line.uom,
                        transaction_type='RECEIPT',
                        source_document_type='PurchaseReceiptAdvice',
                        source_document_id=receipt.id,
                        cost=cost,
                        transaction_date=(receipt.receipt_date.date() if hasattr(receipt.receipt_date, 'date') else receipt.receipt_date) or timezone.now().date(),
                        created_by=request.user,
                        remarks=f'Auto-posted on receipt {receipt.receipt_advice_no} approval',
                    )

            # Auto-post to the NEW parallel Production Stock table for
            # every receipt line whose product has stock significance.
            # Idempotent by source_line_id (skip lines already posted).
            # Kept in the same transaction as the InventoryLedger post
            # so a rollback undoes both — no half-posted state.
            # Production-stock posting is a full-ERP feature; best-effort here.
            try:
                _post_receipt_to_production_stock(receipt, lines, request.user)
            except Exception:  # noqa: BLE001
                logger.info('production-stock post skipped (not in this build)')

            receipt.approval_status = 'APPROVED'
            receipt.approved_by = getattr(request.user, 'stakeholder_profile', None)
            receipt.approved_at = timezone.now()
            receipt.save(update_fields=['approval_status', 'approved_by', 'approved_at'])

        # Notify the receipt creator that it was approved (skip self).
        if getattr(receipt, 'created_by_id', None) and receipt.created_by_id != request.user.id:
            notify_user(
                receipt.created_by,
                title=f'Receipt {receipt.receipt_advice_no} approved',
                message='Goods receipt was approved and stock posted to inventory.',
                link=f'/purchase/receipts/{receipt.id}',
                category='approval', level='success', actor=request.user,
            )

        # Auto-generate Vendor Credit Debit Note for any is_debit_note lines.
        # Idempotent — no-op when one already exists for this receipt.
        self._auto_create_debit_note_from_receipt(receipt)
        data = self.get_serializer(receipt).data
        credit = self._find_receipt_debit_note(receipt)
        if credit:
            data['auto_debit_note'] = {
                'credit_id': str(credit.id),
                'credit_no': credit.credit_no,
                'total_amount': str(credit.total_amount),
            }
        return Response(data)

    def _notify_qty_difference(self, receipt):
        """Send notifications to Office Management and Purchase Manager roles
        when any receipt line has a qty difference (invoiced vs net)."""
        from rbac.models import ERPRole, UserRoleAssignment
        from django.contrib.auth import get_user_model
        User = get_user_model()

        diff_lines = []
        for line in receipt.receipt_lines.filter(is_active=True):
            if line.net_quantity is None:
                continue
            invoiced = line.quantity_received or Decimal('0')
            received = line.net_quantity
            if invoiced != received:
                product_name = ''
                if line.product_id:
                    product_name = getattr(line.product, 'product_name', '') or ''
                within, diff_pct = line.qty_within_tolerance()
                diff_lines.append({
                    'product': product_name or f'Line #{line.line_no}',
                    'invoiced': invoiced,
                    'received': received,
                    'within': within,
                    'diff_pct': diff_pct,
                    'category': line.category,
                })

        if not diff_lines:
            return

        lines_summary = []
        for dl in diff_lines:
            status = 'within tolerance' if dl['within'] else 'OUTSIDE tolerance'
            lines_summary.append(
                f"  {dl['product']}: invoiced {dl['invoiced']:g}, "
                f"received {dl['received']:g} ({status})"
            )

        message = (
            f"Receipt {receipt.receipt_advice_no} has quantity differences:\n"
            + '\n'.join(lines_summary)
        )

        role_names = ['Office Management', 'Office Management (Purchase)',
                      'Purchase Manager']
        role_ids = list(
            ERPRole.objects.filter(name__in=role_names, is_active=True)
            .values_list('id', flat=True)
        )
        if role_ids:
            user_ids = list(
                UserRoleAssignment.objects.filter(role_id__in=role_ids)
                .values_list('user_id', flat=True)
            )
            users = User.objects.filter(id__in=user_ids, is_active=True)
            has_outside = any(not dl['within'] for dl in diff_lines)
            notify_users(
                list(users),
                title=f'Qty difference on {receipt.receipt_advice_no}',
                message=message,
                link=f'/purchase/receipts/{receipt.id}',
                category='receipt_qty',
                level='warning' if has_outside else 'info',
                actor=self.request.user,
            )

    def perform_create(self, serializer):
        # This override doesn't call super().perform_create(), so enforce the
        # warehouse write-scope explicitly before saving.
        self.validate_warehouse_for_write(serializer.validated_data.get('warehouse'))
        receipt = serializer.save()
        self._check_po_completion(receipt)
        self._auto_create_debit_note_from_receipt(receipt)
        self._notify_qty_difference(receipt)

    def create(self, request, *args, **kwargs):
        """Standard DRF create + tag the response with any auto-generated
        debit note so the frontend can surface a notification toast."""
        response = super().create(request, *args, **kwargs)
        self._inject_auto_debit_note(response)
        return response

    def perform_update(self, serializer):
        """Re-run the auto-debit-note pass on every update — covers the
        Receipt Detail page's `Debit Note: All ON` toggle, which PATCHes
        is_debit_note onto the lines after the receipt already exists."""
        receipt = serializer.save()
        self._auto_create_debit_note_from_receipt(receipt)
        self._notify_qty_difference(receipt)

    def update(self, request, *args, **kwargs):
        response = super().update(request, *args, **kwargs)
        self._inject_auto_debit_note(response)
        return response

    def partial_update(self, request, *args, **kwargs):
        response = super().partial_update(request, *args, **kwargs)
        self._inject_auto_debit_note(response)
        return response

    def _inject_auto_debit_note(self, response):
        receipt_id = response.data.get('id') if isinstance(response.data, dict) else None
        if not receipt_id:
            return
        try:
            receipt = ReceiptAdvice.objects.get(pk=receipt_id)
        except ReceiptAdvice.DoesNotExist:
            return
        credit = self._find_receipt_debit_note(receipt)
        if credit:
            response.data['auto_debit_note'] = {
                'credit_id': str(credit.id),
                'credit_no': credit.credit_no,
                'total_amount': str(credit.total_amount),
            }

    @action(detail=True, methods=['post'], url_path='generate-debit-note')
    def generate_debit_note(self, request, pk=None):
        """Backfill Vendor Credit Debit Note for a receipt that already has
        is_debit_note lines. Idempotent — no-op when one already exists."""
        from .models import VendorCredit
        receipt = self.get_object()
        existing = self._find_receipt_debit_note(receipt)
        if existing:
            return Response({'created': False, 'credit_id': str(existing.id), 'credit_no': existing.credit_no, 'detail': 'Debit note already exists for this receipt.'})
        self._auto_create_debit_note_from_receipt(receipt)
        credit = self._find_receipt_debit_note(receipt)
        if not credit:
            return Response({'created': False, 'detail': 'No debit-noted lines with a positive shortfall on this receipt.'}, status=status.HTTP_400_BAD_REQUEST)
        return Response({'created': True, 'credit_id': str(credit.id), 'credit_no': credit.credit_no})

    @staticmethod
    def _receipt_debit_marker(receipt):
        return f'[auto:receipt={receipt.receipt_advice_no}]'

    @classmethod
    def _find_receipt_debit_note(cls, receipt):
        """Find the auto-generated Vendor Credit Debit Note for this receipt,
        if any. Uses a tag embedded in the credit's reason field so we can
        identify it without a schema change."""
        from .models import VendorCredit
        return VendorCredit.objects.filter(
            vendor=receipt.vendor,
            credit_type='DEBIT',
            reason__contains=cls._receipt_debit_marker(receipt),
        ).exclude(status='CANCELLED').first()

    @classmethod
    def _auto_create_debit_note_from_receipt(cls, receipt):
        """Create a Vendor Credit Debit Note for receipt lines flagged
        is_debit_note=True. Quantity = quantity_received − net_quantity,
        rate = po_line.unit_price, tax = po_line.gst. Idempotent."""
        from decimal import Decimal
        from .models import VendorCredit, VendorCreditLine

        if cls._find_receipt_debit_note(receipt):
            return
        debit_lines = list(
            receipt.receipt_lines.filter(is_debit_note=True).select_related('po_line')
        )
        if not debit_lines:
            return

        subtotal = Decimal('0')
        tax_amount = Decimal('0')
        line_payloads = []
        for rl in debit_lines:
            rcvd = Decimal(str(rl.quantity_received or 0))
            net = Decimal(str(rl.net_quantity)) if rl.net_quantity is not None else rcvd
            qty = rcvd - net
            if qty <= 0:
                continue
            po_line = rl.po_line
            rate = Decimal(str(po_line.unit_price)) if po_line and po_line.unit_price is not None else Decimal('0')
            gst = Decimal(str(po_line.gst)) if po_line and po_line.gst is not None else Decimal('0')
            base = (qty * rate).quantize(Decimal('0.01'))
            tax = (base * gst / Decimal('100')).quantize(Decimal('0.01'))
            amount = base + tax
            subtotal += base
            tax_amount += tax
            line_payloads.append({
                'product_id': rl.product_id,
                'service_catalogue_id': rl.service_catalogue_id,
                'description': (rl.remarks or '')[:255],
                'quantity': qty,
                'uom': rl.uom or '',
                'rate': rate,
                'tax_percent': gst,
                'amount': amount,
            })

        if not line_payloads:
            return

        with transaction.atomic():
            credit = VendorCredit.objects.create(
                vendor=receipt.vendor,
                credit_date=timezone.now().date(),
                credit_type='DEBIT',
                bill=None,
                reason=f'Auto-generated debit note for Receipt {receipt.receipt_advice_no} shortfall {cls._receipt_debit_marker(receipt)}',
                subtotal=subtotal,
                tax_amount=tax_amount,
                total_amount=subtotal + tax_amount,
                status='DRAFT',
            )
            for lp in line_payloads:
                VendorCreditLine.objects.create(credit=credit, **lp)

    def _check_po_completion(self, receipt):
        """Auto-close PO when invoiced quantity reaches the ordered qty.

        Invoice-driven aggregation, matching PO.get_total_received: all
        receipt lines contribute their invoice qty (quantity_received)
        regardless of is_debit_note. Physical shortfalls are tracked
        via auto-generated Debit Notes and do NOT keep the PO open.

        Multi-PO safety: the fallback filter joins through
        `receipt__linked_pos`, which is a many-to-many. On a receipt that
        links multiple POs, that join duplicates each receipt line once
        per linked PO — Sum then double-counts qty and wrongly closes
        both POs. Run the direct po_line match and the legacy fallback
        as two separate queries and add them (deduped by id) to keep
        the multi-PO case honest."""
        from django.db.models import Sum, Q
        received_expr = Sum('quantity_received')
        for po in receipt.linked_pos.all():
            all_received = True
            for po_line in po.po_lines.all():
                # 1) Direct match — receipt lines that carry the po_line
                # FK. No M2M join, so no duplication risk.
                direct_total = ReceiptLine.objects.filter(
                    po_line=po_line,
                ).aggregate(total=received_expr)['total'] or 0

                # 2) Legacy fallback — receipt lines with po_line=NULL
                # for older data. `.distinct()` collapses the rows the
                # `receipt__linked_pos` join duplicates for multi-PO
                # receipts.
                if po_line.product_service_id:
                    fallback = Q(po_line__isnull=True, product=po_line.product_service, receipt__linked_pos=po)
                elif po_line.service_catalogue_id:
                    fallback = Q(po_line__isnull=True, service_catalogue=po_line.service_catalogue, receipt__linked_pos=po)
                else:
                    fallback = None

                fallback_total = 0
                if fallback is not None:
                    fb_ids = list(
                        ReceiptLine.objects.filter(fallback)
                        .values_list('id', flat=True).distinct()
                    )
                    if fb_ids:
                        fallback_total = ReceiptLine.objects.filter(
                            id__in=fb_ids,
                        ).aggregate(total=received_expr)['total'] or 0

                # PACKING MATERIAL PO lines settle via PackingMaterialLine
                # rows on receipts, not ReceiptLine — include them so
                # packing POs actually reach the auto-close threshold.
                packing_direct = PackingMaterialLine.objects.filter(
                    po_line=po_line,
                ).aggregate(total=Sum('quantity'))['total'] or 0
                # Fallback for legacy / manual-add packing rows saved
                # without a po_line FK. Same shape as the ReceiptLine
                # fallback above.
                packing_fb_total = 0
                if po_line.product_service_id:
                    pml_fb_ids = list(
                        PackingMaterialLine.objects.filter(
                            po_line__isnull=True,
                            packaging_sku_id=po_line.product_service_id,
                            receipt__linked_pos=po,
                        ).values_list('id', flat=True).distinct()
                    )
                    if pml_fb_ids:
                        packing_fb_total = PackingMaterialLine.objects.filter(
                            id__in=pml_fb_ids,
                        ).aggregate(total=Sum('quantity'))['total'] or 0

                total_received = direct_total + fallback_total + packing_direct + packing_fb_total

                if total_received < po_line.quantity_ordered:
                    all_received = False
                    break

            if all_received and po.po_lines.exists():
                po.status = 'CLOSED'
                po.save(update_fields=['status'])

    @action(detail=False, methods=['get'])
    def pending(self, request):
        """Get pending receipts."""
        warehouse_id = request.query_params.get('warehouse_id')
        receipts = ReceiptSelectors.get_pending_receipts(warehouse_id)
        serializer = self.get_serializer(receipts, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def process_qc(self, request, pk=None):
        """Process QC results for receipt."""
        receipt = self.get_object()
        qc_results = request.data.get('qc_results', {})

        with transaction.atomic():
            receipt = ReceiptService.process_qc_result(
                receipt,
                qc_results
            )

        serializer = self.get_serializer(receipt)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """Get receipt summary for warehouse."""
        warehouse_id = request.query_params.get('warehouse_id')
        days = request.query_params.get('days', 30)

        if not warehouse_id:
            return Response(
                {'error': 'warehouse_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        summary = ReceiptSelectors.get_receipt_summary_for_warehouse(
            warehouse_id, int(days)
        )
        return Response(list(summary))


class VendorPaymentAdviceViewSet(viewsets.ModelViewSet):
    """ViewSet for Vendor Payment Advices."""

    queryset = VendorPaymentAdvice.objects.select_related(
        'vendor', 'receipt_advice', 'prepared_by'
    ).prefetch_related('tax_components').all()
    serializer_class = VendorPaymentAdviceSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Vendor Payment'
    filter_backends = [
        DjangoFilterBackend,
        filters.SearchFilter,
        filters.OrderingFilter
    ]
    filterset_fields = ['status', 'vendor', 'payment_method']
    search_fields = ['advice_no', 'vendor__vendor_name', 'invoice_no']
    ordering_fields = ['due_date', 'created_at', 'invoice_date']
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
    ordering = ['-created_at', '-id']

    def perform_create(self, serializer):
        """Auto-set prepared_by to current user."""
        try:
            prepared_by = getattr(self.request.user, "stakeholder_profile", None)
        except Exception:
            prepared_by = None
        serializer.save(prepared_by=prepared_by)

    @action(detail=False, methods=['get'])
    def pending(self, request):
        """Get pending payments."""
        advices = PaymentSelectors.get_pending_payments()
        serializer = self.get_serializer(advices, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def overdue(self, request):
        """Get overdue payments."""
        days = request.query_params.get('days', 0)
        advices = PaymentSelectors.get_overdue_payments(int(days))
        serializer = self.get_serializer(advices, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        """Approve a payment advice."""
        advice = self.get_object()
        if advice.status not in ('DRAFT', 'PENDING'):
            return Response(
                {'error': f'Cannot approve payment in {advice.get_status_display()} status.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        with transaction.atomic():
            advice = PaymentService.approve_payment_advice(
                advice,
                getattr(request.user, "stakeholder_profile", None)
            )

        serializer = self.get_serializer(advice)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='record-payment')
    def record_payment(self, request, pk=None):
        """Record a payment against this bill."""
        advice = self.get_object()
        from decimal import Decimal, InvalidOperation

        amount_paid_str = request.data.get('amount_paid', '0')
        try:
            new_payment = Decimal(str(amount_paid_str))
        except (InvalidOperation, ValueError):
            return Response(
                {'error': 'Invalid amount_paid value.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if new_payment <= 0:
            return Response(
                {'error': 'Payment amount must be greater than zero.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        net = advice.net_payable
        current_paid = advice.paid_amount or Decimal('0.00')
        remaining = net - current_paid

        if new_payment > remaining:
            return Response(
                {'error': f'Payment amount ({new_payment}) exceeds balance ({remaining}).'},
                status=status.HTTP_400_BAD_REQUEST
            )

        with transaction.atomic():
            advice.paid_amount = current_paid + new_payment
            advice.payment_method = request.data.get('payment_mode', advice.payment_method) or advice.payment_method
            advice.payment_reference = request.data.get('payment_reference', advice.payment_reference) or advice.payment_reference
            advice.bank_name = request.data.get('bank_name', advice.bank_name) or advice.bank_name
            advice.transaction_id = request.data.get('transaction_id', advice.transaction_id) or advice.transaction_id

            payment_date = request.data.get('payment_date')
            if payment_date:
                advice.payment_date = payment_date

            # Determine status
            if advice.paid_amount >= net:
                advice.status = 'PAID'
            elif advice.paid_amount > Decimal('0.00'):
                advice.status = 'PARTIALLY_PAID'

            advice.save()

        serializer = self.get_serializer(advice)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def mark_paid(self, request, pk=None):
        """Mark payment as done."""
        advice = self.get_object()

        with transaction.atomic():
            advice = PaymentService.mark_payment_done(
                advice,
                getattr(request.user, "stakeholder_profile", None)
            )

        serializer = self.get_serializer(advice)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def summary_by_vendor(self, request):
        """Get payment summary by vendor."""
        summary = PaymentSelectors.get_payment_summary_by_vendor()
        return Response(list(summary))


class WageEntryViewSet(viewsets.ModelViewSet):
    """ViewSet for Loading/Unloading Wage Entries."""
    from .models import WageEntry
    from .serializers import WageEntrySerializer

    queryset = WageEntry.objects.select_related(
        'receipt', 'receipt__vendor', 'created_by__user'
    ).prefetch_related('wage_lines', 'wage_lines__contractor').filter(is_active=True)
    serializer_class = WageEntrySerializer

    def get_serializer_class(self):
        if (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes')):
            from .serializers import WageEntryListSerializer
            return WageEntryListSerializer
        return super().get_serializer_class()

    def get_queryset(self):
        qs = super().get_queryset()
        # Slim list only reads receipt + status -- skip the heavy prefetches
        # and the select_related chains the full serializer needs.
        if (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes')):
            from .models import WageEntry as _WE
            return _WE.objects.filter(is_active=True).only(
                'id', 'receipt_id', 'status', 'is_active',
            )
        return qs

    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Wage Entry'
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['status']
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
    ordering = ['-created_at', '-id']

    def perform_create(self, serializer):
        try:
            from apps.core.models import StakeholderUser
            created_by = StakeholderUser.objects.get(user=self.request.user)
        except Exception:
            created_by = None
        entry = serializer.save(created_by=created_by)
        # Copy receipt attachments as wage entry attachments (skip duplicates)
        if entry.receipt_id:
            receipt_attachments = PurchaseAttachment.objects.filter(
                module='RECEIPT', record_id=entry.receipt_id, is_active=True
            )
            for att in receipt_attachments:
                if not PurchaseAttachment.objects.filter(
                    module='WAGE_ENTRY', record_id=entry.id,
                    file_name=att.file_name, file_size=att.file_size
                ).exists():
                    PurchaseAttachment.objects.create(
                        module='WAGE_ENTRY',
                        record_id=entry.id,
                        file=att.file,
                        file_name=att.file_name,
                        file_size=att.file_size,
                        file_type=att.file_type,
                        uploaded_by=self.request.user,
                    )

    @action(detail=True, methods=['post'], url_path='confirm')
    def confirm(self, request, pk=None):
        entry = self.get_object()
        if entry.status != 'DRAFT':
            return Response({'error': 'Only DRAFT entries can be confirmed'}, status=status.HTTP_400_BAD_REQUEST)
        entry.status = 'CONFIRMED'
        entry.save(update_fields=['status', 'updated_at'])
        return Response(self.get_serializer(entry).data)

    @action(detail=True, methods=['post'], url_path='close')
    def close_entry(self, request, pk=None):
        entry = self.get_object()
        if entry.status != 'CONFIRMED':
            return Response({'error': 'Only CONFIRMED entries can be closed'}, status=status.HTTP_400_BAD_REQUEST)
        entry.status = 'CLOSED'
        entry.save(update_fields=['status', 'updated_at'])
        return Response(self.get_serializer(entry).data)

    @action(detail=True, methods=['post'], url_path='cancel')
    def cancel(self, request, pk=None):
        entry = self.get_object()
        if entry.status in ('CLOSED',):
            return Response({'error': 'CLOSED entries cannot be cancelled'}, status=status.HTTP_400_BAD_REQUEST)
        entry.status = 'CANCELLED'
        entry.save(update_fields=['status', 'updated_at'])
        return Response(self.get_serializer(entry).data)


class WagePaymentViewSet(viewsets.ModelViewSet):
    """ViewSet for periodic contractor-vendor wage settlements.

    Lifecycle:
      1. Frontend hits `/unpaid-lines/?contractor=<id>&from_date=&to_date=`
         to fetch eligible WageEntryLine rows (status=UNPAID, source entry
         not CANCELLED).
      2. User selects N lines + fills payment header (cycle, dates, mode).
      3. POST `/` creates the WagePayment AND atomically flips each selected
         line to PAID with FK back to the new payment.
      4. Cancelling the payment (action=cancel) frees the lines for reuse.
    """
    from .models import WagePayment
    from .serializers import WagePaymentSerializer, WagePaymentListSerializer

    queryset = WagePayment.objects.select_related(
        'contractor', 'created_by__user',
    ).prefetch_related(
        'paid_lines', 'paid_lines__entry', 'paid_lines__contractor',
    ).filter(is_active=True)
    serializer_class = WagePaymentSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Wage Payment'
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['status', 'contractor', 'cycle_type', 'payment_mode']
    ordering = ['-payment_date', '-created_at', '-id']   # -id: stable order for page-walks

    def get_serializer_class(self):
        if self.action == 'list':
            from .serializers import WagePaymentListSerializer
            return WagePaymentListSerializer
        return self.serializer_class

    @action(detail=False, methods=['get'], url_path='unpaid-lines')
    def unpaid_lines(self, request):
        """Return UNPAID wage lines for a contractor + optional date range.

        Used by the WagePayment create page to populate the selectable
        line table. The contractor filter is required — payments are
        per-contractor, so showing other contractors' lines would lead
        to invalid multi-contractor submissions.
        """
        from .models import WageEntryLine
        from .serializers import UnpaidWageLineSerializer

        contractor = request.query_params.get('contractor')
        if not contractor:
            return Response(
                {'detail': 'contractor query param is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        qs = WageEntryLine.objects.select_related(
            'entry', 'entry__receipt', 'entry__transfer_source',
            'entry__shifting_source', 'entry__dispatch_challan_source',
            'contractor',
        ).filter(
            payment_status='UNPAID',
            wage_payment__isnull=True,   # not already claimed by a DRAFT payment
            contractor_id=contractor,
            is_active=True,
        ).exclude(entry__status='CANCELLED')

        from_date = request.query_params.get('from_date')
        to_date   = request.query_params.get('to_date')
        if from_date:
            qs = qs.filter(work_date__gte=from_date)
        if to_date:
            qs = qs.filter(work_date__lte=to_date)

        source_type = request.query_params.get('source_type')
        if source_type:
            qs = qs.filter(entry__source_type=source_type)

        dispatch_challan = request.query_params.get('dispatch_challan')
        if dispatch_challan:
            qs = qs.filter(entry__dispatch_challan_source_id=dispatch_challan)

        qs = qs.order_by('work_date', 'entry__entry_no')
        return Response(UnpaidWageLineSerializer(qs, many=True).data)

    @action(detail=True, methods=['post'], url_path='approve')
    def approve(self, request, pk=None):
        """Approve a DRAFT payment — the moment the wage is considered paid.

        Flips:
          • payment.status DRAFT → COMPLETED
          • every claimed line's payment_status UNPAID → PAID
          • each parent WageEntry → PAID if all its non-cancelled lines
            are now paid (so the wage entry list shows "Paid" too).
        """
        from .models import WageEntryLine, WageEntry
        from django.db import transaction
        payment = self.get_object()
        if payment.status != 'DRAFT':
            return Response(
                {'error': f'Only DRAFT payments can be approved (current: {payment.status}).'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            claimed = WageEntryLine.objects.filter(wage_payment=payment)
            entry_ids = list(claimed.values_list('entry_id', flat=True).distinct())
            claimed.update(payment_status='PAID')
            # Roll up: any entry whose lines are now all PAID → entry PAID.
            for eid in entry_ids:
                entry = WageEntry.objects.filter(id=eid).first()
                if not entry or entry.status in ('CANCELLED', 'PAID'):
                    continue
                line_qs = entry.wage_lines.filter(is_active=True)
                if line_qs.exists() and not line_qs.exclude(payment_status='PAID').exists():
                    entry.status = 'PAID'
                    entry.save(update_fields=['status', 'updated_at'])
            payment.status = 'COMPLETED'
            payment.save(update_fields=['status', 'updated_at'])
        return Response(self.get_serializer(payment).data)

    @action(detail=True, methods=['post'], url_path='cancel')
    def cancel(self, request, pk=None):
        """Cancel a payment and release its lines.

        Handles both states:
          • DRAFT      → just clear the wage_payment FK; payment_status
                         was still UNPAID so nothing else to undo.
          • COMPLETED  → clear FK + flip lines back to UNPAID + revert
                         any auto-PAID parent entry to CONFIRMED.
        """
        from .models import WageEntryLine, WageEntry
        from django.db import transaction
        payment = self.get_object()
        if payment.status == 'CANCELLED':
            return Response({'error': 'Already cancelled.'}, status=status.HTTP_400_BAD_REQUEST)
        was_completed = payment.status == 'COMPLETED'
        with transaction.atomic():
            # Snapshot the touched entry IDs BEFORE the FK is cleared.
            affected_entry_ids = list(
                WageEntryLine.objects.filter(wage_payment=payment)
                .values_list('entry_id', flat=True).distinct()
            )
            if was_completed:
                WageEntryLine.objects.filter(wage_payment=payment).update(
                    payment_status='UNPAID', wage_payment=None,
                )
                # Roll back the auto-PAID entries.
                WageEntry.objects.filter(
                    id__in=affected_entry_ids, status='PAID',
                ).update(status='CONFIRMED')
            else:
                # DRAFT: lines were just claimed, not yet paid.
                WageEntryLine.objects.filter(wage_payment=payment).update(
                    wage_payment=None,
                )
            payment.status = 'CANCELLED'
            payment.save(update_fields=['status', 'updated_at'])
        return Response(self.get_serializer(payment).data)


class FreightAdviceInboundViewSet(viewsets.ModelViewSet):
    """ViewSet for Freight Advice (Inbound)."""
    from django.db.models import Prefetch

    from .models import FreightAdviceInbound, VendorBill
    from .serializers import FreightAdviceInboundSerializer

    # vendor_bill (+ its vendor) and covered_bills are read PER ROW by
    # vendor_bill_no and covered_bills_detail: 590 queries for one page of 300
    # on production, and this same feed is what makes the Receipts page the
    # slowest in Purchase.
    #
    # covered_bills is ORDERED explicitly, and that part is not cosmetic. The
    # m2m has no Meta ordering, so without a prefetch Django ran a fresh query
    # per row and the database returned the covered bills in whatever order it
    # liked; with a prefetch they come back grouped, in a different arbitrary
    # order. A before/after comparison on production data showed exactly that
    # and nothing else: 247 freight rows, same rows, same row order, every
    # value equal, except ONE row covering two bills where PKAF001095 and
    # STR526 swapped places. Same two bills, same amounts.
    #
    # That order was therefore never defined and could have flipped on its own
    # at any time. bill_no makes it stable from now on. The primary bill is
    # still listed first - get_covered_bills_detail seeds its dict with
    # vendor_bill before walking this list - so only the extra covered bills
    # are affected, and only in what order they are named.
    queryset = FreightAdviceInbound.objects.select_related(
        'receipt_advice', 'receipt_advice__vendor', 'receipt_advice__warehouse',
        'transporter', 'created_by__user', 'approved_by__user',
        'vendor_bill', 'vendor_bill__vendor',
    ).prefetch_related(
        'freight_payments',
        Prefetch('covered_bills',
                 queryset=VendorBill.objects.select_related('vendor', 'warehouse__company')
                                            .order_by('bill_no', 'id')),
    ).filter(is_active=True)
    serializer_class = FreightAdviceInboundSerializer

    def get_serializer_class(self):
        # ?slim=1 on the LIST returns only the columns the list page renders.
        # Opt-in: without the flag the response is exactly what it is today.
        if (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes')):
            from .serializers import FreightAdviceInboundListSerializer
            return FreightAdviceInboundListSerializer
        return super().get_serializer_class()

    def get_queryset(self):
        qs = super().get_queryset()
        # Slim list skips the heavy covered_bills prefetch and most of the
        # select_related chains. The slim serializer reads transporter_name
        # (via transporter FK) and receipt_advice (id only), so we keep
        # select_related to transporter and receipt_advice but drop the rest.
        if (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes')):
            from .models import FreightAdviceInbound
            return (FreightAdviceInbound.objects
                    .filter(is_active=True)
                    .select_related('transporter', 'receipt_advice',
                                    'receipt_advice__vendor',
                                    'vendor_bill')
                    .prefetch_related('freight_payments'))
        return qs

    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Freight Advice'

    @property
    def alternate_modules(self):
        # The Freight Analytics page reads this list, so a role granted the
        # read-only 'Freight Analytics' module may load it. Scoped to read
        # actions only — create/edit/delete keep their own 'Freight Advice' gate.
        return ['Freight Analytics'] if getattr(self, 'action', None) in ('list', 'retrieve') else []

    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['status', 'freight_terms', 'freight_type']
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
    ordering = ['-created_at', '-id']
    # "Import to Tally" push — a freight editor may push, so accept can_edit /
    # can_create in addition to the global can_push_tally base (tally_push maps
    # to can_push_tally in ACTION_PERM_MAP).
    additional_action_perms = {'tally_push': ['can_edit', 'can_create'],
                               'link_bill': ['can_edit']}

    @action(detail=False, methods=['get'], url_path='search', permission_classes=[IsAuthenticated])
    def search_existing(self, request):
        """Search existing INBOUND freight to LINK a goods bill to (one slip covering
        several bills). Matches freight no / transporter / lorry / amount. Returns
        lightweight rows for the review picker + how many bills each already covers."""
        from decimal import Decimal
        from django.db.models import Q
        q = (request.query_params.get('q') or '').strip()
        if not q:
            return Response({'results': []})
        qs = (self.queryset.filter(direction='INBOUND')
              .select_related('transporter').prefetch_related('covered_bills'))
        cond = (Q(advice_no__icontains=q) | Q(transport_document_no__icontains=q)
                | Q(transporter__name__icontains=q) | Q(lorry_no__icontains=q))
        try:
            amt = Decimal(q.replace(',', ''))
            cond |= Q(base_amount=amt) | Q(payable_amount=amt)
        except Exception:  # noqa: BLE001 — non-numeric query, name/no match only
            pass
        out = []
        for fa in qs.filter(cond).order_by('-created_at')[:15]:
            covered = set(fa.covered_bills.values_list('id', flat=True))
            if fa.vendor_bill_id:
                covered.add(fa.vendor_bill_id)
            out.append({
                'id': str(fa.id), 'advice_no': fa.advice_no,
                'transporter_name': getattr(fa.transporter, 'name', '') or '',
                'freight_no': fa.transport_document_no or '',
                'lorry_no': fa.lorry_no or '',
                'freight_date': fa.freight_date.isoformat() if fa.freight_date else None,
                'base_amount': str(fa.base_amount or 0),
                'payable_amount': str(fa.payable_amount or 0),
                'status': fa.status,
                'covered_count': len(covered),
            })
        return Response({'results': out})

    @staticmethod
    def _freight_company_id(fa):
        """Company a freight slip belongs to. Delegates to the model's
        resolve_company_id() — the SINGLE source of truth also used by the list
        serializer's company_name, so the filter and the displayed company can
        never disagree."""
        return fa.resolve_company_id()

    @action(detail=True, methods=['get'], url_path='linkable-bills',
            permission_classes=[IsAuthenticated])
    def linkable_bills(self, request, pk=None):
        """Goods bills this slip can be linked to — typeahead for the detail-page
        "Link a bill" picker. Same company as the slip, active, not cancelled, and
        NOT already covered by another freight. Matches bill no / invoice / vendor."""
        from django.db.models import Q
        from .models import VendorBill, FreightAdviceInbound
        fa = self.get_object()
        q = (request.query_params.get('q') or '').strip()
        comp = self._freight_company_id(fa)
        qs = (VendorBill.objects.filter(is_active=True).exclude(status='CANCELLED')
              .select_related('vendor'))
        if comp:
            qs = qs.filter(vendor__company_id=comp)
        if q:
            qs = qs.filter(Q(bill_no__icontains=q) | Q(vendor_invoice_no__icontains=q)
                           | Q(vendor__vendor_name__icontains=q))
        # Bills already covered by ANY other live freight — excluded so a bill
        # can't be double-linked (one covering slip per bill).
        other = (FreightAdviceInbound.objects.filter(is_active=True)
                 .exclude(status='CANCELLED').exclude(pk=fa.pk))
        taken = set(other.filter(vendor_bill__isnull=False)
                    .values_list('vendor_bill_id', flat=True))
        taken |= set(other.filter(covered_bills__isnull=False)
                     .values_list('covered_bills__id', flat=True))
        # this slip's own bills shouldn't reappear in the picker either
        if fa.vendor_bill_id:
            taken.add(fa.vendor_bill_id)
        taken |= set(fa.covered_bills.values_list('id', flat=True))
        results = [{
            'id': str(b.id),
            'bill_no': b.bill_no,
            'vendor_invoice_no': b.vendor_invoice_no or '',
            'vendor_name': b.vendor.vendor_name if b.vendor else '',
            'bill_date': b.bill_date.isoformat() if b.bill_date else None,
            'total_amount': str(b.total_amount or 0),
        } for b in qs.order_by('-bill_date')[:40] if b.id not in taken][:20]
        return Response({'results': results})

    @action(detail=True, methods=['post'], url_path='link-bill')
    def link_bill(self, request, pk=None):
        """Link a goods bill to this freight slip. The FIRST bill becomes the
        primary (vendor_bill) — which clears the slip from "Unmatched"; further
        bills are added as "also covered". Validated: goods bill exists & active,
        same company, not already on another freight, not already on this one."""
        from django.db.models import Q
        from .models import VendorBill, FreightAdviceInbound
        fa = self.get_object()
        bill_id = request.data.get('bill_id') or request.data.get('bill')
        if not bill_id:
            return Response({'detail': 'bill_id is required.'},
                            status=status.HTTP_400_BAD_REQUEST)
        bill = (VendorBill.objects.filter(id=bill_id, is_active=True)
                .select_related('vendor').first())
        if not bill:
            return Response({'detail': 'No such bill (or it was deleted).'},
                            status=status.HTTP_404_NOT_FOUND)
        if bill.status == 'CANCELLED':
            return Response({'detail': 'That bill is cancelled — pick an active bill.'},
                            status=status.HTTP_400_BAD_REQUEST)
        fc = self._freight_company_id(fa)
        bc = getattr(bill.vendor, 'company_id', None) if bill.vendor_id else None
        if fc and bc and str(fc) != str(bc):
            return Response({'detail': 'That bill belongs to a different company than this freight.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if fa.vendor_bill_id == bill.id or fa.covered_bills.filter(pk=bill.id).exists():
            return Response({'detail': 'That bill is already linked to this freight.'},
                            status=status.HTTP_400_BAD_REQUEST)
        other = (FreightAdviceInbound.objects.filter(is_active=True)
                 .exclude(status='CANCELLED').exclude(pk=fa.pk)
                 .filter(Q(vendor_bill_id=bill.id) | Q(covered_bills__id=bill.id))
                 .first())
        if other:
            return Response(
                {'detail': f'That bill is already covered by freight {other.advice_no}. '
                           'Unlink it there first.'},
                status=status.HTTP_400_BAD_REQUEST)
        if not fa.vendor_bill_id:
            fa.vendor_bill = bill
            fa.save(update_fields=['vendor_bill', 'updated_at'])
        else:
            fa.covered_bills.add(bill)
        return Response(self.get_serializer(fa).data)

    @action(detail=True, methods=['get'], url_path='zoho-photo')
    def zoho_photo(self, request, pk=None):
        """Stream the freight's Zoho attachment (the freight bill PDF). Fetched with
        the ERP's Zoho token and proxied — the browser never talks to Zoho."""
        from django.http import HttpResponse
        from .models import ZohoInwardFreight
        from .zoho_creator import ZohoCreatorClient, ZohoConfigError
        kind = (request.query_params.get('kind') or 'pdf').lower()
        zf = ZohoInwardFreight.objects.filter(created_advice_id=pk).first()
        if zf is None:
            return Response({'detail': 'No Zoho freight linked.'}, status=status.HTTP_404_NOT_FOUND)
        path = ZohoCreatorClient.freight_photo_paths(zf).get(kind)
        if not path:
            return Response({'detail': 'No such attachment.'}, status=status.HTTP_404_NOT_FOUND)
        try:
            content, ctype = ZohoCreatorClient().download_file(path)
        except ZohoConfigError as e:
            return Response({'detail': str(e)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:  # noqa: BLE001
            return Response({'detail': f'Could not fetch the attachment: {e}'},
                            status=status.HTTP_502_BAD_GATEWAY)
        resp = HttpResponse(content, content_type=ctype)
        resp['Cache-Control'] = 'private, max-age=3600'
        return resp

    def list(self, request, *args, **kwargs):
        # Precompute which freights link to a real bill for the whole page in one
        # bulk pass (the per-row lookup would be far too slow across the list), and
        # pass it to the serializer via context so `bill_linked` is cheap per row.
        from .serializers import FreightAdviceInboundSerializer as _Ser
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        objs = page if page is not None else list(queryset)
        ctx = self.get_serializer_context()
        ctx['linked_map'] = _Ser.bulk_linked_map(objs)
        serializer = self.get_serializer(objs, many=True, context=ctx)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)

    # ── "Import to Tally": review popup then confirm-push (local/direct) ──
    @action(detail=True, methods=['get'], url_path='tally-preview')
    def tally_preview(self, request, pk=None):
        """Structured Journal breakdown for the review popup. Writes nothing."""
        from sales.tally_sync import freight_preview
        return Response(freight_preview(self.get_object(), 'Inbound'))

    @action(detail=True, methods=['post'], url_path='tally-push')
    def tally_push(self, request, pk=None):
        """Confirm from the popup — POST the Journal to the local Tally gateway."""
        from sales.tally_sync import push_freight
        ok, vch, err = push_freight(self.get_object(), 'Inbound')
        if ok:
            return Response({'ok': True, 'tally_voucher_id': vch,
                             'message': f'Journal created in Tally (id {vch}).'})
        return Response({'ok': False, 'error': err}, status=status.HTTP_400_BAD_REQUEST)

    def perform_create(self, serializer):
        """After creating freight, copy receipt attachments as freight attachments (skip duplicates)."""
        freight = serializer.save()
        if freight.receipt_advice_id:
            receipt_attachments = PurchaseAttachment.objects.filter(
                module='RECEIPT', record_id=freight.receipt_advice_id, is_active=True
            )
            for att in receipt_attachments:
                # Skip if same file already exists for this freight
                if not PurchaseAttachment.objects.filter(
                    module='FREIGHT', record_id=freight.id, file_name=att.file_name, file_size=att.file_size
                ).exists():
                    PurchaseAttachment.objects.create(
                        module='FREIGHT',
                        record_id=freight.id,
                        file=att.file,
                        file_name=att.file_name,
                        file_size=att.file_size,
                        file_type=att.file_type,
                        uploaded_by=self.request.user,
                    )

    @action(detail=True, methods=['post'], url_path='approve')
    def approve(self, request, pk=None):
        freight = self.get_object()
        if freight.status not in ('DRAFT', 'PENDING_APPROVAL'):
            return Response(
                {'error': 'Only DRAFT or PENDING_APPROVAL freight can be approved'},
                status=status.HTTP_400_BAD_REQUEST
            )
        freight.status = 'APPROVED'
        # Use the StakeholderUser linked to the request user
        try:
            from apps.core.models import StakeholderUser
            freight.approved_by = StakeholderUser.objects.get(user=request.user)
        except Exception:
            pass
        freight.approved_at = timezone.now()
        freight.save()

        # Update linked receipt's freight details: TO_PAY → PAID
        if freight.receipt_advice_id:
            FreightDetail.objects.filter(
                receipt=freight.receipt_advice,
                freight_terms='TO_PAY',
            ).update(freight_terms='PAID')

        return Response(self.get_serializer(freight).data)

    @action(detail=False, methods=['post'], url_path='approve-all')
    def approve_all(self, request):
        """Approve many pending separate-slip freight advices at once — the
        freight counterpart of VendorBill.approve_all. Pass {"ids": [...]} to
        approve a selection, or omit it to approve every DRAFT / PENDING_APPROVAL
        separate slip. Only separately-payable slips are gated; invoice-included
        freight follows its goods bill and is never touched here."""
        ids = request.data.get('ids') or None
        qs = self.get_queryset().filter(
            freight_source='SEPARATE_SLIP',
            status__in=('DRAFT', 'PENDING_APPROVAL'),
        )
        if ids:
            qs = qs.filter(id__in=ids)
        approver = None
        try:
            from apps.core.models import StakeholderUser
            approver = StakeholderUser.objects.get(user=request.user)
        except Exception:
            approver = None
        now = timezone.now()
        approved = 0
        for freight in qs:
            freight.status = 'APPROVED'
            freight.approved_by = approver
            freight.approved_at = now
            freight.save(update_fields=['status', 'approved_by', 'approved_at', 'updated_at'])
            if freight.receipt_advice_id:
                FreightDetail.objects.filter(
                    receipt=freight.receipt_advice, freight_terms='TO_PAY',
                ).update(freight_terms='PAID')
            approved += 1
        return Response({'approved': approved})

    @action(detail=True, methods=['post'], url_path='update-status')
    def update_status(self, request, pk=None):
        freight = self.get_object()
        new_status = request.data.get('status')
        valid_statuses = dict(freight.FREIGHT_ADVICE_STATUS).keys()
        if new_status not in valid_statuses:
            return Response(
                {'error': f'Invalid status. Must be one of: {", ".join(valid_statuses)}'},
                status=status.HTTP_400_BAD_REQUEST
            )
        # Define valid transitions
        valid_transitions = {
            'DRAFT': ['PENDING_APPROVAL', 'CANCELLED'],
            'PENDING_APPROVAL': ['APPROVED', 'DRAFT', 'CANCELLED'],
            'APPROVED': ['IN_TRANSIT', 'CANCELLED'],
            'IN_TRANSIT': ['COMPLETED', 'CANCELLED'],
            'COMPLETED': ['PAID'],
            'PAID': [],
            'CANCELLED': ['DRAFT'],
        }
        allowed = valid_transitions.get(freight.status, [])
        if new_status not in allowed:
            return Response(
                {'error': f'Cannot transition from {freight.status} to {new_status}'},
                status=status.HTTP_400_BAD_REQUEST
            )
        freight.status = new_status
        freight.save()
        return Response(self.get_serializer(freight).data)

    @action(detail=False, methods=['get'], url_path='summary')
    def summary(self, request):
        """Month-wise BILLED / PAID / PENDING freight totals across BOTH
        invoice-included and separate-slip freight. Filters (all optional):
        freight_source, transporter, company, from, to (freight_date)."""
        from collections import defaultdict
        from decimal import Decimal as _Dec
        qs = self.get_queryset().select_related(
            'vendor_bill', 'vendor_bill__vendor', 'transporter',
            'receipt_advice', 'receipt_advice__warehouse')
        src = request.query_params.get('freight_source')
        if src:
            qs = qs.filter(freight_source=src)
        tr = request.query_params.get('transporter')
        if tr:
            qs = qs.filter(transporter_id=tr)
        frm = request.query_params.get('from')
        if frm:
            qs = qs.filter(freight_date__gte=frm)
        to = request.query_params.get('to')
        if to:
            qs = qs.filter(freight_date__lte=to)
        company = request.query_params.get('company')

        def _company_id(fa):
            # Single source of truth (see FreightAdviceInbound.resolve_company_id)
            # so this summary scopes by the SAME company the list shows.
            cid = fa.resolve_company_id()
            return str(cid) if cid else ''

        def _blank():
            return {'billed': _Dec('0'), 'paid': _Dec('0'), 'pending': _Dec('0'), 'count': 0}
        months = defaultdict(_blank)
        total = _blank()
        for fa in qs:
            if company and _company_id(fa) != str(company):
                continue
            payable = fa.get_total_payable()
            paid = fa.get_total_paid()
            pending = payable - paid
            if pending < 0:
                pending = _Dec('0')
            key = fa.freight_date.strftime('%Y-%m') if fa.freight_date else 'undated'
            for bucket in (months[key], total):
                bucket['billed'] += payable
                bucket['paid'] += paid
                bucket['pending'] += pending
                bucket['count'] += 1

        def _out(b):
            return {'billed': str(b['billed']), 'paid': str(b['paid']),
                    'pending': str(b['pending']), 'count': b['count']}
        rows = [dict(month=k, **_out(v)) for k, v in sorted(months.items())]
        return Response({'months': rows, 'total': _out(total)})

    @action(detail=True, methods=['post'], url_path='add-payment')
    def add_payment(self, request, pk=None):
        """Add a payment entry to this freight."""
        from .models import FreightPaymentInbound
        from .serializers import FreightPaymentInboundSerializer
        from decimal import Decimal
        freight = self.get_object()

        # Invoice-included freight is paid THROUGH the vendor bill (goods first,
        # freight last) — never a separate freight payment.
        if freight.freight_source == 'INVOICE_INCLUDED':
            return Response(
                {'error': 'This freight is billed inside the vendor invoice — it is paid when the bill is paid. Record the payment on the vendor bill, not here.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Freight Terms = 'Paid' means the charges were already settled
        # at source (typically baked into the vendor invoice). No
        # downstream payment should be recorded against this freight.
        if (freight.freight_terms or '').upper() == 'PAID':
            return Response(
                {'error': 'Freight Terms are set to "Paid" — this freight was settled at source. No payment can be recorded.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        serializer = FreightPaymentInboundSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        amount = serializer.validated_data['amount_paid']
        payable = freight.get_total_payable()
        current_balance = payable - freight.get_total_paid()
        if amount > current_balance:
            return Response(
                {'error': f'Payment amount ({amount}) exceeds balance ({current_balance}).'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # LINEHAUL freight: partial payments NOT allowed — full balance must be paid
        if freight.freight_type == 'LINEHAUL':
            if abs(Decimal(str(amount)) - Decimal(str(current_balance))) > Decimal('0.01'):
                return Response(
                    {'error': f'Partial payments are not allowed for LINEHAUL freight. Full balance of {current_balance} must be paid in a single payment.'},
                    status=status.HTTP_400_BAD_REQUEST
                )

        try:
            from apps.core.models import StakeholderUser
            created_by = StakeholderUser.objects.get(user=request.user)
        except Exception:
            created_by = None

        payment = FreightPaymentInbound.objects.create(
            freight=freight,
            created_by=created_by,
            **serializer.validated_data
        )
        freight.update_payment_status()
        return Response(
            FreightPaymentInboundSerializer(payment).data,
            status=status.HTTP_201_CREATED
        )

    @action(detail=True, methods=['get'], url_path='payments')
    def list_payments(self, request, pk=None):
        """List all payments for this freight."""
        from .serializers import FreightPaymentInboundSerializer
        freight = self.get_object()
        payments = freight.freight_payments.all()
        return Response(FreightPaymentInboundSerializer(payments, many=True).data)

    @action(detail=True, methods=['delete'], url_path='delete-payment/(?P<payment_id>[^/.]+)')
    def delete_payment(self, request, pk=None, payment_id=None):
        """Delete a payment entry and recalculate."""
        from .models import FreightPaymentInbound
        freight = self.get_object()
        try:
            payment = freight.freight_payments.get(id=payment_id)
        except FreightPaymentInbound.DoesNotExist:
            return Response({'error': 'Payment not found.'}, status=status.HTTP_404_NOT_FOUND)
        payment.delete()
        freight.update_payment_status()
        return Response(self.get_serializer(freight).data)


class FreightPaymentInboundViewSet(viewsets.ModelViewSet):
    """Standalone ViewSet for listing/creating/deleting inbound freight payments."""
    from .models import FreightPaymentInbound
    from .serializers import FreightPaymentInboundListSerializer, FreightPaymentInboundSerializer

    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Freight Payment'

    def get_queryset(self):
        from .models import FreightPaymentInbound
        return FreightPaymentInbound.objects.select_related(
            'freight', 'freight__transporter', 'freight__receipt_advice',
            'freight__receipt_advice__vendor', 'created_by__user'
        ).filter(freight__is_active=True).order_by('-payment_date', '-id')   # -id: stable page-walks

    def get_serializer_class(self):
        from .serializers import FreightPaymentInboundListSerializer, FreightPaymentInboundSerializer
        if self.action in ('create', 'update', 'partial_update'):
            return FreightPaymentInboundSerializer
        return FreightPaymentInboundListSerializer

    def perform_create(self, serializer):
        from .models import FreightPaymentInbound
        freight = serializer.validated_data.get('freight') or self.request.data.get('freight')
        if isinstance(freight, str):
            from .models import FreightAdviceInbound
            freight = FreightAdviceInbound.objects.get(id=freight)
        amount = serializer.validated_data['amount_paid']
        payable = freight.get_total_payable()
        balance = payable - freight.get_total_paid()
        if amount > balance:
            from rest_framework.exceptions import ValidationError
            raise ValidationError(f'Payment amount ({amount}) exceeds balance ({balance}).')
        try:
            from apps.core.models import StakeholderUser
            created_by = StakeholderUser.objects.get(user=self.request.user)
        except Exception:
            created_by = None
        serializer.save(freight=freight, created_by=created_by)
        freight.update_payment_status()

    def perform_destroy(self, instance):
        freight = instance.freight
        instance.delete()
        freight.update_payment_status()


# ──────────────────────────────────────────────────────────────
#  Vendor Bills, Payments Made, Vendor Credits
# ──────────────────────────────────────────────────────────────

class VendorBillViewSet(BulkImportMixin, viewsets.ModelViewSet):
    """ViewSet for Vendor Bills."""

    from .models import VendorBill
    from .serializers import VendorBillSerializer

    # Every one of these is walked by VendorBillSerializer on EVERY row —
    # bill_lines (nested), payments (payment_history) and credits (has_credit).
    # Without the prefetch the list ran 3.8 queries per bill, so a 500-row page
    # cost ~1,900 round trips; `product` is included because the nested line
    # serializer reads the product name.
    queryset = VendorBill.objects.select_related(
        'vendor', 'purchase_order', 'receipt_advice'
    ).prefetch_related(
        'bill_lines__product', 'payments', 'credits',
    ).all()
    serializer_class = VendorBillSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Vendor Bill'

    @property
    def alternate_modules(self):
        # ONLY the read-only vendor-ledger drawer is also reachable from the
        # unified Import › Ledger page (module 'Ledger'), so a role granted
        # 'Ledger' may load it. Every other Vendor Bill action keeps its own
        # gate — the alternate is not granted viewset-wide.
        return ['Ledger'] if getattr(self, 'action', None) == 'vendor_ledger' else []

    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]

    import_columns = [
        ('Bought Note No', 'vendor_invoice_no'),
        ('Vendor Name', 'vendor'),
        ('Bill Date', 'bill_date'),
        ('Amount', 'subtotal'),
        ('Notes', 'notes'),
    ]
    import_fk_resolvers = {
        'vendor': ('master.Vendor', ('vendor_code', 'vendor_name')),
    }
    import_line_relation = 'bill_lines'
    import_line_columns = [
        ('Product', 'product'),
        ('Description', 'description'),
        ('Quantity', 'quantity'),
        ('UOM', 'uom'),
        ('Rate', 'rate'),
        ('Amount', 'amount'),
    ]
    import_line_fk_resolvers = {
        'product': ('master.Product', ('sku_code', 'product_name')),
    }
    import_parent_unique_field = 'vendor_invoice_no'
    # A Bought Note is GST-exempt — no tax, no other charges — so
    # total_amount always equals subtotal. Deriving it from the row's own
    # subtotal (rather than asking for a duplicate column) is what the
    # callable-default support in BulkImportMixin.import_defaults exists for.
    import_defaults = {
        'purchase_category': 'BOUGHT_NOTE',
        'category_source': 'manual',
        'tax_amount': 0,
        'total_amount': lambda payload: payload.get('subtotal', 0),
        'status': 'OPEN',
    }

    @action(detail=False, methods=['get'], url_path='search', permission_classes=[IsAuthenticated])
    def search_existing(self, request):
        """Search existing vendor bills to LINK a scanned bill to (merge into it),
        by vendor/company name, invoice no, bill no, vendor GSTIN or bill date.
        Mirrors the freight 'search' picker — lightweight rows for the scan review."""
        from datetime import datetime
        from django.db.models import Q
        from .models import VendorBill
        q = (request.query_params.get('q') or '').strip()
        if not q:
            return Response({'results': []})
        qs = VendorBill.objects.select_related('vendor').exclude(status='CANCELLED')
        company = (request.query_params.get('company') or '').strip()
        if company:
            qs = qs.filter(vendor__company__company_code=company)
        cond = (Q(vendor_invoice_no__icontains=q) | Q(bill_no__icontains=q)
                | Q(vendor__vendor_name__icontains=q) | Q(vendor__gstin__icontains=q))
        for fmt in ('%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y'):
            try:
                cond |= Q(bill_date=datetime.strptime(q, fmt).date())
                break
            except ValueError:
                pass
        out = [{
            'id': str(bill.id), 'bill_no': bill.bill_no,
            'invoice_no': bill.vendor_invoice_no or '',
            'vendor_name': getattr(bill.vendor, 'vendor_name', '') or '',
            'gstin': getattr(bill.vendor, 'gstin', '') or '',
            'bill_date': bill.bill_date.isoformat() if bill.bill_date else None,
            'total': str(bill.total_amount or 0),
            'amount_paid': str(bill.amount_paid or 0),
            'status': bill.status,
        } for bill in qs.filter(cond).order_by('-bill_date')[:15]]
        return Response({'results': out})

    def get_serializer_class(self):
        """The LIST uses a slim serializer (scalar columns only) so a page of
        bills is one query, not thousands. Detail/create/update keep the full
        serializer (lines, payment history, credit eligibility, etc.)."""
        if self.action == 'list':
            # ?slim=1 -> the four fields the Receipts page needs to tell
            # "Create Bill" from "Paid". Opt-in: without the flag the list
            # returns exactly what it returns today.
            slim = str(self.request.query_params.get('slim', '')).lower()
            if slim in ('1', 'true', 'yes', 'link'):
                from .serializers import VendorBillReceiptLinkSerializer
                return VendorBillReceiptLinkSerializer
            if slim == 'list':
                # The Bills page's own columns - six unread fields dropped.
                from .serializers import VendorBillListSlimSerializer
                return VendorBillListSlimSerializer
            from .serializers import VendorBillListSerializer
            return VendorBillListSerializer
        # Import locally: VendorBillSerializer is bound in the class body (so it's
        # self.VendorBillSerializer, not a module name) — returning the bare name
        # here raised NameError and 500'd every detail/create/update.
        from .serializers import VendorBillSerializer
        return VendorBillSerializer

    def get_required_perm(self, request):
        """Strict separation: receipt → bill is a convert action and requires
        can_convert; standalone bill creation requires can_create."""
        if self.action == 'create' and request.data.get('receipt_advice'):
            return 'can_convert'
        return None  # let HasModulePermission fall back to the default mapping

    @action(detail=True, methods=['get'], url_path='zoho-photo')
    def zoho_photo(self, request, pk=None):
        """Stream a Zoho photo (invoice copy / gatepass / weighment) for this bill.
        The file lives behind Zoho's authenticated API, so we fetch it with the
        ERP's Zoho token and proxy the bytes — the browser <img> never sees Zoho."""
        from django.http import HttpResponse
        from .models import ZohoPurchaseBill
        from .zoho_creator import ZohoCreatorClient, ZohoConfigError
        kind = (request.query_params.get('kind') or 'invoice').lower()
        zb = ZohoPurchaseBill.objects.filter(converted_bill_id=pk).first()
        if zb is None:
            return Response({'detail': 'No Zoho bill linked.'}, status=status.HTTP_404_NOT_FOUND)
        path = ZohoCreatorClient.bill_photo_paths(zb).get(kind)
        if not path:
            return Response({'detail': 'No such photo.'}, status=status.HTTP_404_NOT_FOUND)
        try:
            content, ctype = ZohoCreatorClient().download_file(path)
        except ZohoConfigError as e:
            return Response({'detail': str(e)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:  # noqa: BLE001
            return Response({'detail': f'Could not fetch the photo: {e}'},
                            status=status.HTTP_502_BAD_GATEWAY)
        resp = HttpResponse(content, content_type=ctype)
        resp['Cache-Control'] = 'private, max-age=3600'
        return resp
    filterset_fields = ['status', 'vendor', 'rm_category', 'purchase_category',
                        'expense_group', 'expense_subcategory', 'tds_status']
    # vendor__vendor_name, not vendor__name: master.Vendor has no `name` field,
    # so `?search=` on this endpoint raised FieldError and returned 500. It went
    # unnoticed because the Bills page searches in the BROWSER over rows it has
    # already downloaded, and never sent `search` at all.
    search_fields = ['bill_no', 'vendor__vendor_name', 'vendor_invoice_no']
    ordering_fields = ['bill_date', 'due_date', 'total_amount', 'created_at']
    # The tie-break is not cosmetic. Ordering by bill_date ALONE leaves rows
    # that share a date in no defined order, and LIMIT/OFFSET over an undefined
    # order may hand back the same row on two pages and never hand back another.
    # The Bills page walks nine pages of 500 to collect all 4,049 bills, and
    # hundreds of them share an imported bill_date - so it was quietly able to
    # both duplicate and MISS bills. Caught by comparing a July window against
    # the same month taken from the full walk: 884 rows each, different rows.
    #
    # Nothing on screen moves: the page re-sorts by bill_date then bill_no
    # itself before rendering, so this only decides WHICH rows arrive, not the
    # order they are shown in.
    ordering = ['-bill_date', '-id']

    def get_queryset(self):
        # Flag bills backed by BOTH a scanned invoice and a Tally voucher (the
        # scan<->Tally merge). Annotate _scan_confirmed so the list serializer
        # can show a "Scan + Tally matched" tag without an N+1 query.
        from django.db.models import Exists, OuterRef, Q
        from ai_parser.scan_models import InvoiceScanBill
        from purchase.models import PurchaseAttachment
        scan = InvoiceScanBill.objects.filter(
            Q(matched_bill=OuterRef('pk')) | Q(created_bill=OuterRef('pk')),
            status='CONFIRMED')
        # A scan record is deleted when its batch is cleaned up, but the bill keeps
        # its scan-*.pdf attachment — still proof it was scanned. Annotated (Exists
        # subquery) so the list badge stays correct with no N+1.
        # ANY bill attachment counts as scanned: a bill carrying an invoice/scan
        # copy (even a hand-uploaded "Blow.pdf", not just a scan-*.pdf) is a scan
        # for the badge — so the list agrees with the Revert-Tally keep-rule, which
        # never deletes a bill that has a copy.
        scan_att = PurchaseAttachment.objects.filter(
            module='BILL', record_id=OuterRef('pk'))
        # Goods-line quantity sum + distinct-UOM count, as correlated subqueries
        # so the list stays one query. Feed the Bills "Quantity"/"UOM" columns and
        # the "Appears in → Stock" flag (a bill with goods lines reaches Stock).
        from django.db.models import Sum, Count, Subquery
        from .models import VendorBillLine
        _line_qs = (VendorBillLine.objects.filter(bill_id=OuterRef('pk'), is_active=True,
                                                  product__isnull=False)
                    .values('bill_id'))
        _qty_sub = _line_qs.annotate(s=Sum('quantity')).values('s')
        _uom_sub = _line_qs.annotate(n=Count('uom', distinct=True)).values('n')
        qs = super().get_queryset().annotate(
            _scan_confirmed=Exists(scan), _scan_attach=Exists(scan_att),
            _qty=Subquery(_qty_sub), _uom_n=Subquery(_uom_sub))
        # Branch-transfer filter for the Bills page. A "DC/" invoice no is an
        # internal branch-transfer delivery challan, not a purchase.
        #   ?transfers=only    -> just the DC branch transfers
        #   ?transfers=exclude -> only real purchases (no DC)
        #   (omitted)          -> everything
        t = (self.request.query_params.get('transfers') or '').lower()
        if t == 'only':
            from .branch_transfer import branch_transfer_q
            qs = qs.filter(branch_transfer_q())
        elif t in ('exclude', 'no', 'purchases'):
            from .branch_transfer import branch_transfer_q
            qs = qs.exclude(branch_transfer_q())
        # The LIST serializer touches no related collections, so drop the heavy
        # bill_lines/payments/credits prefetch inherited from the base queryset —
        # loading them for every bill is what kept the full-table list slow — and
        # pull the vendor's company in the same join for the company column/filter.
        if self.action == 'list':
            # select_related(None) FIRST: the base queryset joins purchase_order
            # and receipt_advice, which the list serializers never read. Without
            # the reset, select_related ADDS to those joins instead of replacing
            # them, dragging a full PurchaseOrder and ReceiptAdvice row along with
            # every bill. vendor__company is re-added because the company column
            # needs it, and is_branch_transfer reads vendor.is_branch off it.
            # warehouse is re-added for the same reason as vendor__company:
            # the ?slim=list serializer shows warehouse_name, and without it
            # every row fetched its own warehouse - 74 fetches out of this
            # endpoint's 76 queries on production, from a table of 12 rows.
            if (self.request.query_params.get('include_lines') or '').lower() in ('1', 'true'):
                qs = (qs.prefetch_related(None)
                        .select_related(None)
                        .select_related('vendor__company', 'warehouse')
                        .prefetch_related('bill_lines__product'))
            else:
                qs = (qs.prefetch_related(None)
                        .select_related(None)
                        .select_related('vendor__company', 'warehouse'))
            # The list is the working view of REAL bills: drop soft-deleted rows,
            # and — unless the operator explicitly filters by status — cancelled
            # ones too. Cancelled bills (e.g. voided duplicates) inflated the count
            # and never matched the dashboard tiles, which already exclude them.
            # An explicit ?status=CANCELLED still shows them for audit.
            qs = qs.filter(is_active=True)
            qs = qs.exclude(purchase_category='FREIGHT')
            if not (self.request.query_params.get('status') or '').strip():
                qs = qs.exclude(status='CANCELLED')
            # company=X: scope the list to that company's bills. Filter by the
            # bill's VENDOR company — a single cheap join — so choosing SS Biochem
            # shows SS Biochem's vendors' bills and UAI shows UAI's, instead of
            # every company's. (The dashboard tile uses a 3-way PO/receipt/vendor
            # OR-join; that join on THIS list endpoint — already carrying the TDS
            # subquery + line prefetch — was slow/broke on 512MB and was reverted.
            # vendor__company is what nearly every bill resolves to anyway.)
            _co = (self.request.query_params.get('company') or '').strip()
            if _co:
                qs = qs.filter(vendor__company_id=_co)
            # Bound the list to the period the page is showing. The Bills page
            # already filters by its period chip - in the BROWSER, after
            # downloading every row: 4,049 bills sent so it can display the 27
            # in the current month. Doing it here sends the 27.
            #
            # Deliberately the ONLY filtering moved to the server. Search, sort,
            # the vendor/company pickers, Approve All and the drill-downs that
            # must tally with the Analytics cards all still run over the rows in
            # the browser, unchanged - so none of those rules had to be
            # rewritten in SQL, where one wrong translation quietly stops a
            # drilled count matching the card it was opened from.
            #
            # No dates, or dates that do not parse, mean no bound - which is
            # exactly today's behaviour, and what the page's "All" chip sends.
            for param, lookup in (('bill_date_from', 'bill_date__gte'),
                                  ('bill_date_to', 'bill_date__lte'),
                                  ('bill_date_after', 'bill_date__gte'),
                                  ('bill_date_before', 'bill_date__lte')):
                raw = (self.request.query_params.get(param) or '').strip()
                if not raw:
                    continue
                parsed = parse_date(raw)
                if parsed is not None:
                    qs = qs.filter(**{lookup: parsed})
            # Product filter: ?product=<master.Product id> keeps only bills that
            # carry a line for that product. Done on the server (unlike the other
            # pickers) because the slim row deliberately ships no line items, so
            # the browser has no product to match on. distinct() collapses the
            # row-per-line join back to one row per bill.
            _product = (self.request.query_params.get('product') or '').strip()
            if _product:
                qs = qs.filter(bill_lines__product_id=_product).distinct()
            # is_expense filter: ?is_expense=false excludes expense-like bills,
            # mirroring the dashboard Bills TILE's expense_like rule EXACTLY so the
            # "Purchase Bills" popup / list count ties the tile — is_expense flag OR
            # an expense category (FREIGHT/EXPENSES/MACHINERY/LAB_EXPENSE) OR a
            # journal voucher. (An earlier attempt was reverted together with a
            # separate 3-way company OR-join that was the actual "dashboard broken"
            # culprit — a join-heavy query timing out on 512MB. This clause is pure
            # field conditions on VendorBill: no joins, cheap, safe.)
            _ie = (self.request.query_params.get('is_expense') or '').lower()
            if _ie == 'false':
                _EXPENSE_CATS = ('FREIGHT', 'EXPENSES', 'MACHINERY', 'LAB_EXPENSE')
                qs = qs.exclude(
                    Q(is_expense=True)
                    | Q(purchase_category__in=_EXPENSE_CATS)
                    | Q(tally_voucher_type__icontains='journal')
                )
            elif _ie == 'true':
                qs = qs.filter(is_expense=True)
            # erp_only=1: exclude Tally-imported bills (tally_guid is non-empty)
            if (self.request.query_params.get('erp_only') or '').lower() in ('1', 'true'):
                qs = qs.filter(tally_guid='')
            # source=tally|scan: mirror the Purchase Analytics source toggle
            _src = (self.request.query_params.get('source') or '').lower()
            if _src in ('tally', 'scan'):
                from .source_classify import annotate_source, filter_by_source
                qs = filter_by_source(annotate_source(qs), _src)
            # MSME vendor filter: ?msme=true/false
            _msme = (self.request.query_params.get('msme') or '').lower()
            if _msme == 'true':
                qs = qs.filter(vendor__is_msme=True)
            elif _msme == 'false':
                qs = qs.filter(vendor__is_msme=False)
            # purchases_only=1: exclude expense-like bills (same filter as the
            # dashboard tiles — is_expense, Freight/Expenses/Machinery categories,
            # journal vouchers) so the list matches the Purchase tiles exactly.
            if (self.request.query_params.get('purchases_only') or '').lower() in ('1', 'true'):
                from .dashboard_views import _EXPENSE_CATS
                qs = (qs.exclude(is_expense=True)
                      .exclude(purchase_category__in=_EXPENSE_CATS)
                      .exclude(tally_voucher_type__icontains='journal'))
            # exclude_opening=1: strip opening-balance carrier bills from the list
            if (self.request.query_params.get('exclude_opening') or '').lower() in ('1', 'true'):
                from django.db.models import Q as _Q
                qs = qs.exclude(
                    _Q(vendor_invoice_no='OPENING') |
                    _Q(vendor_invoice_no__startswith='OPEN-') |
                    _Q(tally_guid__startswith='OPENING')
                )
            # Aging bucket filter: ?aging_bucket=0_30|31_60|61_90|91_180|180p
            # `age` is the alias the Purchase Analytics "Outstanding by Age" panel
            # links with (same five keys); both read the SAME bill_date windows the
            # dashboard _aging_buckets helper computes, so a filtered list ties the
            # bucket count it was opened from.
            _ab = (self.request.query_params.get('aging_bucket')
                   or self.request.query_params.get('age') or '').strip()
            if _ab:
                from django.utils import timezone as _tz
                _today = _tz.localdate()
                _RANGES = {
                    '0_30':   (0,   30),
                    '31_60':  (31,  60),
                    '61_90':  (61,  90),
                    '91_180': (91,  180),
                    '180p':   (181, None),
                }
                _lo, _hi = _RANGES.get(_ab, (None, None))
                if _lo is not None:
                    from datetime import timedelta
                    _cutoff_lo = _today - timedelta(days=_hi) if _hi is not None else None
                    _cutoff_hi = _today - timedelta(days=_lo)
                    if _cutoff_lo:
                        qs = qs.filter(bill_date__gte=_cutoff_lo, bill_date__lte=_cutoff_hi)
                    else:
                        qs = qs.filter(bill_date__lte=_cutoff_hi)
            # Actual TDS DEDUCTED on each bill (Tally's TDS Payable, linked by ref),
            # as a Subquery so the list can show the REAL figure beside the engine's
            # expected one without an N+1 or join-multiplying the row.
            from django.db.models import Subquery, Sum
            from .models import TdsPayable
            _tds = (TdsPayable.objects
                    .filter(vendor_bill=OuterRef('pk'), is_active=True, amount__gt=0)
                    .exclude(voucher_type='Opening Balance')
                    .values('vendor_bill').annotate(t=Sum('amount')).values('t'))
            qs = qs.annotate(tds_deducted_sum=Subquery(_tds))
        return qs

    def perform_create(self, serializer):
        """After creating bill, copy receipt attachments as bill attachments (skip duplicates).

        Also auto-create a Vendor Credit Debit Note when the linked receipt has any
        is_debit_note=True lines — using PO rates for the shortfall (rcvd − net),
        so users don't have to manually raise it from the Vendor Credits page.
        """
        bill = serializer.save()
        self._sync_invoice_freight(bill)
        if bill.receipt_advice_id:
            receipt_attachments = PurchaseAttachment.objects.filter(
                module='RECEIPT', record_id=bill.receipt_advice_id, is_active=True
            )
            for att in receipt_attachments:
                if not PurchaseAttachment.objects.filter(
                    module='BILL', record_id=bill.id, file_name=att.file_name, file_size=att.file_size
                ).exists():
                    PurchaseAttachment.objects.create(
                        module='BILL',
                        record_id=bill.id,
                        file=att.file,
                        file_name=att.file_name,
                        file_size=att.file_size,
                        file_type=att.file_type,
                        uploaded_by=self.request.user,
                    )
            self._auto_create_debit_note(bill)

    def perform_update(self, serializer):
        bill = serializer.save()
        self._sync_invoice_freight(bill)

    def _sync_invoice_freight(self, bill):
        """Mirror any freight charge line on the bill into the freight tracker
        (invoice-included). Best-effort; never blocks saving the bill."""
        try:
            from .invoice_freight import sync_invoice_freight
            sync_invoice_freight(bill, self.request.user)
        except Exception:  # noqa: BLE001
            logger.exception('invoice-freight sync failed for bill %s', getattr(bill, 'id', None))

    def _auto_create_debit_note(self, bill):
        """Create a Debit Note Vendor Credit from receipt lines flagged is_debit_note.

        Idempotent: skips if a non-cancelled credit already exists for this bill.
        If a receipt-based credit was already created (when the receipt was
        saved), link it to this bill instead of creating a duplicate. Otherwise
        create a fresh one at PO unit_price / gst (shortfall is owed back at
        the PO price, not whatever the bill happened to charge).
        """
        from decimal import Decimal
        from .models import VendorCredit, VendorCreditLine

        if VendorCredit.objects.filter(bill=bill).exclude(status='CANCELLED').exists():
            return
        receipt = bill.receipt_advice
        if not receipt:
            return

        # Prefer linking the receipt-based credit if one was already
        # auto-created when the receipt was saved.
        existing = ReceiptAdviceViewSet._find_receipt_debit_note(receipt)
        if existing and not existing.bill_id:
            existing.bill = bill
            existing.save(update_fields=['bill'])
            return

        debit_lines = list(receipt.receipt_lines.filter(is_debit_note=True).select_related('po_line'))
        if not debit_lines:
            return

        subtotal = Decimal('0')
        tax_amount = Decimal('0')
        line_payloads = []
        for rl in debit_lines:
            rcvd = Decimal(str(rl.quantity_received or 0))
            net = Decimal(str(rl.net_quantity)) if rl.net_quantity is not None else rcvd
            qty = rcvd - net
            if qty <= 0:
                continue
            po_line = rl.po_line
            rate = Decimal(str(po_line.unit_price)) if po_line and po_line.unit_price is not None else Decimal('0')
            gst = Decimal(str(po_line.gst)) if po_line and po_line.gst is not None else Decimal('0')
            base = (qty * rate).quantize(Decimal('0.01'))
            tax = (base * gst / Decimal('100')).quantize(Decimal('0.01'))
            amount = base + tax
            subtotal += base
            tax_amount += tax
            line_payloads.append({
                'product_id': rl.product_id,
                'service_catalogue_id': rl.service_catalogue_id,
                'description': (rl.remarks or '')[:255],
                'quantity': qty,
                'uom': rl.uom or '',
                'rate': rate,
                'tax_percent': gst,
                'amount': amount,
            })

        if not line_payloads:
            return

        with transaction.atomic():
            credit = VendorCredit.objects.create(
                vendor=bill.vendor,
                credit_date=timezone.now().date(),
                credit_type='DEBIT',
                bill=bill,
                reason=f'Auto-generated from Receipt {receipt.receipt_advice_no} debit-noted shortfall',
                subtotal=subtotal,
                tax_amount=tax_amount,
                total_amount=subtotal + tax_amount,
                status='DRAFT',
            )
            for lp in line_payloads:
                VendorCreditLine.objects.create(credit=credit, **lp)

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        """Move bill from DRAFT to OPEN and auto-set due date."""
        from datetime import timedelta
        bill = self.get_object()
        if bill.status != 'DRAFT':
            return Response({'error': f'Cannot approve bill in {bill.get_status_display()} status.'}, status=status.HTTP_400_BAD_REQUEST)
        bill.status = 'OPEN'
        update_fields = ['status']
        # Auto-calculate due_date = bill_date + 15 days if not already set
        if not bill.due_date and bill.bill_date:
            bill.due_date = bill.bill_date + timedelta(days=15)
            update_fields.append('due_date')
        bill.save(update_fields=update_fields)
        self._auto_create_debit_note(bill)
        return Response(self.get_serializer(bill).data)

    @action(detail=False, methods=['get'], url_path='filter-options')
    def filter_options(self, request):
        """GET /api/purchase/bills/filter-options/?company=<id>

        The values for the Bills page's filter pickers, read from the whole
        table rather than from the rows on screen.

        The page used to build these lists out of the bills it had downloaded,
        which worked only because it downloaded every one of them. Now that the
        list is bounded to the period being viewed, a picker built that way
        would offer the vendors of that month alone - so a vendor you did not
        buy from in October would simply vanish from the dropdown.

        Distinct values only, no rows: a handful of short strings. Scoped by
        company when one is given, and it reads the same base queryset the list
        does, so a warehouse-scoped user is offered the same values the list
        would actually show them.
        """
        # NOT scoped by company, deliberately. `?company=` is not a filter on
        # this list at all - the Bills page picks the company in the browser,
        # over rows it already has - so scoping here would offer fewer vendors
        # than the page can actually show, and a vendor would vanish from the
        # dropdown while its bills were still on screen. Measured: scoping by
        # company offered 545 vendors where the rows held 776.
        qs = self.filter_queryset(self.get_queryset())

        def _distinct(field):
            return sorted({v for v in qs.values_list(field, flat=True) if v})

        def _pairs(id_field, name_field):
            seen = {}
            for pk, name in qs.values_list(id_field, name_field):
                if pk and name:
                    seen[str(pk)] = name
            return [{'value': k, 'label': v}
                    for k, v in sorted(seen.items(), key=lambda kv: kv[1])]

        return Response({
            'vendors': _distinct('vendor__vendor_name'),
            'companies': _pairs('vendor__company_id', 'vendor__company__legal_name'),
            'warehouses': _pairs('warehouse_id', 'warehouse__name'),
            'categories': _distinct('purchase_category'),
            'statuses': _distinct('status'),
            # Products actually appearing on bills (value = Product id), for the
            # product picker. Only bought products show, not the full 2,600-row
            # master, so the list stays usable.
            'products': _pairs('bill_lines__product_id', 'bill_lines__product__product_name'),
        })

    @action(detail=False, methods=['get'], url_path='sales-offset')
    def sales_offset(self, request):
        """Per-vendor and aggregate sales-side offset for linked vendor-customers.

        GET /api/purchase/bills/sales-offset/?company=SSB-002[&vendor=<id>]

        Returns net offset (invoices - receipts + debit-notes - adjustments) so the
        Bills / Payments pages can show the combined Tally-style net position.
        """
        from decimal import Decimal
        from django.db.models import Sum
        from sales.models import (SalesInvoiceCheck, ReceivablePayment,
                                  ReceivableAdjustment)
        from sales.models import DebitNote
        from master.models import Vendor

        _Z = Decimal('0')
        code = request.query_params.get('company', '')
        vendor_id = request.query_params.get('vendor')

        lq = Vendor.objects.filter(is_active=True, linked_customer__isnull=False)
        if code and code.lower() != 'all':
            lq = lq.filter(company__company_code=code)
        if vendor_id:
            lq = lq.filter(id=vendor_id)
        pairs = list(lq.values_list('id', 'linked_customer_id'))
        if not pairs:
            return Response({'offset': 0, 'invoices': 0, 'receipts': 0,
                             'debit_notes': 0, 'adjustments_cr': 0,
                             'adjustments_dr': 0, 'linked_vendors': 0})

        cust_ids = [c for _, c in pairs]

        inv_t = (SalesInvoiceCheck.objects
                 .filter(customer_id__in=cust_ids, is_active=True)
                 .exclude(status='CANCELLED')
                 .aggregate(t=Sum('grand_total'))['t'] or _Z)
        rcp_t = (ReceivablePayment.objects
                 .filter(receivable__customer_id__in=cust_ids, is_active=True)
                 .aggregate(t=Sum('amount'))['t'] or _Z)
        sdn_t = (DebitNote.objects
                 .filter(customer_id__in=cust_ids, side='SALES',
                         note_type='DEBIT', is_active=True)
                 .aggregate(t=Sum('amount'))['t'] or _Z)
        adj_cr_t = (ReceivableAdjustment.objects
                    .filter(customer_id__in=cust_ids, is_active=True,
                            direction='CREDIT')
                    .aggregate(t=Sum('amount'))['t'] or _Z)
        adj_dr_t = (ReceivableAdjustment.objects
                    .filter(customer_id__in=cust_ids, is_active=True,
                            direction='DEBIT')
                    .aggregate(t=Sum('amount'))['t'] or _Z)

        offset = inv_t - rcp_t + sdn_t - adj_cr_t + adj_dr_t
        return Response({
            'offset': float(offset),
            'invoices': float(inv_t),
            'receipts': float(rcp_t),
            'debit_notes': float(sdn_t),
            'adjustments_cr': float(adj_cr_t),
            'adjustments_dr': float(adj_dr_t),
            'linked_vendors': len(pairs),
        })

    @action(detail=False, methods=['get'], url_path='vendor-customer-report')
    def vendor_customer_report(self, request):
        """One row per party that is BOTH a vendor and a customer (linked), with
        its purchase side (bills / outstanding) beside its sales side (invoices /
        received / sales offset) and the net position. This is the home for the
        sales-offset figures that used to crowd the Bills list — here they apply
        to exactly the handful of parties they're about.

        GET /api/purchase/bills/vendor-customer-report/?company=<id|code>
        """
        from decimal import Decimal
        from django.db.models import Sum, Q
        from sales.models import (SalesInvoiceCheck, ReceivablePayment,
                                  ReceivableAdjustment, DebitNote)
        from master.models import Vendor

        Z = Decimal('0')
        comp = request.query_params.get('company', '')
        lq = (Vendor.objects.filter(is_active=True, linked_customer__isnull=False)
              .select_related('company', 'linked_customer'))
        if comp and comp.lower() != 'all':
            # Accept a company id (UUID, what the companies lookup sends) or a
            # company code. Filtering `company_id` with a non-UUID (a code) would
            # raise, so pick the right field by whether it parses as a UUID.
            import uuid as _uuid
            try:
                _uuid.UUID(str(comp))
                lq = lq.filter(company_id=comp)
            except (ValueError, TypeError, AttributeError):
                lq = lq.filter(company__company_code=comp)

        rows = []
        tot = {'purchase_total': Z, 'purchase_outstanding': Z, 'sales_invoices': Z,
               'sales_received': Z, 'sales_offset': Z, 'net': Z}
        import logging as _logging
        _log = _logging.getLogger(__name__)
        for v in lq:
            try:
                cid = v.linked_customer_id
                cust = v.linked_customer
                if cid is None or cust is None:
                    continue      # linked customer was removed — skip, don't crash
                # Purchase side — the vendor's own bills (active, not cancelled).
                pb = (VendorBill.objects.filter(vendor_id=v.id, is_active=True)
                      .exclude(status='CANCELLED')
                      .aggregate(t=Sum('total_amount'), b=Sum('balance_due'),
                                 p=Sum('amount_paid')))
                p_total = pb['t'] or Z
                p_out = pb['b'] or Z
                p_paid = pb['p'] or Z
                # Sales side — the linked customer's invoices / receipts / notes.
                inv = (SalesInvoiceCheck.objects.filter(customer_id=cid, is_active=True)
                       .exclude(status='CANCELLED').aggregate(t=Sum('grand_total'))['t'] or Z)
                rcp = (ReceivablePayment.objects
                       .filter(receivable__customer_id=cid, is_active=True)
                       .aggregate(t=Sum('amount'))['t'] or Z)
                sdn = (DebitNote.objects.filter(customer_id=cid, side='SALES',
                                                note_type='DEBIT', is_active=True)
                       .aggregate(t=Sum('amount'))['t'] or Z)
                acr = (ReceivableAdjustment.objects
                       .filter(customer_id=cid, is_active=True, direction='CREDIT')
                       .aggregate(t=Sum('amount'))['t'] or Z)
                adr = (ReceivableAdjustment.objects
                       .filter(customer_id=cid, is_active=True, direction='DEBIT')
                       .aggregate(t=Sum('amount'))['t'] or Z)
                offset = inv - rcp + sdn - acr + adr       # net the sales side owes us
                net = p_out - offset                       # what we net-owe this party
                rows.append({
                    'vendor_id': str(v.id), 'vendor_name': v.vendor_name,
                    'customer_id': str(cid), 'customer_name': cust.customer_name,
                    'company_code': v.company.company_code if v.company_id else '',
                    'purchase_total': float(p_total), 'purchase_paid': float(p_paid),
                    'purchase_outstanding': float(p_out),
                    'sales_invoices': float(inv), 'sales_received': float(rcp),
                    'sales_offset': float(offset), 'net': float(net),
                })
                tot['purchase_total'] += p_total
                tot['purchase_outstanding'] += p_out
                tot['sales_invoices'] += inv
                tot['sales_received'] += rcp
                tot['sales_offset'] += offset
                tot['net'] += net
            except Exception:  # noqa: BLE001 — one bad party must not 500 the report
                _log.exception('vendor-customer-report: skipped vendor %s', getattr(v, 'id', '?'))
                continue
        rows.sort(key=lambda r: abs(r['sales_offset']), reverse=True)
        return Response({'rows': rows, 'totals': {k: float(x) for k, x in tot.items()},
                         'count': len(rows)})

    @action(detail=False, methods=['post'], url_path='approve-all')
    def approve_all(self, request):
        """Bulk version of `approve`: post many DRAFT bills to OPEN at once.

        The Bills list filters client-side, so the caller sends the ids of the
        DRAFT rows it is showing; we approve exactly those, each still guarded on
        status == 'DRAFT'. Same per-bill effect as `approve` (due date + the auto
        debit-note), so a draft approved in bulk is identical to one approved on
        its own — and a payment can then link to it."""
        from datetime import timedelta
        from .models import VendorBill
        ids = request.data.get('ids') or []
        if not isinstance(ids, (list, tuple)) or not ids:
            return Response({'error': 'No bill ids provided.'}, status=status.HTTP_400_BAD_REQUEST)
        ids = list(ids)[:2000]  # backstop against a runaway request
        approved = 0
        for bill in VendorBill.objects.filter(id__in=ids, status='DRAFT'):
            bill.status = 'OPEN'
            update_fields = ['status']
            if not bill.due_date and bill.bill_date:
                bill.due_date = bill.bill_date + timedelta(days=15)
                update_fields.append('due_date')
            bill.save(update_fields=update_fields)
            try:
                self._auto_create_debit_note(bill)
            except Exception:  # noqa: BLE001 — a debit-note hiccup must not abort the batch
                pass
            approved += 1
        return Response({'approved': approved, 'requested': len(ids)})

    @action(detail=True, methods=['post'], url_path='generate-debit-note')
    def generate_debit_note(self, request, pk=None):
        """Backfill the auto-debit-note for a bill that pre-dates the auto-create
        logic. Idempotent — no-op if a credit already exists for this bill or
        the receipt has no is_debit_note lines.
        """
        from .models import VendorCredit
        bill = self.get_object()
        existing = VendorCredit.objects.filter(bill=bill).exclude(status='CANCELLED').first()
        if existing:
            return Response({'created': False, 'credit_id': str(existing.id), 'credit_no': existing.credit_no, 'detail': 'Credit already exists for this bill.'})
        self._auto_create_debit_note(bill)
        credit = VendorCredit.objects.filter(bill=bill).exclude(status='CANCELLED').first()
        if not credit:
            return Response({'created': False, 'detail': 'No debit-noted lines found on the linked receipt.'}, status=status.HTTP_400_BAD_REQUEST)
        return Response({'created': True, 'credit_id': str(credit.id), 'credit_no': credit.credit_no})

    @action(detail=True, methods=['post'], url_path='record-payment')
    def record_payment(self, request, pk=None):
        """Create a PaymentMade record against this bill."""
        bill = self.get_object()
        from decimal import Decimal, InvalidOperation

        amount_str = request.data.get('amount', '0')
        try:
            amount = Decimal(str(amount_str))
        except (InvalidOperation, ValueError):
            return Response({'error': 'Invalid amount.'}, status=status.HTTP_400_BAD_REQUEST)

        # Delegates to the shared service so this endpoint and the
        # bank-statement reconciliation screen book a payment identically —
        # the amount checks and the amount_paid/status update all live in one
        # place now. Behaviour here is unchanged.
        from .vendor_payments import apply_payment_to_bill
        try:
            payment = apply_payment_to_bill(
                bill, amount,
                payment_date=request.data.get('payment_date', timezone.now().date()),
                payment_mode=request.data.get('payment_mode', 'BANK_TRANSFER'),
                reference_no=request.data.get('reference_no', ''),
                bank_name=request.data.get('bank_name', ''),
                notes=request.data.get('notes', ''),
            )
        except ValueError as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

        data = self.get_serializer(bill).data
        data['payment_id'] = str(payment.id)
        return Response(data)

    @action(detail=False, methods=['get'], url_path='vendor-ledger')
    def vendor_ledger(self, request):
        """Tally-style running ledger for ONE vendor: opening balance, then every
        bill (Cr — we owe more), payment (Dr — we paid), and purchase debit/credit
        note in date order with a running balance, plus Current Total (Dr/Cr) and
        Closing Balance. TDS is shown per-bill as an informational column but does
        NOT reduce the running balance — in Tally the vendor is credited GROSS and
        TDS is debited separately (journal to TDS Payable) only when the TDS is
        actually remitted to the government; until that journal is posted (and
        imported), the vendor's balance should stay gross.
        When the vendor is also a customer (linked_customer), sales-side
        transactions appear too — mirroring Tally's combined party ledger where
        both purchase and sales net on one account.
        Mirror of sales' customer-ledger."""
        from decimal import Decimal
        from django.db.models import Sum
        from .models import VendorBill, PaymentMade, TdsPayable
        from sales.models import DebitNote, SalesInvoiceCheck, ReceivablePayment, ReceivableAdjustment
        from master.models import Vendor
        from rest_framework.exceptions import ValidationError

        vendor_id = request.query_params.get('vendor')
        # No vendor -> the whole creditor book. `company` then scopes it, because
        # a ledger spanning two companies is not a statement of anything.
        company_id = request.query_params.get('company') or None
        if not vendor_id and not company_id:
            raise ValidationError(
                'pass vendor=<id> for one vendor, or company=<id> for all of them')
        vend = Vendor.objects.filter(id=vendor_id).first() if vendor_id else None
        # How many rows to return. All-vendor statements run to thousands, and a
        # truncated answer that says so is better than one that silently stops.
        try:
            limit = max(1, min(int(request.query_params.get('limit') or 5000), 20000))
        except (TypeError, ValueError):
            limit = 5000

        def scope(qs, path='vendor'):
            if vendor_id:
                return qs.filter(**{path + '_id': vendor_id})
            return qs.filter(**{path + '__company_id': company_id})
        # Optional period window — everything BEFORE `from` folds into Opening
        # Balance (so the statement still reconciles), only events WITHIN
        # [from, to] show as rows, and Closing Balance lands as of `to`.
        # Omit both for the full all-time ledger (unchanged default).
        date_from = request.query_params.get('from') or None
        date_to = request.query_params.get('to') or None

        # TDS the company DEDUCTED from this vendor at bill time (194Q/194C), taken
        # from Tally's TDS Payable register linked to each bill (vendor_bill FK).
        # Shown as an informational column per bill but NOT subtracted from the
        # running balance — Tally credits the vendor GROSS and only debits the TDS
        # via a separate journal when remitted; the ERP imports that journal as a
        # payment debit when it arrives.
        _tq = TdsPayable.objects.filter(is_active=True, amount__gt=0,
                                        vendor_bill__isnull=False)
        _tq = scope(_tq, 'vendor_bill__vendor')
        tds_by_bill = {
            r['vendor_bill_id']: (r['t'] or Decimal('0'))
            for r in (_tq.exclude(voucher_type='Opening Balance')
                      .values('vendor_bill_id').annotate(t=Sum('amount')))
        }
        # Per-vendor set of UNLINKED TDS-Payable rows still waiting for a bill. Used
        # to tell a fallback bill apart: if an unlinked Tally TDS row exists for this
        # vendor, the bill is RELINKABLE (run relink_tds_to_bills, amber warn); if
        # none exists, the TDS lives ONLY on the bill (Tally booked no separate TDS
        # voucher — e.g. the early Sperrholz SETN2627-02/03/21 bills) so relink can
        # never help and the fallback figure is final (info mark, not a warning).
        _uq = TdsPayable.objects.filter(is_active=True, amount__gt=0,
                                        vendor_bill__isnull=True)
        _uq = scope(_uq, 'vendor')
        _unlinked_vendors = set(
            _uq.exclude(voucher_type='Opening Balance')
               .values_list('vendor_id', flat=True).distinct())

        events, opening = [], Decimal('0')
        # Exclude CANCELLED bills: a voided bill is not a real credit, and a
        # duplicate that was cancelled (e.g. 26-T47 vs its keeper 26-T163) would
        # otherwise be ADDED again here -- double-counting Total Billed + Closing.
        # Payments already exclude CANCELLED below; bills must match.
        for b in (scope(VendorBill.objects.filter(is_active=True))
                  .exclude(status='CANCELLED')
                  .select_related('vendor')):
            is_open = ((b.vendor_invoice_no or '') == 'OPENING'
                       or (b.tally_guid or '').startswith('OPENING'))
            amt = Decimal(str(b.total_amount or 0))
            if is_open:
                opening += amt
                continue
            # TDS for the row: prefer the LINKED TdsPayable (so the figure can
            # hyperlink to the deduction voucher), but when nothing is linked fall
            # back to the bill's OWN tds_amount. Without this fallback a bill whose
            # total is stored net of TDS (total_is_net) but whose TdsPayable link
            # never matched — e.g. the "-N"-suffixed Sperrholz bills — shows a BLANK
            # TDS cell here even though the deduction plainly shows inside the bill
            # detail. The blank read as "no TDS" and hid real deductions; the
            # fallback makes the column agree with the bill. Still display-only; the
            # running balance is unchanged (Tally credits gross).
            _linked_tds = tds_by_bill.get(b.id)
            _row_tds = _linked_tds
            if not _row_tds:
                _row_tds = Decimal(str(b.tds_amount or 0))
            # Classify where the TDS figure came from, so the UI can mark it honestly:
            #   'linked'     — a Tally TDS voucher is linked to this bill (drillable).
            #   'relinkable' — fell back to the bill's own tds, BUT an unlinked Tally
            #                  TDS row exists for this vendor → relink can attach it
            #                  (amber warning: run relink_tds_to_bills).
            #   'bill_only'  — fell back to the bill's own tds and NO unlinked Tally
            #                  row exists for the vendor → Tally never booked a
            #                  separate TDS voucher; the bill figure is final and
            #                  relink can't help (info mark, not a warning).
            if _linked_tds:
                _tds_source = 'linked'
            elif _row_tds and b.vendor_id in _unlinked_vendors:
                _tds_source = 'relinkable'
            elif _row_tds:
                _tds_source = 'bill_only'
            else:
                _tds_source = 'linked'   # no TDS at all — nothing to mark
            events.append({'date': str(b.bill_date or ''), 'type': 'Bill',
                           'doc_no': (b.bill_no or ''), 'ref_id': str(b.id),
                           'vendor': b.vendor.vendor_name if b.vendor_id else '',
                           'debit': Decimal('0'), 'credit': amt,
                           'tds': _row_tds,
                           # True when the figure came from a linked TdsPayable (can
                           # drill to the voucher); False when it fell back to the
                           # bill's own field (link missing — needs relink).
                           'tds_linked': bool(_linked_tds),
                           'tds_source': _tds_source,
                           # Per-bill settlement, so the Bills popup can show
                           # Paid / Partial (+ how much) / Not paid.
                           'status': b.status,
                           'paid': Decimal(str(b.amount_paid or 0)),
                           # Per-bill outstanding + due date, so the vendor ledger
                           # can flag which bill is still unpaid / overdue (user
                           # ask, parity with the sales statement). Display only.
                           'outstanding': amt - Decimal(str(b.amount_paid or 0)),
                           'due_date': str(getattr(b, 'due_date', None)
                                           or getattr(b, 'payment_due_date', None) or '')})
        for p in (scope(PaymentMade.objects.filter(is_active=True))
                  .exclude(status='CANCELLED').select_related('vendor')):
            events.append({'date': str(p.payment_date or ''), 'type': 'Payment',
                           'doc_no': (p.payment_no or p.reference_no or 'Payment'), 'ref_id': str(p.id),
                           'vendor': p.vendor.vendor_name if p.vendor_id else '',
                           'debit': Decimal(str(p.amount or 0)), 'credit': Decimal('0'),
                           'tds': Decimal('0')})
        for dn in (scope(DebitNote.objects.filter(side='PURCHASE', is_active=True))
                   .select_related('vendor')):
            amt = Decimal(str(dn.amount or 0))
            _vn = dn.vendor.vendor_name if dn.vendor_id else ''
            if dn.note_type == 'DEBIT':   # we debit the vendor -> reduces payable
                events.append({'date': str(dn.note_date or ''), 'type': 'Debit Note',
                               'doc_no': dn.note_no, 'ref_id': str(dn.id), 'vendor': _vn,
                               'debit': amt, 'credit': Decimal('0'), 'tds': Decimal('0')})
            else:
                events.append({'date': str(dn.note_date or ''), 'type': 'Credit Note',
                               'doc_no': dn.note_no, 'ref_id': str(dn.id), 'vendor': _vn,
                               'debit': Decimal('0'), 'credit': amt, 'tds': Decimal('0')})

        # Advances (VendorCredit type ADVANCE) — money paid to the vendor ahead
        # of a bill, so a DEBIT (reduces payable / sits as a prepaid balance),
        # like a payment. Shown as its own "Advance" row so the ledger reflects
        # what the Vendor Notes & Advances list records.
        from .models import VendorCredit
        for ac in (scope(VendorCredit.objects.filter(is_active=True, credit_type='ADVANCE'))
                   .exclude(status='CANCELLED').select_related('vendor')):
            events.append({'date': str(ac.credit_date or ''), 'type': 'Advance',
                           'doc_no': (ac.credit_no or 'Advance'), 'ref_id': str(ac.id),
                           'vendor': ac.vendor.vendor_name if ac.vendor_id else '',
                           'debit': Decimal(str(ac.total_amount or 0)), 'credit': Decimal('0'),
                           'tds': Decimal('0')})

        # PURCHASE-ONLY (sales-twin merge removed). This drawer USED to pull the
        # linked customer's sales invoices/receipts/notes in when a vendor was
        # "Also a customer", on the assumption Tally nets both on one combined
        # party ledger. That holds only for genuine one-ledger parties; most
        # (e.g. Greenstar) keep SEPARATE Tally creditor/debtor ledgers, so the
        # merge showed a customer's whole sales statement inside the purchase
        # ledger and made the closing balance a sales figure. The sales
        # customer-ledger dropped the mirror of this merge for the same reason
        # (30-Oct-2026). The combined net position lives in the Vendor-Customer
        # report. SalesInvoiceCheck / ReceivablePayment / ReceivableAdjustment
        # imports above are now unused here but left to avoid churn.

        events.sort(key=lambda e: (e['date'], e.get('vendor') or '',
                                   0 if e['type'] == 'Bill' else 1))

        if date_from or date_to:
            before, within = [], []
            for e in events:
                d = e['date']
                if date_from and d < date_from:
                    before.append(e)
                elif date_to and d > date_to:
                    continue  # after the window — irrelevant to this period's statement
                else:
                    within.append(e)
            # A bill (credit) increases what we owe, a payment (debit) reduces it.
            opening += sum((e['credit'] - e['debit'] for e in before), Decimal('0'))
            events = within

        running, tot_d, tot_c, tot_tds = opening, Decimal('0'), Decimal('0'), Decimal('0')
        rows = []
        for e in events:
            # a bill (credit) raises what we owe; a payment (debit) lowers it
            running += e['credit'] - e['debit']
            tot_d += e['debit']
            tot_c += e['credit']
            tot_tds += e['tds']
            rows.append({
                'date': e['date'], 'type': e['type'], 'doc_no': e['doc_no'], 'ref_id': e['ref_id'],
                'vendor_name': e.get('vendor') or '',
                'debit': str(e['debit']), 'credit': str(e['credit']), 'tds': str(e['tds']),
                # False only for a Bill whose TDS fell back to its own field (the
                # linked TdsPayable is missing) — the frontend flags it so a real
                # deduction with a broken link is visible, not silently blank.
                'tds_linked': e.get('tds_linked', True),
                # 'linked' | 'relinkable' | 'bill_only' — lets the UI show an amber
                # warning (relink will fix) vs a neutral info mark (TDS on bill only,
                # Tally has no voucher, relink can't help).
                'tds_source': e.get('tds_source', 'linked'),
                'balance': str(running),
                'bill_status': e.get('status') or '',
                'paid': str(e.get('paid') or Decimal('0')),
                'outstanding': str(e.get('outstanding') or Decimal('0')),
                'due_date': e.get('due_date') or '',
            })
        # The totals above are the WHOLE period; only the row list is capped,
        # so a truncated statement still closes on the right balance.
        shown = rows[:limit]
        return Response({
            'vendor_id': vendor_id,
            'vendor_name': (vend.vendor_name if vend else
                            ('All vendors' if not vendor_id else '')),
            'company_name': (getattr(vend.company, 'legal_name', '') if (vend and vend.company_id) else ''),
            'is_msme': bool(getattr(vend, 'is_msme', False)) if vend else False,
            'msme_category': (getattr(vend, 'msme_category', '') or '') if vend else '',
            'all_vendors': not vendor_id,
            'vendors': len({r['vendor_name'] for r in rows if r['vendor_name']}),
            'opening_balance': str(opening),
            'rows': shown,
            'current_debit': str(tot_d),
            'current_credit': str(tot_c),
            'current_tds': str(tot_tds),
            'closing_balance': str(opening + tot_c - tot_d),
            'count': len(rows),
            'shown': len(shown),
            'truncated': len(shown) < len(rows),
        })


def _freight_by_guid_map(guids):
    """{tally_guid: {kind, no, id}} for Outward/Local freight records whose
    voucher GUID is in `guids` — so a freight payment on the Payment Entries list
    links to the freight record it settled instead of reading on-account. Two
    grouped queries, no per-row work."""
    if not guids:
        return {}
    out = {}
    try:
        from sales.models import FreightAdviceOutbound
        for fid, no, g in (FreightAdviceOutbound.objects
                           .filter(tally_guid__in=guids)
                           .values_list('id', 'advice_no', 'tally_guid')):
            if g and g not in out:
                out[g] = {'kind': 'outward', 'no': no, 'id': str(fid)}
    except Exception:
        pass
    try:
        from .models import LocalFreight
        for fid, no, g in (LocalFreight.objects
                           .filter(tally_guid__in=guids)
                           .values_list('id', 'freight_no', 'tally_guid')):
            if g and g not in out:
                out[g] = {'kind': 'local', 'no': no, 'id': str(fid)}
    except Exception:
        pass
    return out


def _vendor_billed_category_map(vendors):
    """For each vendor, the category to show on an on-account payment to it.

    Two fallbacks, in order — this is the on-account Category-chip resolver:

      1. the vendor's HIGHEST-VALUE billed purchase_category (freight bills ->
         FREIGHT, RM bills -> RM, …). Mirrors the Purchase dashboard split's
         vendor_cat so the chip and the tile agree.

      2. if the vendor has no categorised bill, but its NAME matches a record in
         the Transporter master (same company), it is a transporter -> FREIGHT.
         This is why outward / local freight payees — who are paid through Tally
         as plain payment vouchers and carry NO VendorBill at all (their freight
         lives in LocalFreight / FreightAdvice, not a bill) — stop showing as a
         blank on-account chip. Without this they resolve to nothing: no
         vendor_type, no bill.

    `vendors` is an iterable of Vendor instances (needs id, name key, company).
    Returns {vendor_id: 'FREIGHT'|'RM'|...}, upper-cased.
    """
    vendors = list(vendors or [])
    if not vendors:
        return {}
    from django.db.models import Sum
    from .models import VendorBill
    from master.models import Transporter
    from master.merge_utils import vkey

    ids = [v.id for v in vendors]
    rows = (VendorBill.objects
            .filter(vendor_id__in=ids)
            .exclude(purchase_category='')
            .exclude(purchase_category=None)
            .values('vendor_id', 'purchase_category')
            .annotate(v=Sum('total_amount')))
    best = {}  # vendor_id -> (category, value)
    for r in rows:
        vid = r['vendor_id']
        cat = (r['purchase_category'] or '').strip().upper()
        if not cat:
            continue
        val = r['v'] or 0
        cur = best.get(vid)
        if cur is None or val > cur[1]:
            best[vid] = (cat, val)
    out = {vid: cat for vid, (cat, _v) in best.items()}

    # Fallback 2 — Transporter master, only for vendors still unresolved.
    unresolved = [v for v in vendors if v.id not in out]
    if unresolved:
        # Transporter names -> normalised key, scoped per company. Only the
        # companies present in this page are queried.
        company_ids = {getattr(v, 'company_id', None) for v in unresolved}
        company_ids.discard(None)
        tpt_keys = {}  # (company_id, name_key) -> True ; also None-company (shared)
        tq = Transporter.objects.filter(active_flag=True)
        if company_ids:
            from django.db.models import Q as _Q
            tq = tq.filter(_Q(company_id__in=company_ids) | _Q(company_id__isnull=True))
        for name, cid in tq.values_list('name', 'company_id'):
            k = vkey(name or '')
            if k:
                tpt_keys[(cid, k)] = True
        for v in unresolved:
            k = getattr(v, 'vendor_name_key', '') or vkey(getattr(v, 'vendor_name', '') or '')
            if not k:
                continue
            if (v.company_id, k) in tpt_keys or (None, k) in tpt_keys:
                out[v.id] = 'FREIGHT'
    return out


class PaymentMadeViewSet(viewsets.ModelViewSet):
    """ViewSet for Payments Made."""

    from .models import PaymentMade
    from .serializers import PaymentMadeSerializer

    queryset = PaymentMade.objects.select_related('vendor', 'vendor__company', 'bill').all()
    serializer_class = PaymentMadeSerializer

    def _slim(self):
        return (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes'))

    def get_queryset(self):
        qs = super().get_queryset()
        # Server-side scope so the list can load ONE account (or one company) at a
        # time instead of every payment — the Payments Made drill-down
        # (company -> bank account -> payments) passes these.
        company = (self.request.query_params.get('company') or '').strip()
        if company and company.lower() != 'all':
            if len(company) == 36 and '-' in company:
                qs = qs.filter(vendor__company_id=company)
            else:
                qs = qs.filter(vendor__company__company_code=company)
        bank_account = (self.request.query_params.get('bank_account') or '').strip()
        if bank_account and bank_account.lower() not in ('', 'all'):
            qs = qs.filter(bank_account_id=bank_account)
        # Server-side PERIOD + KIND filters, so a month / FY view fetches only that
        # slice instead of every payment for the company (the Payment Entries page
        # was loading ALL ~1,500 rows then filtering in the browser — slow). The
        # page passes date_from/date_to from its period picker and kind from the
        # bill/on-account/transfer dropdown.
        df = (self.request.query_params.get('date_from') or '').strip()
        dt = (self.request.query_params.get('date_to') or '').strip()
        if df:
            qs = qs.filter(payment_date__gte=df)
        if dt:
            qs = qs.filter(payment_date__lte=dt)
        kind = (self.request.query_params.get('kind') or '').strip().lower()
        if kind == 'bill':
            qs = qs.filter(bill__isnull=False).exclude(is_transfer=True).exclude(payment_category='REFUND')
        elif kind == 'onaccount':
            qs = qs.filter(bill__isnull=True).exclude(is_transfer=True).exclude(payment_category='REFUND')
        elif kind == 'transfer':
            qs = qs.filter(is_transfer=True)
        elif kind == 'refund':
            qs = qs.filter(payment_category='REFUND')
        if self._slim():
            # Narrow the COLUMNS as well as the fields. select_related('bill')
            # pulls all 39 VendorBill columns and 38 Vendor columns for every
            # payment so the row can show one bill_no and one vendor_name -
            # on 7,771 payments that is the bulk of the work. .only() keeps the
            # same joins but fetches just the columns the slim serializer reads.
            qs = qs.select_related('bank_account').only(
                'id', 'payment_no', 'payment_date', 'amount', 'reference_no',
                'payment_mode', 'status', 'vendor', 'bill', 'bank_account',
                'vendor__vendor_name', 'vendor__vendor_type',
                # name key + company for the on-account chip's Transporter-master
                # fallback (outward/local freight payees have no bill to infer from).
                'vendor__vendor_name_key', 'vendor__company_id',
                'vendor__company__company_code',
                'vendor__company__trade_name', 'bank_account__code',
                'bank_account__nickname', 'bill__bill_no',
                'bill__status', 'bill__total_amount', 'bill__amount_paid',
                # category bucket (Purchase / Expense / Freight) for the filter —
                # included in .only() so get_bill_category needs no extra query.
                'bill__purchase_category', 'bill__is_expense',
                # Tally guid for the Tally-vs-ERP source badge (get_source_origin).
                'tally_guid',
                # Inter-account transfer flag/category for the list's transfer badge.
                'is_transfer', 'payment_category',
            )
        return qs
    def get_serializer_class(self):
        # ?slim=1 on the LIST returns only the columns the list page renders.
        # Opt-in: without the flag the response is exactly what it is today.
        if (self.action == 'list'
                and str(self.request.query_params.get('slim', '')).lower()
                in ('1', 'true', 'yes')):
            from .serializers import PaymentMadeListSerializer
            return PaymentMadeListSerializer
        return super().get_serializer_class()

    def paginate_queryset(self, queryset):
        """Same pagination, plus a vendor -> billed-category fallback map built
        for THIS page only, stashed for get_serializer_context.

        The Category chip on an ON-ACCOUNT payment resolves from the vendor's
        vendor_type. When that is empty (common for transporters and farmers
        imported from Tally, who have freight / purchase BILLS but no master
        type set) the chip was BLANK even though the vendor plainly buys/sells
        one category — e.g. "Amutha Roadways" shows Freight on its bill-linked
        rows but blank on its on-account rows. So fall the chip back to the
        vendor's highest-value billed purchase_category (the same fallback the
        Purchase dashboard split uses), computed once per page — no N+1.
        """
        page = super().paginate_queryset(queryset)
        self._page_vendor_cat = {}
        try:
            rows = page if page is not None else []
            need = {}  # vendor_id -> Vendor instance (dedup)
            for p in rows:
                ven = getattr(p, 'vendor', None)
                vt = getattr(ven, 'vendor_type', None)
                typed = bool(vt) and any(str(t).strip() for t in (vt or []))
                if getattr(p, 'bill_id', None) is None and not typed and ven is not None:
                    need[ven.id] = ven
            self._page_vendor_cat = _vendor_billed_category_map(need.values())
        except Exception:
            self._page_vendor_cat = {}
        # Freight link map: for the Tally-guid payments on this page, which ones
        # settle an Outward/Local freight record (matched by guid). One query each
        # — so a freight payment shows "→ Freight" instead of a loose on-account.
        self._page_freight = {}
        try:
            guids = [g for g in ((getattr(p, 'tally_guid', '') or '').strip()
                                 for p in (page or [])) if g]
            if guids:
                self._page_freight = _freight_by_guid_map(guids)
        except Exception:
            self._page_freight = {}
        return page

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx['vendor_billed_category'] = getattr(self, '_page_vendor_cat', {}) or {}
        ctx['freight_by_guid'] = getattr(self, '_page_freight', {}) or {}
        return ctx
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Payment Made'
    # This one endpoint backs three menu items (Payments Made, Payables Overview,
    # Payment Entries). Payment Entries has its own module, so a role granted
    # only that must still be able to load this list — accept either module.
    alternate_modules = ['Payment Entries']

    def perform_destroy(self, instance):
        """Delete the payment AND put the bill back.

        A payment is two writes, so removing one is two writes as well. The
        default ModelViewSet destroy removed only the PaymentMade row and left
        bill.amount_paid inflated — the bill kept reading part-paid for money
        that no longer existed anywhere. That is why the UI only ever offered
        Delete on DRAFT rows: a guard standing in for a missing unwind, which
        also meant an APPROVED payment (every Tally-imported one, and every one
        booked from a bank statement) could not be corrected at all.

        reverse_payment is the same function the bank-statement Undo uses, so
        both routes put the bill back identically rather than drifting.

        A statement line that created or matched this payment is reset first.
        The FK is SET_NULL, so without this the line would be left MATCHED and
        entry_created=True while pointing at nothing — the reconcile report
        would show a settled row with no record behind it.
        """
        from finance.models import BankStatementLine
        from .vendor_payments import reverse_payment

        with transaction.atomic():
            BankStatementLine.objects.filter(matched_vendor_payment=instance).update(
                matched_vendor_payment=None, match_status='UNMATCHED',
                entry_created=False, match_notes='')
            reverse_payment(instance)
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['status', 'vendor', 'payment_mode']
    search_fields = ['payment_no', 'vendor__vendor_name', 'reference_no']
    ordering_fields = ['payment_date', 'amount', 'created_at']
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
    ordering = ['-payment_date', '-id']

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        payment = self.get_object()
        if payment.status != 'DRAFT':
            return Response({'error': f'Cannot approve in {payment.get_status_display()} status.'}, status=status.HTTP_400_BAD_REQUEST)
        payment.status = 'APPROVED'
        payment.save(update_fields=['status'])
        return Response(self.get_serializer(payment).data)

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """Dashboard aggregates for the Payments Made page, scoped by ?company and a
        date window (?period=today|week|month, or ?from=&to=). Read-only.

        Returns a roll-forward (opening + bills − paid − returns = outstanding now),
        the period's payments (linked vs on-account), bills cleared, and the live
        bill status split (paid / partial / open) with balances — so the page can show
        what was billed, what was paid, and what is still owing at a glance. The
        'opening' is back-calculated so the roll-forward always ties exactly."""
        from datetime import datetime, timedelta
        from decimal import Decimal
        from django.utils import timezone
        from django.db.models import (Sum, Count, F, Q, DecimalField, ExpressionWrapper,
                                      Case, When, Value, CharField)
        from .models import VendorBill, PaymentMade, VendorOpeningBalance
        from sales.models import DebitNote

        _Z = Decimal('0')
        _BAL = ExpressionWrapper(F('total_amount') - F('amount_paid'),
                                 output_field=DecimalField(max_digits=18, decimal_places=2))

        def _m(x):
            return float(Decimal(str(x or 0)).quantize(Decimal('0.01')))

        # ── date window ────────────────────────────────────────────────────
        today = timezone.localdate()
        period = (request.query_params.get('period') or 'month').lower()

        def _pd(s):
            try:
                return datetime.strptime((s or '').strip(), '%Y-%m-%d').date()
            except ValueError:
                return None
        d_from, d_to = _pd(request.query_params.get('from')), _pd(request.query_params.get('to'))
        if not (d_from and d_to):
            if period == 'today':
                d_from = d_to = today
            elif period == 'week':
                d_from, d_to = today - timedelta(days=today.weekday()), today
            else:
                period = 'month'
                d_from, d_to = today.replace(day=1), today
        if d_from > d_to:
            d_from, d_to = d_to, d_from

        # ── company scope ──────────────────────────────────────────────────
        code = (request.query_params.get('company') or '').strip()
        bills = VendorBill.objects.filter(is_active=True).exclude(status='CANCELLED')
        pays = PaymentMade.objects.filter(is_active=True).exclude(status='CANCELLED')
        rets = DebitNote.objects.filter(side='PURCHASE', note_type='DEBIT', is_active=True,
                                        vendor__isnull=False)
        if code and code.lower() != 'all':
            bills = bills.filter(vendor__company__company_code=code)
            pays = pays.filter(vendor__company__company_code=code)
            rets = rets.filter(company__company_code=code)

        # ── period flows ───────────────────────────────────────────────────
        pp = pays.filter(payment_date__gte=d_from, payment_date__lte=d_to)
        paid_total = _m(pp.aggregate(t=Sum('amount'))['t'])
        paid_count = pp.count()
        linked = _m(pp.exclude(bill__isnull=True).aggregate(t=Sum('amount'))['t'])
        on_account = _m(pp.filter(bill__isnull=True).aggregate(t=Sum('amount'))['t'])

        bp = bills.filter(bill_date__gte=d_from, bill_date__lte=d_to)
        bills_amt = _m(bp.aggregate(t=Sum('total_amount'))['t'])
        bills_count = bp.count()
        returns_amt = _m(rets.filter(note_date__gte=d_from, note_date__lte=d_to)
                         .aggregate(t=Sum('amount'))['t'])

        # bills that reached PAID and took a payment inside the window. Collect the
        # DISTINCT bill ids first, then total them on a join-free query — otherwise a
        # bill with two in-window payments would be counted (and summed) twice.
        cleared_ids = set(bills.filter(
            status='PAID', payments__payment_date__gte=d_from,
            payments__payment_date__lte=d_to).values_list('id', flat=True))
        cleared_count = len(cleared_ids)
        cleared_amt = _m(VendorBill.objects.filter(id__in=cleared_ids)
                         .aggregate(t=Sum('total_amount'))['t']) if cleared_ids else 0.0

        # Point-in-time outstanding ("now"). If a Tally OPENING anchor exists for this
        # ONE company (VendorOpeningBalance as-of <= today), the ERP's pre-anchor bills
        # are known-incomplete (the team started keying from the anchor month), so the
        # raw open-bill sum overstates. Instead roll forward FROM Tally's opening:
        #   anchor + bills_since − payments_since − returns_since.
        # No anchor (or company=all) -> unchanged raw open-bill sum.
        anchor_date = None
        if code and code.lower() != 'all':
            anchor_date = (VendorOpeningBalance.objects
                           .filter(company__company_code=code, as_of_date__lte=today)
                           .order_by('-as_of_date')
                           .values_list('as_of_date', flat=True).first())
        # Sales-side offset: for vendors with a linked_customer, their sales
        # invoices reduce what we owe and receipts restore it — matching Tally's
        # combined Sundry Creditors closing which nets both sides.
        from sales.models import SalesInvoiceCheck, ReceivablePayment, ReceivableAdjustment
        from master.models import Vendor
        _lq = Vendor.objects.filter(is_active=True, linked_customer__isnull=False)
        if code and code.lower() != 'all':
            _lq = _lq.filter(company__company_code=code)
        _cust_ids = list(_lq.values_list('linked_customer_id', flat=True))

        def _sales_offset(since_date=None):
            """Net sales-side offset: invoices (Dr) - receipts (Cr) - adjustments."""
            if not _cust_ids:
                return _Z
            inv_q = SalesInvoiceCheck.objects.filter(
                customer_id__in=_cust_ids, is_active=True).exclude(status='CANCELLED')
            rcp_q = ReceivablePayment.objects.filter(
                receivable__customer_id__in=_cust_ids, is_active=True)
            # Sales-side debit notes (we debit them = reduces our payable)
            sdn_q = DebitNote.objects.filter(
                customer_id__in=_cust_ids, side='SALES', note_type='DEBIT', is_active=True)
            # Receivable adjustments credit direction (reduces their debt = increases our net payable)
            adj_cr_q = ReceivableAdjustment.objects.filter(
                customer_id__in=_cust_ids, is_active=True, direction='CREDIT')
            adj_dr_q = ReceivableAdjustment.objects.filter(
                customer_id__in=_cust_ids, is_active=True, direction='DEBIT')
            if since_date:
                inv_q = inv_q.filter(invoice_date__gte=since_date)
                rcp_q = rcp_q.filter(payment_date__gte=since_date)
                sdn_q = sdn_q.filter(note_date__gte=since_date)
                adj_cr_q = adj_cr_q.filter(date__gte=since_date)
                adj_dr_q = adj_dr_q.filter(date__gte=since_date)
            inv_t = inv_q.aggregate(t=Sum('grand_total'))['t'] or _Z
            rcp_t = rcp_q.aggregate(t=Sum('amount'))['t'] or _Z
            sdn_t = sdn_q.aggregate(t=Sum('amount'))['t'] or _Z
            adj_cr_t = adj_cr_q.aggregate(t=Sum('amount'))['t'] or _Z
            adj_dr_t = adj_dr_q.aggregate(t=Sum('amount'))['t'] or _Z
            return inv_t - rcp_t + sdn_t - adj_cr_t + adj_dr_t

        if anchor_date:
            a_amt = (VendorOpeningBalance.objects
                     .filter(company__company_code=code, as_of_date=anchor_date)
                     .aggregate(t=Sum('amount'))['t']) or _Z
            b_since = bills.filter(bill_date__gte=anchor_date).aggregate(t=Sum('total_amount'))['t'] or _Z
            p_since = pays.filter(payment_date__gte=anchor_date).aggregate(t=Sum('amount'))['t'] or _Z
            r_since = rets.filter(note_date__gte=anchor_date).aggregate(t=Sum('amount'))['t'] or _Z
            s_offset = _sales_offset(anchor_date)
            closing = _m(a_amt + b_since - p_since - r_since - s_offset)
            out_count = bills.exclude(status='PAID').filter(bill_date__gte=anchor_date).count()
        else:
            oa = bills.exclude(status='PAID').aggregate(t=Sum(_BAL), n=Count('id'))
            s_offset = _sales_offset()
            closing = _m(Decimal(str(oa['t'] or 0)) - s_offset)
            out_count = oa['n'] or 0
        # Status split of THIS PERIOD's bills (dated in the window) — so it moves with
        # the Today/Week/Month selector, matching "Bills this period". bp is already the
        # period-scoped bill queryset.
        paid_n = bp.filter(status='PAID').count()
        pa = bp.filter(status='PARTIALLY_PAID').aggregate(n=Count('id'), b=Sum(_BAL))
        op = bp.exclude(status__in=['PAID', 'PARTIALLY_PAID']).aggregate(n=Count('id'), b=Sum(_BAL))
        # opening = closing − bills + paid + returns, so the roll-forward always ties
        opening = _m(Decimal(str(closing)) - Decimal(str(bills_amt))
                     + Decimal(str(paid_total)) + Decimal(str(returns_amt)))

        # By-category split of THIS PERIOD's bills (count + their still-owing balance),
        # one bucket per bill so totals never double-count — so it moves with the period
        # selector like the rest of the page. Expense flag wins first (matches the
        # by-category page: a machinery/expense-flagged bill is an Expense, not RM).
        # FREIGHT and PACKING are matched by their category BEFORE the is_expense flag,
        # so a freight bill (which is booked as an expense, is_expense=True) still shows
        # as Freight rather than being swallowed into Expenses — matches the Purchase
        # by-category page, which lists Freight as its own line.
        _bucket = Case(
            When(purchase_category='FREIGHT', then=Value('FREIGHT')),
            When(purchase_category='PACKING', then=Value('PACKING')),
            When(is_expense=True, then=Value('EXPENSES')),
            When(purchase_category__in=['EXPENSES', 'MACHINERY'], then=Value('EXPENSES')),
            When(purchase_category__in=['RM', 'MAIZE', 'BOUGHT_NOTE'], then=Value('RM')),
            When(purchase_category='BRANCH', then=Value('BRANCH')),
            default=Value('OTHER'), output_field=CharField(),
        )
        _CATLBL = {'RM': 'Raw Material', 'PACKING': 'Packing', 'FREIGHT': 'Freight',
                   'EXPENSES': 'Expenses', 'BRANCH': 'Branch', 'OTHER': 'Other'}
        by_category = [
            {'key': r['_b'], 'label': _CATLBL.get(r['_b'], r['_b']),
             'count': r['n'] or 0, 'outstanding': _m(r['bal'])}
            for r in (bp.annotate(_b=_bucket)
                      .values('_b').annotate(n=Count('id'), bal=Sum(_BAL)).order_by('-bal'))
        ]

        payload = {
            'period': {'key': period, 'from': d_from.isoformat(), 'to': d_to.isoformat()},
            'rollforward': {
                'opening': opening, 'bills': bills_amt, 'paid': paid_total,
                'returns': returns_amt, 'closing': closing,
            },
            'paid': {'total': paid_total, 'count': paid_count,
                     'linked': linked, 'on_account': on_account},
            'bills': {'total': bills_amt, 'count': bills_count},
            'cleared': {'count': cleared_count, 'amount': cleared_amt},
            'outstanding': {'total': closing, 'count': out_count},
            'status': {
                'paid': {'count': paid_n},
                'partial': {'count': pa['n'] or 0, 'balance': _m(pa['b'])},
                'open': {'count': op['n'] or 0, 'balance': _m(op['b'])},
            },
            'by_category': by_category,
        }

        # ?by_month=1 — a month-by-month roll-forward (Opening + Purchases − Payments
        # − Returns = Closing), chained BACKWARD from the current outstanding so the
        # latest month's closing equals it and each month's closing = next month's
        # opening. Lets the Overview page verify the books month by month. NOT
        # period-scoped — it always walks every month that has activity.
        if str(request.query_params.get('by_month', '')).lower() in ('1', 'true', 'yes'):
            from django.db.models.functions import TruncMonth

            def _mk(dt):
                return f"{dt.year:04d}-{dt.month:02d}" if dt else None
            pur, pay, ret = {}, {}, {}
            for r in bills.annotate(mm=TruncMonth('bill_date')).values('mm').annotate(t=Sum('total_amount')):
                if r['mm']:
                    pur[_mk(r['mm'])] = Decimal(str(r['t'] or 0))
            for r in pays.annotate(mm=TruncMonth('payment_date')).values('mm').annotate(t=Sum('amount')):
                if r['mm']:
                    pay[_mk(r['mm'])] = Decimal(str(r['t'] or 0))
            for r in rets.annotate(mm=TruncMonth('note_date')).values('mm').annotate(t=Sum('amount')):
                if r['mm']:
                    ret[_mk(r['mm'])] = Decimal(str(r['t'] or 0))
            months = sorted(set(pur) | set(pay) | set(ret))
            running = Decimal(str(closing))   # current outstanding = latest month's closing
            rows = []
            for mkey in reversed(months):
                p, q, r2 = pur.get(mkey, _Z), pay.get(mkey, _Z), ret.get(mkey, _Z)
                open_m = running - (p - q - r2)
                rows.append({'month': mkey, 'opening': _m(open_m), 'purchases': _m(p),
                             'payments': _m(q), 'returns': _m(r2), 'closing': _m(running)})
                running = open_m
            rows.reverse()
            # Show only the CURRENT financial year (Apr→Mar); the chain is computed over
            # all months so the first shown month's opening is still correct, but ancient
            # or mis-dated rows (e.g. a bill typed as 2016) fold into April's opening
            # instead of cluttering the table.
            fy_y = today.year if today.month >= 4 else today.year - 1
            fy_start = f"{fy_y:04d}-04"
            payload['months'] = [r for r in rows if r['month'] >= fy_start]

        return Response(payload)

    @action(detail=False, methods=['post'], url_path='bulk-payment')
    def bulk_payment(self, request):
        """Record a single vendor payment spread across MULTIPLE bills, plus
        optional advance applications — the Zoho-style "Payments Made" flow.

        Payload:
            {
              "vendor": "<uuid>",
              "payment_date": "YYYY-MM-DD",
              "payment_mode": "BANK_TRANSFER",
              "reference_no": "...",          # optional, shared across rows
              "bank_name": "...",             # "Paid Through", optional
              "notes": "...",                 # optional
              "allocations": [                # cash spread, one per bill
                  {"bill_id": "<uuid>", "amount": "264348.00"}, ...
              ],
              "advance_allocations": [        # optional, applies open advances
                  {"credit_id": "<uuid>", "bill_id": "<uuid>", "amount": "..."}
              ]
            }

        Each cash allocation becomes its own PaymentMade row (the model links
        one payment to one bill); they share reference_no/payment_date so they
        read as one payment. Everything runs in a single transaction — if any
        line is invalid the whole payment is rolled back.
        """
        from decimal import Decimal, InvalidOperation
        from django.core.exceptions import ValidationError
        from .models import VendorBill, VendorCredit, PaymentMade

        vendor_id = request.data.get('vendor')
        if not vendor_id:
            return Response({'error': 'vendor is required.'}, status=status.HTTP_400_BAD_REQUEST)

        payment_date = request.data.get('payment_date') or timezone.now().date()
        payment_mode = request.data.get('payment_mode', 'BANK_TRANSFER')
        reference_no = request.data.get('reference_no', '') or ''
        bank_name = request.data.get('bank_name', '') or ''
        notes = request.data.get('notes', '') or ''
        allocations = request.data.get('allocations') or []
        advance_allocations = request.data.get('advance_allocations') or []

        if not allocations and not advance_allocations:
            return Response({'error': 'At least one bill allocation is required.'}, status=status.HTTP_400_BAD_REQUEST)

        def _dec(v):
            try:
                return Decimal(str(v))
            except (InvalidOperation, ValueError, TypeError):
                return None

        # ── Resolve + validate every referenced bill and credit up front, and
        #    track how much each bill is being asked to absorb across BOTH the
        #    cash and advance lines so the combined total can't exceed its
        #    outstanding balance. ───────────────────────────────────────────
        # Dicts are keyed by str(id) throughout so a UUID instance and its
        # string form never collide as two different keys.
        bills = {}
        def _get_bill(bill_id):
            key = str(bill_id)
            if key in bills:
                return bills[key]
            try:
                b = VendorBill.objects.select_for_update().get(pk=bill_id, vendor_id=vendor_id)
            except (VendorBill.DoesNotExist, ValueError, ValidationError):
                return None
            bills[str(b.id)] = b
            return b

        per_bill_requested = {}   # str(bill.id) -> Decimal total (cash + advance)
        clean_cash = []           # (bill, Decimal)
        clean_adv = []            # (credit, bill, Decimal)

        for a in allocations:
            amt = _dec(a.get('amount'))
            if amt is None:
                return Response({'error': 'Invalid payment amount on a bill row.'}, status=status.HTTP_400_BAD_REQUEST)
            if amt <= 0:
                continue  # blank/zero rows are simply skipped
            bill = _get_bill(a.get('bill_id'))
            if bill is None:
                return Response({'error': f"Bill {a.get('bill_id')} not found for this vendor."}, status=status.HTTP_404_NOT_FOUND)
            key = str(bill.id)
            per_bill_requested[key] = per_bill_requested.get(key, Decimal('0')) + amt
            clean_cash.append((bill, amt))

        credits = {}
        for a in advance_allocations:
            amt = _dec(a.get('amount'))
            if amt is None:
                return Response({'error': 'Invalid advance amount on a bill row.'}, status=status.HTTP_400_BAD_REQUEST)
            if amt <= 0:
                continue
            bill = _get_bill(a.get('bill_id'))
            if bill is None:
                return Response({'error': f"Bill {a.get('bill_id')} not found for this vendor."}, status=status.HTTP_404_NOT_FOUND)
            credit_key = str(a.get('credit_id'))
            credit = credits.get(credit_key)
            if credit is None:
                try:
                    credit = VendorCredit.objects.select_for_update().get(
                        pk=a.get('credit_id'), vendor_id=vendor_id, credit_type='ADVANCE',
                    )
                except (VendorCredit.DoesNotExist, ValueError, ValidationError):
                    return Response({'error': f"Advance {a.get('credit_id')} not found for this vendor."}, status=status.HTTP_404_NOT_FOUND)
                credits[str(credit.id)] = credit
            bkey = str(bill.id)
            per_bill_requested[bkey] = per_bill_requested.get(bkey, Decimal('0')) + amt
            clean_adv.append((credit, bill, amt))

        if not clean_cash and not clean_adv:
            return Response({'error': 'Enter a payment amount on at least one bill.'}, status=status.HTTP_400_BAD_REQUEST)

        # Combined cash+advance per bill must fit within its outstanding balance.
        for bill_key, requested in per_bill_requested.items():
            bill = bills[bill_key]
            if requested > bill.balance_due:
                return Response(
                    {'error': f'Total applied to {bill.bill_no} ({requested}) exceeds its balance ({bill.balance_due}).'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        # Advance consumption per credit can't exceed its remaining balance.
        per_credit_requested = {}
        for credit, _bill, amt in clean_adv:
            ckey = str(credit.id)
            per_credit_requested[ckey] = per_credit_requested.get(ckey, Decimal('0')) + amt
        for credit_key, requested in per_credit_requested.items():
            credit = credits[credit_key]
            if requested > credit.balance:
                return Response(
                    {'error': f'Advance {credit.credit_no} applied ({requested}) exceeds its balance ({credit.balance}).'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        created_ids = []
        total_paid = Decimal('0')

        def _apply_to_bill(bill, amt):
            bill.amount_paid = bill.amount_paid + amt
            if bill.amount_paid >= bill.total_amount:
                bill.status = 'PAID'
            elif bill.amount_paid > 0:
                bill.status = 'PARTIALLY_PAID'
            bill.save(update_fields=['amount_paid', 'status'])

        with transaction.atomic():
            # Advances first, then cash — so each bill's balance reflects the
            # advance before the cash row lands (matters only for status, but
            # keeps the books tidy).
            for credit, bill, amt in clean_adv:
                credit.amount_applied = credit.amount_applied + amt
                credit.status = 'APPLIED' if credit.amount_applied >= credit.total_amount else 'OPEN'
                credit.bill = bill
                credit.save(update_fields=['amount_applied', 'status', 'bill'])
                _apply_to_bill(bill, amt)
                p = PaymentMade.objects.create(
                    vendor=bill.vendor,
                    payment_date=payment_date,
                    payment_mode='ADVANCE',
                    amount=amt,
                    reference_no=reference_no or credit.credit_no,
                    bank_name=bank_name,
                    bill=bill,
                    status='APPROVED',
                    notes=(notes + ' ' if notes else '') + f'Advance {credit.credit_no} applied to {bill.bill_no}',
                )
                created_ids.append(str(p.id))
                total_paid += amt

            for bill, amt in clean_cash:
                p = PaymentMade.objects.create(
                    vendor=bill.vendor,
                    payment_date=payment_date,
                    payment_mode=payment_mode,
                    amount=amt,
                    reference_no=reference_no,
                    bank_name=bank_name,
                    bill=bill,
                    status='APPROVED',
                    notes=notes,
                )
                _apply_to_bill(bill, amt)
                created_ids.append(str(p.id))
                total_paid += amt

        return Response(
            {
                'detail': f'Recorded {len(created_ids)} payment line(s) totalling {total_paid}.',
                'payment_ids': created_ids,
                'count': len(created_ids),
                'total_amount': str(total_paid),
            },
            status=status.HTTP_201_CREATED,
        )


class VendorCreditViewSet(viewsets.ModelViewSet):
    """ViewSet for Vendor Credits."""

    from .models import VendorCredit
    from .serializers import VendorCreditSerializer

    queryset = VendorCredit.objects.select_related('vendor', 'bill').all()
    serializer_class = VendorCreditSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Vendor Credit'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['status', 'vendor', 'credit_type']
    search_fields = ['credit_no', 'vendor__vendor_name', 'reason']
    ordering_fields = ['credit_date', 'total_amount', 'created_at']
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
    ordering = ['-credit_date', '-id']

    def get_queryset(self):
        """Scope to the global company filter (?company=<id>) via the vendor's
        company, so Vendor Notes re-scope with the rest of the app."""
        qs = super().get_queryset()
        company = self.request.query_params.get('company')
        if company:
            qs = qs.filter(vendor__company_id=company)
        return qs

    @action(detail=True, methods=['post'], url_path='apply-to-bill')
    def apply_to_bill(self, request, pk=None):
        """Apply credit to a vendor bill."""
        credit = self.get_object()
        from decimal import Decimal, InvalidOperation

        bill_id = request.data.get('bill_id')
        amount_str = request.data.get('amount', '0')
        try:
            amount = Decimal(str(amount_str))
        except (InvalidOperation, ValueError):
            return Response({'error': 'Invalid amount.'}, status=status.HTTP_400_BAD_REQUEST)

        if amount <= 0:
            return Response({'error': 'Amount must be > 0.'}, status=status.HTTP_400_BAD_REQUEST)

        if amount > credit.balance:
            return Response({'error': f'Amount exceeds credit balance ({credit.balance}).'}, status=status.HTTP_400_BAD_REQUEST)

        from .models import VendorBill
        try:
            bill = VendorBill.objects.get(pk=bill_id)
        except VendorBill.DoesNotExist:
            return Response({'error': 'Bill not found.'}, status=status.HTTP_404_NOT_FOUND)

        if amount > bill.balance_due:
            return Response({'error': f'Amount exceeds bill balance ({bill.balance_due}).'}, status=status.HTTP_400_BAD_REQUEST)

        from .models import PaymentMade

        with transaction.atomic():
            credit.amount_applied = credit.amount_applied + amount
            if credit.amount_applied >= credit.total_amount:
                credit.status = 'APPLIED'
            else:
                credit.status = 'OPEN'
            credit.bill = bill
            credit.save(update_fields=['amount_applied', 'status', 'bill'])

            bill.amount_paid = bill.amount_paid + amount
            if bill.amount_paid >= bill.total_amount:
                bill.status = 'PAID'
            elif bill.amount_paid > 0:
                bill.status = 'PARTIALLY_PAID'
            bill.save(update_fields=['amount_paid', 'status'])

            # Create PaymentMade record for tracking
            credit_type_label = credit.get_credit_type_display()
            if credit.credit_type == 'ADVANCE':
                payment_mode = 'ADVANCE'
            elif credit.credit_type == 'DEBIT':
                payment_mode = 'DEBIT'
            else:
                payment_mode = 'CREDIT'
            PaymentMade.objects.create(
                vendor=bill.vendor,
                payment_date=timezone.now().date(),
                payment_mode=payment_mode,
                amount=amount,
                reference_no=credit.credit_no,
                bill=bill,
                status='APPROVED',
                notes=f'{credit_type_label} {credit.credit_no} applied to {bill.bill_no}',
            )

        return Response(self.get_serializer(credit).data)

    @action(detail=False, methods=['get'], url_path='vendor-advances')
    def vendor_advances(self, request):
        """Get advance balance per vendor."""
        vendor_id = request.query_params.get('vendor_id')
        from .models import VendorCredit
        from django.db.models import Sum, F
        qs = VendorCredit.objects.filter(credit_type='ADVANCE', status__in=['OPEN', 'DRAFT'])
        if vendor_id:
            qs = qs.filter(vendor_id=vendor_id)
        advances = qs.values('vendor', 'vendor__vendor_name').annotate(
            total_advance=Sum('total_amount'),
            total_applied=Sum('amount_applied'),
        )
        result = []
        for a in advances:
            balance = (a['total_advance'] or 0) - (a['total_applied'] or 0)
            if balance > 0:
                result.append({
                    'vendor_id': str(a['vendor']),
                    'vendor_name': a['vendor__vendor_name'],
                    'total_advance': float(a['total_advance'] or 0),
                    'total_applied': float(a['total_applied'] or 0),
                    'balance': float(balance),
                })
        return Response(result)

    @action(detail=False, methods=['get'], url_path='available-for-bill')
    def available_for_bill(self, request):
        """Get available credits/advances/debit notes for a vendor to apply to a bill.

        Only APPROVED credits (status=OPEN) are returned — Draft credits must
        be approved on their detail page before they appear in the bill's
        Apply Debit / Apply Credit / Apply Advance modals.

        Optional `credit_type` filter (CREDIT | DEBIT | ADVANCE) scopes the
        result to a single type so the bill page can render one button per
        type without client-side filtering.
        """
        vendor_id = request.query_params.get('vendor_id')
        credit_type = request.query_params.get('credit_type')
        # bill_id is accepted but no longer used to scope down the result set;
        # kept as a parameter so existing frontend callers don't break.
        _bill_id = request.query_params.get('bill_id')  # noqa: F841
        if not vendor_id:
            return Response({'error': 'vendor_id required'}, status=400)
        from .models import VendorCredit

        credits = VendorCredit.objects.filter(
            vendor_id=vendor_id,
            status='OPEN',
        )
        if credit_type in ('CREDIT', 'DEBIT', 'ADVANCE'):
            credits = credits.filter(credit_type=credit_type)

        data = []
        for c in credits:
            balance = c.total_amount - c.amount_applied
            if balance > 0:
                data.append({
                    'id': str(c.id),
                    'credit_no': c.credit_no,
                    'credit_type': c.credit_type,
                    'credit_type_display': c.get_credit_type_display(),
                    'total_amount': float(c.total_amount),
                    'amount_applied': float(c.amount_applied),
                    'balance': float(balance),
                    'credit_date': c.credit_date.isoformat() if c.credit_date else None,
                    'linked_bill': str(c.bill_id) if c.bill_id else None,
                })
        return Response(data)


class QuoteUploadView(APIView):
    """Upload a quote document (PDF, image, Word, Excel, CSV, TXT) and extract structured data.

    POST /api/purchase/quotes/parse-upload/
    Content-Type: multipart/form-data
    Body: file=<uploaded file>

    Returns JSON with:
        - success: bool indicating if parsing succeeded
        - raw_text: the full extracted text
        - extracted: flat dict of fields (backward-compatible with frontend)
        - extracted_detailed: dict of fields with {value, confidence, source} per key
        - line_items: list of items with per-field confidence scores
        - confidence: 0-100 overall extraction quality score
        - warnings: list of warning messages
        - format: detected file format
        - pages: number of pages (for PDFs)
        - error: (optional) description of any issues
    """

    parser_classes = [MultiPartParser, FormParser]
    permission_classes = [IsAuthenticated]

    def post(self, request):
        file = request.FILES.get('file')
        if not file:
            return Response(
                {
                    'success': False,
                    'error': 'No file uploaded. Send a file with key "file".',
                    'extracted': {},
                    'extracted_detailed': {},
                    'line_items': [],
                    'warnings': [],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate file size (max 20 MB)
        max_size = 20 * 1024 * 1024
        if file.size > max_size:
            return Response(
                {
                    'success': False,
                    'error': f'File too large ({file.size} bytes). Maximum is {max_size} bytes.',
                    'extracted': {},
                    'extracted_detailed': {},
                    'line_items': [],
                    'warnings': [],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        result = QuoteParser.parse(file, file.name)

        # Return 200 even on parse errors — the frontend checks result.success / result.error
        return Response(result)


class DocumentExtractorView(APIView):
    """Extract structured data from raw text or uploaded files.

    POST /api/purchase/extract-document/
    Body (JSON):  { "text": "raw text here" }
    Body (multipart): file=<uploaded file>
    Body (multipart): file=<uploaded file> + text=<additional context>

    Returns the structured extraction schema with confidence scores.
    """
    parser_classes = [MultiPartParser, FormParser]
    permission_classes = [IsAuthenticated]

    def post(self, request):
        file = request.FILES.get('file')
        text = request.data.get('text', '') or request.POST.get('text', '')

        if file:
            # File-based: parse file first, then also run structured extraction
            file_result = QuoteParser.parse(file, file.name)
            raw_text = file_result.get('raw_text', '')
            if text:
                raw_text = text + '\n\n' + raw_text
            if not raw_text.strip():
                error_msg = file_result.get('error', 'No text could be extracted from file')
                hint = file_result.get('hint', '')
                return Response({
                    'status': 'failed',
                    'success': False,
                    'reason': error_msg,
                    'hint': hint or 'Try copying the text from the document and pasting it in the text input instead.',
                    'warnings': file_result.get('warnings', []),
                })
            structured = QuoteParser.parse_raw_text(raw_text)
            # Merge file parser data
            if structured.get('status') == 'success' and file_result.get('success'):
                structured['raw_parser']['format'] = file_result.get('format')
                structured['raw_parser']['pages'] = file_result.get('pages')
            return Response(structured)

        if text:
            result = QuoteParser.parse_raw_text(text)
            return Response(result)

        return Response({
            'status': 'failed',
            'reason': 'Provide either "text" (JSON body) or "file" (multipart upload)'
        }, status=status.HTTP_400_BAD_REQUEST)


class EvaluationDashboardView(APIView):
    """Quote Evaluation Dashboard API.

    GET  /api/purchase/evaluation-dashboard/?pr_id={uuid}
        Returns all related quote responses grouped for comparison.

    POST /api/purchase/evaluation-dashboard/submit/
        Submits evaluation decisions and optionally auto-creates a PO.
    """

    permission_classes = [IsAuthenticated]

    # ------------------------------------------------------------------
    # GET — fetch comparison data for a Purchase Request
    # ------------------------------------------------------------------
    def get(self, request):
        pr_id = request.query_params.get('pr_id')
        if not pr_id:
            return Response(
                {'error': 'pr_id query parameter is required'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            pr = PurchaseRequest.objects.select_related(
                'warehouse'
            ).prefetch_related('lines__product_service').get(pk=pr_id)
        except PurchaseRequest.DoesNotExist:
            return Response(
                {'error': 'Purchase Request not found'},
                status=status.HTTP_404_NOT_FOUND,
            )

        # ---- PR payload ------------------------------------------------
        pr_data = {
            'id': str(pr.id),
            'pr_no': pr.pr_no,
            'warehouse_name': pr.warehouse.name if pr.warehouse else '',
            'priority': pr.priority,
            'approval_status': pr.approval_status,
            'allow_rfq_skip': pr.allow_rfq_skip,
            'request_date': pr.request_date.date().isoformat() if pr.request_date else None,
            'lines': [
                {
                    'id': str(line.id),
                    'line_no': line.line_no,
                    'product_name': line.product_service.product_name if line.product_service else '',
                    'product_code': line.product_service.sku_code if line.product_service else '',
                    'quantity_requested': float(line.quantity_requested),
                    'uom': line.uom,
                }
                # Exclude products routed to "Skip RFQ" — they already have a
                # direct PO, so they must not appear in the evaluation (would
                # let the coordinator award and double-order them).
                for line in pr.lines.all()
                if not line.allow_rfq_skip
            ],
        }

        # ---- Collect all RFQs linked to this PR -------------------------
        # PR can be linked via PR.linked_rfq (FK) and via RFQHeader.linked_prs M2M
        rfq_ids = set()
        if pr.linked_rfq_id:
            rfq_ids.add(pr.linked_rfq_id)
        for rfq in RFQHeader.objects.filter(linked_prs=pr):
            rfq_ids.add(rfq.id)

        rfqs = RFQHeader.objects.filter(id__in=rfq_ids).prefetch_related(
            'quote_responses__vendor',
            'quote_responses__quote_lines__product_service',
        )

        rfq_list = []
        all_quotes_flat = []  # for the comparison block

        for rfq in rfqs:
            quotes_payload = []
            for quote in rfq.quote_responses.filter(is_active=True):
                lines_payload = []
                quote_total = 0
                for ql in quote.quote_lines.all():
                    lt = float(ql.get_line_total())
                    quote_total += lt
                    lines_payload.append({
                        'id': str(ql.id),
                        'product_name': ql.product_service.product_name if ql.product_service else '',
                        'product_code': ql.product_service.sku_code if ql.product_service else '',
                        'quantity_offered': float(ql.quantity_offered),
                        'uom': ql.uom,
                        'unit_price': float(ql.unit_price),
                        'gst': float(ql.gst),
                        'discount': float(ql.discount),
                        'total': lt,
                    })

                quote_data = {
                    'id': str(quote.id),
                    'quote_id': quote.quote_id,
                    'vendor_name': quote.vendor.vendor_name if quote.vendor else '',
                    'vendor_id': str(quote.vendor_id) if quote.vendor_id else None,
                    'quote_date': quote.quote_date.isoformat() if quote.quote_date else None,
                    'currency': quote.currency,
                    'payment_terms': quote.payment_terms,
                    'delivery_terms': quote.delivery_terms,
                    'lead_time_days': quote.lead_time_days,
                    'chosen_flag': quote.chosen_flag,
                    'evaluation_score': float(quote.evaluation_score) if quote.evaluation_score else None,
                    'total_cost': round(quote_total, 2),
                    'lines': lines_payload,
                }
                quotes_payload.append(quote_data)
                all_quotes_flat.append(quote_data)

            rfq_list.append({
                'id': str(rfq.id),
                'rfq_no': rfq.rfq_no,
                'rfq_status': rfq.rfq_status,
                'quotes': quotes_payload,
            })

        # ---- Comparison block -------------------------------------------
        comparison = self._build_comparison(pr_data, all_quotes_flat)

        # ---- Per-product converted status (independent evaluation) ------
        # A product whose awarded quote line is already on an active PO is
        # "converted" and gets locked in the UI; the rest stay open to be
        # evaluated/converted later. Evaluation is fully done only once every
        # product is converted.
        converted_ql = {}  # quote_line_id (str) -> po_no
        for pol in POLine.objects.filter(
            po__is_active=True,
            linked_rfq_line__quote__rfq_id__in=rfq_ids,
        ).select_related('po'):
            if pol.linked_rfq_line_id:
                converted_ql[str(pol.linked_rfq_line_id)] = pol.po.po_no
        _products = comparison.get('products', [])
        _conv_count = 0
        for prod in _products:
            conv_po = conv_vendor = None
            for vp in prod.get('vendor_prices', []):
                qlid = vp.get('quote_line_id')
                if qlid and str(qlid) in converted_ql:
                    conv_po = converted_ql[str(qlid)]
                    conv_vendor = vp.get('vendor_name')
                    break
            prod['converted'] = bool(conv_po)
            prod['converted_po_no'] = conv_po or ''
            prod['converted_vendor'] = conv_vendor or ''
            if conv_po:
                _conv_count += 1
        comparison['converted_count'] = _conv_count
        comparison['all_converted'] = bool(_products) and _conv_count == len(_products)

        # ---- POs already created for this PR/RFQ (so the page can offer
        # "Send" even after a reload, and enable the bottom Send button).
        _po_ids = set(
            POLine.objects.filter(
                po__is_active=True,
                linked_rfq_line__quote__rfq_id__in=rfq_ids,
            ).values_list('po_id', flat=True)
        )
        pos_out = []
        for p in PurchaseOrder.objects.filter(id__in=_po_ids).select_related('vendor'):
            pos_out.append({
                'id': str(p.id),
                'po_no': p.po_no,
                'vendor_name': p.vendor.vendor_name if p.vendor_id else '',
                'total_amount': float(p.get_total_order_value()),
                'status': p.status,
            })

        # ---- Evaluation lock: block until every invited vendor's quote is in.
        locked = False
        locked_reason = ''
        for rfq in rfqs:
            if not rfq.is_fully_quoted():
                locked = True
                locked_reason = (
                    f'{rfq.rfq_no}: only {rfq.get_active_quote_count()} of '
                    f'{rfq.get_invited_vendor_count()} quotes recorded. Record all '
                    'vendor quotes before evaluating.'
                )
                break

        return Response({
            'pr': pr_data,
            'rfqs': rfq_list,
            'comparison': comparison,
            'pos': pos_out,
            'locked': locked,
            'locked_reason': locked_reason,
        })

    @staticmethod
    def _build_comparison(pr_data, all_quotes):
        """Build a product-level price comparison across all vendors."""
        if not all_quotes:
            return {
                'total_vendors': 0,
                'lowest_total': None,
                'products': [],
            }

        # Build comparison data — keyed by quote_id (not vendor_id)
        # so multiple quotes from the same vendor each get their own column
        comparison_products = []
        all_quotes_map = {}  # quote_uuid -> quote_info

        for quote_data in all_quotes:
            qkey = quote_data['id']  # use quote UUID as unique key
            if qkey not in all_quotes_map:
                all_quotes_map[qkey] = {
                    'vendor_name': quote_data['vendor_name'],
                    'vendor_id': quote_data['vendor_id'],
                    'quote_id': quote_data['quote_id'],
                    'quote_uuid': quote_data['id'],
                    'total_cost': quote_data['total_cost'],
                    'payment_terms': quote_data.get('payment_terms', ''),
                    'delivery_terms': quote_data.get('delivery_terms', ''),
                    'lead_time_days': quote_data.get('lead_time_days', 0),
                    'currency': quote_data.get('currency', 'INR'),
                    'lines': quote_data.get('lines', []),
                }

        # For each PR line item, build vendor price comparison (per quote)
        for pr_line in pr_data['lines']:
            product_comparison = {
                'product_name': pr_line['product_name'],
                'product_code': pr_line.get('product_code', ''),
                'requested_qty': pr_line['quantity_requested'],
                'uom': pr_line.get('uom', ''),
                'vendor_prices': [],
            }

            best_price = None
            best_vendor = None

            for qkey, quote_info in all_quotes_map.items():
                # Match the vendor's quote line to THIS product. A vendor may
                # quote only a subset of the PR's products; unquoted products
                # must stay BLANK — never bleed another line's price in.
                matching_line = None
                for ql in quote_info['lines']:
                    if (ql.get('product_code') == pr_line.get('product_code') or
                            ql.get('product_name') == pr_line['product_name']):
                        matching_line = ql
                        break

                if matching_line:
                    unit_price = float(matching_line.get('unit_price', 0))
                    qty = float(matching_line.get('quantity_offered', pr_line['quantity_requested']))
                    gst = float(matching_line.get('gst', 0))
                    total = unit_price * qty
                    vendor_price = {
                        'vendor_name': quote_info['vendor_name'],
                        'vendor_id': quote_info['vendor_id'],
                        'quote_id': quote_info['quote_id'],
                        'quote_uuid': quote_info['quote_uuid'],
                        'quote_line_id': matching_line.get('id'),
                        'unit_price': round(unit_price, 2),
                        'quantity': qty,
                        'gst': gst,
                        'total': round(total, 2),
                        'delivery_days': quote_info.get('lead_time_days', 0),
                        'payment_terms': quote_info.get('payment_terms', ''),
                        'quoted': True,
                        'has_line_detail': True,
                    }
                    if best_price is None or total < best_price:
                        best_price = total
                        best_vendor = quote_info['vendor_name']
                else:
                    # Vendor did not quote this product → blank cell, not eligible.
                    vendor_price = {
                        'vendor_name': quote_info['vendor_name'],
                        'vendor_id': quote_info['vendor_id'],
                        'quote_id': quote_info['quote_id'],
                        'quote_uuid': quote_info['quote_uuid'],
                        'quote_line_id': None,
                        'unit_price': None,
                        'quantity': None,
                        'gst': None,
                        'total': None,
                        # A vendor that didn't quote this product has no terms
                        # for it either — keep the whole cell blank (no bleed of
                        # their quote-level payment/delivery onto this product).
                        'delivery_days': None,
                        'payment_terms': '',
                        'quoted': False,
                        'has_line_detail': False,
                    }
                product_comparison['vendor_prices'].append(vendor_price)

            product_comparison['best_price_vendor'] = best_vendor
            comparison_products.append(product_comparison)

        # Lowest total across all quotes
        lowest = min(all_quotes, key=lambda q: q['total_cost'])

        # Count unique vendors (not quotes) for total_vendors stat
        unique_vendor_ids = {q['vendor_id'] for q in all_quotes}

        return {
            'total_vendors': len(unique_vendor_ids),
            'lowest_total': {
                'vendor_name': lowest['vendor_name'],
                'amount': lowest['total_cost'],
            },
            'products': comparison_products,
        }


class EvaluationDashboardSubmitView(APIView):
    """Submit evaluation decisions and optionally auto-create a PO.

    POST /api/purchase/evaluation-dashboard/submit/
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        pr_id = request.data.get('pr_id')
        # `awards` = the winning quote-line ids, one per product (per-product
        # award). Each product can be awarded to a different vendor.
        award_ids = request.data.get('awards', [])
        generate_po = request.data.get('generate_po', False)

        # ---------- basic validation ----------
        if not pr_id:
            return Response(
                {'error': 'pr_id is required'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not award_ids:
            return Response(
                {'error': 'Award at least one product to a vendor before submitting.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            pr = PurchaseRequest.objects.select_related('warehouse').get(pk=pr_id)
        except PurchaseRequest.DoesNotExist:
            return Response(
                {'error': 'Purchase Request not found'},
                status=status.HTTP_404_NOT_FOUND,
            )

        # ---------- evaluation lock: every invited vendor's quote must be in ----
        _rfq_ids = set()
        if pr.linked_rfq_id:
            _rfq_ids.add(pr.linked_rfq_id)
        for _r in RFQHeader.objects.filter(linked_prs=pr):
            _rfq_ids.add(_r.id)
        for _r in RFQHeader.objects.filter(id__in=_rfq_ids):
            if not _r.is_fully_quoted():
                return Response(
                    {'error': (
                        f'{_r.rfq_no}: only {_r.get_active_quote_count()} of '
                        f'{_r.get_invited_vendor_count()} quotes recorded. Record all '
                        'vendor quotes before evaluating.'
                    )},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # ---------- resolve the awarded quote lines ----------
        awarded_lines = list(
            QuoteLine.objects.select_related(
                'quote__vendor', 'quote__rfq',
                'pr_line', 'product_service', 'service_catalogue',
            ).filter(id__in=award_ids)
        )
        found = {str(ql.id) for ql in awarded_lines}
        missing = [a for a in award_ids if str(a) not in found]
        if missing:
            return Response(
                {'error': f'Awarded quote line(s) not found: {", ".join(map(str, missing))}'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Every awarded line must belong to an RFQ linked to this PR.
        for ql in awarded_lines:
            if ql.quote.rfq_id not in _rfq_ids:
                return Response(
                    {'error': 'An awarded quote does not belong to an RFQ linked to this PR.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # One award per product — reject a product awarded to two vendors.
        seen_products = set()
        for ql in awarded_lines:
            key = (ql.pr_line_id or ql.product_service_id
                   or ql.service_catalogue_id)
            if key in seen_products:
                return Response(
                    {'error': 'Each product can be awarded to only one vendor.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            seen_products.add(key)

        involved_rfq_ids = {ql.quote.rfq_id for ql in awarded_lines}
        winning_quote_ids = {ql.quote_id for ql in awarded_lines}

        with transaction.atomic():
            # 1. Reset awards across the involved RFQs, then flag the winners.
            QuoteLine.objects.filter(
                quote__rfq_id__in=involved_rfq_ids
            ).update(is_awarded=False)
            QuoteLine.objects.filter(
                id__in=[ql.id for ql in awarded_lines]
            ).update(is_awarded=True)

            # 2. Winning vendors' quotes → chosen_flag; clear the rest.
            QuoteResponse.objects.filter(
                rfq_id__in=involved_rfq_ids, is_active=True
            ).update(chosen_flag=False)
            QuoteResponse.objects.filter(id__in=winning_quote_ids).update(chosen_flag=True)

            # 3. One audit QuoteEvaluation per involved RFQ (per-product detail
            #    lives on QuoteLine.is_awarded).
            stakeholder = getattr(request.user, 'stakeholder_profile', None)
            for rfq in RFQHeader.objects.filter(id__in=involved_rfq_ids):
                rfq_winners = [ql for ql in awarded_lines if ql.quote.rfq_id == rfq.id]
                counts = {}
                for ql in rfq_winners:
                    counts[ql.quote.vendor] = counts.get(ql.quote.vendor, 0) + 1
                top_vendor = max(counts, key=counts.get) if counts else None
                ev_obj = QuoteEvaluation(
                    rfq=rfq,
                    best_quote_flag=True,
                    recommended_vendor=top_vendor,
                    justification_notes='Per-product award',
                    approval_status='APPROVED',
                )
                if stakeholder:
                    ev_obj.evaluated_by = stakeholder
                ev_obj.save()

            # 4. Optionally create ONE PO per awarded vendor (clubbing).
            pos_data = []
            if generate_po:
                # Idempotency: skip awarded lines already on an active PO
                # (matched by the quote line that produced them).
                already = set(
                    POLine.objects.filter(
                        po__is_active=True,
                        linked_rfq_line__in=[ql.id for ql in awarded_lines],
                    ).values_list('linked_rfq_line_id', flat=True)
                )
                # Also skip any awarded line whose PR line was routed to
                # "Skip RFQ" (absolute — it goes to a direct PO, never here)
                # or whose requested quantity is already FULLY covered by
                # active PO lines — awarding those would double-order. A
                # PARTIALLY covered line stays awardable so a follow-up PO
                # can be cut for the remainder.
                awarded_pr_line_ids = {ql.pr_line_id for ql in awarded_lines if ql.pr_line_id}
                skip_pr_line_ids = {
                    ql.pr_line_id for ql in awarded_lines
                    if ql.pr_line_id and getattr(ql.pr_line, 'allow_rfq_skip', False)
                }
                if awarded_pr_line_ids:
                    from django.db.models import Sum
                    ordered_totals = {
                        row['linked_pr_line_id']: row['total']
                        for row in POLine.objects.filter(
                            po__is_active=True,
                            linked_pr_line_id__in=awarded_pr_line_ids,
                        ).values('linked_pr_line_id').annotate(
                            total=Sum('quantity_ordered')
                        )
                    }
                    for ql in awarded_lines:
                        if not ql.pr_line_id:
                            continue
                        ordered = ordered_totals.get(ql.pr_line_id) or Decimal('0')
                        requested = ql.pr_line.quantity_requested or Decimal('0')
                        if ordered >= requested:
                            skip_pr_line_ids.add(ql.pr_line_id)
                fresh = [
                    ql for ql in awarded_lines
                    if ql.id not in already
                    and not (ql.pr_line_id and ql.pr_line_id in skip_pr_line_ids)
                ]
                by_vendor = {}
                for ql in fresh:
                    by_vendor.setdefault(ql.quote.vendor_id, []).append(ql)
                for _vid, lines in by_vendor.items():
                    po = self._create_po_for_vendor(lines, pr, request.user)
                    pos_data.append({
                        'id': str(po.id),
                        'po_no': po.po_no,
                        'vendor_name': po.vendor.vendor_name if po.vendor else '',
                        'total_amount': float(po.get_total_order_value()),
                        'status': po.status,
                    })

            # 5. Audit log.
            AuditLog.objects.create(
                user=request.user,
                role_name=get_user_role_name(request.user),
                module_name='Quote Evaluation',
                action='CREATE',
                details=(
                    f'Per-product evaluation for PR {pr.pr_no}: '
                    f'{len(awarded_lines)} product(s) awarded to '
                    f'{len(winning_quote_ids)} vendor(s); {len(pos_data)} PO(s) created.'
                ),
            )

        return Response({
            'success': True,
            'message': (
                f'{len(awarded_lines)} product(s) awarded.'
                + (f' {len(pos_data)} PO(s) created & ready to send.' if pos_data else '')
            ),
            'awarded_count': len(awarded_lines),
            'vendor_count': len(winning_quote_ids),
            'pos': pos_data,
        }, status=status.HTTP_201_CREATED)

    @staticmethod
    def _create_po_for_vendor(lines, pr, user):
        """Create ONE PurchaseOrder for the vendor of these awarded quote
        lines (all share a vendor). Only the awarded products go on the PO;
        terms come from the vendor's own quote. Uses the PO model's
        auto-numbering in save().
        """
        first_quote = lines[0].quote
        warehouse = pr.warehouse
        # Prefer the PR's persisted company; fall back to warehouse.company.
        company = pr.company if pr.company_id else (warehouse.company if warehouse else None)

        po = PurchaseOrder(
            vendor=first_quote.vendor,
            company=company,
            warehouse=warehouse,
            linked_rfq=first_quote.rfq,
            freight_terms=first_quote.freight_terms,
            payment_terms=first_quote.payment_terms,
            currency=first_quote.currency,
            terms_and_conditions='',
            status='DRAFT',
            created_by=user,
        )
        po.save()

        line_no = 1
        for ql in lines:
            POLine.objects.create(
                po=po,
                line_no=line_no,
                product_service=ql.product_service,
                service_catalogue=ql.service_catalogue,
                description=ql.specification,
                quantity_ordered=ql.quantity_offered,
                uom=ql.uom,
                unit_price=ql.unit_price,
                discount=ql.discount,
                gst=ql.gst,
                freight_estimate=ql.freight_charge,
                linked_pr_line=ql.pr_line,
                linked_rfq_line=ql,
                # Materialise category from PR line so Receipt-side routing
                # has it; empty when ql.pr_line is null (legacy quote lines).
                category=(ql.pr_line.category if ql.pr_line_id and ql.pr_line else ''),
            )
            line_no += 1

        # Link the PR(s) to the PO.
        po.linked_prs.add(pr)
        for linked_pr in first_quote.rfq.linked_prs.all():
            po.linked_prs.add(linked_pr)

        return po


# ──────────────────────────────────────────────────────────────
#  Purchase Flow Lifecycle Graph API
# ──────────────────────────────────────────────────────────────

class PurchaseLifecycleGraphView(APIView):
    """Returns the complete lifecycle graph for a Purchase Request.

    GET /api/purchase/lifecycle-graph/?pr_id={uuid}
    GET /api/purchase/lifecycle-graph/?pr_no={PR-2026-00001}
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        pr_id = request.query_params.get('pr_id')
        pr_no = request.query_params.get('pr_no')

        if not pr_id and not pr_no:
            return Response({'error': 'pr_id or pr_no is required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            if pr_id:
                pr = PurchaseRequest.objects.select_related(
                    'warehouse', 'requested_by__user', 'approved_by'
                ).prefetch_related('lines__product_service', 'approval_trails__actor__user').get(pk=pr_id)
            else:
                pr = PurchaseRequest.objects.select_related(
                    'warehouse', 'requested_by__user', 'approved_by'
                ).prefetch_related('lines__product_service', 'approval_trails__actor__user').get(pr_no=pr_no)
        except PurchaseRequest.DoesNotExist:
            return Response({'error': 'Purchase Request not found'}, status=status.HTTP_404_NOT_FOUND)

        nodes = []
        edges = []
        timeline = []
        kpis = {'total_ordered_value': 0, 'total_received_qty': 0, 'total_billed': 0, 'total_paid': 0,
                'pending_approvals': 0, 'pending_receipts': 0, 'pending_payments': 0}
        anomalies = []

        # ── 1. PR NODE ─────────────────────────────────────────
        pr_data = {
            'id': f'pr-{pr.id}', 'type': 'pr', 'label': pr.pr_no,
            'status': pr.approval_status,
            'date': pr.request_date.isoformat() if pr.request_date else None,
            'data': {
                'warehouse': pr.warehouse.name if pr.warehouse else '',
                'priority': pr.priority,
                'requested_by': pr.requested_by.user.get_full_name() if pr.requested_by and pr.requested_by.user else '',
                'approved_by': pr.approved_by.get_full_name() if pr.approved_by else '',
                'approved_at': pr.approved_at.isoformat() if pr.approved_at else None,
                'required_by': pr.required_by_date.isoformat() if pr.required_by_date else None,
                'justification': pr.justification or '',
                'items': [{
                    'product': l.product_service.product_name if l.product_service else '',
                    'qty': float(l.quantity_requested), 'uom': l.uom,
                    'status': l.status,
                } for l in pr.lines.all()],
                'approvals': [{
                    'action': a.action,
                    'actor': a.actor.user.get_full_name() if a.actor and a.actor.user else '',
                    'date': a.action_date.isoformat() if a.action_date else None,
                    'remarks': a.remarks or '',
                } for a in pr.approval_trails.all()],
            },
        }
        nodes.append(pr_data)
        _pr_created_by = pr_data['data']['requested_by']
        timeline.append({'date': pr_data['date'], 'label': f'{pr.pr_no} created', 'type': 'pr',
                         'status': pr.approval_status, 'actor': _pr_created_by})
        # Separate approval event on the timeline (who approved + when), so the
        # flow shows not just "created" but who signed it off.
        if pr.approved_by and pr.approved_at:
            timeline.append({
                'date': pr.approved_at.isoformat(),
                'label': f'{pr.pr_no} approved',
                'type': 'pr', 'status': 'APPROVED',
                'actor': pr_data['data']['approved_by'],
            })

        if pr.approval_status in ('DRAFT', 'PENDING', 'PENDING_APPROVAL'):
            kpis['pending_approvals'] += 1

        # ── 2. RFQ NODES ───────────────────────────────────────
        rfq_ids = set()
        if pr.linked_rfq_id:
            rfq_ids.add(pr.linked_rfq_id)
        for rfq in RFQHeader.objects.filter(linked_prs=pr):
            rfq_ids.add(rfq.id)

        rfqs = RFQHeader.objects.filter(id__in=rfq_ids).prefetch_related(
            'quote_responses__vendor', 'quote_responses__quote_lines__product_service',
            'evaluations__recommended_vendor', 'evaluations__comparison_entries__vendor',
        )

        if pr.approval_status == 'APPROVED' and not rfq_ids:
            anomalies.append({'type': 'missing_step', 'message': 'PR approved but no RFQ created', 'severity': 'warning'})

        for rfq in rfqs:
            rfq_node_id = f'rfq-{rfq.id}'
            nodes.append({
                'id': rfq_node_id, 'type': 'rfq', 'label': rfq.rfq_no,
                'status': rfq.rfq_status,
                'date': rfq.creation_date.isoformat() if rfq.creation_date else None,
                'data': {
                    'mode': rfq.rfq_mode, 'quote_count': rfq.get_active_quote_count(),
                    'expected_quotes': rfq.quote_count_expected,
                },
            })
            edges.append({'from': pr_data['id'], 'to': rfq_node_id, 'label': 'RFQ Created'})
            timeline.append({'date': rfq.creation_date.isoformat() if rfq.creation_date else None,
                             'label': f'{rfq.rfq_no} created', 'type': 'rfq', 'status': rfq.rfq_status})

            # ── 3. QUOTE NODES ──────────────────────────────────
            for quote in rfq.quote_responses.filter(is_active=True):
                q_node_id = f'quote-{quote.id}'
                quote_total = sum(float(ql.get_line_total()) for ql in quote.quote_lines.all())
                nodes.append({
                    'id': q_node_id, 'type': 'quote', 'label': quote.quote_id,
                    'status': 'CHOSEN' if quote.chosen_flag else 'RECEIVED',
                    'date': quote.quote_date.isoformat() if quote.quote_date else None,
                    'data': {
                        'vendor': quote.vendor.vendor_name if quote.vendor else '',
                        'total': round(quote_total, 2),
                        'payment_terms': quote.payment_terms or '',
                        'lead_time': quote.lead_time_days,
                        'chosen': quote.chosen_flag,
                        'lines': [{
                            'product': ql.product_service.product_name if ql.product_service else '',
                            'qty': float(ql.quantity_offered), 'price': float(ql.unit_price),
                            'total': float(ql.get_line_total()),
                        } for ql in quote.quote_lines.all()],
                    },
                })
                edges.append({'from': rfq_node_id, 'to': q_node_id, 'label': quote.vendor.vendor_name if quote.vendor else 'Quote'})

            # ── 4. EVALUATION NODES ─────────────────────────────
            for ev in rfq.evaluations.all():
                ev_node_id = f'eval-{ev.id}'
                nodes.append({
                    'id': ev_node_id, 'type': 'evaluation', 'label': ev.evaluation_id,
                    'status': ev.approval_status,
                    'date': ev.evaluation_date.isoformat() if ev.evaluation_date else None,
                    'data': {
                        'recommended_vendor': ev.recommended_vendor.vendor_name if ev.recommended_vendor else '',
                        'justification': ev.justification_notes or '',
                        'comparisons': [{
                            'vendor': c.vendor.vendor_name if c.vendor else '',
                            'total_cost': float(c.total_cost), 'score': float(c.score),
                            'lead_time': c.lead_time,
                        } for c in ev.comparison_entries.all()],
                    },
                })
                edges.append({'from': rfq_node_id, 'to': ev_node_id, 'label': 'Evaluated'})

        # ── 5. PO NODES ────────────────────────────────────────
        pos = PurchaseOrder.objects.filter(linked_prs=pr).select_related(
            'vendor', 'warehouse', 'transporter'
        ).prefetch_related('po_lines__product_service')

        if pr.approval_status == 'APPROVED' and rfq_ids and not pos.exists():
            anomalies.append({'type': 'missing_step', 'message': 'RFQ exists but no PO created', 'severity': 'warning'})

        for po in pos:
            po_node_id = f'po-{po.id}'
            po_total = float(po.get_total_order_value())
            kpis['total_ordered_value'] += po_total
            nodes.append({
                'id': po_node_id, 'type': 'po', 'label': po.po_no,
                'status': po.status,
                'date': po.po_date.isoformat() if po.po_date else None,
                'data': {
                    'vendor': po.vendor.vendor_name if po.vendor else '',
                    'warehouse': po.warehouse.name if po.warehouse else '',
                    'total_value': round(po_total, 2),
                    'payment_terms': po.payment_terms or '',
                    'expected_delivery': po.expected_delivery_end.isoformat() if po.expected_delivery_end else None,
                    'is_fully_received': po.is_fully_received(),
                    'lines': [{
                        'product': pl.product_service.product_name if pl.product_service else '',
                        'qty_ordered': float(pl.quantity_ordered),
                        'unit_price': float(pl.unit_price), 'uom': pl.uom,
                    } for pl in po.po_lines.all()],
                },
            })
            # Link PO to RFQ or directly to PR
            linked = False
            if po.linked_rfq_id and f'rfq-{po.linked_rfq_id}' in [n['id'] for n in nodes]:
                edges.append({'from': f'rfq-{po.linked_rfq_id}', 'to': po_node_id, 'label': 'PO Created'})
                linked = True
            if not linked:
                edges.append({'from': pr_data['id'], 'to': po_node_id, 'label': 'PO Created'})
            timeline.append({'date': po.po_date.isoformat() if po.po_date else None,
                             'label': f'{po.po_no} ({po.vendor.vendor_name if po.vendor else ""})', 'type': 'po', 'status': po.status})

            if po.status in ('APPROVED', 'ISSUED') and not po.is_fully_received():
                kpis['pending_receipts'] += 1

            # ── 6. RECEIPT / GRN NODES ──────────────────────────
            receipts = po.receipt_advices.select_related('vendor', 'warehouse').prefetch_related(
                'receipt_lines__product', 'freight_advices__transporter',
            )
            for ra in receipts.all():
                ra_node_id = f'grn-{ra.id}'
                total_rcvd = float(ra.get_total_received())
                kpis['total_received_qty'] += total_rcvd
                # Avoid duplicate nodes if receipt is linked to multiple POs
                if not any(n['id'] == ra_node_id for n in nodes):
                    nodes.append({
                        'id': ra_node_id, 'type': 'grn', 'label': ra.receipt_advice_no,
                        'status': ra.qc_status or ('PARTIAL' if ra.partial_receipt_flag else 'RECEIVED'),
                        'date': ra.receipt_date.isoformat() if ra.receipt_date else None,
                        'data': {
                            'vendor': ra.vendor.vendor_name if ra.vendor else '',
                            'warehouse': ra.warehouse.name if ra.warehouse else '',
                            'total_received': total_rcvd,
                            'qc_status': ra.qc_status, 'partial': ra.partial_receipt_flag,
                            'vehicle': ra.vehicle_number or '',
                            'lines': [{
                                'product': rl.product.product_name if rl.product else '',
                                'qty_received': float(rl.quantity_received), 'uom': rl.uom,
                                'batch': rl.batch_no or '',
                            } for rl in ra.receipt_lines.all()],
                        },
                    })
                    timeline.append({'date': ra.receipt_date.isoformat() if ra.receipt_date else None,
                                     'label': f'{ra.receipt_advice_no} received', 'type': 'grn', 'status': ra.qc_status or 'RECEIVED'})
                edges.append({'from': po_node_id, 'to': ra_node_id, 'label': 'Received'})

                # ── 7. FREIGHT NODES ────────────────────────────
                for fa in ra.freight_advices.filter(is_active=True):
                    fa_node_id = f'freight-{fa.id}'
                    if not any(n['id'] == fa_node_id for n in nodes):
                        nodes.append({
                            'id': fa_node_id, 'type': 'freight', 'label': fa.advice_no,
                            'status': fa.status,
                            'date': fa.created_date.isoformat() if fa.created_date else None,
                            'data': {
                                'transporter': fa.transporter.name if fa.transporter else '',
                                'amount': float(fa.payable_amount), 'freight_terms': fa.freight_terms,
                                'lorry': fa.lorry_no or '',
                            },
                        })
                        timeline.append({'date': fa.created_date.isoformat() if fa.created_date else None,
                                         'label': f'{fa.advice_no}', 'type': 'freight', 'status': fa.status})
                    edges.append({'from': ra_node_id, 'to': fa_node_id, 'label': 'Freight'})

                # ── 8. VENDOR BILL from Receipt ─────────────────
                for bill in VendorBill.objects.filter(receipt_advice=ra, is_active=True):
                    bill_node_id = f'bill-{bill.id}'
                    if not any(n['id'] == bill_node_id for n in nodes):
                        kpis['total_billed'] += float(bill.total_amount)
                        nodes.append({
                            'id': bill_node_id, 'type': 'bill', 'label': bill.bill_no,
                            'status': bill.status,
                            'date': bill.bill_date.isoformat() if bill.bill_date else None,
                            'data': {
                                'vendor': bill.vendor.vendor_name if bill.vendor else '',
                                'invoice_no': bill.vendor_invoice_no or '',
                                'total': float(bill.total_amount), 'paid': float(bill.amount_paid),
                                'due_date': bill.due_date.isoformat() if bill.due_date else None,
                            },
                        })
                        timeline.append({'date': bill.bill_date.isoformat() if bill.bill_date else None,
                                         'label': f'{bill.bill_no}', 'type': 'bill', 'status': bill.status})
                    edges.append({'from': ra_node_id, 'to': bill_node_id, 'label': 'Billed'})
                    self._add_payment_nodes(bill, bill_node_id, nodes, edges, timeline, kpis)

            # ── 8b. VENDOR BILL from PO (no receipt link) ───────
            for bill in VendorBill.objects.filter(purchase_order=po, is_active=True):
                bill_node_id = f'bill-{bill.id}'
                if not any(n['id'] == bill_node_id for n in nodes):
                    kpis['total_billed'] += float(bill.total_amount)
                    nodes.append({
                        'id': bill_node_id, 'type': 'bill', 'label': bill.bill_no,
                        'status': bill.status,
                        'date': bill.bill_date.isoformat() if bill.bill_date else None,
                        'data': {
                            'vendor': bill.vendor.vendor_name if bill.vendor else '',
                            'invoice_no': bill.vendor_invoice_no or '',
                            'total': float(bill.total_amount), 'paid': float(bill.amount_paid),
                            'due_date': bill.due_date.isoformat() if bill.due_date else None,
                        },
                    })
                    timeline.append({'date': bill.bill_date.isoformat() if bill.bill_date else None,
                                     'label': f'{bill.bill_no}', 'type': 'bill', 'status': bill.status})
                    edges.append({'from': po_node_id, 'to': bill_node_id, 'label': 'Billed'})
                    self._add_payment_nodes(bill, bill_node_id, nodes, edges, timeline, kpis)

        # ── Anomalies ──────────────────────────────────────────
        if kpis['total_billed'] > 0 and kpis['total_paid'] < kpis['total_billed']:
            kpis['pending_payments'] = round(kpis['total_billed'] - kpis['total_paid'], 2)

        # Sort timeline by date, then by lifecycle stage order
        _stage_order = {'pr': 0, 'rfq': 1, 'quote': 2, 'evaluation': 3, 'po': 4, 'grn': 5, 'freight': 6, 'bill': 7, 'payment': 8, 'credit': 9}
        timeline.sort(key=lambda t: (t.get('date') or '', _stage_order.get(t.get('type'), 99)))

        # ── Status funnel ───────────────────────────────────────
        funnel = [
            {'stage': 'Purchase Request', 'status': pr.approval_status, 'done': pr.approval_status == 'APPROVED'},
            {'stage': 'RFQ Sent', 'status': 'DONE' if rfq_ids else 'PENDING', 'done': bool(rfq_ids)},
            {'stage': 'Quotes Received', 'status': 'DONE' if any(n['type'] == 'quote' for n in nodes) else 'PENDING',
             'done': any(n['type'] == 'quote' for n in nodes)},
            {'stage': 'PO Created', 'status': 'DONE' if pos.exists() else 'PENDING', 'done': pos.exists()},
            {'stage': 'Goods Received', 'status': 'DONE' if any(n['type'] == 'grn' for n in nodes) else 'PENDING',
             'done': any(n['type'] == 'grn' for n in nodes)},
            {'stage': 'Billed', 'status': 'DONE' if any(n['type'] == 'bill' for n in nodes) else 'PENDING',
             'done': any(n['type'] == 'bill' for n in nodes)},
            {'stage': 'Paid', 'status': 'DONE' if any(n['type'] == 'payment' for n in nodes) else 'PENDING',
             'done': any(n['type'] == 'payment' for n in nodes)},
        ]

        return Response({
            'pr': {'id': str(pr.id), 'pr_no': pr.pr_no, 'status': pr.approval_status},
            'nodes': nodes,
            'edges': edges,
            'timeline': timeline,
            'funnel': funnel,
            'kpis': kpis,
            'anomalies': anomalies,
        })

    @staticmethod
    def _add_payment_nodes(bill, bill_node_id, nodes, edges, timeline, kpis):
        """Add payment and credit nodes for a bill."""
        for pay in PaymentMade.objects.filter(bill=bill, is_active=True):
            pay_node_id = f'payment-{pay.id}'
            if not any(n['id'] == pay_node_id for n in nodes):
                kpis['total_paid'] += float(pay.amount)
                nodes.append({
                    'id': pay_node_id, 'type': 'payment', 'label': pay.payment_no,
                    'status': pay.status,
                    'date': pay.payment_date.isoformat() if pay.payment_date else None,
                    'data': {
                        'amount': float(pay.amount), 'mode': pay.payment_mode,
                        'reference': pay.reference_no or '',
                    },
                })
                timeline.append({'date': pay.payment_date.isoformat() if pay.payment_date else None,
                                 'label': f'{pay.payment_no}', 'type': 'payment', 'status': pay.status})
            edges.append({'from': bill_node_id, 'to': pay_node_id, 'label': 'Paid'})

        for cr in VendorCredit.objects.filter(bill=bill, is_active=True):
            cr_node_id = f'credit-{cr.id}'
            if not any(n['id'] == cr_node_id for n in nodes):
                nodes.append({
                    'id': cr_node_id, 'type': 'credit', 'label': cr.credit_no,
                    'status': cr.status,
                    'date': cr.credit_date.isoformat() if cr.credit_date else None,
                    'data': {
                        'type': cr.credit_type, 'amount': float(cr.total_amount),
                        'reason': cr.reason or '',
                    },
                })
            edges.append({'from': bill_node_id, 'to': cr_node_id, 'label': cr.credit_type})


class PurchaseAttachmentViewSet(viewsets.ModelViewSet):
    """ViewSet for uploading, listing, and deleting attachments for any purchase document."""

    serializer_class = PurchaseAttachmentSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    parser_classes = [MultiPartParser, FormParser]

    # Attachment access is gated by the parent purchase document's module:
    # the `module` code on the request maps to its ERPModule name and
    # HasModulePermission enforces the user's role rights on it. Unknown
    # codes resolve to None, which HasModulePermission treats as ungated
    # (no regression for any module not listed here).
    _MODULE_TO_ERP = {
        'PR': 'Purchase Request', 'RFQ': 'RFQ', 'QUOTE': 'Quote',
        'EVALUATION': 'Quote Evaluation', 'PO': 'Purchase Order',
        'RECEIPT': 'Receipt Advice', 'FREIGHT': 'Freight Advice',
        'BILL': 'Vendor Bill', 'PAYMENT': 'Payment Made',
        'CREDIT': 'Vendor Credit', 'REJECTION': 'Material Rejection',
        'WAGE_ENTRY': 'Wage Entry',
    }

    @property
    def module_name(self):
        code = (self.request.query_params.get('module')
                or self.request.data.get('module'))
        return self._MODULE_TO_ERP.get(code)

    def get_required_perm(self, request):
        # Any attachment operation (read / upload / delete) requires VIEW on
        # the parent module — if you can see the document you can manage its
        # files. This avoids forcing uploaders to also hold can_create.
        return 'can_view'

    def get_queryset(self):
        qs = PurchaseAttachment.objects.filter(is_active=True)
        module = self.request.query_params.get('module')
        record_id = self.request.query_params.get('record_id')
        # `record_ids` (comma-separated) fetches attachments for MANY records in
        # one request — a list page showing an attachment marker per row uses it
        # to avoid one call per row (N+1). Same enumeration guard: a specific
        # module plus at least one id.
        record_ids = self.request.query_params.get('record_ids')
        id_list = [r for r in (record_ids or '').split(',') if r.strip()]
        # The LIST action must never return the whole attachment table —
        # require a specific (module, record_id[s]) so attachments can't be
        # enumerated across documents. Detail actions (retrieve/delete by
        # UUID pk) stay reachable and are covered by the module gate above.
        if getattr(self, 'action', None) == 'list' and (not module or not (record_id or id_list)):
            return qs.none()
        if module:
            qs = qs.filter(module=module)
        if id_list:
            qs = qs.filter(record_id__in=id_list)
        elif record_id:
            qs = qs.filter(record_id=record_id)
        category = self.request.query_params.get('category')
        if category:
            qs = qs.filter(category=category)
        return qs

    @action(detail=True, methods=['get'], url_path='signed-url',
            permission_classes=[IsAuthenticated])
    def signed_url(self, request, pk=None):
        """Mint a FRESH short-lived URL to open this attachment, per click.

        The URL baked into the page (file.url) is a presigned R2 link that expires
        after an hour, so clicking it later 403s — the "Failed to load PDF" the user
        hit. This signs a new one on demand, and forces signing even when the
        storage is set to a custom domain (private bucket), so the link always opens.
        """
        att = self.get_object()
        if not att.file:
            return Response({'detail': 'This attachment has no file.'},
                            status=status.HTTP_404_NOT_FOUND)
        url = None
        try:
            st = att.file.storage
            if hasattr(st, 'bucket_name') and hasattr(st, 'connection'):
                client = st.connection.meta.client
                params = {'Bucket': st.bucket_name, 'Key': att.file.name}
                # Serve with the REAL content type, sniffed from the first bytes — the
                # Email Inbox can save a JPEG/PNG under a .pdf name + application/pdf,
                # which the browser's PDF viewer can't parse. Override so it renders
                # correctly (fixes the mislabelled files already in storage, no
                # re-upload). Best-effort: a range GET of 12 bytes.
                try:
                    magic = client.get_object(
                        Bucket=st.bucket_name, Key=att.file.name,
                        Range='bytes=0-11')['Body'].read()
                    ct = ('application/pdf' if magic.startswith(b'%PDF')
                          else 'image/jpeg' if magic.startswith(b'\xff\xd8\xff')
                          else 'image/png' if magic.startswith(b'\x89PNG\r\n\x1a\n')
                          else 'image/tiff' if magic[:4] in (b'II*\x00', b'MM\x00*')
                          else None)
                    if ct:
                        params['ResponseContentType'] = ct
                except Exception:  # noqa: BLE001 — sniff is best-effort
                    pass
                url = client.generate_presigned_url('get_object', Params=params, ExpiresIn=3600)
        except Exception:  # noqa: BLE001 — fall back to the storage's own URL
            url = None
        if not url:
            try:
                url = request.build_absolute_uri(att.file.url)
            except Exception:  # noqa: BLE001
                return Response({'detail': 'Could not resolve the file URL.'},
                                status=status.HTTP_400_BAD_REQUEST)
        return Response({'url': url})

    def _check_pr_editable(self, module, record_id, category=None):
        """For PR module, block attachment changes when PR is not in DRAFT (non-admins)."""
        if module != 'PR' or not record_id:
            return None
        # A VOICE_NOTE is a reason-of-record for a change — it is recorded
        # PRECISELY when a non-draft PR is edited, so it must be allowed through
        # even though the PR is past DRAFT. (The edit itself is already gated by
        # the PR edit endpoint; this is only its spoken reason.)
        if (category or '').upper() == 'VOICE_NOTE':
            return None
        user = self.request.user
        if user.is_superuser:
            return None
        try:
            from rbac.views import _is_office_manager_or_admin
            if _is_office_manager_or_admin(user):
                return None
        except Exception:
            pass
        try:
            pr = PurchaseRequest.objects.get(pk=record_id)
        except PurchaseRequest.DoesNotExist:
            return None
        if pr.approval_status != 'DRAFT':
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied(
                'Attachments can only be modified when Purchase Request is in DRAFT status.'
            )
        return None

    def perform_create(self, serializer):
        f = self.request.FILES.get('file')
        if not f:
            from rest_framework.exceptions import ValidationError
            raise ValidationError({'file': 'File is required'})
        module = self.request.data.get('module')
        record_id = self.request.data.get('record_id')
        self._check_pr_editable(module, record_id, self.request.data.get('category'))
        # Skip duplicate: same module, record, file_name, file_size
        if module and record_id and PurchaseAttachment.objects.filter(
            module=module, record_id=record_id,
            file_name=f.name, file_size=f.size, is_active=True
        ).exists():
            # Return existing attachment silently instead of creating duplicate
            existing = PurchaseAttachment.objects.filter(
                module=module, record_id=record_id,
                file_name=f.name, file_size=f.size, is_active=True
            ).first()
            serializer.instance = existing
            return
        serializer.save(
            file=f,
            file_name=f.name,
            file_size=f.size,
            file_type=f.content_type or '',
            uploaded_by=self.request.user,
        )

    def perform_destroy(self, instance):
        self._check_pr_editable(instance.module, str(instance.record_id))
        instance.soft_delete()


class MaterialRejectionViewSet(WarehouseScopedQuerysetMixin, viewsets.ModelViewSet):
    """ViewSet for Material Rejections."""
    from .models import MaterialRejection
    from .serializers import MaterialRejectionSerializer

    warehouse_field = 'warehouse'
    queryset = MaterialRejection.objects.select_related(
        'receipt_advice', 'purchase_order', 'vendor', 'warehouse', 'rejected_by__user'
    ).prefetch_related(
        'rejection_lines__product',
        'rejection_lines__service_catalogue',
    ).filter(is_active=True)
    serializer_class = MaterialRejectionSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Material Rejection'
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['status', 'vendor', 'warehouse']
    search_fields = ['rejection_no', 'vendor__vendor_name']
    ordering_fields = ['rejection_date', 'created_at']
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
    ordering = ['-rejection_date', '-id']

    def perform_create(self, serializer):
        try:
            from apps.core.models import StakeholderUser
            rejected_by = StakeholderUser.objects.get(user=self.request.user)
        except Exception:
            rejected_by = None
        rejection = serializer.save(rejected_by=rejected_by)
        # Copy receipt attachments
        if rejection.receipt_advice_id:
            receipt_attachments = PurchaseAttachment.objects.filter(
                module='RECEIPT', record_id=rejection.receipt_advice_id, is_active=True
            )
            for att in receipt_attachments:
                if not PurchaseAttachment.objects.filter(
                    module='REJECTION', record_id=rejection.id,
                    file_name=att.file_name, file_size=att.file_size
                ).exists():
                    PurchaseAttachment.objects.create(
                        module='REJECTION', record_id=rejection.id,
                        file=att.file, file_name=att.file_name,
                        file_size=att.file_size, file_type=att.file_type,
                        uploaded_by=self.request.user,
                    )

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        rejection = self.get_object()
        if rejection.status != 'DRAFT':
            return Response({'error': 'Only DRAFT rejections can be approved'}, status=status.HTTP_400_BAD_REQUEST)
        rejection.status = 'APPROVED'
        rejection.save(update_fields=['status'])
        return Response(self.get_serializer(rejection).data)

    @action(detail=True, methods=['post'], url_path='mark-returned')
    def mark_returned(self, request, pk=None):
        rejection = self.get_object()
        if rejection.status != 'APPROVED':
            return Response({'error': 'Only APPROVED rejections can be marked as returned'}, status=status.HTTP_400_BAD_REQUEST)
        rejection.status = 'RETURNED'
        rejection.return_date = timezone.now().date()
        rejection.save(update_fields=['status', 'return_date'])
        return Response(self.get_serializer(rejection).data)


class VendorProductMappingViewSet(viewsets.ModelViewSet):
    """CRUD for vendor → product alias mappings created via the Quote Response
    extraction mismatch resolution modal."""

    queryset = VendorProductMapping.objects.filter(is_active=True).select_related('vendor', 'product', 'created_by')
    serializer_class = VendorProductMappingSerializer
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'RFQ'
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['vendor', 'product']
    ordering_fields = ['created_at']
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
    ordering = ['-created_at', '-id']

    def perform_create(self, serializer):
        serializer.save(
            created_by=getattr(self.request.user, 'stakeholder_profile', None),
        )

    def create(self, request, *args, **kwargs):
        """Upsert-style create: if a mapping already exists for this
        (vendor, extracted_text) pair, update the product instead of erroring
        on the unique constraint. This matches what the modal needs — clicking
        'Remember' should always work, regardless of prior history."""
        vendor = request.data.get('vendor')
        extracted = (request.data.get('extracted_text') or '').strip()
        product = request.data.get('product')
        if not vendor or not extracted or not product:
            return Response(
                {'error': 'vendor, extracted_text and product are required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        existing = VendorProductMapping.objects.filter(
            vendor_id=vendor, extracted_text=extracted.lower(),
        ).first()
        if existing:
            existing.product_id = product
            existing.extracted_text_display = extracted
            existing.is_active = True
            existing.save()
            return Response(self.get_serializer(existing).data, status=status.HTTP_200_OK)
        return super().create(request, *args, **kwargs)


# Product Mismatch Logs are intentionally NOT exposed via a public API.
# Rows are written by QuoteResponseViewSet.create() on Quote save and the
# PurchaseOrder post_save signal. They are visible only in Django Admin to
# staff/superusers — see purchase/admin.py.


class PurchaseItemsView(APIView):
    """Unified item catalogue for Purchase forms.

    Returns a merged, paginated list of selectable line-item records
    pulled from two different masters:

      - master.Product           → item_type = 'PRODUCT' (machine spares
                                    are MACHINERY-type Products here)
      - master.ServiceCatalogue  → item_type = 'SERVICE'

    Every Purchase form (PR, RFQ, Quote, Eval, PO, Receipt, Bill,
    Vendor Credit, Rejection) should source its line-item dropdown
    from here so users can pick from either source without the form
    having to know which one it is. The frontend then routes the
    selection to the right FK (product_service / service_catalogue)
    based on the returned `item_type`.

    Response shape (single row):
        {
          item_type: 'PRODUCT' | 'SERVICE',
          item_id: '<uuid or pk as string>',
          item_name: 'Product Name',
          item_code: 'SKU-123',
          uom: 'KG',                      # may be empty for non-Goods
          category: 'RAW_MATERIAL',       # subtype/category, see below
          label: 'Product Name (SKU-123)',  # ready-to-render dropdown text
        }

    `category` semantics per source:
      PRODUCT   → product.goods_sub_type  (RAW_MATERIAL, FINISHED_GOOD, …)
      SERVICE   → service.category        (JOB_WORK, TESTING, …)

    Query params:
      ?item_type=PRODUCT,SERVICE    comma-separated filter (any subset)
      ?search=oil                   case-insensitive name+code substring
      ?category=RAW_MATERIAL        exact match against `category`
      ?page=&page_size=             standard DRF pagination
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        from django.db.models import Q, Sum
        from decimal import Decimal
        from master.models import Product, ServiceCatalogue
        from inventory.models import InventoryLedger

        # Parse filters. `item_type` is comma-separated so a single
        # query can return any combination of the sources.
        raw_types = (request.query_params.get('item_type') or '').strip().upper()
        wanted = {t.strip() for t in raw_types.split(',') if t.strip()} if raw_types else {'PRODUCT', 'SERVICE'}
        search = (request.query_params.get('search') or '').strip()
        category = (request.query_params.get('category') or '').strip()
        # Optional warehouse filter — when present, every PRODUCT row
        # also carries a `current_stock` field showing on-hand at that
        # warehouse. The PR form passes the PR's warehouse so each line
        # item can display "stock for THIS product at THIS warehouse".
        warehouse_id = (request.query_params.get('warehouse') or '').strip() or None
        # Optional godown narrowing — when supplied, current_stock is
        # restricted to ledger rows on this godown only. Without this
        # the PR form's "Available Stock" column was showing the SUM
        # across every godown at the warehouse, so picking a specific
        # (empty) godown still displayed another godown's balance.
        godown_id = (request.query_params.get('godown') or '').strip() or None

        rows = []

        product_rows = []  # held aside so we can stamp current_stock in one pass
        if 'PRODUCT' in wanted:
            qs = Product.objects.filter(active_flag=True)
            if search:
                qs = qs.filter(
                    Q(product_name__icontains=search) |
                    Q(sku_code__icontains=search)
                )
            if category:
                # Goods sub-type uses 'FINISHED_GOOD' singular on the
                # Product master but the rest of the system uses
                # 'FINISHED_GOODS' (plural) — accept both for the caller.
                cat = 'FINISHED_GOOD' if category == 'FINISHED_GOODS' else category
                qs = qs.filter(goods_sub_type=cat)
            for p in qs.only('id', 'product_name', 'sku_code', 'uom',
                             'goods_sub_type', 'product_type', 'sg_applicable',
                             'pack_size_kg', 'pack_size_ltr', 'specific_gravity'):
                product_rows.append({
                    'item_type': 'PRODUCT',
                    # Surface the Product master's product_type so the
                    # PR form can route each line by Requirement Type
                    # (GOODS / SERVICES / MACHINERY).
                    'product_type': p.product_type or '',
                    'item_id': str(p.id),
                    'item_name': p.product_name or '',
                    'item_code': p.sku_code or '',
                    'uom': p.uom or '',
                    'category': p.goods_sub_type or '',
                    # Needed by the Production Entry form so a SG-applicable
                    # product surfaces BOTH Qty (KG) and Qty (LTR) columns
                    # instead of just Qty (KG) inferred from the master UOM.
                    'sg_applicable': bool(p.sg_applicable),
                    # Pack-size + specific gravity drive the packing-entry
                    # auto-fill: output_count × pack_size = expected bulk
                    # consumption, then KG↔LTR conversion via SG when
                    # source and target units differ.
                    'pack_size_kg':  str(p.pack_size_kg  or ''),
                    'pack_size_ltr': str(p.pack_size_ltr or ''),
                    'specific_gravity': str(p.specific_gravity or ''),
                    'label': f"{p.product_name}{f'  ({p.sku_code})' if p.sku_code else ''}",
                    # Default '' — replaced below if a warehouse filter
                    # was supplied. Empty string (not 0) so the frontend
                    # can tell "no warehouse selected" apart from "zero
                    # stock at this warehouse".
                    'current_stock': '',
                })

            if warehouse_id and product_rows:
                # One aggregated InventoryLedger query covers every
                # PRODUCT row in the response — sums quantity_in and
                # quantity_out across batches and (when no godown filter
                # is supplied) every godown at this warehouse, giving us
                # closing stock per product without N round-trips. When
                # `godown_id` is passed too the sum is restricted to a
                # single godown so the PR form's Available Stock column
                # reflects the picked godown, not a sibling.
                product_ids = [r['item_id'] for r in product_rows]
                ledger_qs = InventoryLedger.objects.filter(
                    warehouse_id=warehouse_id,
                    product_id__in=product_ids,
                    is_active=True,
                )
                if godown_id:
                    ledger_qs = ledger_qs.filter(godown_id=godown_id)
                stock_rows = (
                    ledger_qs
                    .values('product_id')
                    .annotate(
                        in_total=Sum('quantity_in'),
                        out_total=Sum('quantity_out'),
                    )
                )
                stock_by_pid = {
                    str(r['product_id']): (
                        (r['in_total'] or Decimal('0'))
                        - (r['out_total'] or Decimal('0'))
                    )
                    for r in stock_rows
                }

                # This standalone derives stock (no InventoryLedger postings):
                # on-hand = OpeningStock + (ledger in-out) - StockIssue, matching
                # the Stock page. Fold Opening + Issues in so Available Stock on
                # the PR form reflects real seeded/opening quantities, not 0.
                try:
                    from inventory.models import OpeningStock
                    os_rows = (
                        OpeningStock.objects
                        .filter(warehouse_id=warehouse_id, product_id__in=product_ids,
                                is_active=True)
                        .values('product_id')
                        .annotate(q=Sum('quantity'))
                    )
                    for r in os_rows:
                        pid = str(r['product_id'])
                        stock_by_pid[pid] = stock_by_pid.get(pid, Decimal('0')) + (r['q'] or Decimal('0'))
                except Exception:
                    pass
                try:
                    from inventory.models import StockIssue
                    iss_qs = StockIssue.objects.filter(
                        warehouse_id=warehouse_id, product_id__in=product_ids)
                    if godown_id and any(
                        f.name == 'godown' for f in StockIssue._meta.get_fields()):
                        iss_qs = iss_qs.filter(godown_id=godown_id)
                    iss_rows = iss_qs.values('product_id').annotate(q=Sum('quantity'))
                    for r in iss_rows:
                        pid = str(r['product_id'])
                        stock_by_pid[pid] = stock_by_pid.get(pid, Decimal('0')) - (r['q'] or Decimal('0'))
                except Exception:
                    pass

                for row in product_rows:
                    row['current_stock'] = str(stock_by_pid.get(row['item_id'], Decimal('0')))

            rows.extend(product_rows)

        if 'SERVICE' in wanted:
            qs = ServiceCatalogue.objects.filter(active_flag=True)
            if search:
                qs = qs.filter(
                    Q(name__icontains=search) |
                    Q(service_code__icontains=search)
                )
            if category:
                qs = qs.filter(category=category)
            for s in qs.only('id', 'name', 'service_code', 'category'):
                rows.append({
                    'item_type': 'SERVICE',
                    'item_id': str(s.id),
                    'item_name': s.name or '',
                    'item_code': s.service_code or '',
                    'uom': '',  # Services have no UOM at master level
                    'category': s.category or '',
                    'label': f"{s.name}{f'  ({s.service_code})' if s.service_code else ''}",
                })

        # Sort consistently across sources so the dropdown is alphabetical.
        rows.sort(key=lambda r: (r['item_name'] or '').lower())
        return Response({'results': rows, 'count': len(rows)})


def _post_receipt_to_production_stock(receipt, lines, user):
    """Post each receipt line to the parallel Production Stock ledger.

    Idempotent — a re-run for the same receipt-line skips if a movement
    row already exists. Stores both qty_kg and qty_litres:
      * qty_kg  = net_quantity (or quantity_received) — always in the
        line's UOM; for sg-applicable products this is treated as kg.
      * qty_litres = line.quantity_in_litres for sg-applicable products
        (frozen at save time), else Decimal('0').

    Skips lines without product / godown / quantity. Never raises — a
    failure here is logged but doesn't block the receipt approval.
    """
    from decimal import Decimal
    from inventory.models import ProductionStockMovement
    import logging
    logger = logging.getLogger(__name__)

    receipt_date = (
        receipt.receipt_date.date()
        if hasattr(receipt.receipt_date, 'date') else receipt.receipt_date
    ) or timezone.now().date()

    for line in lines:
        if line.service_catalogue_id:
            continue
        if not line.product_id or not line.godown_location_id:
            continue

        qty = line.net_quantity if line.net_quantity is not None else line.quantity_received
        if qty is None or Decimal(qty) <= 0:
            continue

        # Idempotency: skip if already posted for this receipt-line.
        if ProductionStockMovement.objects.filter(
            source_type='PURCHASE_RECEIPT',
            source_line_id=line.id,
            is_active=True,
        ).exists():
            continue

        qty_kg = Decimal(qty)
        qty_litres = Decimal(line.quantity_in_litres or 0)

        try:
            ProductionStockMovement.objects.create(
                warehouse_id=receipt.warehouse_id,
                godown_id=line.godown_location_id,
                product_id=line.product_id,
                direction='IN',
                qty_kg=qty_kg,
                qty_litres=qty_litres,
                movement_date=receipt_date,
                source_type='PURCHASE_RECEIPT',
                source_document_id=receipt.id,
                source_document_ref=receipt.receipt_advice_no or '',
                source_line_id=line.id,
                remarks=f'Auto-posted from receipt {receipt.receipt_advice_no}',
                created_by=user,
            )
        except Exception as exc:
            logger.warning(
                'Production Stock post failed for receipt %s line %s: %s',
                receipt.id, line.id, exc,
            )
