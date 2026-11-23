"""PO amendment workflow.

A coordinator (can_request_amendment) raises an amendment on an already
APPROVED/ISSUED Purchase Order with proposed new values + a reason. A
manager/admin (can_approve_amendment) reviews and APPROVES to apply the
changes (bumping the PO's revision_no) or REJECTS with remarks.
"""
from django.db import transaction
from django.utils import timezone
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from rbac.permissions import check_permission

from .models import POAmendmentRequest, POLine, PurchaseOrder

# Whitelists — only these may be changed via an amendment.
AMENDABLE_HEADER_FIELDS = {
    'freight_terms', 'freight_estimate', 'payment_terms', 'delivery_terms',
    'terms_and_conditions', 'broker_name', 'expected_delivery_date', 'remarks',
    'currency',
}
# An amendment is for genuine commercial changes only — a new quantity or
# unit price. GST is deliberately NOT amendable: a wrong GST is a data-entry
# mistake, not a re-negotiation, and is corrected by an admin in Django admin
# (Purchase Order → line → GST) rather than through the request/approve flow.
AMENDABLE_LINE_FIELDS = {'unit_price', 'quantity_ordered'}


class POAmendmentRequestSerializer(serializers.ModelSerializer):
    requested_by_name = serializers.CharField(source='requested_by.get_full_name', read_only=True, default='')
    reviewed_by_name = serializers.CharField(source='reviewed_by.get_full_name', read_only=True, default='')
    po_no = serializers.CharField(source='po.po_no', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        model = POAmendmentRequest
        fields = [
            'id', 'po', 'po_no', 'reason', 'proposed_changes', 'status', 'status_display',
            'requested_by', 'requested_by_name', 'reviewed_by', 'reviewed_by_name',
            'reviewed_at', 'review_remarks', 'created_at',
        ]
        read_only_fields = [
            'id', 'status', 'status_display', 'requested_by', 'requested_by_name',
            'reviewed_by', 'reviewed_by_name', 'reviewed_at', 'review_remarks',
            'po_no', 'created_at',
        ]


def _notify(user, **kw):
    if user is None:
        return
    try:
        from notifications.services import notify_user
        notify_user(user, **kw)
    except Exception:
        pass


class POAmendmentRequestViewSet(viewsets.ModelViewSet):
    queryset = POAmendmentRequest.objects.select_related('po', 'requested_by', 'reviewed_by').all()
    serializer_class = POAmendmentRequestSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = super().get_queryset()
        po_id = self.request.query_params.get('po')
        if po_id:
            qs = qs.filter(po_id=po_id)
        status_f = self.request.query_params.get('status')
        if status_f:
            qs = qs.filter(status=status_f)
        return qs

    def create(self, request, *args, **kwargs):
        if not check_permission(request.user, 'Purchase Order', 'request_amendment'):
            return Response({'error': 'You do not have permission to request a PO amendment.'}, status=403)
        po = PurchaseOrder.objects.filter(pk=request.data.get('po')).first()
        if not po:
            return Response({'error': 'Purchase Order not found.'}, status=404)
        if po.status not in ('APPROVED', 'ISSUED'):
            return Response({'error': 'Only an approved or issued PO can be amended.'}, status=400)
        if po.amendment_requests.filter(status='PENDING').exists():
            return Response({'error': 'There is already a pending amendment request for this PO.'}, status=400)
        if not (request.data.get('reason') or '').strip():
            return Response({'error': 'A reason for the amendment is required.'}, status=400)
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        amendment = ser.save(requested_by=request.user, created_by=request.user, status='PENDING')

        # 1) Self-confirmation to the requester — always fires so the
        # operator sees SOMETHING even when no approvers are configured
        # yet (the original notify-approvers path was silent on an
        # empty approver set, which read as "no notification wired").
        _notify(
            request.user,
            title=f'Amendment for PO {po.po_no} submitted',
            message='Your amendment request is pending approval.',
            link=f'/purchase/orders/{po.id}',
            category='approval', level='info', actor=request.user,
        )

        # 2) Tell the amendment approvers (can_approve_amendment) there's
        # something to review — notify_approvers only targets can_approve,
        # so resolve this flag's holders directly.
        try:
            from notifications.services import notify_users, users_with_module_permission
            approvers = users_with_module_permission('Purchase Order', 'can_approve_amendment')
            try:
                approvers = approvers.exclude(pk=request.user.pk)
            except Exception:
                pass
            approvers = list(approvers)
            if not approvers:
                # can_approve_amendment is a later RBAC flag that defaults
                # to False — on installs whose roles predate it nobody
                # holds it, and requests sat pending with no bell for
                # anyone. Fall back to the module's regular approvers so
                # the alert never dead-ends on a config gap.
                fallback = users_with_module_permission('Purchase Order', 'can_approve')
                try:
                    fallback = fallback.exclude(pk=request.user.pk)
                except Exception:
                    pass
                approvers = list(fallback)
            # Superusers can action the approval (permission checks pass
            # for them) but are invisible to the RolePermission queries
            # above — include them explicitly. notify_users de-dups.
            from django.contrib.auth import get_user_model
            approvers += list(
                get_user_model().objects.filter(is_superuser=True, is_active=True)
                .exclude(pk=request.user.pk)
            )
            if approvers:
                notify_users(
                    approvers,
                    f'PO {po.po_no} amendment requested',
                    message=(amendment.reason or '')[:200],
                    link=f'/purchase/orders/{po.id}', category='approval', level='info', actor=request.user,
                )
            else:
                # Even the fallback found nobody — log the config gap so
                # admins can see a role needs can_approve_amendment (or
                # can_approve) on Purchase Order.
                import logging
                logging.getLogger(__name__).warning(
                    'PO amendment %s created but no users have '
                    'can_approve_amendment (or can_approve) on Purchase '
                    'Order — assign the permission to a role or nobody '
                    'will be notified.',
                    amendment.id,
                )
        except Exception:
            pass
        return Response(ser.data, status=201)

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        amendment = self.get_object()
        if not check_permission(request.user, 'Purchase Order', 'approve_amendment'):
            return Response({'error': 'You do not have permission to approve a PO amendment.'}, status=403)
        if amendment.status != 'PENDING':
            return Response({'error': 'This amendment has already been reviewed.'}, status=400)
        # The manager may tweak the proposed values before applying.
        changes = request.data.get('proposed_changes', amendment.proposed_changes) or {}
        with transaction.atomic():
            po = amendment.po
            for key, value in (changes.get('header') or {}).items():
                if key in AMENDABLE_HEADER_FIELDS and hasattr(po, key):
                    setattr(po, key, value)
            for ln in (changes.get('lines') or []):
                line = POLine.objects.filter(pk=ln.get('id'), po=po).first()
                if not line:
                    continue
                for key, value in ln.items():
                    if key in AMENDABLE_LINE_FIELDS:
                        setattr(line, key, value)
                line.save()
            po.revision_no = (po.revision_no or 0) + 1
            po.updated_by = request.user
            po.save()
            amendment.proposed_changes = changes
            amendment.status = 'APPROVED'
            amendment.reviewed_by = request.user
            amendment.reviewed_at = timezone.now()
            amendment.review_remarks = request.data.get('review_remarks', '')
            amendment.save()
        _notify(
            amendment.requested_by,
            title=f'PO {po.po_no} amendment approved',
            message='Your amendment was approved and applied to the PO.',
            link=f'/purchase/orders/{po.id}', category='approval', level='success', actor=request.user,
        )
        return Response(self.get_serializer(amendment).data)

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        amendment = self.get_object()
        if not check_permission(request.user, 'Purchase Order', 'approve_amendment'):
            return Response({'error': 'You do not have permission to review a PO amendment.'}, status=403)
        if amendment.status != 'PENDING':
            return Response({'error': 'This amendment has already been reviewed.'}, status=400)
        amendment.status = 'REJECTED'
        amendment.reviewed_by = request.user
        amendment.reviewed_at = timezone.now()
        amendment.review_remarks = request.data.get('review_remarks', '')
        amendment.save()
        _notify(
            amendment.requested_by,
            title=f'PO {amendment.po.po_no} amendment rejected',
            message=amendment.review_remarks or 'Your amendment request was rejected.',
            link=f'/purchase/orders/{amendment.po_id}', category='approval', level='warning', actor=request.user,
        )
        return Response(self.get_serializer(amendment).data)
