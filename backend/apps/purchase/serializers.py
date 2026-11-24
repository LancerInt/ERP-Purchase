"""Serializers for purchase app."""

import datetime as _dt
from decimal import Decimal
from rest_framework import serializers
from django.utils import timezone
from django.db import transaction

from sales.field_permissions import FieldPermissionMixin
from common.serializer_cache import ctx_store, lookup_map, root_objects

from .models import (
    PurchaseRequest, PRLine, PRApprovalTrail,
    RFQHeader, DispatchETAUpdate,
    QuoteResponse, QuoteLine, QuoteEvaluation, ComparisonEntry, EvalApprovalTrail,
    PurchaseOrder, POLine, POETAUpdate,
    ReceiptAdvice, ReceiptLine, PackingMaterialLine, WeighmentDetail, FreightDetail,
    LoadingUnloadingWage, FreightPaymentSchedule, FreightAdviceInbound,
    VendorPaymentAdvice, PaymentTaxComponent,
    PurchaseAttachment,
    MaterialRejection, MaterialRejectionLine,
)


def _line_item_name(line):
    """Display name for a PR / Quote / PO / Receipt line — resolves whichever
    of the mutually-exclusive FKs is set. PR / Quote / PO lines use
    `product_service` for the Product FK, while ReceiptLine uses `product`;
    both shapes route here so the same _names_from_lines helper can back
    the "Products" list-view column across every document type."""
    if getattr(line, 'service_catalogue_id', None):
        return getattr(line.service_catalogue, 'name', '') or ''
    if getattr(line, 'product_service_id', None):
        return getattr(line.product_service, 'product_name', '') or ''
    if getattr(line, 'product_id', None):
        return getattr(line.product, 'product_name', '') or ''
    return ''


# ── Machinery-line helpers ────────────────────────────────────────────
# Machine spares are MACHINERY Products, carried by the line's product FK.
# These resolve the "machine" behind a line (Product exposes
# machine_id/machine_name via compat properties), so display + type checks
# work off the product FK alone.
def _machine_ref(obj):
    # A line model has EITHER product_service (PR/Quote/PO) or product
    # (Receipt/Bill/Credit/Rejection); it's a "machine" line when that product
    # is a MACHINERY item.
    p = getattr(obj, 'product_service', None) or getattr(obj, 'product', None)
    return p if (p is not None and getattr(p, 'product_type', None) == 'MACHINERY') else None


def _is_machinery_line(obj):
    return _machine_ref(obj) is not None


def _ctx_store(serializer, bucket):
    """Per-response memo shared by every serializer in the tree.

    DRF's `.context` property returns the ROOT serializer's context dict, so a
    nested line serializer and its parent see the same object. Must be tested
    with `isinstance`, not truthiness - an empty context is a perfectly good
    (and very common) dict, and `if ctx` would silently hand back a throwaway,
    turning the memo into a no-op.
    """
    ctx = getattr(serializer, 'context', None)
    return ctx.setdefault(bucket, {}) if isinstance(ctx, dict) else {}


def _page_pks(serializer):
    """Primary keys of every object in THIS response, or None when unknown.

    `serializer.root` is the ListSerializer DRF wraps a page in, and its
    `.instance` is the page itself, so a figure that was being fetched once per
    row can be fetched once per page instead. Returns None rather than guessing
    when there is no list to read - a detail route, a create/update response -
    and every caller then falls back to the single-object query it ran before.
    """
    inst = getattr(getattr(serializer, 'root', None), 'instance', None)
    if inst is None:
        return None
    if hasattr(inst, 'pk'):
        return [inst.pk]
    try:
        return [o.pk for o in inst]
    except Exception:
        return None


def _names_from_lines(lines):
    """Ordered, de-duplicated list of item names from a line iterable — the
    value behind the list-view "Products" column."""
    seen, out = set(), []
    for ln in lines:
        n = _line_item_name(ln)
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


class PurchaseAttachmentSerializer(serializers.ModelSerializer):
    """Serializer for purchase attachments."""
    uploaded_by_name = serializers.CharField(source='uploaded_by.get_full_name', read_only=True, default='')
    # Absolute URL for the uploaded file. The default FileField returns
    # the relative storage path (e.g. /media/purchase/freight.pdf),
    # which 404s if the frontend opens it on the wrong origin. Building
    # an absolute URL via the request context guarantees the link works
    # cross-origin (Render frontend → Render backend).
    file_url = serializers.SerializerMethodField()

    class Meta:
        model = PurchaseAttachment
        fields = ['id', 'module', 'record_id', 'category', 'file', 'file_url', 'file_name', 'file_size', 'file_type',
                  'uploaded_by', 'uploaded_by_name', 'created_at']
        read_only_fields = ['id', 'file_url', 'file_name', 'file_size', 'file_type', 'uploaded_by', 'created_at']

    def validate_file(self, value):
        from common.validators import upload_error
        err = upload_error(value)
        if err:
            raise serializers.ValidationError(err)
        return value

    def get_file_url(self, obj):
        if not obj.file:
            return ''
        try:
            url = obj.file.url
        except (ValueError, AttributeError):
            return ''
        request = self.context.get('request')
        if request is not None:
            return request.build_absolute_uri(url)
        return url


class PRLineSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for PR line items."""
    field_permission_module = 'Purchase Request Line'

    id = serializers.UUIDField(required=False, allow_null=True)
    product_name = serializers.CharField(
        source='product_service.product_name',
        read_only=True,
        allow_null=True,
    )
    product_code = serializers.CharField(
        source='product_service.sku_code',
        read_only=True,
        allow_null=True,
    )
    # Exposes the product master's GST% so the Approve-route modal can
    # pre-fill the per-line GST field when a vendor is picked (avoids
    # operators looking it up + retyping for every line).
    product_gst_percentage = serializers.DecimalField(
        source='product_service.gst_percentage',
        max_digits=5, decimal_places=2,
        read_only=True, allow_null=True,
    )
    # Display-only friendly names resolved from the product / service-catalogue
    # FKs (machinery_name comes from the MACHINERY product via _machine_ref).
    machinery_name = serializers.SerializerMethodField()
    service_catalogue_name = serializers.SerializerMethodField()
    # Live on-hand balance for this line's product at the PR's warehouse —
    # surfaced as "Available Stock" on the PR detail page.
    current_stock = serializers.SerializerMethodField()
    preferred_vendor_name = serializers.CharField(
        source='preferred_vendor.vendor_name', read_only=True, allow_null=True,
    )
    # Conversion coverage: how much of quantity_requested is already on
    # active POs, and what remains orderable. Strings (str(Decimal)) so the
    # frontend renders precision unchanged. `residual_quantity` further
    # excludes CANCELLED/SPLIT POs and drives the partial-route convert.
    ordered_quantity = serializers.SerializerMethodField()
    balance_quantity = serializers.SerializerMethodField()
    residual_quantity = serializers.SerializerMethodField()

    class Meta:
        model = PRLine
        fields = [
            'id', 'line_no', 'category',
            # New polymorphic-style line item — exactly one of these should be
            # set per row, matching the parent PR's requirement_type.
            'product_service', 'product_name', 'product_code',
            'product_gst_percentage',
            'machinery_name',
            'service_catalogue', 'service_catalogue_name',
            'preferred_vendor', 'preferred_vendor_name',
            'description_override', 'quantity_requested', 'uom', 'required_date',
            'purpose', 'allow_rfq_skip',
            'status', 'approved_quantity', 'current_stock',
            'ordered_quantity', 'balance_quantity', 'residual_quantity', 'created_at', 'updated_at'
        ]
        read_only_fields = ['created_at', 'updated_at']
        extra_kwargs = {
            'category': {'required': False, 'allow_blank': True},
            'product_service': {'required': False, 'allow_null': True},
            'service_catalogue': {'required': False, 'allow_null': True},
            'preferred_vendor': {'required': False, 'allow_null': True},
            'description_override': {'required': False, 'allow_blank': True},
            'uom': {'required': False, 'allow_blank': True},
            'required_date': {'required': False},
            'purpose': {'required': False, 'allow_blank': True},
            'status': {'required': False, 'allow_blank': True},
            'approved_quantity': {'required': False},
        }

    def get_machinery_name(self, obj):
        m = _machine_ref(obj)
        if not m:
            return ''
        return getattr(m, 'machine_name', None) or getattr(m, 'name', None) or str(m)

    def get_service_catalogue_name(self, obj):
        s = obj.service_catalogue
        if not s:
            return ''
        return f"{s.service_code} — {s.name}" if getattr(s, 'service_code', None) else s.name

    def get_current_stock(self, obj):
        """Live on-hand balance for this line's product at the PR's
        warehouse (+ godown when the PR specifies one), summed across all
        batches, from the InventoryLedger. Returned as a string so React
        renders the precision unchanged; None when not applicable."""
        product_id = getattr(obj, 'product_service_id', None)
        pr = getattr(obj, 'purchase_request', None)
        warehouse_id = getattr(pr, 'warehouse_id', None) if pr else None
        if not (product_id and warehouse_id):
            return None
        godown_id = getattr(pr, 'godown_id', None)

        # This was one aggregate per LINE - 369 of them on one page of purchase
        # requests, the single heaviest thing on the endpoint. _page_stock_maps
        # asks for every pair on the page at once. A pair with no ledger rows is
        # simply absent from the map, which lands on the same answer the old
        # aggregate gave for an empty set: Sum() returns None, None or 0 gives
        # Decimal('0'), and str() of that is '0'.
        maps = self._page_stock_maps()
        m = maps['wpg'] if godown_id else maps['wp']
        if m is not None:
            key = ((warehouse_id, product_id, godown_id) if godown_id
                   else (warehouse_id, product_id))
            got_in, got_out = m.get(key, (None, None))
            return str((got_in or Decimal('0')) - (got_out or Decimal('0')))

        try:
            from django.db.models import Sum
            from inventory.models import InventoryLedger
            qs = InventoryLedger.objects.filter(
                warehouse_id=warehouse_id, product_id=product_id, is_active=True,
            )
            if godown_id:
                qs = qs.filter(godown_id=godown_id)
            agg = qs.aggregate(in_total=Sum('quantity_in'), out_total=Sum('quantity_out'))
            return str((agg['in_total'] or Decimal('0')) - (agg['out_total'] or Decimal('0')))
        except Exception:
            return None

    def _page_stock_maps(self):
        """On-hand in/out totals for every pair this page will ask about, in at
        most TWO queries. {'wp': ..., 'wpg': ...}; either may be None, and the
        caller then runs the per-line aggregate it ran before.

        Two maps because the question itself differs per PR. A PR that names a
        godown wants that godown only. A PR that names none wants every godown
        summed - and that total includes ledger rows carrying no godown at all,
        so it cannot be added up from the per-godown map. They are kept apart
        rather than derived from one another.

        The queries widen the filters to all the warehouses, products (and
        godowns) on the page, so they may group a few pairs nobody asked for.
        That costs a little scanning and changes no answer: the rows are grouped
        by the same keys the old aggregate filtered to, and only the keys asked
        for are ever read back out.
        """
        store = ctx_store(self, '_pr_stock')
        if 'built' in store:
            return store
        store['built'] = True
        store['wp'] = None
        store['wpg'] = None

        prs = root_objects(self)
        # Only a page of PURCHASE REQUESTS can answer this. PRLineSerializer is
        # also used on its own for a single line (see the PR viewset's add-line
        # and update-line actions), and a PRLine carries no warehouse - without
        # this guard the gather below would find nothing, hand back an EMPTY map
        # rather than no map, and report every stock figure as 0.
        if not prs or not all(isinstance(pr, PurchaseRequest) for pr in prs):
            return store

        want_wp, want_wpg = set(), set()
        try:
            for pr in prs:
                warehouse_id = getattr(pr, 'warehouse_id', None)
                if not warehouse_id:
                    continue
                godown_id = getattr(pr, 'godown_id', None)
                for ln in pr.lines.all():
                    product_id = getattr(ln, 'product_service_id', None)
                    if not product_id:
                        continue
                    if godown_id:
                        want_wpg.add((warehouse_id, product_id, godown_id))
                    else:
                        want_wp.add((warehouse_id, product_id))
        except Exception:       # noqa: BLE001 - fall back, never break the page
            return store

        from django.db.models import Sum
        from inventory.models import InventoryLedger
        base = InventoryLedger.objects.filter(is_active=True)
        try:
            wp = {}
            if want_wp:
                rows = (base.filter(
                    warehouse_id__in={w for w, _ in want_wp},
                    product_id__in={p for _, p in want_wp},
                ).values('warehouse_id', 'product_id')
                 .annotate(i=Sum('quantity_in'), o=Sum('quantity_out')))
                for r in rows:
                    wp[(r['warehouse_id'], r['product_id'])] = (r['i'], r['o'])
            store['wp'] = wp

            wpg = {}
            if want_wpg:
                rows = (base.filter(
                    warehouse_id__in={w for w, _, _ in want_wpg},
                    product_id__in={p for _, p, _ in want_wpg},
                    godown_id__in={g for _, _, g in want_wpg},
                ).values('warehouse_id', 'product_id', 'godown_id')
                 .annotate(i=Sum('quantity_in'), o=Sum('quantity_out')))
                for r in rows:
                    wpg[(r['warehouse_id'], r['product_id'],
                         r['godown_id'])] = (r['i'], r['o'])
            store['wpg'] = wpg
        except Exception:       # noqa: BLE001 - fall back, never break the page
            store['wp'] = None
            store['wpg'] = None
        return store

    def _ordered_total(self, obj):
        """Sum of quantity_ordered across this line's active-PO PO lines.
        Iterates the relation in python (the PR viewset prefetches
        'lines__po_lines__po') so list endpoints don't N+1."""
        total = Decimal('0')
        for pol in obj.po_lines.all():
            if pol.po and pol.po.is_active:
                total += pol.quantity_ordered or Decimal('0')
        return total

    def _committed_total(self, obj):
        """Same as _ordered_total but excludes CANCELLED / SPLIT POs —
        obligation on those isn't real. Drives the residual computation
        for partial-route convert on the PR detail page."""
        total = Decimal('0')
        for pol in obj.po_lines.all():
            po = pol.po
            if po and po.is_active and po.status not in ('CANCELLED', 'SPLIT'):
                total += pol.quantity_ordered or Decimal('0')
        return total

    def get_ordered_quantity(self, obj):
        return str(self._ordered_total(obj))

    def get_balance_quantity(self, obj):
        balance = (obj.quantity_requested or Decimal('0')) - self._ordered_total(obj)
        return str(balance if balance > 0 else Decimal('0'))

    def get_residual_quantity(self, obj):
        """Open qty on this PR line = requested − committed to active
        (non-cancelled, non-split) POs. Convert-held-line can only
        route up to this amount. Distinct from balance_quantity which
        counts every active-flag PO regardless of status."""
        rem = (obj.quantity_requested or Decimal('0')) - self._committed_total(obj)
        return str(rem if rem > 0 else Decimal('0'))

    def validate_quantity_requested(self, value):
        if value <= 0:
            raise serializers.ValidationError("Quantity must be greater than 0")
        return value

    def validate_approved_quantity(self, value):
        if value is not None and value < 0:
            raise serializers.ValidationError("Approved quantity cannot be negative")
        return value

    def validate(self, data):
        """Exactly one of product_service / service_catalogue must be set on
        every PR line. This is what makes the dropdown switch on the
        frontend safe — the backend rejects rows that carry the wrong FK
        for the parent PR's requirement_type.
        """
        # On partial updates `data` may not include all keys, so fall
        # back to the instance.
        inst = self.instance
        ps = data.get('product_service', getattr(inst, 'product_service', None) if inst else None)
        sc = data.get('service_catalogue', getattr(inst, 'service_catalogue', None) if inst else None)
        count = sum(1 for v in (ps, sc) if v)
        if count == 0:
            raise serializers.ValidationError(
                'Each line must reference a product or service.'
            )
        if count > 1:
            raise serializers.ValidationError(
                'Only one of product / service may be set per line.'
            )
        return data


class PRApprovalTrailSerializer(serializers.ModelSerializer):
    """Read-only trail items nested under the PR. Frontend contract:
    {action, actor_name, actor_label, action_date, remarks,
     changes: [{scope, label, old, new}]} — actor_label is the display
    fallback when the actor had no StakeholderUser profile."""

    actor_name = serializers.SerializerMethodField()

    class Meta:
        model = PRApprovalTrail
        fields = [
            'action', 'actor_name', 'actor_label', 'action_date',
            'remarks', 'changes',
        ]
        read_only_fields = ['action', 'actor_label', 'action_date', 'remarks', 'changes']

    def get_actor_name(self, obj):
        # Null-safe: actor is optional on trail rows (see model).
        if not obj.actor_id:
            return ''
        user = getattr(obj.actor, 'user', None)
        if user:
            return user.get_full_name() or user.username
        return str(obj.actor)


class PurchaseRequestSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for purchase requests with nested lines."""
    field_permission_module = 'Purchase Request'

    lines = PRLineSerializer(many=True, required=False)
    approval_trails = PRApprovalTrailSerializer(many=True, read_only=True)
    warehouse_name = serializers.CharField(
        source='warehouse.name',
        read_only=True
    )
    company_name = serializers.CharField(
        source='company.legal_name',
        read_only=True,
        default=''
    )
    preferred_vendor_name = serializers.CharField(
        source='preferred_vendor.vendor_name',
        read_only=True,
        default=''
    )
    godown_name = serializers.CharField(
        source='godown.godown_name',
        read_only=True,
        allow_null=True
    )
    godowns_detail = serializers.SerializerMethodField()

    def get_godowns_detail(self, obj):
        # Was one query PER ROW against a Godown table of 19 - measured at 149
        # queries for a single page of purchase requests. lookup_map reads the
        # table once for the whole response.
        #
        # The result is built by walking the MAP, not the id list, because the
        # old `filter(id__in=ids)` returned rows in Godown's own Meta.ordering
        # (godown_code) and listed a repeated id once. Walking the id list
        # instead would reorder the response - which is a changed value, not an
        # optimisation.
        ids = obj.godown_ids or []
        if not ids:
            return []
        from core.models import Godown
        names = lookup_map(self, Godown, 'id', 'godown_name')
        if names is None:       # table too big to hold - behave as before
            gs = Godown.objects.filter(id__in=ids).values('id', 'godown_name')
            return [{'id': str(g['id']), 'name': g['godown_name']} for g in gs]
        wanted = {str(i) for i in ids}
        return [{'id': k, 'name': v} for k, v in names.items() if k in wanted]
    requested_by_name = serializers.CharField(
        source='requested_by.user.get_full_name',
        read_only=True
    )
    requirement_type_display = serializers.CharField(
        source='get_requirement_type_display',
        read_only=True
    )
    priority_display = serializers.CharField(
        source='get_priority_display',
        read_only=True
    )
    approval_status_display = serializers.CharField(
        source='get_approval_status_display',
        read_only=True
    )
    approved_by_name = serializers.SerializerMethodField()
    created_by_name = serializers.SerializerMethodField()
    linked_rfq_no = serializers.SerializerMethodField()
    # Justification reference — the SO this requisition was raised to
    # fulfil. Number surfaced read-only so lists/detail can render a link
    # without a second fetch.
    sales_order_no = serializers.CharField(
        source='sales_order.so_no', read_only=True, default='',
    )
    has_po = serializers.SerializerMethodField()
    fully_converted = serializers.SerializerMethodField()
    product_names = serializers.SerializerMethodField()
    # Per-line RFQ-skip counters for the list "X/Y skipped" indicator. Uses
    # the prefetched lines (no extra query per row on the annotated list qs).
    line_count = serializers.SerializerMethodField()
    skipped_line_count = serializers.SerializerMethodField()

    def get_line_count(self, obj):
        return len(obj.lines.all())

    def get_skipped_line_count(self, obj):
        return sum(1 for ln in obj.lines.all() if getattr(ln, 'allow_rfq_skip', False))

    def get_product_names(self, obj):
        return _names_from_lines(obj.lines.all())

    def get_approved_by_name(self, obj):
        if obj.approved_by:
            return obj.approved_by.get_full_name() or obj.approved_by.username
        return None

    def get_created_by_name(self, obj):
        # created_by is a plain auth User (BaseModel FK), not a StakeholderUser.
        if obj.created_by:
            return obj.created_by.get_full_name() or obj.created_by.username
        return None

    def get_linked_rfq_no(self, obj):
        if obj.linked_rfq:
            return obj.linked_rfq.rfq_no
        return None

    def get_has_po(self, obj):
        # Prefer the viewset's _has_po annotation (one Exists subquery for the
        # whole page) and fall back to a per-object query when the serializer
        # is used outside the annotated list queryset.
        annotated = getattr(obj, '_has_po', None)
        if annotated is not None:
            return annotated
        return obj.purchase_orders.filter(is_active=True).exists()

    def _page_ordered_map(self):
        """{pr_line_id: total quantity ordered on active POs} for every line on
        this page, in ONE query. None when there is no page to read - a detail
        route, a create or update response - and the caller then runs the
        per-PR query it ran before.

        Built from every line on the page, which is a superset of any one PR's
        lines. That changes nothing: the figures are grouped per line id, so a
        line's total is the same whether or not other lines were asked about in
        the same breath.
        """
        store = ctx_store(self, '_pr_ordered')
        if 'm' in store:
            return store['m']
        store['m'] = None
        prs = root_objects(self)
        # Same guard as _page_stock_maps: no page of purchase requests to read,
        # no map - the caller falls back to the per-PR query.
        if not prs or not all(isinstance(pr, PurchaseRequest) for pr in prs):
            return None
        ids = [ln.id for pr in prs for ln in pr.lines.all()]
        if not ids:
            store['m'] = {}
            return store['m']
        from django.db.models import Sum
        from .models import POLine
        try:
            store['m'] = {
                row['linked_pr_line_id']: row['total']
                for row in POLine.objects.filter(
                    po__is_active=True, linked_pr_line_id__in=ids,
                ).values('linked_pr_line_id').annotate(total=Sum('quantity_ordered'))
            }
        except Exception:       # noqa: BLE001 - fall back, never break the page
            store['m'] = None
        return store['m']

    def get_fully_converted(self, obj):
        """True when EVERY PR line's requested quantity is fully covered by
        active PO lines (Σ quantity_ordered >= quantity_requested) — quantity-
        aware, so a line ordered 250/500 keeps the PR available for a
        follow-up award/PO on the remainder. Used by the evaluation dropdown.
        Only runs the extra query when the PR actually has a PO, so PRs with
        none stay cheap."""
        if not self.get_has_po(obj):
            return False
        lines = list(obj.lines.all())
        if not lines:
            return False
        # Was one grouped query per PR that has a PO - 130 of them on one page.
        # _page_ordered_map asks the same question for every line on the page at
        # once; the per-line totals it groups are identical either way. It is
        # only reached after the has_po guard above, so a page of PRs with no
        # purchase orders still costs nothing.
        ordered = self._page_ordered_map()
        if ordered is None:     # detail / write response - exactly as before
            from django.db.models import Sum
            from .models import POLine
            ordered = {
                row['linked_pr_line_id']: row['total']
                for row in POLine.objects.filter(
                    po__is_active=True,
                    linked_pr_line_id__in=[ln.id for ln in lines],
                ).values('linked_pr_line_id').annotate(total=Sum('quantity_ordered'))
            }
        return all(
            (ordered.get(ln.id) or Decimal('0')) >= (ln.quantity_requested or Decimal('0'))
            for ln in lines
        )

    class Meta:
        model = PurchaseRequest
        fields = [
            'id', 'pr_no', 'request_date', 'company', 'company_name',
            'warehouse', 'warehouse_name',
            'godown', 'godown_name', 'godown_ids', 'godowns_detail', 'requested_by', 'requested_by_name',
            'requestor_role', 'requirement_type', 'requirement_type_display',
            'priority', 'priority_display', 'required_by_date', 'justification',
            'approval_status', 'approval_status_display', 'visibility_scope',
            'notes', 'allow_rfq_skip', 'preferred_vendor', 'preferred_vendor_name',
            'approved_by', 'approved_by_name', 'created_by_name', 'approved_at', 'reject_reason',
            'linked_rfq', 'linked_rfq_no', 'sales_order', 'sales_order_no',
            'has_po', 'fully_converted',
            'line_count', 'skipped_line_count',
            'product_names', 'lines', 'approval_trails', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'pr_no', 'request_date', 'approved_by', 'approved_at',
            'linked_rfq', 'created_at', 'updated_at'
        ]
        extra_kwargs = {
            'company': {'required': False, 'allow_null': True},
            'sales_order': {'required': False, 'allow_null': True},
            'requested_by': {'required': False, 'allow_null': True},
            'godown': {'required': False, 'allow_null': True},
            'godown_ids': {'required': False},
            'preferred_vendor': {'required': False, 'allow_null': True},
            'requestor_role': {'required': False, 'allow_blank': True},
            'requirement_type': {'required': False, 'allow_blank': True},
            'priority': {'required': False, 'allow_blank': True},
            'required_by_date': {'required': False},
            'justification': {'required': False, 'allow_blank': True},
            'approval_status': {'required': False, 'allow_blank': True},
            'visibility_scope': {'required': False},
            'notes': {'required': False, 'allow_blank': True},
        }

    def validate_required_by_date(self, value):
        if value and value < timezone.now().date():
            raise serializers.ValidationError("Required date cannot be in the past")
        return value

    def validate_visibility_scope(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Visibility scope must be a JSON object")
        return value

    def validate_allow_rfq_skip(self, value):
        # Only Admins, Purchase Coordinators, and Purchase Managers may enable RFQ Skip.
        if not value:
            return value
        request = self.context.get('request')
        user = getattr(request, 'user', None) if request else None
        from .permissions import user_can_skip_rfq
        if not user_can_skip_rfq(user):
            raise serializers.ValidationError("You are not authorized to skip RFQ.")
        return value

    def validate(self, data):
        """Cross-field validation: line categories must be consistent with the PR's
        requirement_type. For GOODS, every line's category must be RAW_MATERIAL or
        FINISHED_GOODS. For non-GOODS, free-form text is allowed."""
        lines = data.get('lines')
        if lines:
            # Cap PR at MAX_PR_LINES lines per request. Beyond this a
            # single PR gets unwieldy to route (per-line vendor, price,
            # payment terms, held-line conversion) — split into two PRs.
            MAX_PR_LINES = 15
            if len(lines) > MAX_PR_LINES:
                raise serializers.ValidationError({
                    'lines': (
                        f"A Purchase Request can hold at most {MAX_PR_LINES} lines "
                        f"({len(lines)} received). Split the extras into a new PR."
                    )
                })
            req_type = (data.get('requirement_type')
                        or (self.instance.requirement_type if self.instance else 'GOODS')
                        or 'GOODS').upper()
            for idx, line in enumerate(lines, start=1):
                category = (line.get('category') or '').strip()
                if not category:
                    raise serializers.ValidationError({
                        'lines': f"Category is required for line {idx}."
                    })
                if req_type == 'GOODS' and category not in ('RAW_MATERIAL', 'PACKING_MATERIAL', 'FINISHED_GOODS'):
                    raise serializers.ValidationError({
                        'lines': (
                            f"Line {idx}: when Requirement Type is Goods, Category "
                            f"must be Raw Material, Packing Material, or Finished Goods."
                        )
                    })
        return data

    def update(self, instance, validated_data):
        lines_data = validated_data.pop('lines', None)

        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if lines_data is not None:
            existing_lines = {line.id: line for line in instance.lines.all()}
            incoming_ids = set()

            for line_data in lines_data:
                line_data.pop('purchase_request', None)
                line_id = line_data.pop('id', None)

                if line_id and line_id in existing_lines:
                    line_obj = existing_lines[line_id]
                    for attr, value in line_data.items():
                        setattr(line_obj, attr, value)
                    line_obj.save()
                    incoming_ids.add(line_id)
                else:
                    new_line = PRLine.objects.create(purchase_request=instance, **line_data)
                    incoming_ids.add(new_line.id)

            for line_id, line_obj in existing_lines.items():
                if line_id not in incoming_ids:
                    line_obj.delete()

        return instance


class DispatchETAUpdateSerializer(serializers.ModelSerializer):
    """Serializer for RFQ ETA updates."""

    updated_by_name = serializers.CharField(
        source='updated_by.user.get_full_name',
        read_only=True
    )

    class Meta:
        model = DispatchETAUpdate
        fields = [
            'id', 'rfq', 'update_date', 'updated_by', 'updated_by_name',
            'expected_arrival', 'remarks'
        ]
        read_only_fields = ['id', 'update_date']
        extra_kwargs = {
            'expected_arrival': {'required': False},
            'remarks': {'required': False, 'allow_blank': True},
        }


class RFQHeaderSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for RFQ headers."""
    field_permission_module = 'RFQ'

    eta_updates = DispatchETAUpdateSerializer(
        source='eta_updates.all',
        many=True,
        read_only=True
    )
    created_by_name = serializers.CharField(
        source='created_by.user.get_full_name',
        read_only=True
    )
    purchase_manager_approval_name = serializers.CharField(
        source='purchase_manager_approval.user.get_full_name',
        read_only=True,
        allow_null=True
    )
    quote_count = serializers.SerializerMethodField()
    linked_pr_numbers = serializers.SerializerMethodField()
    rfq_mode_display = serializers.CharField(
        source='get_rfq_mode_display',
        read_only=True
    )
    rfq_status_display = serializers.CharField(
        source='get_rfq_status_display',
        read_only=True
    )
    email_sent = serializers.SerializerMethodField()
    # Vendors invited on this RFQ — derived from the EmailLog rows
    # created when the Send Email page ran. The Quote Response form
    # reads this to scope its vendor dropdown so an operator can only
    # record a quote against vendors that were actually invited. Without
    # this field the frontend's `rfqRes.data?.vendors` was always
    # undefined and the dropdown showed "No vendors invited".
    vendors = serializers.SerializerMethodField()
    # True once any quote on this RFQ has been chosen by the Evaluation
    # Dashboard (chosen_flag=True). Drives the RFQ list / detail UI to
    # disable the "Quote Response" button after evaluation so the
    # operator can't accidentally enter a new quote against an
    # already-decided RFQ.
    is_evaluated = serializers.SerializerMethodField()
    # Products required across this RFQ's linked PRs (list-view column).
    product_names = serializers.SerializerMethodField()
    # company_code of the BUYING company (first linked PR's company, else that
    # PR's warehouse company). The Send-RFQ page passes this to the resolved-
    # sender endpoint so the preview shows the per-company purchase mailbox
    # (e.g. UAI's) that the send will actually use.
    company_code = serializers.SerializerMethodField()

    def get_company_code(self, obj):
        for pr in obj.linked_prs.all():
            if pr.company_id:
                return pr.company.company_code or ''
        for pr in obj.linked_prs.all():
            wh = getattr(pr, 'warehouse', None)
            if wh is not None and getattr(wh, 'company_id', None):
                return wh.company.company_code or ''
        return ''

    def get_product_names(self, obj):
        # Skip-routed lines already have a direct PO — they are NOT part of
        # this RFQ, so the list column must not show them (a 1-of-3-skipped
        # PR's RFQ covers 2 products, not 3).
        return _names_from_lines(
            ln for pr in obj.linked_prs.all() for ln in pr.lines.all()
            if not ln.allow_rfq_skip
        )

    class Meta:
        model = RFQHeader
        fields = [
            'id', 'rfq_no', 'creation_date', 'created_by', 'created_by_name',
            'rfq_mode', 'rfq_mode_display', 'rfq_status', 'rfq_status_display',
            'quote_count_expected', 'quote_count', 'skip_rfq_flag',
            'skip_rfq_justification', 'purchase_manager_approval',
            'purchase_manager_approval_name', 'linked_prs', 'linked_pr_numbers', 'eta_updates',
            'email_sent', 'vendors', 'is_evaluated', 'product_names', 'company_code', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'rfq_no', 'creation_date', 'created_at', 'updated_at']
        extra_kwargs = {
            'rfq_mode': {'required': False, 'allow_blank': True},
            'rfq_status': {'required': False, 'allow_blank': True},
            'quote_count_expected': {'required': False},
            'skip_rfq_justification': {'required': False, 'allow_blank': True},
            'purchase_manager_approval': {'required': False},
        }

    def validate_linked_prs(self, value):
        """A PR flagged to skip RFQ goes straight to a PO — it must never be
        pulled into an RFQ (and therefore no quote/evaluation downstream)."""
        skipped = [pr.pr_no for pr in value if getattr(pr, 'allow_rfq_skip', False)]
        if skipped:
            raise serializers.ValidationError(
                f"RFQ was skipped for {', '.join(skipped)} — these requests cannot be added to an RFQ."
            )
        return value

    def get_quote_count(self, obj):
        return obj.get_active_quote_count()

    def get_linked_pr_numbers(self, obj):
        """Return PR numbers instead of UUIDs for linked purchase requests."""
        prs = obj.source_purchase_requests.all() if hasattr(obj, 'source_purchase_requests') else []
        if prs:
            return [pr.pr_no for pr in prs]
        if hasattr(obj, 'linked_prs'):
            return [pr.pr_no for pr in obj.linked_prs.all()]
        return []

    def get_email_sent(self, obj):
        try:
            from communications.models import EmailLog
            return EmailLog.objects.filter(rfq=obj, email_sent=True).exists()
        except Exception:
            return False

    def get_is_evaluated(self, obj):
        """True once the Evaluation Dashboard has chosen a quote on this
        RFQ — i.e. any linked QuoteResponse has chosen_flag=True. The
        list view uses this to disable the per-row "Quote Response"
        button so an evaluated RFQ can't accept further quotes."""
        try:
            return obj.quote_responses.filter(chosen_flag=True).exists()
        except Exception:
            return False

    def get_vendors(self, obj):
        """Distinct vendor IDs we recorded an RFQ email attempt for.

        We don't gate on `email_sent=True` here because the EmailLog row
        is created the moment the operator hits Send — even if Gmail
        rejects the credentials at SMTP, the vendor was still invited
        in intent and the operator may want to record a manually-
        collected quote against them. Returns string UUIDs so the
        frontend's `.map(String)` comparison lines up with the
        vendor-master IDs without ambiguity."""
        try:
            from communications.models import EmailLog
            return [
                str(vid) for vid in (
                    EmailLog.objects
                    .filter(rfq=obj, vendor__isnull=False)
                    .values_list('vendor_id', flat=True)
                    .distinct()
                )
            ]
        except Exception:
            return []


class QuoteLineSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for quote line items.

    Like PRLineSerializer and POLineSerializer, exposes the source item
    via two FKs (product_service / service_catalogue) with unified
    display fields so the same column renders for every line type
    without per-source conditionals on the page.
    """
    field_permission_module = 'Quote Line'

    product_name = serializers.CharField(
        source='product_service.product_name',
        read_only=True,
        default='',
    )
    product_code = serializers.CharField(
        source='product_service.sku_code',
        read_only=True,
        default='',
    )
    machinery_name = serializers.SerializerMethodField()
    service_catalogue_name = serializers.SerializerMethodField()
    # Unified display fields. Frontend should prefer these.
    item_type = serializers.SerializerMethodField()
    item_name = serializers.SerializerMethodField()
    item_code = serializers.SerializerMethodField()
    pr_line_description = serializers.CharField(
        source='pr_line.description_override',
        read_only=True
    )
    line_total = serializers.SerializerMethodField()

    class Meta:
        model = QuoteLine
        fields = [
            'id', 'quote', 'pr_line', 'pr_line_description',
            'product_service', 'product_name', 'product_code',
            'machinery_name',
            'service_catalogue', 'service_catalogue_name',
            'item_type', 'item_name', 'item_code',
            'specification', 'quantity_offered', 'uom',
            'unit_price', 'discount', 'gst', 'freight_charge',
            'delivery_timeline',
            'length', 'width', 'breadth', 'height',
            'line_total',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'product_service': {'required': False, 'allow_null': True},
            'service_catalogue': {'required': False, 'allow_null': True},
            'pr_line': {'required': False},
            'specification': {'required': False, 'allow_blank': True},
            'uom': {'required': False, 'allow_blank': True},
            'discount': {'required': False},
            'gst': {'required': False},
            'freight_charge': {'required': False},
            'delivery_timeline': {'required': False},
            'length': {'required': False, 'allow_null': True},
            'width': {'required': False, 'allow_null': True},
            'breadth': {'required': False, 'allow_null': True},
            'height': {'required': False, 'allow_null': True},
        }

    def get_machinery_name(self, obj):
        m = _machine_ref(obj)
        if not m:
            return ''
        return getattr(m, 'machine_name', None) or getattr(m, 'name', None) or str(m)

    def get_service_catalogue_name(self, obj):
        s = obj.service_catalogue
        if not s:
            return ''
        return f"{s.service_code} — {s.name}" if getattr(s, 'service_code', None) else s.name

    def get_item_type(self, obj):
        if _is_machinery_line(obj):
            return 'MACHINERY'
        if obj.service_catalogue_id:
            return 'SERVICE'
        return 'PRODUCT'

    def get_item_name(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'name', '') or ''
        if obj.product_service_id:
            return obj.product_service.product_name or ''
        return ''

    def get_item_code(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'service_code', '') or ''
        if obj.product_service_id:
            return obj.product_service.sku_code or ''
        return ''

    def validate(self, attrs):
        """Enforce exactly-one-of (product_service, machinery, service_catalogue)."""
        instance = getattr(self, 'instance', None)
        product = attrs.get('product_service', getattr(instance, 'product_service', None) if instance else None)
        service = attrs.get('service_catalogue', getattr(instance, 'service_catalogue', None) if instance else None)
        populated = sum(1 for v in (product, service) if v)
        if populated == 0:
            raise serializers.ValidationError(
                'Line must reference exactly one of product_service, machinery, or service_catalogue.'
            )
        if populated > 1:
            raise serializers.ValidationError(
                'Line cannot reference more than one of product_service, machinery, or service_catalogue.'
            )
        return attrs

    def get_line_total(self, obj):
        return str(obj.get_line_total())

    def validate_quantity_offered(self, value):
        if value <= 0:
            raise serializers.ValidationError("Quantity must be greater than 0")
        return value

    def validate_unit_price(self, value):
        if value < 0:
            raise serializers.ValidationError("Unit price cannot be negative")
        return value


class QuoteResponseSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for quote responses."""
    field_permission_module = 'Quote'

    quote_lines = QuoteLineSerializer(many=True, read_only=True)
    vendor_name = serializers.CharField(source='vendor.vendor_name', read_only=True, default='')
    vendor_code = serializers.CharField(source='vendor.vendor_code', read_only=True, default='')
    rfq_no = serializers.CharField(source='rfq.rfq_no', read_only=True, default='')
    total_cost = serializers.SerializerMethodField()
    pr_numbers = serializers.SerializerMethodField()
    pr_ids = serializers.SerializerMethodField()
    # How many vendors this RFQ was emailed to = the number of quotes we
    # EXPECT to receive (the denominator for "all quotes recorded?").
    rfq_invited_count = serializers.SerializerMethodField()
    product_names = serializers.SerializerMethodField()

    def get_product_names(self, obj):
        return _names_from_lines(obj.quote_lines.all())

    class Meta:
        model = QuoteResponse
        fields = [
            'id', 'quote_id', 'rfq', 'rfq_no', 'pr_numbers', 'pr_ids', 'vendor', 'vendor_name', 'vendor_code',
            'vendor_name_text', 'quote_date',
            'price_valid_till', 'currency', 'freight_terms', 'payment_terms', 'custom_payment_terms',
            'delivery_terms', 'lead_time_days', 'remarks', 'evaluation_score',
            'chosen_flag', 'quote_lines', 'total_cost', 'rfq_invited_count', 'product_names', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'quote_id', 'quote_date', 'created_at', 'updated_at']
        extra_kwargs = {
            'vendor_name_text': {'required': False, 'allow_blank': True},
            'price_valid_till': {'required': False},
            'currency': {'required': False, 'allow_blank': True},
            'freight_terms': {'required': False, 'allow_blank': True},
            'payment_terms': {'required': False, 'allow_blank': True},
            'custom_payment_terms': {'required': False, 'allow_blank': True},
            'delivery_terms': {'required': False, 'allow_blank': True},
            'lead_time_days': {'required': False},
            'remarks': {'required': False, 'allow_blank': True},
            'evaluation_score': {'required': False},
        }

    def get_total_cost(self, obj):
        return str(obj.get_total_cost())

    def get_pr_numbers(self, obj):
        """Get PR numbers linked through the RFQ."""
        if obj.rfq:
            prs = obj.rfq.linked_prs.all()
            return [pr.pr_no for pr in prs]
        return []

    def get_pr_ids(self, obj):
        """Get PR IDs linked through the RFQ."""
        if obj.rfq:
            return [str(pr.id) for pr in obj.rfq.linked_prs.all()]
        return []

    def get_rfq_invited_count(self, obj):
        """Distinct vendors this RFQ was emailed to (the 'expected quotes').

        Cached per-RFQ on the shared serializer context so a list of many
        quotes for the same RFQ runs one count, not one per quote.
        """
        if not obj.rfq_id:
            return 0
        cache = self.context.get('_invited_cache')
        if cache is None:
            cache = {}
            self.context['_invited_cache'] = cache
        if obj.rfq_id in cache:
            return cache[obj.rfq_id]
        try:
            from communications.models import EmailLog
            n = (EmailLog.objects
                 .filter(rfq_id=obj.rfq_id, email_sent=True)
                 .values('vendor').distinct().count())
        except Exception:
            n = 0
        cache[obj.rfq_id] = n
        return n


class ComparisonEntrySerializer(serializers.ModelSerializer):
    """Serializer for quote comparison entries."""

    vendor_name = serializers.CharField(
        source='vendor.vendor_name',
        read_only=True
    )

    class Meta:
        model = ComparisonEntry
        fields = [
            'id', 'evaluation', 'vendor', 'vendor_name', 'total_cost',
            'lead_time', 'freight_terms', 'payment_terms', 'score', 'remarks'
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'total_cost': {'required': False},
            'lead_time': {'required': False},
            'freight_terms': {'required': False, 'allow_blank': True},
            'payment_terms': {'required': False, 'allow_blank': True},
            'score': {'required': False},
            'remarks': {'required': False, 'allow_blank': True},
        }


class EvalApprovalTrailSerializer(serializers.ModelSerializer):
    """Serializer for evaluation approval trails."""

    actor_name = serializers.CharField(
        source='actor.user.get_full_name',
        read_only=True
    )

    class Meta:
        model = EvalApprovalTrail
        fields = [
            'id', 'evaluation', 'actor', 'actor_name', 'action',
            'action_date', 'remarks'
        ]
        read_only_fields = ['id', 'action_date']
        extra_kwargs = {
            'remarks': {'required': False, 'allow_blank': True},
        }


class QuoteEvaluationSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for quote evaluations."""
    field_permission_module = 'Quote Evaluation'

    comparison_entries = ComparisonEntrySerializer(many=True, read_only=True)
    approval_trails = EvalApprovalTrailSerializer(many=True, read_only=True)
    rfq_no = serializers.CharField(source='rfq.rfq_no', read_only=True, default='')
    evaluated_by_name = serializers.SerializerMethodField()
    recommended_vendor_name = serializers.CharField(
        source='recommended_vendor.vendor_name',
        read_only=True,
        default=''
    )
    approval_status_display = serializers.CharField(
        source='get_approval_status_display',
        read_only=True
    )
    linked_pr_numbers = serializers.SerializerMethodField()
    linked_pr_ids = serializers.SerializerMethodField()
    # Products under evaluation, from the RFQ's linked PRs (list-view column).
    product_names = serializers.SerializerMethodField()

    def get_product_names(self, obj):
        if not obj.rfq_id:
            return []
        # Same skip filter as the RFQ list — skipped lines aren't evaluated.
        return _names_from_lines(
            ln for pr in obj.rfq.linked_prs.all() for ln in pr.lines.all()
            if not ln.allow_rfq_skip
        )

    class Meta:
        model = QuoteEvaluation
        fields = [
            'id', 'evaluation_id', 'rfq', 'rfq_no', 'linked_pr_numbers', 'linked_pr_ids',
            'evaluation_date', 'evaluated_by',
            'evaluated_by_name', 'best_quote_flag', 'recommended_vendor',
            'recommended_vendor_name', 'justification_notes', 'approval_status',
            'approval_status_display', 'comparison_entries', 'approval_trails',
            'product_names', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'evaluation_id', 'evaluation_date', 'created_at', 'updated_at']
        extra_kwargs = {
            'recommended_vendor': {'required': False},
            'justification_notes': {'required': False, 'allow_blank': True},
            'approval_status': {'required': False, 'allow_blank': True},
        }

    def get_evaluated_by_name(self, obj):
        if obj.evaluated_by and hasattr(obj.evaluated_by, 'user'):
            return obj.evaluated_by.user.get_full_name() or obj.evaluated_by.user.username
        return '-'

    def get_linked_pr_numbers(self, obj):
        if obj.rfq and hasattr(obj.rfq, 'linked_prs'):
            return [pr.pr_no for pr in obj.rfq.linked_prs.all()]
        return []

    def get_linked_pr_ids(self, obj):
        if obj.rfq and hasattr(obj.rfq, 'linked_prs'):
            return [str(pr.id) for pr in obj.rfq.linked_prs.all()]
        return []


class POLineSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for PO line items.

    Mirrors PRLineSerializer's two-FK shape: exactly one of
    (product_service, service_catalogue) is populated per line. Exposes
    display name/code for each so the frontend can render a single
    Product column regardless of source.
    """
    field_permission_module = 'Purchase Order Line'

    product_name = serializers.CharField(
        source='product_service.product_name',
        read_only=True,
        default='',
    )
    product_code = serializers.CharField(
        source='product_service.sku_code',
        read_only=True,
        default='',
    )
    # Surface the SG-applicable flag on the linked Product so the receipt
    # form can conditionally show the Specific Gravity input on receipt
    # lines that draw from PO lines whose product is 'buy kg / consume L'.
    product_sg_applicable = serializers.BooleanField(
        source='product_service.sg_applicable',
        read_only=True,
        default=False,
    )
    machinery_name = serializers.SerializerMethodField()
    service_catalogue_name = serializers.SerializerMethodField()
    # Unified display fields — the frontend should prefer these so the
    # same column renders for every line type without per-source
    # conditionals scattered across pages.
    item_type = serializers.SerializerMethodField()
    item_name = serializers.SerializerMethodField()
    item_code = serializers.SerializerMethodField()
    line_total = serializers.SerializerMethodField()
    received_quantity = serializers.SerializerMethodField()
    # Godown from the originating PR (for receipt-form auto-fill).
    pr_godown = serializers.UUIDField(
        source='linked_pr_line.purchase_request.godown_id',
        read_only=True,
        default=None,
    )
    # UOM on the originating PR line — used by the receipt form to know
    # when to surface the Density input (LTR → liquid intake). Falls back
    # to '' for legacy PO lines with no PR link.
    pr_line_uom = serializers.CharField(
        source='linked_pr_line.uom',
        read_only=True, default='',
    )
    # Category from the originating PR line. The Receipt form uses
    # this to route a line into the right section: PACKING_MATERIAL
    # lines flow into the Packing Materials subform, everything else
    # into Receipt Line Items. POLine itself doesn't carry category —
    # we resolve it from the originating PR.
    #
    # Two paths can reach a PO line; linked_pr_line is set in only
    # one of them out of the box:
    #
    #   PR → Direct PO (RFQ skip) → linked_pr_line set at PO create.
    #   PR → RFQ → Quote → PO     → linked_pr_line set IF the Quote
    #                                line carried pr_line. We now set
    #                                that in the add-line endpoint
    #                                (purchase/views.py add_line), but
    #                                quotes saved before that fix have
    #                                pr_line=NULL and the chain breaks.
    #
    # The resolver below falls back to walking the RFQ → linked_prs
    # chain and matching by the item FK so legacy POs keep working
    # without a data migration.
    pr_line_category = serializers.SerializerMethodField()

    class Meta:
        model = POLine
        fields = [
            'id', 'po', 'line_no',
            'product_service', 'product_name', 'product_code', 'product_sg_applicable',
            'machinery_name',
            'service_catalogue', 'service_catalogue_name',
            'item_type', 'item_name', 'item_code',
            'description', 'specification', 'quantity_ordered', 'uom',
            'unit_price', 'discount', 'gst', 'extra_commission',
            'agent_commission', 'freight_estimate', 'delivery_schedule',
            'linked_pr_line', 'linked_rfq_line', 'batch_requirement_notes',
            'pr_godown', 'pr_line_uom',
            # `category` is the editable per-PO override (defaults to ''
            # which makes pr_line_category fall back to the PR-resolved
            # value). `pr_line_category` is the resolved value the
            # frontend should READ — it honours category first, then
            # walks back to the PR chain.
            'category', 'pr_line_category',
            'line_total', 'received_quantity', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']
        extra_kwargs = {
            'product_service': {'required': False, 'allow_null': True},
            'service_catalogue': {'required': False, 'allow_null': True},
            'description': {'required': False, 'allow_blank': True},
            'uom': {'required': False, 'allow_blank': True},
            'discount': {'required': False},
            'gst': {'required': False},
            'extra_commission': {'required': False},
            'agent_commission': {'required': False},
            'freight_estimate': {'required': False},
            'delivery_schedule': {'required': False},
            'linked_pr_line': {'required': False},
            'linked_rfq_line': {'required': False},
            'batch_requirement_notes': {'required': False, 'allow_blank': True},
            'category': {'required': False, 'allow_blank': True},
            'specification': {'required': False, 'allow_blank': True},
        }

    def get_machinery_name(self, obj):
        m = _machine_ref(obj)
        if not m:
            return ''
        return getattr(m, 'machine_name', None) or getattr(m, 'name', None) or str(m)

    def get_service_catalogue_name(self, obj):
        s = obj.service_catalogue
        if not s:
            return ''
        return f"{s.service_code} — {s.name}" if getattr(s, 'service_code', None) else s.name

    def get_pr_line_category(self, obj):
        """Resolve the effective category for this PO line.

        Strategy, in order:
          0. obj.category — explicit per-PO override. Set when the
             operator typed it on the PO form or when PO-create copied
             it from the originating PR (see services.py / views.py
             PO-create flows). Authoritative when present.
          1. obj.linked_pr_line.category  — direct FK (RFQ-skip path,
             plus Quote → PO path for quotes saved with pr_line set).
          2. linked_rfq_line.pr_line.category — Quote line carried the
             PR linkage even though POLine.linked_pr_line wasn't echoed
             across (legacy Quote→PO snapshots).
          3. linked_rfq_line.quote.rfq.linked_prs * pr_lines, matched
             by item FK. Rescues legacy POs whose quote line dropped
             pr_line entirely.

        Returns '' when nothing matches — Receipt form treats it as a
        goods line (pre-feature default), preserving backward compat.
        """
        # Path 0 — explicit override on the PO line itself
        own = getattr(obj, 'category', '') or ''
        if own.strip():
            return own
        # Path 1 — direct linked_pr_line FK
        pr_line = getattr(obj, 'linked_pr_line', None)
        if pr_line and getattr(pr_line, 'category', ''):
            return pr_line.category

        # Path 2 — quote line carried pr_line even if PO didn't echo it
        rfq_line = getattr(obj, 'linked_rfq_line', None)
        if rfq_line is not None:
            ql_pr_line = getattr(rfq_line, 'pr_line', None)
            if ql_pr_line and getattr(ql_pr_line, 'category', ''):
                return ql_pr_line.category

        # Path 3 — walk RFQ.linked_prs and match by item FK. PRLine is
        # imported lazily to avoid circular imports at module load.
        if rfq_line is not None:
            quote = getattr(rfq_line, 'quote', None)
            rfq = getattr(quote, 'rfq', None) if quote else None
            if rfq is not None:
                from .models import PRLine
                match_kwargs = {}
                if obj.product_service_id:
                    match_kwargs['product_service_id'] = obj.product_service_id
                elif obj.service_catalogue_id:
                    match_kwargs['service_catalogue_id'] = obj.service_catalogue_id
                if match_kwargs:
                    pr_match = (
                        PRLine.objects
                        .filter(purchase_request__rfqs=rfq, **match_kwargs)
                        .order_by('purchase_request_id', 'line_no')
                        .values_list('category', flat=True)
                        .first()
                    )
                    if pr_match:
                        return pr_match
        return ''

    def get_item_type(self, obj):
        if _is_machinery_line(obj):
            return 'MACHINERY'
        if obj.service_catalogue_id:
            return 'SERVICE'
        # Default to PRODUCT even when product_service is null so legacy
        # rows (pre-migration) still serialise without breaking the UI —
        # they'll just have empty names, which the page already handles.
        return 'PRODUCT'

    def get_item_name(self, obj):
        if obj.service_catalogue_id:
            s = obj.service_catalogue
            return s.name if s else ''
        if obj.product_service_id:
            return obj.product_service.product_name or ''
        return ''

    def get_item_code(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'service_code', '') or ''
        if obj.product_service_id:
            return obj.product_service.sku_code or ''
        return ''

    def validate(self, attrs):
        """Enforce exactly-one-of (product_service, machinery, service_catalogue).
        Mirrors PRLineSerializer.validate so the rule is identical across
        purchase line models.
        """
        # On partial updates merge incoming attrs over the instance's
        # current FKs so we don't false-positive a missing field that the
        # caller didn't touch.
        instance = getattr(self, 'instance', None)
        product = attrs.get('product_service', getattr(instance, 'product_service', None) if instance else None)
        service = attrs.get('service_catalogue', getattr(instance, 'service_catalogue', None) if instance else None)
        populated = sum(1 for v in (product, service) if v)
        if populated == 0:
            raise serializers.ValidationError(
                'Line must reference exactly one of product_service, machinery, or service_catalogue.'
            )
        if populated > 1:
            raise serializers.ValidationError(
                'Line cannot reference more than one of product_service, machinery, or service_catalogue.'
            )
        return attrs

    def get_line_total(self, obj):
        return str(obj.get_line_total())

    def get_received_quantity(self, obj):
        """Total quantity already received against this PO line.

        Invoice-driven: counts vendor-invoiced qty (quantity_received)
        regardless of is_debit_note. PO balance closes when invoiced
        sum = ordered; any physical shortfall (quantity_received −
        net_quantity) is tracked via Debit Notes, NOT by inflating
        the remaining balance. Drives the Create-Receipt form's Rcvd
        / Balance columns and the per-line `max` cap, so this MUST
        match PurchaseOrder.get_total_received and the validate()
        check in CreateUpdateReceiptSerializer or the form / save /
        close paths disagree.

        Sums BOTH ReceiptLine (Goods) and PackingMaterialLine (Packing
        Material). A packing-material PO line's receipts land in the
        packing_materials subform, not receipt_lines, and were silently
        missing from the balance calculation — leaving Rcvd stuck at 0
        even after multiple packing receipts and blocking the pending
        prefill on subsequent receipts.

        Only excludes soft-deleted receipts (is_active=False) — a deleted
        receipt's lines aren't real stock and must not inflate this total.
        DRAFT is deliberately still counted: ReceiptAdvice.approval_status
        only has DRAFT/APPROVED, DRAFT is the default every receipt starts
        in, and a receipt sitting in draft still represents real recorded
        intake — excluding it (as an earlier version of this fix did) made
        freshly-received, not-yet-approved goods show as 0 received / fully
        outstanding, which is wrong in the other direction.
        """
        po_id = getattr(obj, 'po_id', None)
        rl_map, pml_map = self._recv_maps(po_id)
        rl_total = rl_map.get(obj.pk) or 0
        pml_direct = pml_map.get(obj.pk) or 0
        pml_fb_total = 0
        # Resolved lazily: a PO whose lines carry no product_service never pays
        # for the fallback pair at all, matching the old per-line behaviour.
        if getattr(obj, 'product_service_id', None) and po_id:
            pml_fb_total = self._fb_map(po_id).get(obj.product_service_id) or 0
        return float(rl_total) + float(pml_direct) + float(pml_fb_total)

    def _page_po_ids(self):
        """Every PurchaseOrder in THIS response, or None when that is unknown.

        The maps below were already batched once - from one query per LINE to
        one query per PO. That is still one round trip per row, so a 100-row
        page paid 100 of them. `self.root` is the ListSerializer DRF wraps the
        page in, and its `.instance` is the page itself, so the same arithmetic
        can be grouped by po_id and answered for the whole page at once.

        Returns None rather than guessing when there is no list to read (a
        detail route, a create response), and every caller then falls back to
        the single PO it was asked about - same query it ran before.
        """
        return _page_pks(self)

    def _store(self, bucket):
        """Per-response memo shared with the parent serializer.

        DRF's `.context` property returns the ROOT serializer's context dict,
        so a nested line serializer and its PO parent see the same object. Must
        be tested with `isinstance`, not truthiness — an empty context is a
        perfectly good (and very common) dict, and `if self.context` would
        silently hand back a throwaway, turning the memo into a no-op.
        """
        return _ctx_store(self, bucket)

    def _recv_maps(self, po_id):
        """Received quantities for EVERY line of one PO, in four queries.

        This used to run per LINE: two aggregates plus, for any line carrying a
        product_service (which is every ordinary Goods line, not just packing
        SKUs), a further two for the legacy fallback. On the PO list that was
        the single largest cost — measured at 8 of the 11 queries per row, so a
        500-row page spent thousands of round trips here.

        Same arithmetic, grouped instead of looped: the totals are bucketed by
        po_line_id and by packaging_sku_id, and each line reads its own entry.
        The fallback still collects DISTINCT ids before aggregating, because
        the `receipt__linked_pos` M2M join double-counts a receipt linked to
        more than one PO — dropping that dedupe would inflate the figure.

        Cached on the serializer context, which DRF shares with the parent, so
        one PO's lines resolve it once however many lines it has.
        """
        from django.db.models import Q, Sum
        store = self._store('_po_line_recv')
        if po_id in store:
            return store[po_id]
        live = Q(receipt__is_active=True)
        # Every PO on the page in one pair of queries. Adding po_id to the
        # GROUP BY cannot change any individual total: a ReceiptLine /
        # PackingMaterialLine reaches exactly one po_line, which reaches
        # exactly one PO, so the buckets only get labelled, never merged.
        ids = self._page_po_ids() or []
        if po_id not in ids:
            ids = list(ids) + [po_id]
        rl_all, pml_all = {}, {}
        for pid, lid, t in (
            ReceiptLine.objects.filter(live, po_line__po_id__in=ids)
            .values('po_line__po_id', 'po_line_id')
            .annotate(t=Sum('quantity_received'))
            .values_list('po_line__po_id', 'po_line_id', 't')
        ):
            rl_all.setdefault(pid, {})[lid] = t
        for pid, lid, t in (
            PackingMaterialLine.objects.filter(live, po_line__po_id__in=ids)
            .values('po_line__po_id', 'po_line_id')
            .annotate(t=Sum('quantity'))
            .values_list('po_line__po_id', 'po_line_id', 't')
        ):
            pml_all.setdefault(pid, {})[lid] = t
        for pid in ids:
            store[pid] = (rl_all.get(pid, {}), pml_all.get(pid, {}))
        return store[po_id]

    def _fb_map(self, po_id):
        """{packaging_sku_id: qty} for this PO's legacy no-po_line packing rows.

        DISTINCT ids are collected before aggregating because the
        `receipt__linked_pos` M2M join double-counts a receipt linked to more
        than one PO — exactly the dedupe the per-line version did.
        """
        from django.db.models import Q, Sum
        store = self._store('_po_line_fb')
        if po_id in store:
            return store[po_id]
        live = Q(receipt__is_active=True)
        ids = self._page_po_ids() or []
        if po_id not in ids:
            ids = list(ids) + [po_id]
        # One query for the whole page. The row's own PO comes back alongside
        # it, which is what keeps the dedupe correct: a receipt linked to two
        # POs still yields that line once PER PO, exactly as a per-PO query
        # did, because (po, id) is distinct even though id alone is not.
        rows = (
            PackingMaterialLine.objects.filter(
                live, po_line__isnull=True, receipt__linked_pos__in=ids,
            )
            .values_list('receipt__linked_pos', 'id', 'packaging_sku_id', 'quantity')
            .distinct()
        )
        per_po = {}
        for pid, _lid, sku, qty in rows:
            if sku is None:
                continue
            bucket = per_po.setdefault(pid, {})
            bucket[sku] = (bucket.get(sku) or 0) + (qty or 0)
        for pid in ids:
            store[pid] = per_po.get(pid, {})
        return store[po_id]


class POETAUpdateSerializer(serializers.ModelSerializer):
    """Serializer for PO ETA updates."""

    updated_by_name = serializers.CharField(
        source='updated_by.user.get_full_name',
        read_only=True
    )
    status_display = serializers.CharField(
        source='get_status_display',
        read_only=True
    )

    class Meta:
        model = POETAUpdate
        fields = [
            'id', 'po', 'update_date', 'updated_by', 'updated_by_name',
            'expected_arrival_date', 'status', 'status_display', 'remarks'
        ]
        read_only_fields = ['id', 'update_date']
        extra_kwargs = {
            'expected_arrival_date': {'required': False},
            'status': {'required': False, 'allow_blank': True},
            'remarks': {'required': False, 'allow_blank': True},
        }


def _coerce_address_blob(s):
    """Best-effort parse of a stringified address into a dict/list.

    A JSONField normally hands back a real dict, but some call sites pass a
    str that is itself a JSON blob — or worse, a Python-dict repr produced by
    an earlier `str(dict)`. Parse both so we never print a raw
    "{'state': ...}" on a document. Returns None if it can't be parsed.
    """
    import json
    try:
        return json.loads(s)
    except Exception:
        pass
    try:
        import ast
        return ast.literal_eval(s)
    except Exception:
        return None


def _fmt_address(addr):
    """Flatten a JSONField address (dict / list / str) into one display line.

    Handles the various key shapes used across the app: the street lives
    under any of street/line1/address_line/raw_address/line, the city under
    city/district, and the PIN under pincode/postal_code/pin. Used by the
    printable PO document (and the PO email/PDF) so the header, Supplier,
    Bill To and Deliver To blocks render from live master data as a clean
    human-readable line rather than a raw dict.
    """
    if not addr:
        return ''
    if isinstance(addr, str):
        # Could be a plain address line, or a stringified JSON/dict blob.
        s = addr.strip()
        if s[:1] in ('{', '['):
            parsed = _coerce_address_blob(s)
            if parsed is None:
                return s
            addr = parsed
        else:
            return s
    if isinstance(addr, list):
        return ', '.join(str(a).strip() for a in addr if str(a).strip())
    if isinstance(addr, dict):
        street = (addr.get('street') or addr.get('line1') or addr.get('address_line')
                  or addr.get('raw_address') or addr.get('line') or '')
        parts = [street,
                 addr.get('city') or addr.get('district') or '',
                 addr.get('state') or '',
                 addr.get('pincode') or addr.get('postal_code') or addr.get('pin') or '',
                 addr.get('country') or '']
        return ', '.join(str(p).strip() for p in parts if str(p).strip())
    return str(addr)


class PurchaseOrderSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for purchase orders."""
    field_permission_module = 'Purchase Order'

    po_lines = POLineSerializer(many=True, read_only=True)
    eta_updates = POETAUpdateSerializer(
        source='eta_updates.all',
        many=True,
        read_only=True
    )
    vendor_name = serializers.CharField(
        source='vendor.vendor_name',
        read_only=True,
        default=''
    )
    company_name = serializers.CharField(
        source='company.legal_name',
        read_only=True,
        default=''
    )
    warehouse_name = serializers.CharField(
        source='warehouse.name',
        read_only=True,
        default=''
    )
    transporter_name = serializers.CharField(
        source='transporter.name',
        read_only=True,
        default=''
    )
    # ── Printable-PO-document fields ──────────────────────────────────
    # Tax identifiers + addresses pulled from the linked masters so the
    # PO print template renders its header / Supplier / Bill To / Deliver
    # To blocks entirely from live master data. All read-only.
    company_gstin = serializers.CharField(source='company.gstin', read_only=True, default='')
    company_pan = serializers.CharField(source='company.pan', read_only=True, default='')
    company_phone = serializers.CharField(source='company.contact_phone', read_only=True, default='')
    company_trade_name = serializers.CharField(source='company.trade_name', read_only=True, default='')
    company_address = serializers.SerializerMethodField()
    company_billing_address = serializers.SerializerMethodField()
    vendor_code = serializers.CharField(source='vendor.vendor_code', read_only=True, default='')
    vendor_gstin = serializers.CharField(source='vendor.gstin', read_only=True, default='')
    vendor_gst_type = serializers.CharField(source='vendor.gst_type', read_only=True, default='')
    vendor_address = serializers.SerializerMethodField()
    warehouse_address = serializers.SerializerMethodField()

    def get_company_address(self, obj):
        return _fmt_address(getattr(obj.company, 'registered_address', None)) if obj.company_id else ''

    def get_company_billing_address(self, obj):
        if not obj.company_id:
            return ''
        return (_fmt_address(getattr(obj.company, 'billing_address', None))
                or _fmt_address(getattr(obj.company, 'registered_address', None)))

    def _addr_with_columns(self, entity):
        """Join a JSON address blob with the entity's own city/state/pincode
        columns (Vendor / Warehouse keep both)."""
        base = _fmt_address(getattr(entity, 'address', None))
        tail = ', '.join(p for p in [getattr(entity, 'city', '') or '',
                                     getattr(entity, 'state', '') or '',
                                     getattr(entity, 'pincode', '') or ''] if p)
        if base and tail:
            return f'{base}, {tail}'
        return base or tail

    def get_vendor_address(self, obj):
        return self._addr_with_columns(obj.vendor) if obj.vendor_id else ''

    def get_warehouse_address(self, obj):
        return self._addr_with_columns(obj.warehouse) if obj.warehouse_id else ''

    total_order_value = serializers.SerializerMethodField()
    total_received = serializers.SerializerMethodField()
    is_fully_received = serializers.SerializerMethodField()
    linked_pr_numbers = serializers.SerializerMethodField()
    status_display = serializers.CharField(
        source='get_status_display',
        read_only=True
    )
    # Receipt-aware status — keeps the existing `status` (DRAFT/APPROVED/
    # ISSUED/CLOSED/CANCELLED) but overrides display with RECEIVED /
    # PARTIALLY_RECEIVED when receipts exist.
    fulfillment_status = serializers.SerializerMethodField()
    fulfillment_status_display = serializers.SerializerMethodField()
    email_sent = serializers.SerializerMethodField()
    product_names = serializers.SerializerMethodField()

    def _store(self, bucket):
        """Per-response memo - see _ctx_store. Lets the page-wide maps below
        be built once and read by every row."""
        return _ctx_store(self, bucket)

    def get_product_names(self, obj):
        return _names_from_lines(obj.po_lines.all())

    class Meta:
        model = PurchaseOrder
        fields = [
            'id', 'po_no', 'revision_no', 'vendor', 'vendor_name', 'company',
            'company_name', 'warehouse', 'warehouse_name', 'linked_rfq',
            'po_date', 'expected_delivery_start', 'expected_delivery_end',
            'freight_terms', 'transporter', 'transporter_name', 'payment_terms', 'currency', 'terms_and_conditions',
            'broker_name',
            # Printable-PO-document fields (read-only, master-derived)
            'company_gstin', 'company_pan', 'company_phone', 'company_trade_name',
            'company_address', 'company_billing_address',
            'vendor_code', 'vendor_gstin', 'vendor_gst_type', 'vendor_address',
            'warehouse_address',
            'status', 'status_display', 'partial_receipt_flag', 'linked_prs',
            'linked_pr_numbers',
            'po_lines', 'eta_updates', 'total_order_value', 'total_received',
            'is_fully_received', 'fulfillment_status', 'fulfillment_status_display',
            'email_sent', 'product_names', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'po_no', 'revision_no', 'po_date', 'created_at', 'updated_at'
        ]
        extra_kwargs = {
            'vendor': {'required': False},
            'linked_rfq': {'required': False},
            'expected_delivery_start': {'required': False},
            'expected_delivery_end': {'required': False},
            'freight_terms': {'required': False, 'allow_blank': True},
            'payment_terms': {'required': False, 'allow_blank': True},
            'currency': {'required': False, 'allow_blank': True},
            'terms_and_conditions': {'required': False, 'allow_blank': True},
            'broker_name': {'required': False, 'allow_blank': True},
            'status': {'required': False, 'allow_blank': True},
        }

    def _received(self, obj):
        """get_total_received(), computed at most ONCE per PO per response.

        The model method costs ~4 queries (receipt lines, packing-material
        lines, and the legacy no-po_line fallback pair), and THREE separate
        fields each asked for it independently: total_received,
        is_fully_received and _compute_fulfillment. That was ~12 of the 18
        queries this serializer ran per row — on a 500-row page, ~6,000 round
        trips for one list request.

        Cached on `obj`, exactly like _fulfillment_cache, and for the same
        reason: within one serialization pass nothing can change what this PO
        has received. Deliberately cached HERE and not on the model, because
        the model method is also used by write paths (receipt approval) where
        a stale read would be wrong.
        """
        cached = getattr(obj, '_received_cache', None)
        if cached is not None:
            return cached
        # One call for every PO in the response. PurchaseOrder.totals_received
        # is the same arithmetic the single-PO method runs - the single-PO
        # method IS this method with one id - so batching cannot change a
        # figure, only how many round trips it took to get it.
        store = self._store('_po_received')
        if obj.pk not in store:
            ids = _page_pks(self) or [obj.pk]
            if obj.pk not in ids:
                ids = list(ids) + [obj.pk]
            store.update(PurchaseOrder.totals_received(ids))
            store.setdefault(obj.pk, None)
        cached = store.get(obj.pk)
        if cached is None:
            cached = obj.get_total_received()
        obj._received_cache = cached
        return cached

    def get_total_order_value(self, obj):
        store = self._store('_po_order_value')
        if obj.pk not in store:
            ids = _page_pks(self) or [obj.pk]
            if obj.pk not in ids:
                ids = list(ids) + [obj.pk]
            store.update(PurchaseOrder.totals_order_value(ids))
            store.setdefault(obj.pk, None)
        return str(store.get(obj.pk) or Decimal('0.00'))

    def get_total_received(self, obj):
        return str(self._received(obj))

    def get_is_fully_received(self, obj):
        # Same comparison as PurchaseOrder.is_fully_received(), but reading the
        # cached received figure and the ALREADY-PREFETCHED lines instead of
        # re-running the four-query aggregate. Identical arithmetic.
        ordered = sum((line.quantity_ordered for line in obj.po_lines.all()),
                      Decimal('0'))
        return self._received(obj) >= ordered

    def _compute_fulfillment(self, obj):
        """Return ('STATUS_CODE', 'Display Label') reflecting receipts.
        CLOSED / CANCELLED short-circuit — receipts don't change those.
        Otherwise: fully-received → RECEIVED; partial → PARTIALLY_RECEIVED;
        else fall back to the underlying PO status.

        Cached on `obj` — get_fulfillment_status and
        get_fulfillment_status_display are two separate SerializerMethodFields
        that both need this, and DRF calls each independently per row with no
        way for one to know the other already computed it. Safe within one
        serialization pass: nothing between the two calls can change what
        this PO has received.
        """
        cached = getattr(obj, '_fulfillment_cache', None)
        if cached is not None:
            return cached
        from decimal import Decimal
        # Terminal states stay as-is.
        if obj.status in ('CANCELLED',):
            result = ('CANCELLED', 'Cancelled')
            obj._fulfillment_cache = result
            return result
        try:
            received = Decimal(str(self._received(obj) or 0))
            # Use line quantities, not value, for fulfillment check. Summed off
            # the PREFETCHED lines rather than re-aggregating in the database —
            # same figure, but it costs nothing on a list page where po_lines
            # is already loaded.
            ordered_qty = sum((ln.quantity_ordered for ln in obj.po_lines.all()),
                              Decimal('0')) or Decimal('0')
        except Exception:
            received = Decimal('0')
            ordered_qty = Decimal('0')
        if ordered_qty > 0 and received >= ordered_qty:
            result = ('RECEIVED', 'Received')
        elif received > 0:
            result = ('PARTIALLY_RECEIVED', 'Partially Received')
        else:
            # No receipts yet — use the PO's own status.
            result = (obj.status, obj.get_status_display())
        obj._fulfillment_cache = result
        return result

    def get_fulfillment_status(self, obj):
        return self._compute_fulfillment(obj)[0]

    def get_fulfillment_status_display(self, obj):
        return self._compute_fulfillment(obj)[1]

    def get_linked_pr_numbers(self, obj):
        """Return PR numbers for linked purchase requests."""
        return [pr.pr_no for pr in obj.linked_prs.all()]

    def get_email_sent(self, obj):
        """Has a PO email been sent for THIS specific PO?

        The PO send_email view stamps `[{po_no}]` into the EmailLog subject
        (see PurchaseOrderViewSet.send_email), so a subject/body match on the
        PO number is the reliable, PO-specific signal.

        We deliberately do NOT fall back to a "any recent non-RFQ email to
        this vendor" heuristic. That cross-contaminated sibling POs for the
        same vendor and falsely flagged a brand-new PO — e.g. one just created
        via Skip RFQ, for which nothing was sent — as "Mail Sent", which also
        hid its Send Mail button so the user couldn't send it either.
        """
        if not obj.vendor or not obj.po_no:
            return False
        try:
            from communications.models import EmailLog
            from django.db.models import Q
            store = self._store('_po_email_sent')
            if not store:
                # The icontains match cannot be expressed as an IN, so the sent
                # mail for the page's vendors is fetched ONCE and matched in
                # Python. Same test, same case-insensitivity, same OR across
                # subject and body - just not re-asked per row.
                ids = _page_pks(self)
                rows = None
                if ids:
                    pos = [p for p in getattr(getattr(self, 'root', None),
                                              'instance', []) or []]
                    vend = {p.vendor_id for p in pos if getattr(p, 'vendor_id', None)}
                    if vend:
                        rows = list(EmailLog.objects.filter(
                            vendor_id__in=vend, email_sent=True,
                        ).values_list('vendor_id', 'subject', 'body_preview'))
                if rows is None:
                    return EmailLog.objects.filter(
                        vendor=obj.vendor, email_sent=True,
                    ).filter(
                        Q(subject__icontains=obj.po_no)
                        | Q(body_preview__icontains=obj.po_no)
                    ).exists()
                for p in pos:
                    no = (p.po_no or '').lower()
                    hit = bool(no) and any(
                        v == p.vendor_id and (no in (sub_ or '').lower()
                                              or no in (body or '').lower())
                        for v, sub_, body in rows
                    )
                    store[p.pk] = hit
                store.setdefault('__built__', True)
            if obj.pk in store:
                return store[obj.pk]
            return EmailLog.objects.filter(
                vendor=obj.vendor, email_sent=True,
            ).filter(
                Q(subject__icontains=obj.po_no) | Q(body_preview__icontains=obj.po_no)
            ).exists()
        except Exception:
            return False


class PurchaseOrderListSerializer(PurchaseOrderSerializer):
    """The PO LIST page's columns, and nothing else. Opt-in via ?slim=1.

    Narrows the field list only - every field kept is still produced by
    PurchaseOrderSerializer's own method, so no value can change.

    The prize is `po_lines`: the line items of every PO, 347 KB of a 761 KB
    page, 46% of the payload, shipped so the page can render a table of PO
    HEADERS. It is never read there. The printable-PO document fields
    (company_gstin, vendor_address, warehouse_address and friends) go the same
    way - they exist for the printed PO, not the list.

    `product_names` stays: the page shows it, and it is served off the
    prefetched lines, not a fresh query.
    """

    class Meta(PurchaseOrderSerializer.Meta):
        fields = [
            'id', 'po_no', 'vendor', 'vendor_name', 'company', 'company_name',
            'warehouse', 'warehouse_name', 'linked_rfq', 'po_date',
            'expected_delivery_start', 'expected_delivery_end',
            'freight_terms', 'payment_terms', 'currency',
            'terms_and_conditions', 'broker_name', 'status',
            'linked_prs', 'linked_pr_numbers', 'total_order_value',
            'is_fully_received', 'fulfillment_status', 'email_sent',
            'product_names',
        ]



class ReceiptLineSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for receipt line items.

    Three-FK shape matches PRLine / POLine / QuoteLine. Note: stock
    ledger gating lives in ReceiptAdviceViewSet.approve — see comments
    there. The serializer just records the FKs and exposes unified
    display fields.
    """
    field_permission_module = 'Receipt Line'

    id = serializers.UUIDField(required=False, allow_null=True)
    product_name = serializers.CharField(source='product.product_name', read_only=True, default='')
    product_code = serializers.CharField(source='product.sku_code', read_only=True, default='')
    machinery_name = serializers.SerializerMethodField()
    service_catalogue_name = serializers.SerializerMethodField()
    item_type = serializers.SerializerMethodField()
    item_name = serializers.SerializerMethodField()
    item_code = serializers.SerializerMethodField()
    godown_name = serializers.CharField(source='godown_location.godown_name', read_only=True, default='')
    po_line_info = serializers.SerializerMethodField()
    po_unit_price = serializers.DecimalField(source='po_line.unit_price', max_digits=18, decimal_places=4, read_only=True, allow_null=True)
    po_gst = serializers.DecimalField(source='po_line.gst', max_digits=5, decimal_places=2, read_only=True, allow_null=True)
    # UOM of the linked PR line — walked through po_line → linked_pr_line
    # so the receipt form can conditionally show the Density input for
    # liquid receipts (LTR) without an extra fetch.
    pr_line_uom = serializers.SerializerMethodField()
    product_sg_applicable = serializers.BooleanField(source='product.sg_applicable', read_only=True, default=False)

    class Meta:
        model = ReceiptLine
        fields = [
            'id', 'line_no', 'po_line', 'po_line_info', 'po_unit_price', 'po_gst',
            'pr_line_uom',
            'product', 'product_name', 'product_code', 'product_sg_applicable',
            'machinery_name',
            'service_catalogue', 'service_catalogue_name',
            'item_type', 'item_name', 'item_code',
            'batch_no', 'expiry_date', 'quantity_received',
            'net_quantity', 'density', 'specific_gravity', 'quantity_in_litres', 'uom',
            'extra_commission', 'agent_commission', 'quantity_accepted',
            'quantity_rejected', 'godown_location', 'godown_name', 'remarks',
            'is_debit_note',
            'rate', 'gst_percentage',
            'length', 'breadth', 'width', 'weight',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['created_at', 'updated_at', 'quantity_in_litres']
        extra_kwargs = {
            'product': {'required': False, 'allow_null': True},
            'service_catalogue': {'required': False, 'allow_null': True},
            'po_line': {'required': False, 'allow_null': True},
            'batch_no': {'required': False, 'allow_blank': True},
            'expiry_date': {'required': False},
            'uom': {'required': False, 'allow_blank': True},
            'extra_commission': {'required': False},
            'agent_commission': {'required': False},
            'net_quantity': {'required': False, 'allow_null': True},
            'quantity_accepted': {'required': False},
            'quantity_rejected': {'required': False},
            'godown_location': {'required': False, 'allow_null': True},
            'remarks': {'required': False, 'allow_blank': True},
            'is_debit_note': {'required': False},
            'rate': {'required': False, 'allow_null': True},
            'gst_percentage': {'required': False, 'allow_null': True},
            'length': {'required': False, 'allow_null': True},
            'breadth': {'required': False, 'allow_null': True},
            'width': {'required': False, 'allow_null': True},
            'weight': {'required': False, 'allow_null': True},
            'specific_gravity': {'required': False, 'allow_null': True},
        }

    def get_machinery_name(self, obj):
        m = _machine_ref(obj)
        if not m:
            return ''
        return getattr(m, 'machine_name', None) or getattr(m, 'name', None) or str(m)

    def get_service_catalogue_name(self, obj):
        s = obj.service_catalogue
        if not s:
            return ''
        return f"{s.service_code} — {s.name}" if getattr(s, 'service_code', None) else s.name

    def get_item_type(self, obj):
        if _is_machinery_line(obj):
            return 'MACHINERY'
        if obj.service_catalogue_id:
            return 'SERVICE'
        return 'PRODUCT'

    def get_item_name(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'name', '') or ''
        if obj.product_id:
            return obj.product.product_name or ''
        return ''

    def get_item_code(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'service_code', '') or ''
        if obj.product_id:
            return obj.product.sku_code or ''
        return ''

    def validate(self, attrs):
        """Enforce exactly-one-of (product, machinery, service_catalogue)."""
        instance = getattr(self, 'instance', None)
        product = attrs.get('product', getattr(instance, 'product', None) if instance else None)
        service = attrs.get('service_catalogue', getattr(instance, 'service_catalogue', None) if instance else None)
        populated = sum(1 for v in (product, service) if v)
        if populated == 0:
            raise serializers.ValidationError(
                'Receipt line must reference exactly one of product, machinery, or service_catalogue.'
            )
        if populated > 1:
            raise serializers.ValidationError(
                'Receipt line cannot reference more than one of product, machinery, or service_catalogue.'
            )

        # Derive quantity_in_litres = quantity_received / SG for sg_applicable
        # products. Frozen at save time so a later SG edit does not
        # retroactively shift stored litres (Production Stock reads this).
        #
        # This lived in a SECOND validate() defined just above this one. Python
        # keeps the last definition, so it never ran - the receipt form sends
        # the field blank and tells the user "the backend derives
        # quantity_in_litres = kg / SG", and the backend quietly did not. The
        # figure is then posted into ProductionStockMovement.qty_litres, so
        # those movements went in as zero.
        #
        # Checked on production before merging the two: ZERO receipt lines are
        # affected today - no product carries an SG - so this restores the
        # intended behaviour for future receipts and corrects no existing row.
        from decimal import Decimal
        product = attrs.get('product') or getattr(self.instance, 'product', None)
        qty = attrs.get('quantity_received',
                        getattr(self.instance, 'quantity_received', None))
        sg = attrs.get('specific_gravity',
                       getattr(self.instance, 'specific_gravity', None))
        if product and getattr(product, 'sg_applicable', False) and qty and sg:
            try:
                sg_dec = Decimal(str(sg))
                if sg_dec > 0:
                    attrs['quantity_in_litres'] = (
                        Decimal(str(qty)) / sg_dec).quantize(Decimal('0.0001'))
            except Exception:   # noqa: BLE001 - a bad SG must not block the receipt
                pass
        return attrs

    def get_po_line_info(self, obj):
        # Include the PO NUMBER, not just the line no — a receipt can span
        # multiple POs (linked_pos M2M), and "PO Line 1" alone made those
        # lines impossible to attribute to their source PO.
        if obj.po_line:
            po_no = getattr(obj.po_line.po, 'po_no', '') if obj.po_line.po_id else ''
            return f"{po_no} · L{obj.po_line.line_no}" if po_no else f"PO Line {obj.po_line.line_no}"
        return '-'

    def get_pr_line_uom(self, obj):
        # Walk PO line → linked PR line to surface the PR's UOM. Drives
        # the "show Density input for LTR" toggle on the receipt form.
        po_line = obj.po_line
        if po_line and getattr(po_line, 'linked_pr_line_id', None):
            return getattr(po_line.linked_pr_line, 'uom', '') or ''
        return ''


class PackingMaterialLineSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for packing materials. Mirrors the ReceiptLine shape
    so the Packing Materials subform on the Receipt page can render the
    same column set (dimensions, PO Qty / Rcvd / Balance, Invoice /
    Received quantity, Batch, Godown, Remarks) without per-source
    branching on the frontend."""

    field_permission_module = 'Receipt Packing Material'

    id = serializers.UUIDField(required=False, allow_null=True)
    packaging_sku_name = serializers.CharField(source='packaging_sku.product_name', read_only=True, default='')
    condition_display = serializers.CharField(source='get_condition_display', read_only=True)
    godown_name = serializers.CharField(source='godown_location.godown_name', read_only=True, default='')
    # PO-context fields — computed off the linked POLine when present.
    # Match the names the frontend already uses for Receipt Line Items
    # (po_quantity / already_received) so the same column renderer can
    # be reused.
    po_quantity = serializers.SerializerMethodField()
    already_received = serializers.SerializerMethodField()
    po_uom = serializers.CharField(source='po_line.uom', read_only=True, default='')
    po_line_info = serializers.SerializerMethodField()

    class Meta:
        model = PackingMaterialLine
        fields = [
            'id', 'packaging_sku', 'packaging_sku_name',
            'po_line', 'po_line_info', 'po_quantity', 'already_received', 'po_uom',
            'quantity', 'net_quantity',
            'length', 'breadth', 'width', 'weight',
            'uom', 'batch_no', 'godown_location', 'godown_name',
            'remarks', 'condition', 'condition_display',
        ]
        extra_kwargs = {
            'packaging_sku': {'required': False, 'allow_null': True},
            'po_line': {'required': False, 'allow_null': True},
            'uom': {'required': False, 'allow_blank': True},
            'condition': {'required': False, 'allow_blank': True},
            'quantity': {'required': False, 'default': 0},
            'net_quantity': {'required': False, 'allow_null': True},
            'length': {'required': False, 'allow_null': True},
            'breadth': {'required': False, 'allow_null': True},
            'width': {'required': False, 'allow_null': True},
            'weight': {'required': False, 'allow_null': True},
            'batch_no': {'required': False, 'allow_blank': True},
            'godown_location': {'required': False, 'allow_null': True},
            'remarks': {'required': False, 'allow_blank': True},
        }

    def get_po_line_info(self, obj):
        # Same PO-number attribution as ReceiptLineSerializer, so packing
        # rows on a multi-PO receipt are traceable to their source PO too.
        if obj.po_line_id:
            po_no = getattr(obj.po_line.po, 'po_no', '') if obj.po_line.po_id else ''
            return f"{po_no} · L{obj.po_line.line_no}" if po_no else f"PO Line {obj.po_line.line_no}"
        return '-'

    def get_po_quantity(self, obj):
        return obj.po_line.quantity_ordered if obj.po_line_id else None

    def get_already_received(self, obj):
        # Invoice-driven aggregation — mirrors
        # POLineSerializer.get_received_quantity. Counts invoice qty
        # (quantity_received) regardless of is_debit_note.
        if not obj.po_line_id:
            return None
        po_line = obj.po_line
        rl_sum = sum(
            (rl.quantity_received or 0)
            for rl in po_line.receipt_lines.all()
            if rl.receipt and rl.receipt.approval_status == 'APPROVED'
        )
        return rl_sum


class WeighmentDetailSerializer(serializers.ModelSerializer):
    """Serializer for receipt weighment details."""

    id = serializers.UUIDField(required=False, allow_null=True)

    class Meta:
        model = WeighmentDetail
        fields = [
            'id', 'weighment_name', 'weighment_number',
            'first_weight', 'second_weight', 'tare_weight', 'uom',
        ]
        extra_kwargs = {
            'weighment_name': {'required': False, 'allow_blank': True},
            'weighment_number': {'required': False, 'allow_blank': True},
            'first_weight': {'required': False, 'allow_null': True},
            'second_weight': {'required': False, 'allow_null': True},
            'tare_weight': {'required': False, 'allow_null': True},
            'uom': {'required': False, 'allow_blank': True},
        }


class FreightDetailSerializer(serializers.ModelSerializer):
    """Serializer for freight details."""

    id = serializers.UUIDField(required=False, allow_null=True)
    transporter_name = serializers.CharField(source='transporter.name', read_only=True, default='')
    freight_type_display = serializers.CharField(source='get_freight_type_display', read_only=True)
    payable_by_display = serializers.CharField(source='get_payable_by_display', read_only=True)
    payable_amount = serializers.SerializerMethodField()

    class Meta:
        model = FreightDetail
        fields = [
            'id', 'freight_type', 'freight_type_display', 'transporter',
            'transporter_name', 'freight_terms', 'tentative_charge', 'discount',
            'payable_by', 'payable_by_display', 'quantity_basis', 'quantity_uom',
            'destination_state', 'cost_per_unit_calc', 'payable_amount'
        ]
        extra_kwargs = {
            'freight_type': {'required': False},
            'transporter': {'required': False, 'allow_null': True},
            'freight_terms': {'required': False, 'allow_blank': True},
            'tentative_charge': {'required': False},
            'discount': {'required': False},
            'payable_by': {'required': False},
            'quantity_basis': {'required': False, 'allow_null': True},
            'quantity_uom': {'required': False, 'allow_blank': True},
            'destination_state': {'required': False, 'allow_blank': True},
            'cost_per_unit_calc': {'required': False, 'allow_null': True},
        }

    def get_payable_amount(self, obj):
        return str(obj.get_payable_amount())


class LoadingUnloadingWageSerializer(serializers.ModelSerializer):
    """Serializer for loading/unloading wages."""

    id = serializers.UUIDField(required=False, allow_null=True)
    contractor_vendor_name = serializers.CharField(source='contractor_vendor.vendor_name', read_only=True, default='')
    wage_type_display = serializers.CharField(source='get_wage_type_display', read_only=True)
    payable_by_display = serializers.CharField(source='get_payable_by_display', read_only=True)
    tds_amount = serializers.SerializerMethodField()
    net_payable = serializers.SerializerMethodField()

    class Meta:
        model = LoadingUnloadingWage
        fields = [
            'id', 'wage_type', 'wage_type_display', 'contractor_vendor',
            'contractor_vendor_name', 'amount', 'tds_applicable', 'payable_by',
            'payable_by_display', 'remarks', 'tds_amount', 'net_payable'
        ]
        extra_kwargs = {
            'wage_type': {'required': False},
            'contractor_vendor': {'required': False, 'allow_null': True},
            'amount': {'required': False, 'default': 0},
            'tds_applicable': {'required': False, 'default': 0},
            'payable_by': {'required': False},
            'remarks': {'required': False, 'allow_blank': True},
        }

    def get_tds_amount(self, obj):
        return str(obj.get_tds_amount())

    def get_net_payable(self, obj):
        return str(obj.get_net_payable())


class FreightPaymentScheduleSerializer(serializers.ModelSerializer):
    """Serializer for freight payment schedules."""

    transporter_name = serializers.CharField(
        source='transporter.name',
        read_only=True,
        allow_null=True
    )
    freight_type_display = serializers.CharField(
        source='get_freight_type_display',
        read_only=True
    )

    class Meta:
        model = FreightPaymentSchedule
        fields = [
            'id', 'receipt', 'freight_type', 'freight_type_display', 'transporter',
            'transporter_name', 'due_date', 'amount', 'tds', 'reminder_flag'
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'transporter': {'required': False},
            'tds': {'required': False},
        }


class ReceiptFreightAdviceSummarySerializer(serializers.ModelSerializer):
    """Lightweight read-only serializer for freight advices linked to a receipt.

    The downstream Wage Entry create form reads transport details off this
    nested summary to auto-fill its "Transport & Counter-party" section,
    so driver_name / driver_contact / transport_document_no must be
    exposed here even though they don't appear on the receipt itself."""
    transporter_name = serializers.CharField(source='transporter.name', read_only=True, default='')
    freight_type_display = serializers.CharField(source='get_freight_type_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    freight_terms_display = serializers.CharField(source='get_freight_terms_display', read_only=True)

    class Meta:
        from .models import FreightAdviceInbound
        model = FreightAdviceInbound
        fields = [
            'id', 'advice_no', 'freight_type', 'freight_type_display',
            'transporter', 'transporter_name', 'freight_terms', 'freight_terms_display',
            'base_amount', 'discount', 'payable_amount', 'destination_state',
            'quantity_basis', 'quantity_uom', 'lorry_no',
            'driver_name', 'driver_contact', 'transport_document_no',
            'status', 'status_display',
        ]
        read_only_fields = fields


class ReceiptAdviceSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for receipt advices."""
    field_permission_module = 'Receipt Advice'

    receipt_lines = ReceiptLineSerializer(many=True, required=False)
    packing_materials = PackingMaterialLineSerializer(many=True, required=False)
    weighment_details = WeighmentDetailSerializer(many=True, required=False)
    freight_details = FreightDetailSerializer(many=True, required=False)
    loading_unloading_wages = LoadingUnloadingWageSerializer(many=True, required=False)
    freight_payment_schedules = FreightPaymentScheduleSerializer(
        many=True,
        read_only=True
    )
    freight_advices = ReceiptFreightAdviceSummarySerializer(many=True, read_only=True)
    warehouse_name = serializers.CharField(source='warehouse.name', read_only=True, default='')
    vendor_name = serializers.CharField(source='vendor.vendor_name', read_only=True, default='')
    # Company isn't a direct FK on ReceiptAdvice — it lives on the
    # linked PurchaseOrder(s). Walk the first PO to surface the company
    # id + name so downstream forms (Wage Entry, Freight, Returns) can
    # pre-fill the dropdown AND set the underlying FK value.
    company = serializers.SerializerMethodField()
    company_name = serializers.SerializerMethodField()
    qc_routing_display = serializers.CharField(source='get_qc_routing_display', read_only=True)
    qc_status_display = serializers.CharField(source='get_qc_status_display', read_only=True)
    total_received = serializers.SerializerMethodField()
    # De-duplicated list of product / service names covered by this
    # receipt's lines — mirrors the "Products" column on PR/PO/RFQ lists
    # so the operator can eyeball a receipt without opening it.
    product_names = serializers.SerializerMethodField()
    linked_po_numbers = serializers.SerializerMethodField()
    linked_pr_numbers = serializers.SerializerMethodField()
    linked_pr_ids = serializers.SerializerMethodField()
    receipt_status = serializers.SerializerMethodField()
    # Surfaces whether a VendorBill has been raised against this
    # receipt — used by the detail page to disable the "Create Bill"
    # action once a bill exists. Shape: { id, bill_no, status } or null.
    bill_info = serializers.SerializerMethodField()

    class Meta:
        model = ReceiptAdvice
        fields = [
            'id', 'receipt_advice_no', 'receipt_date', 'warehouse', 'warehouse_name',
            'vendor', 'vendor_name', 'company', 'company_name', 'vehicle_number',
            'driver_name', 'driver_phone', 'transporter_name', 'freight_bill_no', 'freight_bill_date',
            'qc_routing', 'qc_routing_display', 'qc_status',
            'qc_status_display', 'partial_receipt_flag',
            'approval_status', 'approved_by', 'approved_at',
            'advance_amount', 'freight_value', 'freight_terms',
            'remarks', 'linked_pos',
            'receipt_source', 'direct_reason',
            'invoice_no', 'invoice_date', 'invoice_amount',
            'linked_po_numbers', 'linked_pr_numbers', 'linked_pr_ids', 'receipt_lines', 'packing_materials', 'weighment_details', 'freight_details',
            'loading_unloading_wages', 'freight_payment_schedules', 'freight_advices',
            'total_received', 'product_names', 'receipt_status', 'bill_info', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'receipt_advice_no', 'receipt_date', 'created_at', 'updated_at'
        ]
        extra_kwargs = {
            'vehicle_number': {'required': False, 'allow_blank': True},
            'driver_name': {'required': False, 'allow_blank': True},
            'driver_phone': {'required': False, 'allow_blank': True},
            'transporter_name': {'required': False, 'allow_blank': True},
            'freight_bill_no': {'required': False, 'allow_blank': True},
            'freight_bill_date': {'required': False, 'allow_null': True},
            'qc_routing': {'required': False, 'allow_blank': True},
            'qc_status': {'required': False, 'allow_blank': True},
            'advance_amount': {'required': False},
            'freight_value': {'required': False},
            'freight_terms': {'required': False, 'allow_blank': True},
            'remarks': {'required': False, 'allow_blank': True},
            'linked_pos': {'required': False},
            'receipt_source': {'required': False},
            'direct_reason': {'required': False, 'allow_blank': True},
            'invoice_no': {'required': False, 'allow_blank': True},
            'invoice_date': {'required': False, 'allow_null': True},
            'invoice_amount': {'required': False, 'allow_null': True},
        }

    def get_total_received(self, obj):
        # Resolved for the whole page at once. ReceiptAdvice.totals_received is
        # the same grouped SUM the single-receipt method runs - that method IS
        # this one with a single id - so batching changes the number of round
        # trips and nothing about the figure.
        store = _ctx_store(self, '_ra_received')
        if obj.pk not in store:
            ids = _page_pks(self) or [obj.pk]
            if obj.pk not in ids:
                ids = list(ids) + [obj.pk]
            fetched = ReceiptAdvice.totals_received(ids)
            # A receipt with NO lines gets no row back from the grouped SUM, and
            # one whose sum is NULL comes back as None. Both were left out of the
            # store, read as "not asked yet", and re-queried a row at a time:
            # 199 of the 388 queries on the LAST page of the production list,
            # because the line-less receipts are the oldest ones and the list is
            # newest-first, so they all land on that page. Pages 1-3 cost 15
            # queries each, which is why this never showed up in a trace of
            # page 1.
            #
            # Record what the single-receipt method would have answered instead
            # of asking again: get_total_received is
            # `totals_received([id]).get(id) or Decimal('0.00')`, so missing or
            # NULL is Decimal('0.00').
            #
            # A total the SUM really did return is stored untouched, zero
            # included: str(Decimal('0')) is "0" where the fallback would print
            # "0.00". That difference already exists on this endpoint and is not
            # ours to tidy up here.
            for i in ids:
                got = fetched.get(i)
                store.setdefault(i, Decimal('0.00') if got is None else got)
        return str(store[obj.pk])

    def _pos(self, obj):
        """The receipt's linked POs, read ONCE per receipt.

        Six fields below need this M2M. Each used to re-open it, and .first()
        and .exists() re-query even when prefetch_related has already loaded
        the rows, because each adds its own LIMIT. Going through .all() and
        caching the list on the instance keeps the prefetched copy and turns
        six queries per receipt into none.

        PurchaseOrder orders by -po_date, so the prefetched list carries the
        same order .first() used - element zero is the same PO as before.
        """
        if not hasattr(obj, '_pos_cache'):
            try:
                obj._pos_cache = list(obj.linked_pos.all())
            except Exception:
                obj._pos_cache = []
        return obj._pos_cache

    def _first_po(self, obj):
        pos = self._pos(obj)
        return pos[0] if pos else None

    def get_company(self, obj):
        """Surface the company UUID via the first linked PO so the
        downstream Return form (and any other create form) can set it
        as a real FK value rather than just a display label."""
        try:
            po = self._first_po(obj)
            if po and po.company_id:
                return str(po.company_id)
        except Exception:
            pass
        return None

    def get_company_name(self, obj):
        """Resolve company via the first linked PO. ReceiptAdvice has
        no direct company FK — the company lives on PurchaseOrder.
        core.Company stores the display name in trade_name (preferred)
        and falls back to legal_name."""
        try:
            po = self._first_po(obj)
            if po and po.company:
                c = po.company
                return getattr(c, 'trade_name', '') or getattr(c, 'legal_name', '') or ''
        except Exception:
            pass
        return ''

    def get_linked_po_numbers(self, obj):
        return [po.po_no for po in self._pos(obj)]

    def get_product_names(self, obj):
        # Walks receipt_lines (Goods) + packing_materials (packing SKUs)
        # so the "Products" list column covers every physical item on
        # the receipt, not just the goods section.
        names = _names_from_lines(obj.receipt_lines.all())
        for pm in obj.packing_materials.all():
            sku = getattr(pm, 'packaging_sku', None)
            n = getattr(sku, 'product_name', '') if sku else ''
            if n and n not in names:
                names.append(n)
        return names

    def get_linked_pr_numbers(self, obj):
        pr_numbers = set()
        for po in self._pos(obj):
            for pr in po.linked_prs.all():
                pr_numbers.add(pr.pr_no)
        return list(pr_numbers)

    def get_linked_pr_ids(self, obj):
        pr_ids = set()
        for po in self._pos(obj):
            for pr in po.linked_prs.all():
                pr_ids.add(str(pr.id))
        return list(pr_ids)

    def get_receipt_status(self, obj):
        """Compute receipt status based on PO state."""
        linked_pos = self._pos(obj)
        if not linked_pos:
            return 'Full' if not obj.partial_receipt_flag else 'Partial'

        all_closed = all(po.status == 'CLOSED' for po in linked_pos)
        if all_closed:
            return 'Completed'

        return 'Partial' if obj.partial_receipt_flag else 'Full'

    def get_bill_info(self, obj):
        """Returns the most recent VendorBill raised against this receipt,
        or None. Used by the receipt detail page to hide the "Create Bill"
        button once a bill exists (it already raised one — preventing
        duplicates).
        """
        try:
            # The list view prefetches this into _active_bills with the SAME
            # filter and ordering, so element zero is the row the query below
            # would have returned. Anything not served by that queryset (a
            # create/update response, say) still falls through to the query.
            cached = getattr(obj, '_active_bills', None)
            if cached is not None:
                bill = cached[0] if cached else None
            else:
                from .models import VendorBill
                bill = VendorBill.objects.filter(
                    receipt_advice=obj, is_active=True,
                ).order_by('-created_at').first()
            if not bill:
                return None
            return {
                'id': str(bill.id),
                'bill_no': bill.bill_no,
                'status': bill.status,
                'status_display': bill.get_status_display() if hasattr(bill, 'get_status_display') else bill.status,
            }
        except Exception:
            return None

    def validate(self, data):
        """Validate receipt line quantities against PO ordered quantities."""
        from django.db.models import Sum, Q, Case, When, F
        from django.db.models.functions import Coalesce

        # Direct Receipt is a privileged source (stock IN with no PO; rate/GST
        # keyed by hand). Enforce the dedicated button permission server-side
        # so the frontend toggle gate can't be bypassed. Only checked on
        # create — editing an existing direct receipt is governed by edit perms.
        source = data.get('receipt_source')
        if source is None and self.instance is not None:
            source = self.instance.receipt_source
        if not self.instance and source == 'DIRECT':
            from .permissions import user_can_direct_receipt
            request = self.context.get('request')
            user = getattr(request, 'user', None)
            if not user_can_direct_receipt(user):
                raise serializers.ValidationError(
                    "You don't have permission to create a Direct Receipt. "
                    "Receive against a Purchase Order instead."
                )

        receipt_lines_data = data.get('receipt_lines', [])

        if not receipt_lines_data:
            return data

        # Invoice-driven aggregation — must mirror
        # PurchaseOrder.get_total_received exactly. Counts invoice qty
        # (quantity_received) regardless of is_debit_note; physical
        # shortfalls are tracked separately via Debit Notes.
        received_expr = Sum('quantity_received')

        for line_data in receipt_lines_data:
            qty_received = line_data.get('quantity_received')
            if qty_received is not None and qty_received <= Decimal('0'):
                raise serializers.ValidationError(
                    "Quantity received must be greater than 0."
                )

            # Over-delivery is allowed by policy — vendor production
            # variance often ships a few extra units and the invoice
            # covers it. The previous "exceeds remaining" hard-error
            # blocked that flow; the frontend now surfaces an amber
            # "over-delivery" hint per line instead. Nothing to check
            # here beyond the positive-qty rule above.
            po_line = line_data.get('po_line')
            if po_line and qty_received is not None:
                pass  # over-delivery permitted

        # Over-delivery is permitted, so the "remaining PO qty" check
        # that used to run here for lines without a po_line FK has
        # been dropped. Kept the linked_pos parsing intact because the
        # FIFO block below still needs it.
        linked_pos = data.get('linked_pos', [])

        # ── FIFO across POs of the same vendor ────────────────────────
        # For every product referenced on this receipt (via its linked
        # POs), the OLDEST active PO of the vendor with that product
        # still pending must be in linked_pos. If a newer PO is picked
        # while an older one has the same product open, reject — the
        # operator has to consume the older PO first. Matches the
        # frontend's findFifoBlocker check (see receipts/new.jsx).
        if linked_pos:
            linked_po_ids = {
                (po.id if hasattr(po, 'id') else po) for po in linked_pos
            }
            # Products actually on the receipt lines — only these are
            # subject to the FIFO check.
            receipt_product_ids = set()
            for line_data in receipt_lines_data:
                prod = line_data.get('product')
                if prod:
                    receipt_product_ids.add(prod.id if hasattr(prod, 'id') else prod)
            if receipt_product_ids:
                # Look up the vendor of the first linked PO — multi-PO
                # receipts are already scoped per-vendor by the frontend,
                # so any linked PO tells us the vendor.
                first_po = PurchaseOrder.objects.filter(id__in=linked_po_ids).first()
                if first_po and first_po.vendor_id:
                    vendor_id = first_po.vendor_id
                    for product_id in receipt_product_ids:
                        # Every active PO of this vendor with the product
                        # still pending. Ordered oldest first.
                        po_candidates = PurchaseOrder.objects.filter(
                            vendor_id=vendor_id,
                            po_lines__product_service_id=product_id,
                        ).exclude(
                            status__in=['DRAFT', 'CANCELLED', 'CLOSED'],
                        ).order_by('po_date', 'created_at').distinct()
                        oldest_pending = None
                        for po in po_candidates:
                            for pl in po.po_lines.filter(product_service_id=product_id):
                                pending = (pl.quantity_ordered or Decimal('0')) - (
                                    Decimal(str(POLineSerializer().get_received_quantity(pl)))
                                )
                                if pending > Decimal('0.0001'):
                                    oldest_pending = po
                                    break
                            if oldest_pending:
                                break
                        if oldest_pending and oldest_pending.id not in linked_po_ids:
                            prod_name = ''
                            try:
                                from master.models import Product
                                prod_name = Product.objects.get(id=product_id).product_name
                            except Exception:
                                prod_name = 'this product'
                            raise serializers.ValidationError(
                                f"FIFO rule: {oldest_pending.po_no} (older) still has "
                                f"{prod_name} pending. Receive that PO first before "
                                f"receiving against a newer PO for the same product."
                            )

        return data

    def create(self, validated_data):
        receipt_lines_data = validated_data.pop('receipt_lines', [])
        packing_materials_data = validated_data.pop('packing_materials', [])
        weighment_details_data = validated_data.pop('weighment_details', [])
        freight_details_data = validated_data.pop('freight_details', [])
        wages_data = validated_data.pop('loading_unloading_wages', [])
        linked_pos = validated_data.pop('linked_pos', [])

        with transaction.atomic():
            receipt = ReceiptAdvice.objects.create(**validated_data)

            if linked_pos:
                receipt.linked_pos.set(linked_pos)

            for line_data in receipt_lines_data:
                line_data.pop('receipt', None)
                ReceiptLine.objects.create(receipt=receipt, **line_data)

            for packing_data in packing_materials_data:
                packing_data.pop('receipt', None)
                PackingMaterialLine.objects.create(receipt=receipt, **packing_data)

            for weighment_data in weighment_details_data:
                weighment_data.pop('receipt', None)
                weighment_data.pop('id', None)
                WeighmentDetail.objects.create(receipt=receipt, **weighment_data)

            for freight_data in freight_details_data:
                freight_data.pop('receipt', None)
                FreightDetail.objects.create(receipt=receipt, **freight_data)

            for wage_data in wages_data:
                wage_data.pop('receipt', None)
                LoadingUnloadingWage.objects.create(receipt=receipt, **wage_data)

        return receipt

    def update(self, instance, validated_data):
        receipt_lines_data = validated_data.pop('receipt_lines', None)
        packing_materials_data = validated_data.pop('packing_materials', None)
        weighment_details_data = validated_data.pop('weighment_details', None)
        freight_details_data = validated_data.pop('freight_details', None)
        wages_data = validated_data.pop('loading_unloading_wages', None)
        linked_pos = validated_data.pop('linked_pos', None)

        with transaction.atomic():
            # Update header fields
            for attr, value in validated_data.items():
                setattr(instance, attr, value)
            instance.save()

            if linked_pos is not None:
                instance.linked_pos.set(linked_pos)

            # Update receipt lines: match by id, create new, delete removed
            if receipt_lines_data is not None:
                existing_lines = {line.id: line for line in instance.receipt_lines.all()}
                incoming_ids = set()

                for line_data in receipt_lines_data:
                    line_data.pop('receipt', None)
                    line_id = line_data.pop('id', None)

                    if line_id and line_id in existing_lines:
                        # Update existing line
                        line_obj = existing_lines[line_id]
                        for attr, value in line_data.items():
                            setattr(line_obj, attr, value)
                        line_obj.save()
                        incoming_ids.add(line_id)
                    else:
                        # Create new line
                        new_line = ReceiptLine.objects.create(receipt=instance, **line_data)
                        incoming_ids.add(new_line.id)

                # Delete lines not in incoming data
                for line_id, line_obj in existing_lines.items():
                    if line_id not in incoming_ids:
                        line_obj.delete()

            # Update packing materials
            if packing_materials_data is not None:
                existing = {obj.id: obj for obj in instance.packing_materials.all()}
                incoming_ids = set()

                for data in packing_materials_data:
                    data.pop('receipt', None)
                    obj_id = data.pop('id', None)
                    if obj_id and obj_id in existing:
                        obj = existing[obj_id]
                        for attr, value in data.items():
                            setattr(obj, attr, value)
                        obj.save()
                        incoming_ids.add(obj_id)
                    else:
                        new_obj = PackingMaterialLine.objects.create(receipt=instance, **data)
                        incoming_ids.add(new_obj.id)

                for obj_id in existing:
                    if obj_id not in incoming_ids:
                        existing[obj_id].delete()

            # Update weighment details
            if weighment_details_data is not None:
                existing = {obj.id: obj for obj in instance.weighment_details.all()}
                incoming_ids = set()

                for data in weighment_details_data:
                    data.pop('receipt', None)
                    obj_id = data.pop('id', None)
                    if obj_id and obj_id in existing:
                        obj = existing[obj_id]
                        for attr, value in data.items():
                            setattr(obj, attr, value)
                        obj.save()
                        incoming_ids.add(obj_id)
                    else:
                        new_obj = WeighmentDetail.objects.create(receipt=instance, **data)
                        incoming_ids.add(new_obj.id)

                for obj_id in existing:
                    if obj_id not in incoming_ids:
                        existing[obj_id].delete()

            # Update freight details
            if freight_details_data is not None:
                existing = {obj.id: obj for obj in instance.freight_details.all()}
                incoming_ids = set()

                for data in freight_details_data:
                    data.pop('receipt', None)
                    obj_id = data.pop('id', None)
                    if obj_id and obj_id in existing:
                        obj = existing[obj_id]
                        for attr, value in data.items():
                            setattr(obj, attr, value)
                        obj.save()
                        incoming_ids.add(obj_id)
                    else:
                        new_obj = FreightDetail.objects.create(receipt=instance, **data)
                        incoming_ids.add(new_obj.id)

                for obj_id in existing:
                    if obj_id not in incoming_ids:
                        existing[obj_id].delete()

            # Update loading/unloading wages
            if wages_data is not None:
                existing = {obj.id: obj for obj in instance.loading_unloading_wages.all()}
                incoming_ids = set()

                for data in wages_data:
                    data.pop('receipt', None)
                    obj_id = data.pop('id', None)
                    if obj_id and obj_id in existing:
                        obj = existing[obj_id]
                        for attr, value in data.items():
                            setattr(obj, attr, value)
                        obj.save()
                        incoming_ids.add(obj_id)
                    else:
                        new_obj = LoadingUnloadingWage.objects.create(receipt=instance, **data)
                        incoming_ids.add(new_obj.id)

                for obj_id in existing:
                    if obj_id not in incoming_ids:
                        existing[obj_id].delete()

        instance.refresh_from_db()
        return instance


class ReceiptAdviceListSerializer(ReceiptAdviceSerializer):
    """The Receipts LIST columns. Opt-in via ?slim=1.

    The full serializer carries 48 fields, SIX of them nested many=True lists -
    receipt_lines, packing_materials, weighment_details, freight_details,
    loading_unloading_wages, freight_payment_schedules, freight_advices - built
    so the detail screen can render a whole receipt. The list shows ten columns
    and reads none of those lists.

    Measured on production: the Receipts list sent 4,435 KB for 1,848 rows, or
    2.4 KB per row, where every other Purchase list is 0.1-0.9 KB per row. It
    was the fattest page in the module by a factor of three, and the slowest.

    The field list below is not a guess. It is every key the list page reads:
    the ten columns in `columns`, the two id arrays the PO/PR cells use for
    their links (linked_pos, linked_pr_ids), approval_status for the Approve
    and freight buttons, and qc_status because the filter panel offers it.
    Change a column on that page and this list has to change with it.

    Opt-in on purpose: a caller that does not pass ?slim=1 gets byte-for-byte
    what it got before.
    """

    class Meta(ReceiptAdviceSerializer.Meta):
        fields = [
            'id',
            'receipt_advice_no', 'receipt_date',
            'vendor_name', 'warehouse_name',
            'product_names',
            'linked_pos', 'linked_po_numbers',
            'linked_pr_ids', 'linked_pr_numbers',
            'total_received', 'receipt_status',
            'approval_status', 'qc_status',
        ]


class WageEntryLineSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    field_permission_module = 'Wage Entry Line'
    id = serializers.UUIDField(required=False, allow_null=True)
    contractor_name = serializers.CharField(source='contractor.vendor_name', read_only=True, default='')
    wage_type_display = serializers.CharField(source='get_wage_type_display', read_only=True)
    payment_status_display = serializers.CharField(source='get_payment_status_display', read_only=True)
    wage_payment_no = serializers.CharField(source='wage_payment.payment_no', read_only=True, default='')
    balance = serializers.SerializerMethodField()

    class Meta:
        from .models import WageEntryLine
        model = WageEntryLine
        fields = [
            'id', 'wage_type', 'wage_type_display', 'contractor', 'contractor_name',
            'work_date', 'tons', 'cost_per_ton', 'amount', 'advance_paid', 'balance', 'remarks',
            'payment_status', 'payment_status_display', 'wage_payment', 'wage_payment_no',
        ]
        read_only_fields = ['payment_status', 'wage_payment', 'wage_payment_no']
        extra_kwargs = {
            # Contractor is mandatory — every wage line must point at a
            # contractor vendor so the periodic Wage Payment cycle has
            # a group to settle against. The model FK stays nullable
            # for legacy / pre-validation rows; new writes are gated
            # here at the API boundary.
            'contractor': {'required': True, 'allow_null': False},
            'work_date': {'required': False, 'allow_null': True},
            'tons': {'required': False, 'allow_null': True},
            'cost_per_ton': {'required': False, 'allow_null': True},
            'amount': {'required': False},
            'advance_paid': {'required': False},
            'remarks': {'required': False, 'allow_blank': True},
        }

    def get_balance(self, obj):
        return str(obj.balance)


class WageEntrySerializer(FieldPermissionMixin, serializers.ModelSerializer):
    field_permission_module = 'Wage Entry'
    wage_lines = WageEntryLineSerializer(many=True, required=False)
    receipt_no = serializers.CharField(source='receipt.receipt_advice_no', read_only=True, default='')
    transfer_no = serializers.CharField(source='transfer_source.transfer_no', read_only=True, default='')
    shifting_no = serializers.CharField(source='shifting_source.shifting_no', read_only=True, default='')
    dispatch_challan_no = serializers.CharField(source='dispatch_challan_source.dc_no', read_only=True, default='')
    source_type_display = serializers.CharField(source='get_source_type_display', read_only=True)
    vendor_name = serializers.SerializerMethodField()
    po_numbers = serializers.SerializerMethodField()
    receipt_date = serializers.SerializerMethodField()
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    total_amount = serializers.SerializerMethodField()
    total_advance = serializers.SerializerMethodField()
    total_balance = serializers.SerializerMethodField()
    line_count = serializers.SerializerMethodField()
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        from .models import WageEntry
        model = WageEntry
        fields = [
            'id', 'entry_no', 'date',
            'source_type', 'source_type_display',
            'receipt', 'receipt_no',
            'transfer_source', 'transfer_no',
            'shifting_source', 'shifting_no',
            'dispatch_challan_source', 'dispatch_challan_no',
            'vendor_name',
            'po_numbers', 'receipt_date', 'status', 'status_display',
            'overall_remarks', 'additional_charges', 'additional_charges_remarks',
            'wage_lines', 'total_amount', 'total_advance',
            'total_balance', 'line_count', 'created_by_name',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'entry_no', 'created_at', 'updated_at']
        extra_kwargs = {
            'overall_remarks': {'required': False, 'allow_blank': True},
            'status': {'required': False},
            'source_type': {'required': False, 'allow_blank': True},
            'receipt': {'required': False, 'allow_null': True},
            'transfer_source': {'required': False, 'allow_null': True},
            'shifting_source': {'required': False, 'allow_null': True},
            'dispatch_challan_source': {'required': False, 'allow_null': True},
        }

    def get_vendor_name(self, obj):
        try:
            if obj.source_type == 'PURCHASE_RECEIPT' and obj.receipt and obj.receipt.vendor:
                return obj.receipt.vendor.vendor_name
            if obj.source_type == 'INVENTORY_TRANSFER' and obj.transfer_source and obj.transfer_source.transporter:
                return obj.transfer_source.transporter.name
            if obj.source_type == 'SALES_DISPATCH_CHALLAN' and obj.dispatch_challan_source:
                first_line = obj.dispatch_challan_source.dc_lines.first()
                so = first_line.so_line.so if first_line and first_line.so_line else None
                cust = getattr(so, 'customer', None)
                if cust:
                    return getattr(cust, 'name', '') or getattr(cust, 'customer_name', '')
            # Shifting is intra-warehouse, no counter-party.
        except Exception:
            pass
        return ''

    def get_po_numbers(self, obj):
        try:
            if obj.source_type == 'PURCHASE_RECEIPT' and obj.receipt:
                return list(obj.receipt.linked_pos.values_list('po_number', flat=True))
        except Exception:
            pass
        return []

    def get_receipt_date(self, obj):
        try:
            if obj.source_type == 'PURCHASE_RECEIPT' and obj.receipt:
                rd = obj.receipt.receipt_date
                return rd.date().isoformat() if hasattr(rd, 'date') else str(rd) if rd else None
            if obj.source_type == 'INVENTORY_TRANSFER' and obj.transfer_source:
                rd = obj.transfer_source.transfer_date or obj.transfer_source.dispatch_date
                return rd.isoformat() if rd else None
            if obj.source_type == 'INVENTORY_SHIFTING' and obj.shifting_source:
                rd = obj.shifting_source.request_date
                return rd.date().isoformat() if hasattr(rd, 'date') else str(rd) if rd else None
            if obj.source_type == 'SALES_DISPATCH_CHALLAN' and obj.dispatch_challan_source:
                rd = obj.dispatch_challan_source.dispatch_date
                return rd.date().isoformat() if hasattr(rd, 'date') else str(rd) if rd else None
        except Exception:
            pass
        return None

    def validate(self, data):
        """Enforce exactly-one-source rule matching source_type + duplicate-billing guard."""
        from .models import WageEntry as _WageEntry

        source_type = data.get('source_type') or (self.instance.source_type if self.instance else 'PURCHASE_RECEIPT')
        receipt = data.get('receipt') if 'receipt' in data else (self.instance.receipt if self.instance else None)
        transfer_source = data.get('transfer_source') if 'transfer_source' in data else (self.instance.transfer_source if self.instance else None)
        shifting_source = data.get('shifting_source') if 'shifting_source' in data else (self.instance.shifting_source if self.instance else None)
        dispatch_challan_source = data.get('dispatch_challan_source') if 'dispatch_challan_source' in data else (self.instance.dispatch_challan_source if self.instance else None)

        if source_type == 'PURCHASE_RECEIPT' and not receipt:
            raise serializers.ValidationError({'receipt': 'Required when source_type is PURCHASE_RECEIPT.'})
        if source_type == 'INVENTORY_TRANSFER' and not transfer_source:
            raise serializers.ValidationError({'transfer_source': 'Required when source_type is INVENTORY_TRANSFER.'})
        if source_type == 'INVENTORY_SHIFTING' and not shifting_source:
            raise serializers.ValidationError({'shifting_source': 'Required when source_type is INVENTORY_SHIFTING.'})
        if source_type == 'SALES_DISPATCH_CHALLAN' and not dispatch_challan_source:
            raise serializers.ValidationError({'dispatch_challan_source': 'Required when source_type is SALES_DISPATCH_CHALLAN.'})

        # Duplicate-billing guard — block another live wage entry against the same source.
        if not self.instance:
            qs = _WageEntry.objects.filter(is_active=True).exclude(status='CANCELLED')
            if source_type == 'PURCHASE_RECEIPT' and receipt and qs.filter(receipt=receipt, source_type='PURCHASE_RECEIPT').exists():
                raise serializers.ValidationError({'receipt': 'A wage entry already exists for this receipt.'})
            if source_type == 'INVENTORY_TRANSFER' and transfer_source and qs.filter(transfer_source=transfer_source, source_type='INVENTORY_TRANSFER').exists():
                raise serializers.ValidationError({'transfer_source': 'A wage entry already exists for this transfer.'})
            if source_type == 'INVENTORY_SHIFTING' and shifting_source and qs.filter(shifting_source=shifting_source, source_type='INVENTORY_SHIFTING').exists():
                raise serializers.ValidationError({'shifting_source': 'A wage entry already exists for this shifting.'})
            if source_type == 'SALES_DISPATCH_CHALLAN' and dispatch_challan_source and qs.filter(dispatch_challan_source=dispatch_challan_source, source_type='SALES_DISPATCH_CHALLAN').exists():
                raise serializers.ValidationError({'dispatch_challan_source': 'A wage entry already exists for this dispatch challan.'})

        return data

    def get_total_amount(self, obj):
        return str(obj.get_total_amount())

    def get_total_advance(self, obj):
        return str(obj.get_total_advance())

    def get_total_balance(self, obj):
        return str(obj.get_total_balance())

    def get_line_count(self, obj):
        return obj.wage_lines.count()

    def get_created_by_name(self, obj):
        try:
            return obj.created_by.user.get_full_name() if obj.created_by else ''
        except Exception:
            return ''

    # Read-only computed fields that come back via WageEntryLineSerializer
    # — DRF tries to write them back on update unless stripped here.
    _LINE_READ_ONLY_KEYS = (
        'id', 'contractor_name', 'wage_type_display', 'balance',
        'payment_status', 'payment_status_display',
        'wage_payment', 'wage_payment_no',
    )

    def create(self, validated_data):
        from .models import WageEntryLine
        lines_data = validated_data.pop('wage_lines', [])
        entry = super().create(validated_data)
        for line in lines_data:
            for k in self._LINE_READ_ONLY_KEYS:
                line.pop(k, None)
            WageEntryLine.objects.create(entry=entry, **line)
        return entry

    def update(self, instance, validated_data):
        from .models import WageEntryLine
        lines_data = validated_data.pop('wage_lines', None)
        # Lock-out: editing a wage entry that already has paid lines
        # would orphan those lines from their WagePayment. The settlement
        # document is the system of record once a line is paid, so we
        # refuse the whole edit and ask the user to cancel/re-create.
        if lines_data is not None and instance.wage_lines.filter(payment_status='PAID').exists():
            raise serializers.ValidationError(
                'Cannot edit wage lines: this entry has lines already settled '
                'via a Wage Payment. Cancel the payment first to unlock.'
            )
        instance = super().update(instance, validated_data)
        if lines_data is not None:
            instance.wage_lines.all().delete()
            for line in lines_data:
                for k in self._LINE_READ_ONLY_KEYS:
                    line.pop(k, None)
                WageEntryLine.objects.create(entry=instance, **line)
        return instance


class WageEntryListSerializer(serializers.ModelSerializer):
    """Slim wage-entry list for ?slim=1.

    The Receipts page fetches ALL wage entries only to build a
    receipt_id -> status map. The full serializer nests wage_lines,
    computed totals, and walks multiple FK chains per row - none of
    which the Receipts page reads. This returns the two fields it
    needs plus id.
    """

    class Meta:
        from .models import WageEntry
        model = WageEntry
        fields = ['id', 'receipt', 'status']


# ── Wage Payment serializers ─────────────────────────────────────────
class UnpaidWageLineSerializer(serializers.Serializer):
    """Read-only flat shape for the `unpaid-lines` action.

    Snapshots the wage-entry context (entry_no, source doc, source type)
    onto each line so the create page can render a flat table without
    needing a second round-trip per row.
    """
    id = serializers.UUIDField()
    entry_id = serializers.UUIDField(source='entry.id')
    entry_no = serializers.CharField(source='entry.entry_no')
    entry_date = serializers.DateField(source='entry.date')
    source_type = serializers.CharField(source='entry.source_type')
    source_type_display = serializers.CharField(source='entry.get_source_type_display')
    source_doc_no = serializers.SerializerMethodField()
    contractor = serializers.UUIDField(source='contractor_id')
    contractor_name = serializers.CharField(source='contractor.vendor_name', default='')
    wage_type = serializers.CharField()
    wage_type_display = serializers.CharField(source='get_wage_type_display')
    work_date = serializers.DateField()
    tons = serializers.DecimalField(max_digits=18, decimal_places=4)
    cost_per_ton = serializers.DecimalField(max_digits=18, decimal_places=2)
    amount = serializers.DecimalField(max_digits=18, decimal_places=2)
    advance_paid = serializers.DecimalField(max_digits=18, decimal_places=2)
    balance = serializers.SerializerMethodField()
    remarks = serializers.CharField()

    def get_source_doc_no(self, obj):
        e = obj.entry
        if e.source_type == 'PURCHASE_RECEIPT' and e.receipt:
            return e.receipt.receipt_advice_no
        if e.source_type == 'INVENTORY_TRANSFER' and e.transfer_source:
            return e.transfer_source.transfer_no
        if e.source_type == 'INVENTORY_SHIFTING' and e.shifting_source:
            return e.shifting_source.shifting_no
        if e.source_type == 'SALES_DISPATCH_CHALLAN' and e.dispatch_challan_source:
            return e.dispatch_challan_source.dc_no
        return ''

    def get_balance(self, obj):
        return str(obj.balance)


class WagePaymentPaidLineSerializer(serializers.Serializer):
    """Lines included in a WagePayment, as shown on the detail page."""
    id = serializers.UUIDField()
    entry_id = serializers.UUIDField(source='entry.id')
    entry_no = serializers.CharField(source='entry.entry_no')
    source_type = serializers.CharField(source='entry.source_type')
    source_type_display = serializers.CharField(source='entry.get_source_type_display')
    wage_type = serializers.CharField()
    wage_type_display = serializers.CharField(source='get_wage_type_display')
    work_date = serializers.DateField()
    tons = serializers.DecimalField(max_digits=18, decimal_places=4)
    cost_per_ton = serializers.DecimalField(max_digits=18, decimal_places=2)
    amount = serializers.DecimalField(max_digits=18, decimal_places=2)
    advance_paid = serializers.DecimalField(max_digits=18, decimal_places=2)
    balance = serializers.SerializerMethodField()
    remarks = serializers.CharField()

    def get_balance(self, obj):
        return str(obj.balance)


class WagePaymentSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Header + nested paid-line snapshot. POST takes a `line_ids` list of
    UnpaidWageLine ids to settle.

    Aggregates (gross_wages / total_advance / net_payable / line_count)
    are computed server-side from the selected lines — the client's
    submitted values are ignored to keep the document trustworthy.
    """
    field_permission_module = 'Wage Payment'
    contractor_name = serializers.CharField(source='contractor.vendor_name', read_only=True, default='')
    cycle_type_display = serializers.CharField(source='get_cycle_type_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    payment_mode_display = serializers.CharField(source='get_payment_mode_display', read_only=True)
    created_by_name = serializers.SerializerMethodField()
    paid_lines = WagePaymentPaidLineSerializer(many=True, read_only=True)
    # Write-only input: which UNPAID lines to settle in this payment.
    line_ids = serializers.ListField(
        child=serializers.UUIDField(), write_only=True, required=True, allow_empty=False,
    )

    class Meta:
        from .models import WagePayment
        model = WagePayment
        fields = [
            'id', 'payment_no',
            'contractor', 'contractor_name',
            'cycle_type', 'cycle_type_display',
            'from_date', 'to_date', 'payment_date',
            'line_count', 'gross_wages', 'total_advance',
            'net_payable', 'paid_amount', 'balance_amount',
            'payment_mode', 'payment_mode_display',
            'reference_no', 'remarks',
            'status', 'status_display',
            'created_by_name', 'created_at', 'updated_at',
            'paid_lines', 'line_ids',
        ]
        read_only_fields = [
            'id', 'payment_no', 'created_at', 'updated_at',
            'line_count', 'gross_wages', 'total_advance',
            'net_payable', 'balance_amount',
        ]
        extra_kwargs = {
            'reference_no': {'required': False, 'allow_blank': True},
            'remarks': {'required': False, 'allow_blank': True},
            'status': {'required': False},
        }

    def get_created_by_name(self, obj):
        try:
            if obj.created_by and obj.created_by.user:
                return obj.created_by.user.get_full_name() or obj.created_by.user.username
        except Exception:
            pass
        return ''

    def validate(self, attrs):
        from .models import WageEntryLine
        line_ids = attrs.get('line_ids') or []
        contractor = attrs.get('contractor')
        if not line_ids:
            raise serializers.ValidationError({'line_ids': 'Select at least one wage line.'})
        # Every line must (a) exist, (b) be UNPAID, (c) not already
        # claimed by ANY other payment (DRAFT or COMPLETED), and
        # (d) belong to the same contractor as the payment header.
        lines = WageEntryLine.objects.filter(id__in=line_ids).select_related('entry')
        if lines.count() != len(set(line_ids)):
            raise serializers.ValidationError({'line_ids': 'One or more lines no longer exist.'})
        paid = lines.filter(payment_status='PAID')
        if paid.exists():
            raise serializers.ValidationError({
                'line_ids': f'{paid.count()} line(s) are already paid — refresh and try again.',
            })
        # A line claimed by a DRAFT payment is reserved; surface that
        # explicitly so the user knows to release the other draft.
        claimed = lines.filter(wage_payment__isnull=False)
        if claimed.exists():
            raise serializers.ValidationError({
                'line_ids': f'{claimed.count()} line(s) are already claimed by another wage payment (draft or completed). Cancel that payment first to release them.',
            })
        if contractor and lines.exclude(contractor_id=contractor.id).exists():
            raise serializers.ValidationError({
                'line_ids': 'All selected lines must belong to the chosen contractor.',
            })
        # Stash the resolved queryset so create() doesn't re-fetch.
        attrs['_lines'] = lines
        return attrs

    def create(self, validated_data):
        from .models import WageEntryLine
        from django.db import transaction
        lines = validated_data.pop('_lines')
        validated_data.pop('line_ids', None)
        # Recompute aggregates from the selected lines so the snapshot
        # matches reality regardless of what the client submitted.
        gross   = sum((l.amount       or Decimal('0')) for l in lines)
        advance = sum((l.advance_paid or Decimal('0')) for l in lines)
        net     = gross - advance
        paid    = validated_data.get('paid_amount') or net
        validated_data['line_count']     = lines.count()
        validated_data['gross_wages']    = gross
        validated_data['total_advance']  = advance
        validated_data['net_payable']    = net
        validated_data['paid_amount']    = paid
        validated_data['balance_amount'] = net - paid
        # Attach created_by from request user via StakeholderUser.
        request = self.context.get('request')
        if request and request.user and request.user.is_authenticated:
            try:
                from core.models import StakeholderUser
                su = StakeholderUser.objects.filter(user=request.user).first()
                if su:
                    validated_data['created_by'] = su
            except Exception:
                pass

        with transaction.atomic():
            # New payments start in DRAFT — the lines are CLAIMED
            # (FK set so no other payment can pick them up) but their
            # payment_status stays UNPAID and the parent wage entries
            # are NOT auto-flipped. The Approve action (see view) does
            # the final commit: payment→COMPLETED, lines→PAID, entries
            # roll up to PAID if fully settled.
            payment = super().create(validated_data)
            line_ids = [l.id for l in lines]
            WageEntryLine.objects.filter(id__in=line_ids).update(
                wage_payment=payment,
            )
        return payment


class WagePaymentListSerializer(serializers.ModelSerializer):
    """Lightweight list shape — no nested lines."""
    contractor_name = serializers.CharField(source='contractor.vendor_name', read_only=True, default='')
    cycle_type_display = serializers.CharField(source='get_cycle_type_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    payment_mode_display = serializers.CharField(source='get_payment_mode_display', read_only=True)

    class Meta:
        from .models import WagePayment
        model = WagePayment
        fields = [
            'id', 'payment_no', 'contractor', 'contractor_name',
            'cycle_type', 'cycle_type_display',
            'from_date', 'to_date', 'payment_date',
            'line_count', 'gross_wages', 'total_advance',
            'net_payable', 'paid_amount', 'balance_amount',
            'payment_mode', 'payment_mode_display',
            'reference_no', 'status', 'status_display',
            'created_at',
        ]


class FreightPaymentInboundSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for inbound freight payments."""
    field_permission_module = 'Freight Payment'
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        from .models import FreightPaymentInbound
        model = FreightPaymentInbound
        fields = [
            'id', 'payment_date', 'amount_paid', 'payment_mode',
            'paid_to', 'reference_no', 'notes', 'created_by_name', 'created_at',
        ]
        read_only_fields = ['id', 'created_at', 'created_by_name']
        extra_kwargs = {
            'paid_to': {'required': False, 'allow_blank': True},
            'reference_no': {'required': False, 'allow_blank': True},
            'notes': {'required': False, 'allow_blank': True},
        }

    def get_created_by_name(self, obj):
        try:
            if obj.created_by:
                return obj.created_by.user.get_full_name()
        except Exception:
            pass
        return ''


class FreightPaymentInboundListSerializer(serializers.ModelSerializer):
    """List serializer with freight info for standalone listing."""
    created_by_name = serializers.SerializerMethodField()
    freight_no = serializers.CharField(source='freight.advice_no', read_only=True)
    transporter_name = serializers.SerializerMethodField()
    vendor_name = serializers.SerializerMethodField()
    total_freight_amount = serializers.SerializerMethodField()
    freight_status = serializers.CharField(source='freight.status', read_only=True)
    receipt_date = serializers.SerializerMethodField()

    class Meta:
        from .models import FreightPaymentInbound
        model = FreightPaymentInbound
        fields = [
            'id', 'freight', 'freight_no', 'payment_date', 'amount_paid',
            'payment_mode', 'paid_to', 'reference_no', 'notes',
            'created_by_name', 'transporter_name', 'vendor_name',
            'total_freight_amount', 'freight_status', 'receipt_date', 'created_at',
        ]

    def get_created_by_name(self, obj):
        try:
            return obj.created_by.user.get_full_name() if obj.created_by else ''
        except Exception:
            return ''

    def get_transporter_name(self, obj):
        try:
            return obj.freight.transporter.name if obj.freight and obj.freight.transporter else ''
        except Exception:
            return ''

    def get_vendor_name(self, obj):
        try:
            return obj.freight.receipt_advice.vendor.vendor_name if obj.freight and obj.freight.receipt_advice and obj.freight.receipt_advice.vendor else ''
        except Exception:
            return ''

    def get_total_freight_amount(self, obj):
        try:
            return str(obj.freight.get_total_payable())
        except Exception:
            return '0'

    def get_receipt_date(self, obj):
        try:
            if obj.freight and obj.freight.receipt_advice:
                rd = obj.freight.receipt_advice.receipt_date
                return rd.date().isoformat() if hasattr(rd, 'date') else str(rd) if rd else None
        except Exception:
            pass
        return None


class FreightAdviceInboundSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Serializer for freight advices."""
    field_permission_module = 'Freight Advice'

    transporter_name = serializers.CharField(
        source='transporter.name',
        read_only=True,
        default=''
    )
    created_by_name = serializers.CharField(
        source='created_by.user.get_full_name',
        read_only=True,
        default=''      # created_by is nullable (Zoho/Tally/system freight) — a
                        # missing creator must not 500 the whole freight payload.
    )
    freight_type_display = serializers.CharField(
        source='get_freight_type_display',
        read_only=True
    )
    status_display = serializers.CharField(
        source='get_status_display',
        read_only=True
    )
    freight_terms_display = serializers.CharField(
        source='get_freight_terms_display',
        read_only=True
    )
    receipt_advice_no = serializers.CharField(
        source='receipt_advice.receipt_advice_no',
        read_only=True,
        default=''      # receipt_advice is null for Zoho/Tally/separate-slip
                        # freight — don't let a missing receipt blank the payload.
    )
    transfer_no = serializers.CharField(
        source='transfer_source.transfer_no',
        read_only=True,
        default=''
    )
    shifting_no = serializers.CharField(
        source='shifting_source.shifting_no',
        read_only=True,
        default=''
    )
    dispatch_challan_no = serializers.CharField(
        source='dispatch_challan_source.dc_no',
        read_only=True,
        default=''
    )
    source_type_display = serializers.CharField(
        source='get_source_type_display',
        read_only=True
    )
    freight_source_display = serializers.CharField(
        source='get_freight_source_display',
        read_only=True
    )
    vendor_bill_no = serializers.CharField(
        source='vendor_bill.bill_no',
        read_only=True,
        default=''
    )
    vendor_name = serializers.SerializerMethodField()
    warehouse_name = serializers.SerializerMethodField()
    company_name = serializers.SerializerMethodField()
    po_numbers = serializers.SerializerMethodField()
    approved_by_name = serializers.SerializerMethodField()
    total_payable = serializers.SerializerMethodField()
    total_freight_cost = serializers.SerializerMethodField()
    # Live paid/balance — for invoice-included freight the paid is DERIVED from the
    # linked bill's payment (goods first, freight last), so compute it here rather
    # than trust the stored snapshot. This keeps the Inward Freight LIST and the
    # detail in step with the bill's real payment, whatever path paid it.
    total_paid = serializers.SerializerMethodField()
    balance = serializers.SerializerMethodField()
    receipt_date = serializers.SerializerMethodField()
    linked_bill = serializers.SerializerMethodField()
    bill_linked = serializers.SerializerMethodField()
    covered_bills_detail = serializers.SerializerMethodField()
    payments = FreightPaymentInboundSerializer(source='freight_payments', many=True, read_only=True)
    # Where this freight came from — mirrors the Bills page SOURCE column. 'TALLY'
    # when it carries a real (non-OPENING) Tally voucher guid, else 'ERP'. The
    # frontend renders the ERP / Tally + In-sync / Not-in-Tally badges from this.
    source_origin = serializers.SerializerMethodField()

    def get_source_origin(self, obj):
        g = (getattr(obj, 'tally_guid', '') or '').strip()
        in_tally = bool(g) and not g.startswith('OPENING')
        return 'TALLY' if in_tally else 'ERP'

    def get_covered_bills_detail(self, obj):
        """Every goods bill this ONE freight covers (primary vendor_bill + the
        covered_bills) — so the Inward Freight page can show "Bills covered (N)".
        Excludes FREIGHT-category bills (the freight bill itself, not a goods bill)."""
        primary_id = obj.vendor_bill_id
        bills = {}
        if primary_id and obj.vendor_bill:
            bills[primary_id] = obj.vendor_bill
        for b in obj.covered_bills.all():
            bills[b.id] = b
        return [{'id': str(b.id), 'bill_no': b.bill_no,
                 'vendor_name': (getattr(b.vendor, 'vendor_name', '') if b.vendor_id else '') or '',
                 'invoice_no': b.vendor_invoice_no or '',
                 'total': str(b.total_amount or 0),
                 'is_primary': b.id == primary_id}
                for b in bills.values()
                if getattr(b, 'purchase_category', '') != 'FREIGHT']

    class Meta:
        model = FreightAdviceInbound
        fields = [
            'id', 'advice_no', 'direction',
            'source_type', 'source_type_display',
            'freight_source', 'freight_source_display', 'vendor_bill', 'vendor_bill_no',
            'receipt_advice', 'receipt_advice_no', 'receipt_date',
            'transfer_source', 'transfer_no',
            'shifting_source', 'shifting_no',
            'dispatch_challan_source', 'dispatch_challan_no',
            'transporter', 'transporter_name', 'freight_type', 'freight_type_display',
            'created_by', 'created_by_name', 'created_date', 'base_amount', 'discount',
            'loading_wages_amount', 'unloading_wages_amount', 'other_charges',
            'mamul_amount', 'mamul_sign', 'tds_less', 'less_amount', 'less_amount_sign',
            'additional_charges', 'additional_charges_remarks',
            'quantity_basis', 'quantity_uom', 'cost_per_unit_calc', 'destination_state',
            'payable_amount', 'total_paid', 'balance', 'status', 'status_display',
            'lorry_no', 'driver_name', 'driver_contact',
            'freight_date',
            'dispatch_date', 'expected_arrival_date', 'actual_arrival_date',
            'freight_terms', 'freight_terms_display',
            'transport_document_no', 'delivery_remarks', 'remarks',
            'bank_name', 'ifsc_code', 'beneficiary_name', 'account_no',
            'approved_by', 'approved_by_name', 'approved_at',
            'vendor_name', 'warehouse_name', 'company_name', 'po_numbers',
            'total_payable', 'total_freight_cost', 'payments', 'linked_bill', 'bill_linked',
            'covered_bills', 'covered_bills_detail', 'source_origin',
            'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'advice_no', 'direction', 'created_date', 'created_at', 'updated_at',
            'approved_by', 'approved_at'
        ]
        extra_kwargs = {
            'source_type': {'required': False, 'allow_blank': True},
            'receipt_advice': {'required': False, 'allow_null': True},
            'transfer_source': {'required': False, 'allow_null': True},
            'shifting_source': {'required': False, 'allow_null': True},
            'dispatch_challan_source': {'required': False, 'allow_null': True},
            'created_by': {'required': False, 'allow_null': True},
            'transporter': {'required': False, 'allow_null': True},
            'freight_type': {'required': False, 'allow_blank': True},
            'freight_source': {'required': False},
            'vendor_bill': {'required': False, 'allow_null': True},
            'base_amount': {'required': False},
            'payable_amount': {'required': False},
            'discount': {'required': False},
            'loading_wages_amount': {'required': False},
            'unloading_wages_amount': {'required': False},
            'other_charges': {'required': False},
            'quantity_basis': {'required': False},
            'quantity_uom': {'required': False, 'allow_blank': True},
            'cost_per_unit_calc': {'required': False},
            'destination_state': {'required': False, 'allow_blank': True},
            'status': {'required': False, 'allow_blank': True},
            'lorry_no': {'required': False, 'allow_blank': True},
            'driver_name': {'required': False, 'allow_blank': True},
            'driver_contact': {'required': False, 'allow_blank': True},
            'freight_date': {'required': False, 'allow_null': True},
            'dispatch_date': {'required': False},
            'expected_arrival_date': {'required': False},
            'actual_arrival_date': {'required': False},
            'freight_terms': {'required': False, 'allow_blank': True},
            'transport_document_no': {'required': False, 'allow_blank': True},
            'delivery_remarks': {'required': False, 'allow_blank': True},
            'remarks': {'required': False, 'allow_blank': True},
        }

    def get_total_payable(self, obj):
        return str(obj.get_total_payable())

    def get_total_freight_cost(self, obj):
        return str(obj.get_total_payable())

    def get_total_paid(self, obj):
        return str(obj.get_total_paid())

    def get_balance(self, obj):
        bal = obj.get_total_payable() - obj.get_total_paid()
        return str(bal if bal > 0 else Decimal('0'))

    @staticmethod
    def _goods_bill_from_narration(narr):
        """Pull the goods bill written in a Tally freight narration — the clause
        after "AGST" (against), e.g. "…AGST REFF SENTHIL PLASTIC B.NO: 16" →
        ('SENTHIL PLASTIC', '16'). Returns (vendor_hint, bill_no) or (None, None)."""
        import re
        if not narr:
            return None, None
        text = narr.upper()
        idx = text.find('AGST')                   # goods bill follows the FIRST "against"
        seg = text[idx + 4:] if idx >= 0 else text
        m = re.search(r'B\.?\s*NO\.?\s*:?\s*([A-Z0-9][A-Z0-9/\-]*)', seg)
        bill = m.group(1).strip(' -/') if m else None
        vend = seg[:m.start()] if m else seg
        vend = re.sub(r'\b(AGST|REFF?)\b', ' ', vend)   # drop "AGST"/"REF"/"REFF" fillers
        vend = re.sub(r'[^A-Z ]', ' ', vend)
        vend = re.sub(r'\s+', ' ', vend).strip()
        return (vend or None), (bill or None)

    def get_linked_bill(self, obj):
        """The Vendor Bill this freight is tied to. A Tally freight voucher has no
        clean bill field — it only NAMES the goods bill in its narration ("…AGST
        <vendor> B.NO <no>"), so read that first. Fall back to the Zoho SRA link or
        an exact-unique reference. Never guesses on a trivial/ambiguous number (e.g.
        a bare "2" that matches many bills) — better no link than a wrong one. Only
        computed on the detail view to avoid a per-row lookup on the list."""
        import difflib
        view = self.context.get('view')
        if getattr(view, 'action', 'retrieve') not in ('retrieve', None):
            return None
        from .models import VendorBill, ZohoPurchaseBill, ZohoInwardFreight
        ref = (obj.transport_document_no or '').strip()

        def _out(vb):
            return {'id': str(vb.id), 'bill_no': vb.bill_no or '',
                    'vendor_invoice_no': vb.vendor_invoice_no or '',
                    'vendor_name': (vb.vendor.vendor_name if vb.vendor_id else '')}

        def _bill_for_sra(sra):
            sra = (sra or '').strip()
            if not sra:
                return None
            zb = (ZohoPurchaseBill.objects.filter(sra_no__iexact=sra)
                  .exclude(converted_bill__isnull=True)
                  .select_related('converted_bill').first())
            return zb.converted_bill if (zb and zb.converted_bill_id) else None

        # 0. The freight is DIRECTLY linked to a goods bill. A bundle/shared freight
        #    from the Email Inbox stores vendor_bill = the goods bill the reviewer
        #    picked the vendor on, so that FK is authoritative — use it before any
        #    number-matching heuristic. Skip when the linked bill is itself a FREIGHT
        #    bill (Tally freight links to its own VendorBill for vendor/company
        #    derivation, not because it covers a goods bill).
        if obj.vendor_bill_id and obj.vendor_bill:
            if getattr(obj.vendor_bill, 'purchase_category', '') != 'FREIGHT':
                return _out(obj.vendor_bill)

        # 1. The document IS the bill/SRA number as stored on a Vendor Bill
        #    (e.g. "U SRA NKP-550"). Most direct — but only trust it when the
        #    reference is non-trivial AND matches a SINGLE bill, so a short
        #    transporter document number like "55" (the freight slip's OWN bill
        #    no) never false-matches an unrelated goods bill that happens to be
        #    numbered "55" too. Same guard step 3 uses for the invoice-no match.
        if ref and len(ref) >= 4:
            cands = list(VendorBill.objects.filter(bill_no__iexact=ref)
                         .select_related('vendor')[:2])
            if len(cands) == 1:
                return _out(cands[0])

        # 1a. …or the Zoho SRA number → Zoho bill → the converted Vendor Bill.
        vb = _bill_for_sra(ref)
        if vb is not None:
            return _out(vb)

        # 1b. Older Zoho imports left the document field blank — recover the SRA from
        #     the Zoho freight staging row that created this advice.
        zf = ZohoInwardFreight.objects.filter(created_advice=obj).only('sra_no', 'bill_no').first()
        if zf is not None:
            vb = _bill_for_sra(zf.sra_no)
            if vb is not None:
                return _out(vb)
            if (zf.bill_no or '').strip():        # else fall to the supplier invoice no
                cands = list(VendorBill.objects.filter(vendor_invoice_no__iexact=zf.bill_no.strip())
                             .select_related('vendor')[:2])
                if len(cands) == 1:
                    return _out(cands[0])

        # 2. The goods bill named in the Tally narration ("…AGST <vendor> B.NO <no>").
        import re
        _digits = lambda s: re.sub(r'[^0-9]', '', s or '')
        vend, bno = self._goods_bill_from_narration(obj.remarks)
        if bno:
            bd = _digits(bno)
            # Prefer the vendor named in the narration — match the bill within THEIR
            # bills. This is what makes "16" resolve to Senthil's "16/2026-27" rather
            # than another vendor's bill that happens to be invoice "16".
            if vend:
                word = next((w for w in vend.split() if len(w) >= 4), '')
                if word and len(bd) >= 2:
                    for b in (VendorBill.objects.filter(vendor__vendor_name__icontains=word)
                              .select_related('vendor')[:400]):
                        inv = (b.vendor_invoice_no or '').strip()
                        ibd = _digits(inv)
                        lead = re.match(r'\d+', inv)
                        lead = lead.group(0) if lead else ''
                        # match: exact · full digits equal · leading serial equal
                        # ("16" ↔ "16/2026-27") · long mangled number shares a digit
                        # tail (27IU2627 ↔ 271U/2627).
                        if inv.lower() == bno.lower() or (ibd and (
                                ibd == bd or (lead and lead == bd)
                                or (len(bd) >= 6 and (ibd[-9:] == bd[-9:] or bd in ibd or ibd in bd)))):
                            return _out(b)

            # No vendor hint (or its bill wasn't found): a global exact invoice match,
            # but only when it is unique — never guess among several same-number bills.
            gc = list(VendorBill.objects.filter(vendor_invoice_no__iexact=bno)
                      .select_related('vendor')[:2])
            if len(gc) == 1:
                return _out(gc[0])

        # 3. Exact reference match — only when it's non-trivial AND unique.
        if ref and len(ref) >= 4:
            cands = list(VendorBill.objects.filter(vendor_invoice_no__iexact=ref)
                         .select_related('vendor')[:2])
            if len(cands) == 1:
                return _out(cands[0])

        # 4. No matching bill in the ERP — still surface the bill REFERENCE we know
        #    (the SRA / document / narration bill no) as plain text, flagged
        #    `unresolved` so the UI shows the number without a link. This is why a
        #    freight can show a bill number even before that bill is imported.
        ref_no = ref
        if not ref_no and zf is not None:
            ref_no = (zf.sra_no or zf.bill_no or '').strip()
        if not ref_no and bno:
            ref_no = bno
        if ref_no and len(ref_no) >= 3:
            return {'id': None, 'unresolved': True, 'bill_no': ref_no,
                    'vendor_invoice_no': '', 'vendor_name': ''}
        return None                              # nothing usable → show no link

    def get_bill_linked(self, obj):
        """Whether this freight resolves to a REAL Vendor Bill (a clickable link).
        On the list a precomputed map is passed in the context (`linked_map`) so we
        don't run a per-row lookup; on the detail view we compute it directly."""
        lm = self.context.get('linked_map')
        if lm is not None:
            return obj.id in lm
        lb = self.get_linked_bill(obj)
        return bool(lb and lb.get('id'))

    @staticmethod
    def bulk_linked_map(freights):
        """List-page bulk equivalent of get_linked_bill: return {freight_id:
        vendor_name} for every freight that resolves to a real Vendor Bill, using a
        handful of bulk queries instead of one lookup per row. The vendor name is the
        goods-bill vendor, so the list can show it in the Vendor column."""
        import re
        from collections import defaultdict
        from .models import VendorBill, ZohoPurchaseBill, ZohoInwardFreight
        freights = list(freights)
        if not freights:
            return {}
        digits = lambda s: re.sub(r'[^0-9]', '', s or '')

        bill_no_vendor = {}      # bill_no_lower → vendor_name
        for bn, vn in VendorBill.objects.exclude(bill_no='').values_list('bill_no', 'vendor__vendor_name'):
            bill_no_vendor.setdefault((bn or '').strip().lower(), vn or '')
        sra_vendor = {}          # sra_lower → converted bill's vendor_name
        for sn, vn in (ZohoPurchaseBill.objects.exclude(converted_bill__isnull=True).exclude(sra_no='')
                       .values_list('sra_no', 'converted_bill__vendor__vendor_name')):
            sra_vendor.setdefault((sn or '').strip().lower(), vn or '')
        fa_ids = [f.id for f in freights]
        staging = {}
        for aid, sra in (ZohoInwardFreight.objects.filter(created_advice_id__in=fa_ids)
                         .values_list('created_advice_id', 'sra_no')):
            if aid and aid not in staging:
                staging[aid] = (sra or '').strip().lower()

        # Freight DIRECTLY linked to a goods bill (bundle/shared freight from the
        # Email Inbox) — the primary vendor_bill first, else any covered bill (all
        # the same vendor on a shared slip). Authoritative, so checked before the
        # number-matching heuristics below.
        from .models import FreightAdviceInbound
        direct_vendor = {}
        for fid, vn in (FreightAdviceInbound.objects.filter(id__in=fa_ids, vendor_bill__isnull=False)
                        .values_list('id', 'vendor_bill__vendor__vendor_name')):
            if vn:
                direct_vendor[fid] = vn
        # Covered bills use related_name `covering_freights` back to the freight.
        for fid, vn in (VendorBill.objects.filter(covering_freights__in=fa_ids)
                        .values_list('covering_freights', 'vendor__vendor_name')):
            if vn:
                direct_vendor.setdefault(fid, vn)

        vendor_index = defaultdict(list)     # vendor first-word → [(inv_digits, lead, inv_lower, vendor_name)]
        invoice_count = defaultdict(int)
        invoice_vendor = {}
        for vname, inv in (VendorBill.objects.exclude(vendor_invoice_no='')
                           .values_list('vendor__vendor_name', 'vendor_invoice_no')):
            invl = (inv or '').strip().lower()
            invoice_count[invl] += 1
            invoice_vendor.setdefault(invl, vname or '')
            ibd = digits(inv)
            m = re.match(r'\d+', (inv or '').strip())
            lead = m.group(0) if m else ''
            seen = set()
            for w in (vname or '').split():
                wl = w.lower()
                if len(w) >= 4 and wl not in seen:
                    seen.add(wl)
                    vendor_index[wl].append((ibd, lead, invl, vname or ''))

        out = {}
        for fa in freights:
            # Direct goods-bill link (bundle/shared freight) wins over any heuristic.
            if fa.id in direct_vendor:
                out[fa.id] = direct_vendor[fa.id]; continue
            ref = (fa.transport_document_no or '').strip()
            rl = ref.lower()
            # Only trust an exact bill-no match on a non-trivial reference, so a
            # short transporter document no like "55" doesn't false-match an
            # unrelated goods bill numbered "55" (mirrors the detail view).
            if ref and len(ref) >= 4 and rl in bill_no_vendor:
                out[fa.id] = bill_no_vendor[rl]; continue
            if ref and rl in sra_vendor:
                out[fa.id] = sra_vendor[rl]; continue
            sra = staging.get(fa.id, '')
            if sra and sra in sra_vendor:
                out[fa.id] = sra_vendor[sra]; continue
            if sra and sra in bill_no_vendor:
                out[fa.id] = bill_no_vendor[sra]; continue
            vend, bno = FreightAdviceInboundSerializer._goods_bill_from_narration(fa.remarks)
            if bno:
                bd = digits(bno)
                hit_vendor = None
                if vend:
                    word = next((w for w in vend.split() if len(w) >= 4), '')
                    if word and len(bd) >= 2:
                        for ibd, lead, invl, vn in vendor_index.get(word.lower(), []):
                            if invl == bno.lower() or (ibd and (
                                    ibd == bd or (lead and lead == bd)
                                    or (len(bd) >= 6 and (ibd[-9:] == bd[-9:] or bd in ibd or ibd in bd)))):
                                hit_vendor = vn; break
                if hit_vendor is None and not vend and invoice_count.get(bno.lower(), 0) == 1:
                    hit_vendor = invoice_vendor.get(bno.lower(), '')
                if hit_vendor is not None:
                    out[fa.id] = hit_vendor; continue
            if ref and len(ref) >= 4 and invoice_count.get(rl, 0) == 1:
                out[fa.id] = invoice_vendor.get(rl, '')
        return out

    def get_vendor_name(self, obj):
        try:
            if obj.source_type == 'PURCHASE_RECEIPT' and obj.receipt_advice and obj.receipt_advice.vendor:
                return obj.receipt_advice.vendor.vendor_name
            if obj.source_type == 'INVENTORY_TRANSFER' and obj.transfer_source and obj.transfer_source.transporter:
                return obj.transfer_source.transporter.name
            if obj.source_type == 'SALES_DISPATCH_CHALLAN' and obj.dispatch_challan_source:
                # Treat customer side as the counter-party for a DC-sourced freight.
                so_link = obj.dispatch_challan_source.dc_lines.first()
                so = so_link.so_line.so if so_link and so_link.so_line else None
                cust = getattr(so, 'customer', None)
                if cust:
                    return getattr(cust, 'name', '') or getattr(cust, 'customer_name', '')
            # Shifting is intra-warehouse, no vendor.
            if obj.source_type == 'VENDOR_BILL' and obj.vendor_bill_id and obj.vendor_bill and obj.vendor_bill.vendor_id:
                return obj.vendor_bill.vendor.vendor_name
        except Exception:
            pass
        # Imported freight (Zoho/Tally) has no receipt — use the linked bill's vendor.
        lm = self.context.get('linked_map')
        if lm is not None:
            return lm.get(obj.id, '') or ''
        lb = self.get_linked_bill(obj)
        if lb and lb.get('id'):
            return lb.get('vendor_name') or ''
        # A shared slip with no single primary bill still covers goods bills — all
        # the same vendor — so use any covered bill's vendor (Email Inbox path).
        # Read from the PREFETCHED covered_bills (viewset prefetches vendor): a
        # fresh .select_related().first() here would bypass the prefetch and fire
        # one query per row on the list.
        for cb in obj.covered_bills.all():
            if cb.vendor_id:
                return cb.vendor.vendor_name
        return ''

    def get_warehouse_name(self, obj):
        try:
            if obj.source_type == 'PURCHASE_RECEIPT' and obj.receipt_advice and obj.receipt_advice.warehouse:
                return obj.receipt_advice.warehouse.name
            if obj.source_type == 'INVENTORY_TRANSFER' and obj.transfer_source:
                # "To Warehouse" is the receiving side and matches the Purchase Receipt meaning best.
                to_wh = getattr(obj.transfer_source, 'to_warehouse', None)
                if to_wh:
                    return to_wh.name
            if obj.source_type == 'INVENTORY_SHIFTING' and obj.shifting_source and obj.shifting_source.warehouse:
                return obj.shifting_source.warehouse.name
            if obj.source_type == 'SALES_DISPATCH_CHALLAN' and obj.dispatch_challan_source and obj.dispatch_challan_source.warehouse:
                return obj.dispatch_challan_source.warehouse.name
        except Exception:
            pass
        return ''

    def get_company_name(self, obj):
        """Company that owns this inward freight — FreightAdviceInbound has no
        company FK, so derive it. Powers the Inward Freight company toggle. Returns
        the company's legal_name. Uses the model's resolve_company() so the DISPLAY
        company and the company a record FILTERS under are always the same value
        (they used to be derived two different ways and could disagree)."""
        try:
            # resolve_company() already does all of what this used to inline —
            # linked bill (warehouse-company OR vendor-company, the latter being
            # the Tally-imported path a parallel change had just added), covered
            # bills, transporter, then the source-document warehouse — so the
            # DISPLAY name and the FILTER id can't diverge.
            co = obj.resolve_company()
            return (getattr(co, 'legal_name', '') or getattr(co, 'trade_name', '') or '') if co else ''
        except Exception:  # noqa: BLE001 — a derivation miss must never 500 the row
            return ''

    def get_po_numbers(self, obj):
        try:
            if obj.source_type == 'PURCHASE_RECEIPT' and obj.receipt_advice:
                return list(obj.receipt_advice.linked_pos.values_list('po_number', flat=True))
        except Exception:
            pass
        return []

    def get_approved_by_name(self, obj):
        try:
            if obj.approved_by:
                return obj.approved_by.user.get_full_name()
        except Exception:
            pass
        return ''

    def get_receipt_date(self, obj):
        try:
            if obj.source_type == 'PURCHASE_RECEIPT' and obj.receipt_advice:
                rd = obj.receipt_advice.receipt_date
                return rd.date().isoformat() if hasattr(rd, 'date') else str(rd) if rd else None
            if obj.source_type == 'INVENTORY_TRANSFER' and obj.transfer_source:
                rd = obj.transfer_source.transfer_date or obj.transfer_source.dispatch_date
                return rd.isoformat() if rd else None
            if obj.source_type == 'INVENTORY_SHIFTING' and obj.shifting_source:
                rd = obj.shifting_source.request_date
                return rd.date().isoformat() if hasattr(rd, 'date') else str(rd) if rd else None
            if obj.source_type == 'SALES_DISPATCH_CHALLAN' and obj.dispatch_challan_source:
                rd = obj.dispatch_challan_source.dispatch_date
                return rd.date().isoformat() if hasattr(rd, 'date') else str(rd) if rd else None
        except Exception:
            pass
        return None

    def validate(self, data):
        """Enforce exactly-one-source rule and validate quantity_basis vs source qty."""
        from django.db.models import Sum

        # Pull effective values (handles partial updates that omit unchanged keys).
        source_type = data.get('source_type') or (self.instance.source_type if self.instance else 'PURCHASE_RECEIPT')
        receipt_advice = data.get('receipt_advice') if 'receipt_advice' in data else (self.instance.receipt_advice if self.instance else None)
        transfer_source = data.get('transfer_source') if 'transfer_source' in data else (self.instance.transfer_source if self.instance else None)
        shifting_source = data.get('shifting_source') if 'shifting_source' in data else (self.instance.shifting_source if self.instance else None)
        dispatch_challan_source = data.get('dispatch_challan_source') if 'dispatch_challan_source' in data else (self.instance.dispatch_challan_source if self.instance else None)

        # Dispatch Challan is a sales/outbound document; it cannot be the
        # source of an Inward Freight. Reject it explicitly so direct API
        # callers can't bypass the Inward Freight form (the radio option
        # has been removed from the UI).
        if source_type == 'SALES_DISPATCH_CHALLAN':
            raise serializers.ValidationError({
                'source_type': 'Dispatch Challan is not a valid source for Inward Freight.'
            })

        # Exactly one source FK must match the declared source_type.
        if source_type == 'PURCHASE_RECEIPT' and not receipt_advice:
            raise serializers.ValidationError({'receipt_advice': 'Required when source_type is PURCHASE_RECEIPT.'})
        if source_type == 'INVENTORY_TRANSFER' and not transfer_source:
            raise serializers.ValidationError({'transfer_source': 'Required when source_type is INVENTORY_TRANSFER.'})
        if source_type == 'INVENTORY_SHIFTING' and not shifting_source:
            raise serializers.ValidationError({'shifting_source': 'Required when source_type is INVENTORY_SHIFTING.'})

        # Block one-source-document → multiple-freight unless explicitly allowed.
        # Quietly enforced by the frontend's "exclude-already-billed" filter; we
        # also check here for direct API hits.
        if source_type == 'PURCHASE_RECEIPT' and receipt_advice and not self.instance:
            existing = FreightAdviceInbound.objects.filter(
                receipt_advice=receipt_advice, is_active=True,
            ).exists()
            if existing:
                raise serializers.ValidationError({'receipt_advice': 'A freight bill already exists for this receipt.'})
        if source_type == 'INVENTORY_TRANSFER' and transfer_source and not self.instance:
            existing = FreightAdviceInbound.objects.filter(
                transfer_source=transfer_source, is_active=True,
            ).exists()
            if existing:
                raise serializers.ValidationError({'transfer_source': 'A freight bill already exists for this transfer.'})
        if source_type == 'INVENTORY_SHIFTING' and shifting_source and not self.instance:
            existing = FreightAdviceInbound.objects.filter(
                shifting_source=shifting_source, is_active=True,
            ).exists()
            if existing:
                raise serializers.ValidationError({'shifting_source': 'A freight bill already exists for this shifting.'})
        # Quantity-basis vs source qty is only checked for receipt-advice freight
        # (the legacy validation path).
        quantity_basis = data.get('quantity_basis')
        if quantity_basis is None or source_type != 'PURCHASE_RECEIPT' or receipt_advice is None:
            return data

        if quantity_basis <= Decimal('0'):
            raise serializers.ValidationError(
                "Freight quantity must be greater than 0."
            )

        # Invoice-driven aggregation — matches PO.get_total_received.
        # Counts invoice qty regardless of is_debit_note.
        receipt_qty = receipt_advice.receipt_lines.aggregate(
            total=Sum('quantity_received')
        )['total'] or Decimal('0')

        # Get PO total ordered quantity (via receipt's linked POs)
        po_qty = None
        linked_pos = receipt_advice.linked_pos.all()
        if linked_pos.exists():
            po_qty = Decimal('0')
            for po in linked_pos:
                po_total = po.po_lines.aggregate(
                    total=Sum('quantity_ordered')
                )['total'] or Decimal('0')
                po_qty += po_total

        # Determine the allowed max: MIN(receipt_qty, po_qty)
        if po_qty is not None:
            allowed_qty = min(receipt_qty, po_qty)
        else:
            allowed_qty = receipt_qty

        # Calculate already-used freight quantity for this receipt (exclude current if updating)
        already_used_qs = FreightAdviceInbound.objects.filter(
            receipt_advice=receipt_advice, is_active=True
        ).exclude(status='CANCELLED')

        if self.instance:
            already_used_qs = already_used_qs.exclude(pk=self.instance.pk)

        already_used = already_used_qs.aggregate(
            total=Sum('quantity_basis')
        )['total'] or Decimal('0')

        remaining = allowed_qty - already_used
        if quantity_basis > remaining:
            raise serializers.ValidationError(
                f"Freight quantity ({quantity_basis}) exceeds the allowed quantity. "
                f"Receipt quantity: {receipt_qty}"
                + (f", PO quantity: {po_qty}" if po_qty is not None else "")
                + f", Already allocated: {already_used}, Remaining: {remaining}. "
                f"Freight quantity cannot be greater than the Receipt or Purchase Order quantity."
            )

        return data


class FreightAdviceInboundListSerializer(FreightAdviceInboundSerializer):
    """The Freight LIST columns. Opt-in via ?slim=1.

    The full serializer carries 70 fields - the whole freight advice, built so
    the detail screen can render it. The list shows eight of them. Narrowing
    the field list keeps every value identical and stops shipping the other
    sixty-odd for 408 rows.
    """

    class Meta(FreightAdviceInboundSerializer.Meta):
        # Only fields that exist on the serializer. NOTE: the list page also
        # reads row.advice_date and row.amount, and neither is a field here -
        # those reads render blank today and would keep rendering blank; that
        # is a pre-existing page bug, not something this narrowing caused.
        fields = [
            'id', 'advice_no', 'freight_date', 'vendor_name',
            'transporter', 'transporter_name',
            'receipt_advice', 'receipt_advice_no',
            'freight_source', 'freight_source_display', 'vendor_bill', 'vendor_bill_no',
            'freight_type', 'freight_type_display',
            'freight_terms', 'freight_terms_display',
            'quantity_basis',
            'total_freight_cost', 'payable_amount', 'total_paid', 'balance',
            'status', 'status_display',
        ]



class PaymentTaxComponentSerializer(serializers.ModelSerializer):
    """Serializer for payment tax components."""

    tax_type_display = serializers.CharField(
        source='get_tax_type_display',
        read_only=True
    )

    class Meta:
        model = PaymentTaxComponent
        fields = [
            'id', 'advice', 'tax_type', 'tax_type_display', 'rate', 'amount'
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'rate': {'required': False},
        }


class VendorPaymentAdviceSerializer(serializers.ModelSerializer):
    """Serializer for vendor payment advices."""

    tax_components = PaymentTaxComponentSerializer(many=True, read_only=True)
    vendor_name = serializers.CharField(
        source='vendor.name',
        read_only=True
    )
    prepared_by_name = serializers.SerializerMethodField()
    source_document_type_display = serializers.CharField(
        source='get_source_document_type_display',
        read_only=True,
        default=''
    )
    payment_method_display = serializers.CharField(
        source='get_payment_method_display',
        read_only=True,
        default=''
    )
    status_display = serializers.CharField(
        source='get_status_display',
        read_only=True
    )
    receipt_advice_no = serializers.SerializerMethodField()
    po_numbers = serializers.SerializerMethodField()
    net_payable_amount = serializers.SerializerMethodField()
    balance_amount = serializers.SerializerMethodField()

    class Meta:
        model = VendorPaymentAdvice
        fields = [
            'id', 'advice_no', 'vendor', 'vendor_name',
            'receipt_advice', 'receipt_advice_no',
            'source_document_type', 'source_document_type_display',
            'source_document_id',
            'invoice_no', 'invoice_date',
            'amount', 'tds_amount', 'other_deductions',
            'net_payable_amount', 'paid_amount', 'balance_amount',
            'due_date',
            'payment_method', 'payment_method_display',
            'payment_reference', 'payment_date', 'bank_name', 'transaction_id',
            'prepared_by', 'prepared_by_name',
            'status', 'status_display', 'notes', 'tax_components',
            'po_numbers',
            'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'advice_no', 'created_at', 'updated_at'
        ]
        extra_kwargs = {
            'source_document_type': {'required': False, 'allow_blank': True},
            'source_document_id': {'required': False, 'allow_null': True},
            'due_date': {'required': False, 'allow_null': True},
            'payment_method': {'required': False, 'allow_blank': True},
            'status': {'required': False, 'allow_blank': True},
            'notes': {'required': False, 'allow_blank': True},
            'invoice_no': {'required': False, 'allow_blank': True},
            'invoice_date': {'required': False, 'allow_null': True},
            'tds_amount': {'required': False},
            'other_deductions': {'required': False},
            'paid_amount': {'required': False},
            'payment_reference': {'required': False, 'allow_blank': True},
            'payment_date': {'required': False, 'allow_null': True},
            'bank_name': {'required': False, 'allow_blank': True},
            'transaction_id': {'required': False, 'allow_blank': True},
            'receipt_advice': {'required': False, 'allow_null': True},
            'prepared_by': {'required': False, 'allow_null': True},
        }

    def get_prepared_by_name(self, obj):
        try:
            if obj.prepared_by:
                return obj.prepared_by.user.get_full_name()
        except Exception:
            pass
        return ''

    def get_receipt_advice_no(self, obj):
        try:
            if obj.receipt_advice:
                return obj.receipt_advice.receipt_advice_no
        except Exception:
            pass
        return ''

    def get_po_numbers(self, obj):
        try:
            if obj.receipt_advice:
                return list(
                    obj.receipt_advice.linked_pos.values_list('po_number', flat=True)
                )
        except Exception:
            pass
        return []

    def get_net_payable_amount(self, obj):
        return str(obj.net_payable)

    def get_balance_amount(self, obj):
        return str(obj.balance_amount)


# ──────────────────────────────────────────────────────────────
#  Vendor Bills, Payments Made, Vendor Credits
# ──────────────────────────────────────────────────────────────

class VendorBillLineSerializer(serializers.ModelSerializer):
    """Serializer for vendor bill line items.

    Two-FK shape matches the rest of the purchase line models —
    exposes unified item_type / item_name / item_code so the frontend
    renders Goods and Service lines through one column.
    """

    product_name = serializers.CharField(source='product.product_name', read_only=True, default='')
    product_code = serializers.CharField(source='product.sku_code', read_only=True, default='')
    machinery_name = serializers.SerializerMethodField()
    service_catalogue_name = serializers.SerializerMethodField()
    item_type = serializers.SerializerMethodField()
    item_name = serializers.SerializerMethodField()
    item_code = serializers.SerializerMethodField()
    # "Tax%" column source. Tally-imported bills leave each line's tax_percent at
    # 0 (the whole GST sits on the bill header), so fall back to the bill's
    # effective rate (tax / taxable) and flag it derived so the UI can mark it.
    effective_tax_percent = serializers.SerializerMethodField()
    tax_percent_derived = serializers.SerializerMethodField()

    class Meta:
        from .models import VendorBillLine
        model = VendorBillLine
        fields = [
            'id',
            'product', 'product_name', 'product_code',
            'machinery_name',
            'service_catalogue', 'service_catalogue_name',
            'item_type', 'item_name', 'item_code',
            'description', 'quantity',
            'uom', 'rate', 'discount_percent', 'tax_percent', 'amount',
            'effective_tax_percent', 'tax_percent_derived',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'product': {'required': False, 'allow_null': True},
            'service_catalogue': {'required': False, 'allow_null': True},
            'description': {'required': False, 'allow_blank': True},
            'uom': {'required': False, 'allow_blank': True},
            'discount_percent': {'required': False},
            'tax_percent': {'required': False},
        }

    def _derived_line_rate(self, obj):
        """The bill's effective GST rate = tax / taxable (taxable = subtotal minus
        the non-goods other_charges). Used only when the line itself carries no
        tax_percent. Exact for a single-rate bill; a blended figure otherwise."""
        from decimal import Decimal
        try:
            b = obj.bill
        except Exception:
            return None
        taxable = (b.subtotal or Decimal('0')) - (b.other_charges or Decimal('0'))
        if taxable and (b.tax_amount or Decimal('0')):
            return (Decimal(b.tax_amount) / Decimal(taxable) * 100).quantize(Decimal('0.01'))
        return None

    def get_effective_tax_percent(self, obj):
        if obj.tax_percent and obj.tax_percent > 0:
            return str(obj.tax_percent)
        r = self._derived_line_rate(obj)
        return str(r) if r is not None else str(obj.tax_percent or 0)

    def get_tax_percent_derived(self, obj):
        return bool((not obj.tax_percent or obj.tax_percent == 0)
                    and self._derived_line_rate(obj) is not None)

    def get_machinery_name(self, obj):
        m = _machine_ref(obj)
        if not m:
            return ''
        return getattr(m, 'machine_name', None) or getattr(m, 'name', None) or str(m)

    def get_service_catalogue_name(self, obj):
        s = obj.service_catalogue
        if not s:
            return ''
        return f"{s.service_code} — {s.name}" if getattr(s, 'service_code', None) else s.name

    def get_item_type(self, obj):
        if _is_machinery_line(obj):
            return 'MACHINERY'
        if obj.service_catalogue_id:
            return 'SERVICE'
        return 'PRODUCT'

    def get_item_name(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'name', '') or ''
        if obj.product_id:
            return obj.product.product_name or ''
        return ''

    def get_item_code(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'service_code', '') or ''
        if obj.product_id:
            return obj.product.sku_code or ''
        return ''

    def validate(self, attrs):
        """Enforce exactly-one-of (product, machinery, service_catalogue)."""
        instance = getattr(self, 'instance', None)
        product = attrs.get('product', getattr(instance, 'product', None) if instance else None)
        service = attrs.get('service_catalogue', getattr(instance, 'service_catalogue', None) if instance else None)
        populated = sum(1 for v in (product, service) if v)
        if populated == 0:
            raise serializers.ValidationError(
                'Bill line must reference exactly one of product, machinery, or service_catalogue.'
            )
        if populated > 1:
            raise serializers.ValidationError(
                'Bill line cannot reference more than one of product, machinery, or service_catalogue.'
            )
        return attrs


class VendorBillReceiptLinkSerializer(serializers.ModelSerializer):
    """Just enough for the Receipts page to know which receipts already have a
    bill. Opt-in via ?slim=1, so no other caller's payload moves.

    `receipt_advice` is the whole point. The Receipts list decides between
    "Create Bill" and "Paid" by asking whether any bill points at the row:

        billsData.find(b => b.receipt_advice === row.id)

    VendorBillListSerializer does not carry that field, so the answer was
    always "no bill" and every receipt offered "Create Bill" - including the
    343 that already had one, inviting a duplicate. Sending these four fields
    instead of the whole bill both restores the check and drops the page's
    bills fetch from ~1.1 MB to a few tens of KB.
    """

    status_display = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        from .models import VendorBill      # imported here, as the sibling
                                            # bill serializers below do
        model = VendorBill
        fields = ['id', 'receipt_advice', 'status', 'status_display']


class VendorBillListSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    """Lightweight serializer for the Bills LIST page.

    The list table renders only scalar columns, so it must NOT pay the per-row
    DB cost of the full VendorBillSerializer, whose method fields (bill_lines,
    payment_history, is_debit_eligible, has_credit) each fire a query PER bill —
    which turned a full-table list into thousands of queries and a 30-40s load.
    Every field here is a plain column, a select_related attribute, a no-query
    property (balance_due = total-paid), or the queryset's _scan_confirmed
    annotation — so a page of bills costs a single query. Detail/create/update
    still use the full VendorBillSerializer.
    """
    field_permission_module = 'Vendor Bill'
    vendor_name = serializers.CharField(source='vendor.vendor_name', read_only=True, default='')
    # Whether the bill's vendor is an MSME supplier (MSMED Act / Udyam
    # registered). Carried on the list row so screens that read these rows —
    # the Reports page's Payables ageing among them — can offer an "MSME only"
    # filter without a second round-trip, exactly as the dashboard's ?msme=
    # toggle does server-side.
    vendor_is_msme = serializers.BooleanField(source='vendor.is_msme', read_only=True, default=False)
    # Company the bill belongs to — a bill has no company of its own, it
    # inherits the one its VENDOR is registered under. The source used to be
    # `vendor.company.company_name`, and core.Company has no such field
    # (it carries company_code / legal_name / trade_name). DRF swallows the
    # AttributeError when a field declares a default, so every row came back
    # with company_name='' and the Bills page's company filter — which builds
    # its options from the rows — never had anything to offer and stayed
    # hidden. `legal_name` is what every other serializer in the codebase
    # exposes as company_name (vendor, customer, warehouse).
    company_name = serializers.CharField(source='vendor.company.legal_name', read_only=True, default='')
    # The company's ID as well as its name. Every OTHER purchase screen that
    # scopes by company — Purchase by Category, Creditors — keys on the id and
    # passes it as ?company=<uuid>, so the Bills list has to filter on the same
    # key or a drill-through between them silently lands on zero rows. The name
    # stays for the chip LABEL; the id is what gets compared and put in the URL.
    company = serializers.CharField(source='vendor.company.id', read_only=True, default=None)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    purchase_category_display = serializers.CharField(
        source='get_purchase_category_display', read_only=True, default='')
    balance_due = serializers.SerializerMethodField()
    scan_tally_matched = serializers.SerializerMethodField()
    is_scanned = serializers.SerializerMethodField()
    is_branch_transfer = serializers.SerializerMethodField()
    # Destination warehouse (needs select_related('warehouse') on the queryset to
    # stay a single query — added in the Bills viewset).
    warehouse_name = serializers.CharField(source='warehouse.name', read_only=True, default='')
    # Quantity / Rate columns on the Bills list. Both read the subqueries the
    # LIST queryset annotates (_qty / _uom / _uom_n) -- never the lines
    # themselves, which would be one query per row.
    quantity = serializers.SerializerMethodField()
    quantity_uom = serializers.SerializerMethodField()
    rate = serializers.SerializerMethodField()
    # Actual TDS deducted on the bill (Tally's TDS Payable, linked by ref) — the
    # REAL figure the Bills column shows, beside the engine's expected amount.
    tds_deducted = serializers.SerializerMethodField()
    bill_lines = serializers.SerializerMethodField()
    # Place-of-supply basis for the GST column — 'intra' (CGST+SGST), 'inter'
    # (IGST), 'none' (no GST) or 'unknown'. Lets the list shade the single GST
    # figure by supply type instead of adding three CGST/SGST/IGST columns. No
    # bill stores the split (all zero), so it's derived from vendor vs company
    # state — the same logic the detail's gst_split uses — and the list queryset
    # already select_related('vendor__company'), so it stays one query.
    gst_basis = serializers.SerializerMethodField()

    def get_gst_basis(self, obj):
        from decimal import Decimal
        Z = Decimal('0')
        tax = obj.tax_amount or Z
        if not tax:
            return 'none'
        cg, sg, ig = (obj.cgst_amount or Z), (obj.sgst_amount or Z), (obj.igst_amount or Z)
        if cg or sg or ig:                       # stored split wins, when present
            return 'inter' if (ig and not (cg or sg)) else 'intra'

        def _sc(gstin):
            g = (gstin or '').strip()
            return g[:2] if len(g) >= 2 and g[:2].isdigit() else ''
        vendor = obj.vendor if obj.vendor_id else None
        company = getattr(vendor, 'company', None) if vendor else None
        vstate = _sc(getattr(vendor, 'gstin', '') if vendor else '')
        cstate = _sc(getattr(company, 'gstin', '') if company else '')
        if vstate and cstate:
            return 'intra' if vstate == cstate else 'inter'
        return 'unknown'

    class Meta:
        from .models import VendorBill
        model = VendorBill
        fields = [
            'id', 'bill_no', 'vendor', 'vendor_name', 'company', 'company_name', 'vendor_invoice_no',
            'bill_date', 'due_date', 'subtotal', 'tax_amount', 'gst_basis', 'tds_amount',
            'total_amount', 'other_charges', 'expense_charges', 'amount_paid', 'balance_due',
            'status', 'status_display', 'rm_category', 'purchase_category',
            'purchase_category_display', 'category_source', 'tally_voucher_type',
            'is_expense', 'expense_group', 'expense_subcategory',
            'tally_guid', 'is_active', 'scan_tally_matched', 'is_scanned',
            'is_branch_transfer', 'warehouse', 'warehouse_name', 'created_at', 'updated_at',
            'quantity', 'quantity_uom', 'rate',
            'computed_tds_amount', 'computed_tds_section', 'tds_status', 'tds_deducted',
            'bill_lines', 'vendor_is_msme',
        ]

    def get_tds_deducted(self, obj):
        # Reads the list queryset's tds_deducted_sum annotation (Tally's actual).
        v = getattr(obj, 'tds_deducted_sum', None)
        return str(v) if v else '0'

    def get_bill_lines(self, obj):
        # Only serialized when include_lines=1 triggered the prefetch.
        # Uses _prefetched_objects_cache to avoid an extra query when lines weren't fetched.
        cache = getattr(obj, '_prefetched_objects_cache', {})
        if 'bill_lines' not in cache:
            return []
        lines = cache['bill_lines']
        return [
            {
                'id': ln.id,
                'product_name': (ln.product.product_name if ln.product_id and ln.product else None) or ln.description or '',
                'description': ln.description or '',
                'quantity': str(ln.quantity) if ln.quantity is not None else None,
                'uom': ln.uom or '',
                'rate': str(ln.rate) if ln.rate is not None else None,
                'amount': str(ln.amount) if ln.amount is not None else None,
            }
            for ln in lines
        ]

    def get_quantity(self, obj):
        """Summed line quantity -- None when the units are mixed, because adding
        3 PCS to 2 MTS produces a number that means nothing."""
        if getattr(obj, '_uom_n', None) and obj._uom_n > 1:
            return None
        q = getattr(obj, '_qty', None)
        return str(q) if q is not None else None

    def get_quantity_uom(self, obj):
        """'MIXED' is shown rather than left blank: it tells the reader the bill
        HAS quantities, just not one unit to express them in."""
        n = getattr(obj, '_uom_n', None)
        if n and n > 1:
            return 'MIXED'
        return getattr(obj, '_uom', None) or ''

    def get_rate(self, obj):
        """Effective per-unit rate, EX-GST: subtotal / quantity.

        subtotal, not total_amount -- a purchase rate is quoted before tax, and
        dividing the tax-inclusive total would overstate it by the GST rate.
        Returns None instead of a wrong number when the bill has no lines, no
        quantity, mixed units, or no subtotal (~2% of bills, mostly Tally
        imports booked at a total with no line detail).
        """
        if getattr(obj, '_uom_n', None) and obj._uom_n > 1:
            return None
        q = getattr(obj, '_qty', None)
        sub = obj.subtotal or 0
        if not q or not sub:
            return None
        try:
            return str((Decimal(sub) / Decimal(q)).quantize(Decimal('0.01')))
        except (ArithmeticError, TypeError, ValueError):
            return None

    def get_balance_due(self, obj):
        return str(obj.balance_due)

    @staticmethod
    def _scanned(obj):
        # A scan's record is DELETED when its batch is cleaned up, so the bill it
        # created loses the annotation even though it was scanned. Count ANY
        # attachment (annotated _scan_attach — an invoice/scan copy) or the
        # "Created from scanned invoice" note (on the row, free) as scanned too. An
        # EMAIL-Inbox bill is also an
        # auto-extracted-from-PDF bill not-yet-in-Tally — the same "Scan" reminder
        # applies — so its "Created from emailed bill" note counts too.
        if getattr(obj, '_scan_confirmed', False) or getattr(obj, '_scan_attach', False):
            return True
        note = (getattr(obj, 'notes', '') or '').lower()
        return ('scanned invoice' in note or 'from scanned' in note
                or 'emailed bill' in note or 'email bill inbox' in note)

    def get_is_scanned(self, obj):
        return bool(self._scanned(obj))

    def get_scan_tally_matched(self, obj):
        # Reads the queryset's _scan_confirmed / _scan_attach annotations — never a
        # per-row query. Scan + Tally = scanned AND has a (non-opening) Tally guid.
        g = getattr(obj, 'tally_guid', '') or ''
        if not g or g.startswith('OPENING'):
            return False
        return bool(self._scanned(obj))

    def get_is_branch_transfer(self, obj):
        from .branch_transfer import is_branch_transfer_bill
        return is_branch_transfer_bill(obj)


class VendorBillListSlimSerializer(VendorBillListSerializer):
    """The Bills LIST page's columns. Opt-in via ?slim=list.

    A NARROWING SUBCLASS: every field kept is still produced by
    VendorBillListSerializer, so no value moves. Six fields the page never
    reads are dropped - tds_amount, rm_category, purchase_category_display,
    category_source and the two audit stamps - about 21% of the payload.

    A separate flag value from ?slim=1 on purpose. That one already means
    "the four fields the Receipts page needs to match a bill to a receipt",
    and it is live in production; one flag meaning two different shapes on the
    same endpoint is how quiet bugs get made.

    Deliberately NOT server-side pagination, which is where the real saving on
    this page is (3,178 rows fetched to show 15). That would move search and
    sort from the browser to the database and can return a different set of
    rows - a behaviour change, and the owner's standing instruction here is
    performance only.
    """

    class Meta(VendorBillListSerializer.Meta):
        fields = [
            'id', 'bill_no', 'vendor', 'vendor_name', 'vendor_is_msme', 'company', 'company_name',
            'vendor_invoice_no', 'bill_date', 'due_date',
            'subtotal', 'tax_amount', 'gst_basis', 'total_amount', 'other_charges', 'expense_charges', 'amount_paid',
            'balance_due', 'status', 'status_display',
            'purchase_category', 'category_source', 'expense_group', 'expense_subcategory',
            'tally_voucher_type', 'is_expense',
            'tally_guid', 'is_active', 'scan_tally_matched', 'is_scanned',
            'is_branch_transfer', 'warehouse', 'warehouse_name',
            # Entry Date column — when the bill was actually entered in the ERP
            # (Scan confirm / Email approve / import time), distinct from bill_date.
            'created_at',
            # Quantity / Rate columns. This is a NARROWING subclass with an
            # explicit field list, so a field added to the parent does NOT
            # appear here — it has to be listed. Leaving them out is what made
            # both columns render as an em dash for every row on production
            # while working locally, where the endpoint had been called without
            # ?slim=list.
            'quantity', 'quantity_uom', 'rate',
            'computed_tds_amount', 'computed_tds_section', 'tds_status', 'tds_deducted',
        ]



class VendorBillSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    field_permission_module = 'Vendor Bill'
    bill_lines = VendorBillLineSerializer(many=True, required=False)
    vendor_name = serializers.CharField(source='vendor.vendor_name', read_only=True, default='')
    po_no = serializers.SerializerMethodField()
    receipt_no = serializers.SerializerMethodField()
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    balance_due = serializers.SerializerMethodField()
    tds_withheld = serializers.SerializerMethodField()
    net_payable = serializers.SerializerMethodField()
    payment_history = serializers.SerializerMethodField()
    is_debit_eligible = serializers.SerializerMethodField()
    has_credit = serializers.SerializerMethodField()
    scan_tally_matched = serializers.SerializerMethodField()
    is_branch_transfer = serializers.SerializerMethodField()
    zoho_photos = serializers.SerializerMethodField()
    invoice_freight = serializers.SerializerMethodField()
    attached_freight = serializers.SerializerMethodField()
    warehouse_name = serializers.CharField(source='warehouse.name', read_only=True, default='')
    gst_split = serializers.SerializerMethodField()

    def get_attached_freight(self, obj):
        """Separate-slip freight bills (from Scan or Email) that were MAPPED to
        this goods bill — the transporter wrote this bill's invoice no on the
        slip, so the freight document was ATTACHED here instead of raising a
        Freight Advice. Those never show up in invoice_freight, so surface them
        so the bill visibly says "freight attached", with the amount, transporter
        and TDS. Detail-only serializer, so no per-row cost on the Bills list."""
        out = []
        try:
            from ai_parser.scan_models import InvoiceScanBill
            for sb in (InvoiceScanBill.objects
                       .filter(freight_linked_bill=obj, bill_type='FREIGHT', status='CONFIRMED')
                       .select_related('transporter')):
                out.append({
                    'id': str(sb.id), 'source': 'scan',
                    'transporter_name': (sb.transporter.name if sb.transporter_id
                                         else sb.transporter_name or sb.vendor_name) or '',
                    'invoice_no': sb.freight_invoice_no or sb.invoice_no or '',
                    'amount': str(sb.freight_amount or sb.total_amount or 0),
                    'tds': str(sb.tds_amount or 0),
                })
        except Exception:  # noqa: BLE001 — best-effort; never break the bill page
            pass
        try:
            # Bundles are NOT here — they book a tracked Inward Freight advice, so
            # they surface via invoice_freight (the progress-bar card) instead.
            from email_bills.models import EmailBillDraft
            for d in (EmailBillDraft.objects
                      .filter(freight_linked_bill=obj, is_freight_bill=True, status='APPROVED')
                      .select_related('transporter')):
                out.append({
                    'id': str(d.id), 'source': 'email',
                    'transporter_name': (d.transporter.name if d.transporter_id else '') or '',
                    'invoice_no': d.freight_invoice_no or '',
                    'amount': str(d.freight_amount or 0),
                    'tds': str(d.tds_amount or 0),
                })
        except Exception:  # noqa: BLE001
            pass
        return out

    def get_invoice_freight(self, obj):
        """The invoice-included freight tracked for this bill (its freight line
        mirrored into the freight register), so the bill page can link to it and
        show billed/paid/pending."""
        from itertools import chain
        out, seen = [], set()
        # Freight where this bill is the PRIMARY (vendor_bill) OR one of the extra
        # bills a shared slip covers (covered_bills → covering_freights).
        for fa in chain(obj.invoice_freight_advices.all(), obj.covering_freights.all()):
            if fa.id in seen:
                continue
            seen.add(fa.id)
            payable = fa.get_total_payable()
            paid = fa.get_total_paid()
            covered = set(fa.covered_bills.values_list('id', flat=True))
            if fa.vendor_bill_id:
                covered.add(fa.vendor_bill_id)
            out.append({
                'id': str(fa.id), 'advice_no': fa.advice_no,
                'transporter_name': getattr(fa.transporter, 'name', '') or '',
                # Gross freight (before TDS), the TDS deducted, and the net payable —
                # so the card can show all three, not just the net.
                'freight_amount': str(fa.base_amount or 0),
                'tds': str(fa.tds_less or 0),
                # Round-off rides on less_amount: a LESS sign subtracts from payable
                # (positive round-off), PLUS adds. Send it as the amount SUBTRACTED.
                'roundoff': str((fa.less_amount or 0) if fa.less_amount_sign == 'LESS' else -(fa.less_amount or 0)),
                'lorry_no': fa.lorry_no or '',
                'freight_no': fa.transport_document_no or '',
                # How many goods bills this ONE freight covers (paid once, shared).
                'covered_count': len(covered),
                'billed': str(payable), 'paid': str(paid),
                'pending': str(max(payable - paid, payable * 0)),
                'status': fa.status, 'status_display': fa.get_status_display(),
            })
        return out

    def get_is_branch_transfer(self, obj):
        """True when this bill is an internal branch transfer — either a "DC/"
        delivery-challan invoice, or a bill from a branch/sister entity vendor
        (Vendor.is_branch). Those are stock moved between the company's own
        branches ("NOT FOR SALE"), NOT purchases (Tally excludes them). The Bills
        page uses this to label + filter them."""
        from .branch_transfer import is_branch_transfer_bill
        return is_branch_transfer_bill(obj)

    def get_zoho_photos(self, obj):
        """Zoho integration is not shipped in this standalone build, so there
        are never any Zoho photos to surface."""
        return []

    def get_scan_tally_matched(self, obj):
        """True when this single bill is backed by BOTH a scanned invoice and a
        Tally voucher — i.e. the scan<->Tally merge happened. Reads the annotated
        `_scan_confirmed` (no per-row query); falls back to a query only when the
        annotation is absent (e.g. a freshly created instance)."""
        g = getattr(obj, 'tally_guid', '') or ''
        if not g or g.startswith('OPENING'):
            return False
        if getattr(obj, '_scan_confirmed', False):
            return True
        # A scan record is deleted when its batch is cleaned up, but the bill keeps
        # its "Created from scanned invoice" note AND any attachment it carries —
        # either is proof it has a copy, so the badge must still show.
        note = (getattr(obj, 'notes', '') or '').lower()
        if 'scanned invoice' in note or 'from scanned' in note:
            return True
        try:
            from purchase.models import PurchaseAttachment
            # Any attachment (invoice/scan copy), not only a scan-*.pdf.
            if PurchaseAttachment.objects.filter(
                    module='BILL', record_id=obj.id).exists():
                return True
        except Exception:
            pass
        if getattr(obj, '_scan_confirmed', None) is None:
            from ai_parser.scan_models import InvoiceScanBill
            from django.db.models import Q
            return InvoiceScanBill.objects.filter(
                Q(matched_bill=obj) | Q(created_bill=obj), status='CONFIRMED').exists()
        return False

    purchase_category_display = serializers.CharField(
        source='get_purchase_category_display', read_only=True, default='')

    def get_gst_split(self, obj):
        """CGST/SGST/IGST breakup for the bill. Uses the stored split when the
        bill captured it; otherwise DERIVES it from the combined tax_amount —
        Tally-imported bills store only the total, so classify by place of
        supply: vendor state == buyer-company state -> CGST+SGST (intra), else
        IGST (inter). State read from the GSTIN's leading 2-digit state code.
        `derived=True` and `basis='unknown'` (show combined only) when the states
        can't be read. Reporting-only; never changes stored amounts."""
        from decimal import Decimal
        Z = Decimal('0')
        cg = obj.cgst_amount or Z
        sg = obj.sgst_amount or Z
        ig = obj.igst_amount or Z
        tax = obj.tax_amount or Z
        if cg or sg or ig:                      # stored split wins
            basis = 'inter' if (ig and not (cg or sg)) else 'intra'
            return {'basis': basis, 'cgst': str(cg), 'sgst': str(sg),
                    'igst': str(ig), 'total': str(tax), 'derived': False}
        if not tax:
            return {'basis': 'none', 'cgst': '0', 'sgst': '0', 'igst': '0',
                    'total': '0', 'derived': False}

        def _state_code(gstin):
            g = (gstin or '').strip()
            return g[:2] if len(g) >= 2 and g[:2].isdigit() else ''
        vendor = obj.vendor if obj.vendor_id else None
        company = getattr(vendor, 'company', None) if vendor else None
        vstate = _state_code(getattr(vendor, 'gstin', '') if vendor else '')
        cstate = _state_code(getattr(company, 'gstin', '') if company else '')
        if vstate and cstate:
            if vstate == cstate:                # intra-state -> CGST + SGST
                half = (tax / 2).quantize(Decimal('0.01'))
                return {'basis': 'intra', 'cgst': str(half), 'sgst': str(tax - half),
                        'igst': '0', 'total': str(tax), 'derived': True}
            return {'basis': 'inter', 'cgst': '0', 'sgst': '0',   # inter-state -> IGST
                    'igst': str(tax), 'total': str(tax), 'derived': True}
        return {'basis': 'unknown', 'cgst': '0', 'sgst': '0', 'igst': '0',
                'total': str(tax), 'derived': True}

    class Meta:
        from .models import VendorBill
        model = VendorBill
        fields = [
            'id', 'bill_no', 'vendor', 'vendor_name', 'vendor_invoice_no',
            'bill_date', 'due_date', 'purchase_order', 'po_no',
            'receipt_advice', 'receipt_no',
            'subtotal', 'discount_amount', 'tax_amount', 'gst_split', 'tds_amount',
            'shipping_charges', 'other_charges', 'adjustment', 'total_amount', 'amount_paid',
            'additional_charges', 'additional_charges_remarks',
            'balance_due', 'tds_withheld', 'net_payable', 'status', 'status_display',
            'rm_category', 'tally_voucher_type', 'is_expense', 'tally_guid', 'is_active',
            'purchase_category', 'purchase_category_display', 'category_source',
            'notes', 'terms_and_conditions',
            'bill_lines', 'payment_history', 'is_debit_eligible', 'has_credit',
            'scan_tally_matched', 'is_branch_transfer', 'zoho_photos', 'invoice_freight', 'attached_freight',
            'warehouse', 'warehouse_name', 'created_at', 'updated_at',
            'computed_tds_amount', 'computed_tds_section', 'tds_status',
        ]
        read_only_fields = ['id', 'bill_no', 'created_at', 'updated_at',
                            'computed_tds_amount', 'computed_tds_section', 'tds_status']
        extra_kwargs = {
            'vendor_invoice_no': {'required': False, 'allow_blank': True},
            'due_date': {'required': False, 'allow_null': True},
            'purchase_order': {'required': False, 'allow_null': True},
            'receipt_advice': {'required': False, 'allow_null': True},
            'subtotal': {'required': False},
            'discount_amount': {'required': False},
            'tax_amount': {'required': False},
            'tds_amount': {'required': False},
            'shipping_charges': {'required': False},
            'other_charges': {'required': False},
            'adjustment': {'required': False},
            'total_amount': {'required': False},
            'amount_paid': {'required': False},
            'status': {'required': False},
            'notes': {'required': False, 'allow_blank': True},
            'terms_and_conditions': {'required': False, 'allow_blank': True},
        }

    def get_po_no(self, obj):
        try:
            return obj.purchase_order.po_no if obj.purchase_order else ''
        except Exception:
            return ''

    def get_receipt_no(self, obj):
        try:
            return obj.receipt_advice.receipt_advice_no if obj.receipt_advice else ''
        except Exception:
            return ''

    def get_balance_due(self, obj):
        return str(obj.balance_due)

    def get_tds_withheld(self, obj):
        # 194Q/194C TDS withheld on this bill (Tally's figure). Vendor is paid
        # net of it, so the detail page can show what's actually owed.
        return str(obj.tds_withheld)

    def get_net_payable(self, obj):
        # Gross total - TDS withheld - paid = what we owe the vendor (ties Tally).
        return str(obj.net_payable_to_vendor)

    def get_is_debit_eligible(self, obj):
        """True iff the linked Receipt has at least one line marked as Debit Note.

        Drives the Vendor Credit Bill No dropdown — only debit-eligible bills
        appear there.
        """
        if not obj.receipt_advice_id:
            return False
        try:
            return obj.receipt_advice.receipt_lines.filter(is_debit_note=True).exists()
        except Exception:
            return False

    def get_has_credit(self, obj):
        """True iff a non-cancelled Vendor Credit already exists for this bill.

        Used to hide bills that have already been credited from the Vendor
        Credit Bill No dropdown — only one credit per bill is allowed.
        """
        try:
            # Through the related manager so the viewset's prefetch answers it;
            # VendorCredit.objects.filter(bill=obj) would issue a query per row.
            # `any(...)` over the prefetched rows is the same test as
            # .exclude(status='CANCELLED').exists().
            return any(c.status != 'CANCELLED' for c in obj.credits.all())
        except Exception:
            return False

    def get_payment_history(self, obj):
        # Read through the related manager, NOT PaymentMade.objects.filter():
        # only the former can be answered from the viewset's prefetch. Sorted
        # in Python for the same reason — .order_by() on a prefetched manager
        # issues a fresh query, which is exactly what we are removing. Same
        # ordering as before: newest payment first, undated rows last.
        # The sentinel matters twice over: comparing two Nones raises
        # TypeError, and Postgres orders NULLS FIRST on a DESC sort — so
        # undated rows must stay at the front to match `-payment_date`.
        _floor = _dt.date.min
        payments = sorted(
            obj.payments.all(),
            key=lambda p: (p.payment_date is None, p.payment_date or _floor),
            reverse=True,
        )
        return [{
            'id': str(p.id),
            'payment_no': p.payment_no,
            'payment_date': str(p.payment_date) if p.payment_date else '',
            'amount': str(p.amount),
            'payment_mode': p.payment_mode,
            'reference_no': p.reference_no,
            'status': p.status,
        } for p in payments]

    def validate(self, data):
        """Validate bill line quantities against receipt quantities."""
        import logging
        logger = logging.getLogger(__name__)

        lines_data = data.get('bill_lines', [])
        receipt = data.get('receipt_advice')

        logger.info(f'[BillValidation] receipt={receipt}, lines_count={len(lines_data)}')

        if receipt and lines_data:
            # Build ordered list of receipt line quantities (per line, not summed)
            receipt_lines_list = []
            for rl in receipt.receipt_lines.all().order_by('line_no', 'id'):
                pid = str(rl.product_id) if rl.product_id else None
                if pid:
                    receipt_lines_list.append({'pid': pid, 'qty': float(rl.quantity_received)})

            # Also build summed map for product-level validation
            receipt_line_map = {}
            for entry in receipt_lines_list:
                pid = entry['pid']
                receipt_line_map[pid] = receipt_line_map.get(pid, 0.0) + entry['qty']

            logger.info(f'[BillValidation] receipt_line_map={receipt_line_map}')

            # Extract product IDs from bill lines
            def get_pid(bl):
                product = bl.get('product')
                if hasattr(product, 'id'): return str(product.id)
                if hasattr(product, 'pk'): return str(product.pk)
                if isinstance(product, dict): return str(product.get('id', ''))
                return str(product) if product else None

            # Group bill lines by product and sum quantities
            bill_qty_by_product = {}
            for bl in lines_data:
                pid = get_pid(bl)
                bill_qty = float(bl.get('quantity', 0))
                if bill_qty <= 0:
                    raise serializers.ValidationError("Quantity must be greater than 0.")
                if pid:
                    bill_qty_by_product[pid] = bill_qty_by_product.get(pid, 0.0) + bill_qty

            # Validate: total bill qty per product must EXACTLY match receipt qty
            for pid, total_bill_qty in bill_qty_by_product.items():
                if pid in receipt_line_map:
                    receipt_qty = receipt_line_map[pid]
                    if abs(total_bill_qty - receipt_qty) > 0.001:
                        raise serializers.ValidationError({
                            'bill_lines': (
                                f"Bill quantity ({total_bill_qty}) does not match receipt quantity ({receipt_qty}). "
                                f"Quantity cannot be changed. Bill quantity must match the linked Receipt quantity."
                            )
                        })

        # Also validate from raw request data as fallback
        request = self.context.get('request')
        if request and receipt and not lines_data:
            raw_lines = request.data.get('bill_lines', [])
            if raw_lines:
                receipt_line_map = {}
                for rl in receipt.receipt_lines.all():
                    pid = str(rl.product_id) if rl.product_id else None
                    if pid:
                        receipt_line_map[pid] = receipt_line_map.get(pid, 0.0) + float(rl.quantity_received)

                bill_qty_by_product = {}
                for bl in raw_lines:
                    pid = str(bl.get('product', ''))
                    bill_qty = float(bl.get('quantity', 0))
                    if bill_qty <= 0:
                        raise serializers.ValidationError("Quantity must be greater than 0.")
                    if pid:
                        bill_qty_by_product[pid] = bill_qty_by_product.get(pid, 0.0) + bill_qty

                for pid, total_bill_qty in bill_qty_by_product.items():
                    if pid in receipt_line_map:
                        receipt_qty = receipt_line_map[pid]
                        if abs(total_bill_qty - receipt_qty) > 0.001:
                            raise serializers.ValidationError({
                                'bill_lines': (
                                    f"Bill quantity ({total_bill_qty}) does not match receipt quantity ({receipt_qty}). "
                                    f"Quantity cannot be changed. Bill quantity must match the linked Receipt quantity."
                                )
                            })

        # ---- PO-level cumulative quantity validation ----
        purchase_order = data.get('purchase_order')
        if purchase_order:
            from django.db.models import Sum as DjSum

            effective_lines = lines_data
            if not effective_lines:
                req = self.context.get('request')
                if req:
                    effective_lines = req.data.get('bill_lines', [])

            if effective_lines:
                from .models import VendorBillLine as VBLine

                po_id = purchase_order.id if hasattr(purchase_order, 'id') else purchase_order

                # Group bill lines by product and sum quantities
                bill_qty_by_product = {}
                for bl in effective_lines:
                    product = bl.get('product')
                    if hasattr(product, 'id'):
                        pid = str(product.id)
                    elif hasattr(product, 'pk'):
                        pid = str(product.pk)
                    elif isinstance(product, dict):
                        pid = str(product.get('id', ''))
                    else:
                        pid = str(product) if product else None

                    bl_qty = Decimal(str(bl.get('quantity', 0)))
                    if not pid or bl_qty <= 0:
                        continue
                    bill_qty_by_product[pid] = bill_qty_by_product.get(pid, Decimal('0')) + bl_qty

                # Validate each product's total against PO total for that product
                for pid, total_bill_qty in bill_qty_by_product.items():
                    # Sum ALL PO lines for this product (handles multiple PO lines for same product)
                    po_total = POLine.objects.filter(
                        po_id=po_id, product_service_id=pid
                    ).aggregate(total=DjSum('quantity_ordered'))['total'] or Decimal('0')

                    if po_total <= 0:
                        continue

                    # Sum already billed for this product across other bills
                    already_billed_qs = VBLine.objects.filter(
                        bill__purchase_order_id=po_id,
                        product_id=pid,
                    ).exclude(bill__status='CANCELLED')

                    if self.instance:
                        already_billed_qs = already_billed_qs.exclude(bill=self.instance)

                    already_billed = already_billed_qs.aggregate(
                        total=DjSum('quantity')
                    )['total'] or Decimal('0')

                    remaining = po_total - already_billed
                    if total_bill_qty > remaining:
                        pname = 'Unknown'
                        po_line = POLine.objects.filter(po_id=po_id, product_service_id=pid).first()
                        if po_line:
                            pname = getattr(po_line.product_service, 'product_name', 'Unknown')
                        raise serializers.ValidationError({
                            'bill_lines': (
                                f"Total bill quantity ({total_bill_qty}) for '{pname}' exceeds remaining "
                                f"PO quantity ({remaining}). PO ordered: "
                                f"{po_total}, Already billed: {already_billed}."
                            )
                        })

                # ---- PO unit price validation ----
                # Build receipt line → PO line price map for accurate matching
                receipt = data.get('receipt_advice')
                if not receipt and self.instance:
                    receipt = self.instance.receipt_advice

                receipt_po_price_map = {}
                if receipt:
                    for rl in receipt.receipt_lines.all():
                        if rl.po_line_id:
                            rpid = str(rl.product_id) if rl.product_id else None
                            if rpid:
                                # Store price keyed by product+line_no for ordered matching
                                receipt_po_price_map.setdefault(rpid, []).append(rl.po_line.unit_price)

                # Validate each bill line's rate against PO prices
                bill_line_idx_by_product = {}
                for bl in effective_lines:
                    product = bl.get('product')
                    if hasattr(product, 'id'):
                        pid = str(product.id)
                    elif hasattr(product, 'pk'):
                        pid = str(product.pk)
                    elif isinstance(product, dict):
                        pid = str(product.get('id', ''))
                    else:
                        pid = str(product) if product else None

                    bill_rate = bl.get('rate')
                    if bill_rate is None or not pid:
                        continue

                    bill_rate = Decimal(str(bill_rate))

                    # Track which bill line index for this product
                    idx = bill_line_idx_by_product.get(pid, 0)
                    bill_line_idx_by_product[pid] = idx + 1

                    # Try receipt-based PO price map first (ordered)
                    if pid in receipt_po_price_map:
                        po_prices = receipt_po_price_map[pid]
                        expected_price = po_prices[idx] if idx < len(po_prices) else po_prices[-1]
                        if abs(bill_rate - expected_price) > Decimal('0.01'):
                            pname = 'Unknown'
                            po_line = POLine.objects.filter(po_id=po_id, product_service_id=pid).first()
                            if po_line:
                                pname = getattr(po_line.product_service, 'product_name', 'Unknown')
                            raise serializers.ValidationError({
                                'bill_lines': (
                                    f"Unit price ({bill_rate}) for '{pname}' does not match "
                                    f"PO unit price ({expected_price}). Unit price cannot be changed. "
                                    f"It must match the linked Purchase Order price."
                                )
                            })
                    else:
                        # Fallback: check against all PO line prices for this product
                        po_lines_for_product = POLine.objects.filter(
                            po_id=po_id, product_service_id=pid
                        )
                        if not po_lines_for_product.exists():
                            continue
                        valid_prices = [pl.unit_price for pl in po_lines_for_product]
                        matches_any = any(
                            abs(bill_rate - p) <= Decimal('0.01') for p in valid_prices
                        )
                        if not matches_any:
                            pname = getattr(po_lines_for_product.first().product_service, 'product_name', 'Unknown')
                            raise serializers.ValidationError({
                                'bill_lines': (
                                    f"Unit price ({bill_rate}) for '{pname}' does not match "
                                    f"any PO unit price. Unit price cannot be changed. "
                                    f"It must match the linked Purchase Order price."
                                )
                            })

        return data

    def create(self, validated_data):
        lines_data = validated_data.pop('bill_lines', [])
        from .models import VendorBill, VendorBillLine
        bill = VendorBill.objects.create(**validated_data)
        for line_data in lines_data:
            VendorBillLine.objects.create(bill=bill, **line_data)
        return bill

    def update(self, instance, validated_data):
        lines_data = validated_data.pop('bill_lines', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if lines_data is not None:
            from .models import VendorBillLine
            instance.bill_lines.all().delete()
            for line_data in lines_data:
                VendorBillLine.objects.create(bill=instance, **line_data)
        return instance


class PaymentMadeSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    field_permission_module = 'Payment Made'
    vendor_name = serializers.CharField(source='vendor.vendor_name', read_only=True, default='')
    # The VENDOR master's category (vendor_type: RAW_MATERIAL / PACKING_MATERIAL /
    # EXPENSE / ...). Lets the Payment Entries list show a spend category even for an
    # ON-ACCOUNT payment that has no linked bill — the master is the source.
    vendor_category = serializers.SerializerMethodField()
    bill_no = serializers.SerializerMethodField()
    # The linked bill's own paid state (for the Payments list to show paid/partial/open
    # per row). Null when the payment has no bill (freight / on-account / expense).
    bill_status = serializers.SerializerMethodField()
    bill_total = serializers.SerializerMethodField()
    bill_paid = serializers.SerializerMethodField()
    # The linked bill's spend category bucket (PURCHASE / EXPENSE / FREIGHT) so
    # the Payment Entries page can filter by it. Derived from the bill's
    # purchase_category + is_expense: FREIGHT -> freight, is_expense/EXPENSES/
    # MACHINERY -> expense, else -> purchase. Blank for an on-account payment.
    bill_category = serializers.SerializerMethodField()
    # The FINE spend category of the linked bill (RM / PACKING / BOUGHT_NOTE /
    # FRUIT / MAIZE / FREIGHT / EXPENSES / ...), so the Payment Entries list can
    # show the SAME exact tag the Bills page shows (not just the Purchase/Expense/
    # Freight bucket in bill_category). Blank for an on-account payment.
    bill_purchase_category = serializers.SerializerMethodField()
    # Where the payment came from — 'TALLY' when it carries a real Tally voucher
    # guid (bank / Day-Book import), else 'ERP' (recorded in the ERP). Drives the
    # Tally / ERP source badge on the Payment Entries page, like the Bills page.
    source_origin = serializers.SerializerMethodField()
    # The freight record this payment settles, if any — a freight payment has no
    # VendorBill, so it would otherwise show as a loose "on-account". When the
    # payment's Tally voucher GUID matches an Outward/Local freight record, this
    # names it ({kind, no, id}) so the Payment Entries row links to the freight
    # instead of reading on-account. Built once per page in the viewset context.
    freight_link = serializers.SerializerMethodField()
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    payment_mode_display = serializers.CharField(source='get_payment_mode_display', read_only=True)
    # The payment's company (via its vendor) — lets the list filter SS vs UAI etc.
    company_code = serializers.CharField(source='vendor.company.company_code', read_only=True, default='')
    company_name = serializers.CharField(source='vendor.company.trade_name', read_only=True, default='')
    # Our bank account the payment went out from — drives the account drill-down.
    bank_account_code = serializers.CharField(source='bank_account.code', read_only=True, default='')
    bank_account_name = serializers.CharField(source='bank_account.nickname', read_only=True, default='')

    class Meta:
        from .models import PaymentMade
        model = PaymentMade
        fields = [
            'id', 'payment_no', 'vendor', 'vendor_name', 'vendor_category',
            'payment_date', 'payment_mode', 'payment_mode_display',
            'amount', 'reference_no', 'bank_name',
            'bill', 'bill_no', 'bill_status', 'bill_total', 'bill_paid', 'bill_category', 'bill_purchase_category',
            'source_origin', 'freight_link', 'status', 'status_display', 'notes',
            'company_code', 'company_name', 'bank_account', 'bank_account_code', 'bank_account_name',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'payment_no', 'created_at', 'updated_at']
        extra_kwargs = {
            'payment_mode': {'required': False},
            'reference_no': {'required': False, 'allow_blank': True},
            'bank_name': {'required': False, 'allow_blank': True},
            'bill': {'required': False, 'allow_null': True},
            'status': {'required': False},
            'notes': {'required': False, 'allow_blank': True},
        }

    def get_bill_no(self, obj):
        try:
            return obj.bill.bill_no if obj.bill else ''
        except Exception:
            return ''

    def get_bill_status(self, obj):
        try:
            return obj.bill.status if obj.bill_id else ''
        except Exception:
            return ''

    def get_bill_total(self, obj):
        try:
            return str(obj.bill.total_amount) if obj.bill_id else None
        except Exception:
            return None

    def get_bill_paid(self, obj):
        try:
            return str(obj.bill.amount_paid) if obj.bill_id else None
        except Exception:
            return None

    def get_bill_category(self, obj):
        """Spend bucket of the linked bill: 'FREIGHT' | 'EXPENSE' | 'PURCHASE',
        or '' for an on-account payment. Lets the Payment Entries page filter by
        Purchase / Expense / Freight."""
        try:
            if not obj.bill_id or obj.bill is None:
                return ''
            cat = (getattr(obj.bill, 'purchase_category', '') or '').upper()
            if cat == 'FREIGHT':
                return 'FREIGHT'
            if getattr(obj.bill, 'is_expense', False) or cat in ('EXPENSES', 'MACHINERY'):
                return 'EXPENSE'
            return 'PURCHASE'
        except Exception:
            return ''

    def get_bill_purchase_category(self, obj):
        """The linked bill's FINE purchase_category (RM / PACKING / BOUGHT_NOTE /
        ...), so the Payment Entries list can show the same tag as the Bills page.
        Blank for an on-account payment."""
        try:
            if not obj.bill_id or obj.bill is None:
                return ''
            return (getattr(obj.bill, 'purchase_category', '') or '').upper()
        except Exception:
            return ''

    def get_vendor_category(self, obj):
        """The category to show on an on-account payment (no linked bill).

        First choice is the vendor master's vendor_type (RAW_MATERIAL /
        PACKING_MATERIAL / EXPENSE / TRANSPORTER / CONTRACTOR / EMPLOYEE) — the
        list it is a JSON list, take the first. When that is EMPTY, fall back to
        the vendor's highest-value billed purchase_category, supplied in context
        by the viewset (vendor_billed_category map). That fallback is why a
        transporter with freight BILLS but no vendor_type — e.g. Amutha Roadways
        — now shows Freight on its on-account rows instead of a blank chip,
        matching what its bill-linked rows show."""
        try:
            vt = getattr(obj.vendor, 'vendor_type', None) if obj.vendor_id else None
            if isinstance(vt, (list, tuple)) and vt:
                first = str(vt[0]).strip()
                if first:
                    return first.upper()
            if isinstance(vt, str) and vt.strip():
                return vt.strip().upper()
            # vendor_type empty -> billed-category fallback (on-account chip fix).
            vbc = (self.context or {}).get('vendor_billed_category') or {}
            cat = vbc.get(getattr(obj, 'vendor_id', None))
            if cat:
                return str(cat).upper()
            return ''
        except Exception:
            return ''

    def get_source_origin(self, obj):
        """'TALLY' vs 'ERP' for the source badge. TALLY only when the payment
        carries a Tally/bank VOUCHER reference — a real Tally Day-Book guid, or a
        BK-… reference_no (a bank-statement / Day-Book import writes it). The bank
        ACCOUNT is NOT a signal: an ERP-entered payment also sits in a bank
        account (ICICI-Creditor) yet has a blank reference → ERP. (Confirmed on
        prod: PAY-05218 ref=BK-3377 is Tally; PAY-05228 ref blank is ERP, both
        on the ICICI-Creditor account.)"""
        g = (getattr(obj, 'tally_guid', '') or '').strip()
        if g and not g.startswith('OPENING'):
            return 'TALLY'
        if (getattr(obj, 'reference_no', '') or '').strip():
            return 'TALLY'
        return 'ERP'

    def get_freight_link(self, obj):
        """The Outward/Local freight record this payment settles, matched by the
        Tally voucher GUID. Returns {kind, no, id} or None. Uses a guid->freight
        map from context (built once per page by the viewset); falls back to a
        direct lookup when the map isn't provided (detail view)."""
        guid = (getattr(obj, 'tally_guid', '') or '').strip()
        if not guid:
            return None
        fmap = (self.context or {}).get('freight_by_guid')
        if fmap is not None:
            return fmap.get(guid)
        # Detail fallback — single lookup.
        try:
            from sales.models import FreightAdviceOutbound
            from .models import LocalFreight
            fa = FreightAdviceOutbound.objects.filter(tally_guid=guid).values(
                'id', 'advice_no').first()
            if fa:
                return {'kind': 'outward', 'no': fa['advice_no'], 'id': str(fa['id'])}
            lf = LocalFreight.objects.filter(tally_guid=guid).values(
                'id', 'freight_no').first()
            if lf:
                return {'kind': 'local', 'no': lf['freight_no'], 'id': str(lf['id'])}
        except Exception:
            pass
        return None

    def create(self, validated_data):
        from .models import PaymentMade
        payment = PaymentMade.objects.create(**validated_data)
        # Auto-update bill amount_paid and status
        if payment.bill:
            bill = payment.bill
            bill.amount_paid = bill.amount_paid + payment.amount
            if bill.amount_paid >= bill.total_amount:
                bill.status = 'PAID'
            elif bill.amount_paid > 0:
                bill.status = 'PARTIALLY_PAID'
            bill.save(update_fields=['amount_paid', 'status'])
        return payment


class PaymentMadeListSerializer(PaymentMadeSerializer):
    """The Payments Made LIST columns. Opt-in via ?slim=1.

    Narrows the field list AND replaces SerializerMethodFields with direct
    source= declarations where the data is already in .only(). This cuts
    ~27k Python method calls on a 5,459-row company (5 fields × 5,459 rows).
    bill_category and vendor_category keep their methods (they have logic).
    """

    bill_no = serializers.CharField(source='bill.bill_no', read_only=True, default='')
    bill_status = serializers.CharField(source='bill.status', read_only=True, default='')
    bill_total = serializers.DecimalField(source='bill.total_amount', read_only=True,
                                          default=None, max_digits=15, decimal_places=2)
    bill_paid = serializers.DecimalField(source='bill.amount_paid', read_only=True,
                                         default=None, max_digits=15, decimal_places=2)
    bill_purchase_category = serializers.CharField(source='bill.purchase_category',
                                                   read_only=True, default='')

    class Meta(PaymentMadeSerializer.Meta):
        fields = [
            'id', 'payment_no', 'payment_date', 'vendor', 'vendor_name',
            'bill', 'bill_no', 'bill_status', 'bill_total', 'bill_paid', 'bill_category', 'bill_purchase_category',
            'vendor_category',
            'amount', 'reference_no', 'source_origin', 'freight_link',
            'payment_mode', 'payment_mode_display',
            'status', 'status_display', 'company_code', 'company_name',
            'bank_account', 'bank_account_code', 'bank_account_name',
            'is_transfer', 'payment_category',
        ]



class VendorCreditLineSerializer(serializers.ModelSerializer):
    """Serializer for vendor credit note line items.

    Mirrors the rest of the purchase line serializers — exposes the
    three FKs plus unified item_type / item_name / item_code accessors.
    """

    product_name = serializers.CharField(source='product.product_name', read_only=True, default='')
    product_code = serializers.CharField(source='product.sku_code', read_only=True, default='')
    machinery_name = serializers.SerializerMethodField()
    service_catalogue_name = serializers.SerializerMethodField()
    item_type = serializers.SerializerMethodField()
    item_name = serializers.SerializerMethodField()
    item_code = serializers.SerializerMethodField()

    class Meta:
        from .models import VendorCreditLine
        model = VendorCreditLine
        fields = [
            'id',
            'product', 'product_name', 'product_code',
            'machinery_name',
            'service_catalogue', 'service_catalogue_name',
            'item_type', 'item_name', 'item_code',
            'description', 'quantity',
            'uom', 'rate', 'tax_percent', 'amount',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'product': {'required': False, 'allow_null': True},
            'service_catalogue': {'required': False, 'allow_null': True},
            'description': {'required': False, 'allow_blank': True},
            'uom': {'required': False, 'allow_blank': True},
            'tax_percent': {'required': False},
        }

    def get_machinery_name(self, obj):
        m = _machine_ref(obj)
        if not m:
            return ''
        return getattr(m, 'machine_name', None) or getattr(m, 'name', None) or str(m)

    def get_service_catalogue_name(self, obj):
        s = obj.service_catalogue
        if not s:
            return ''
        return f"{s.service_code} — {s.name}" if getattr(s, 'service_code', None) else s.name

    def get_item_type(self, obj):
        if _is_machinery_line(obj):
            return 'MACHINERY'
        if obj.service_catalogue_id:
            return 'SERVICE'
        return 'PRODUCT'

    def get_item_name(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'name', '') or ''
        if obj.product_id:
            return obj.product.product_name or ''
        return ''

    def get_item_code(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'service_code', '') or ''
        if obj.product_id:
            return obj.product.sku_code or ''
        return ''

    def validate(self, attrs):
        """Enforce exactly-one-of (product, machinery, service_catalogue)."""
        instance = getattr(self, 'instance', None)
        product = attrs.get('product', getattr(instance, 'product', None) if instance else None)
        service = attrs.get('service_catalogue', getattr(instance, 'service_catalogue', None) if instance else None)
        populated = sum(1 for v in (product, service) if v)
        if populated == 0:
            raise serializers.ValidationError(
                'Credit line must reference exactly one of product, machinery, or service_catalogue.'
            )
        if populated > 1:
            raise serializers.ValidationError(
                'Credit line cannot reference more than one of product, machinery, or service_catalogue.'
            )
        return attrs


class VendorCreditSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    field_permission_module = 'Vendor Credit'
    credit_lines = VendorCreditLineSerializer(many=True, required=False)
    vendor_name = serializers.CharField(source='vendor.vendor_name', read_only=True, default='')
    bill_no = serializers.SerializerMethodField()
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    credit_type_display = serializers.CharField(source='get_credit_type_display', read_only=True)
    balance = serializers.SerializerMethodField()

    class Meta:
        from .models import VendorCredit
        model = VendorCredit
        fields = [
            'id', 'credit_no', 'vendor', 'vendor_name',
            'credit_date', 'credit_type', 'credit_type_display',
            'reason', 'bill', 'bill_no',
            'subtotal', 'tax_amount', 'total_amount', 'amount_applied',
            'balance', 'status', 'status_display', 'notes',
            'credit_lines',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'credit_no', 'created_at', 'updated_at']
        extra_kwargs = {
            'credit_type': {'required': False},
            'reason': {'required': False, 'allow_blank': True},
            'bill': {'required': False, 'allow_null': True},
            'subtotal': {'required': False},
            'tax_amount': {'required': False},
            'total_amount': {'required': False},
            'amount_applied': {'required': False},
            'status': {'required': False},
            'notes': {'required': False, 'allow_blank': True},
        }

    def get_bill_no(self, obj):
        try:
            return obj.bill.bill_no if obj.bill else ''
        except Exception:
            return ''

    def get_balance(self, obj):
        return str(obj.balance)

    def validate(self, data):
        """Validate credit line quantities against bill line quantities and PO quantities."""
        from django.db.models import Sum

        lines_data = data.get('credit_lines', [])
        bill = data.get('bill')

        # Block selecting a bill whose receipt has no debit-note-flagged line.
        # The Bill No field on Vendor Credit must come from a receipt that explicitly
        # opted in via the Debit Note toggle on the Receipt form.
        if bill is not None:
            receipt = getattr(bill, 'receipt_advice', None)
            if receipt is None:
                raise serializers.ValidationError(
                    "Selected bill is not linked to a Receipt Advice; cannot raise a Vendor Credit against it."
                )
            has_debit_line = receipt.receipt_lines.filter(is_debit_note=True).exists()
            if not has_debit_line:
                raise serializers.ValidationError(
                    "Selected bill's Receipt Advice does not have any line marked as Debit Note. "
                    "Enable the Debit Note toggle on at least one line of the receipt before raising a Vendor Credit."
                )

            # Only one Vendor Credit allowed per bill (excluding cancelled credits and
            # the current instance on update).
            from .models import VendorCredit
            existing_qs = VendorCredit.objects.filter(bill=bill).exclude(status='CANCELLED')
            if self.instance is not None:
                existing_qs = existing_qs.exclude(pk=self.instance.pk)
            existing = existing_qs.first()
            if existing is not None:
                raise serializers.ValidationError(
                    f"A Vendor Credit ({existing.credit_no}) already exists for bill {bill.bill_no}. "
                    "Only one credit note per bill is allowed."
                )

        if not lines_data:
            return data

        # Validate positive quantities
        for cl in lines_data:
            qty = cl.get('quantity')
            if qty is not None and qty <= Decimal('0'):
                raise serializers.ValidationError("Quantity must be greater than 0.")

        if bill and lines_data:
            from .models import VendorBillLine, VendorCreditLine

            for cl in lines_data:
                product = cl.get('product')
                credit_qty = cl.get('quantity')
                if not product or credit_qty is None:
                    continue

                pid = product.id if hasattr(product, 'id') else (
                    product.pk if hasattr(product, 'pk') else str(product)
                )

                # Check against bill line quantity (cumulative credits)
                bill_line = VendorBillLine.objects.filter(
                    bill=bill, product_id=pid
                ).first()

                if bill_line:
                    already_credited_qs = VendorCreditLine.objects.filter(
                        credit__bill=bill, product_id=pid
                    ).exclude(credit__status='CANCELLED')

                    if self.instance:
                        already_credited_qs = already_credited_qs.exclude(credit=self.instance)

                    already_credited = already_credited_qs.aggregate(
                        total=Sum('quantity')
                    )['total'] or Decimal('0')

                    remaining = bill_line.quantity - already_credited
                    if credit_qty > remaining:
                        pname = getattr(bill_line.product, 'product_name', 'Unknown')
                        raise serializers.ValidationError(
                            f"Credit quantity ({credit_qty}) for '{pname}' exceeds remaining "
                            f"bill quantity ({remaining}). Billed: {bill_line.quantity}, "
                            f"Already credited: {already_credited}."
                        )

            # Also validate against PO quantities if bill has a PO
            if bill.purchase_order:
                po = bill.purchase_order
                for cl in lines_data:
                    product = cl.get('product')
                    credit_qty = cl.get('quantity')
                    if not product or credit_qty is None:
                        continue
                    pid = product.id if hasattr(product, 'id') else str(product)
                    matching_po_line = POLine.objects.filter(
                        po=po, product_service_id=pid
                    ).first()
                    if matching_po_line and credit_qty > matching_po_line.quantity_ordered:
                        pname = getattr(matching_po_line.product_service, 'product_name', 'Unknown')
                        raise serializers.ValidationError(
                            f"Credit quantity ({credit_qty}) for '{pname}' exceeds "
                            f"PO ordered quantity ({matching_po_line.quantity_ordered})."
                        )

        return data

    def create(self, validated_data):
        lines_data = validated_data.pop('credit_lines', [])
        from .models import VendorCredit, VendorCreditLine
        credit = VendorCredit.objects.create(**validated_data)
        for line_data in lines_data:
            VendorCreditLine.objects.create(credit=credit, **line_data)
        return credit

    def update(self, instance, validated_data):
        lines_data = validated_data.pop('credit_lines', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if lines_data is not None:
            from .models import VendorCreditLine
            instance.credit_lines.all().delete()
            for line_data in lines_data:
                VendorCreditLine.objects.create(credit=instance, **line_data)
        return instance


# ============================================================
# Material Rejection Serializers
# ============================================================

class MaterialRejectionLineSerializer(serializers.ModelSerializer):
    id = serializers.UUIDField(required=False, allow_null=True)
    product_name = serializers.CharField(source='product.product_name', read_only=True, default='')
    product_code = serializers.CharField(source='product.sku_code', read_only=True, default='')
    machinery_name = serializers.SerializerMethodField()
    service_catalogue_name = serializers.SerializerMethodField()
    item_type = serializers.SerializerMethodField()
    item_name = serializers.SerializerMethodField()
    item_code = serializers.SerializerMethodField()
    total_value = serializers.SerializerMethodField()
    rejection_reason_display = serializers.CharField(source='get_rejection_reason_display', read_only=True)

    class Meta:
        model = MaterialRejectionLine
        fields = [
            'id', 'line_no',
            'product', 'product_name', 'product_code',
            'machinery_name',
            'service_catalogue', 'service_catalogue_name',
            'item_type', 'item_name', 'item_code',
            'receipt_line', 'received_quantity', 'accepted_quantity',
            'rejected_quantity', 'uom', 'batch_no', 'unit_price',
            'rejection_reason', 'rejection_reason_display',
            'total_value', 'remarks',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'product': {'required': False, 'allow_null': True},
            'service_catalogue': {'required': False, 'allow_null': True},
            'receipt_line': {'required': False, 'allow_null': True},
            'batch_no': {'required': False, 'allow_blank': True},
            'unit_price': {'required': False},
            'remarks': {'required': False, 'allow_blank': True},
        }

    def get_machinery_name(self, obj):
        m = _machine_ref(obj)
        if not m:
            return ''
        return getattr(m, 'machine_name', None) or getattr(m, 'name', None) or str(m)

    def get_service_catalogue_name(self, obj):
        s = obj.service_catalogue
        if not s:
            return ''
        return f"{s.service_code} — {s.name}" if getattr(s, 'service_code', None) else s.name

    def get_item_type(self, obj):
        if _is_machinery_line(obj):
            return 'MACHINERY'
        if obj.service_catalogue_id:
            return 'SERVICE'
        return 'PRODUCT'

    def get_item_name(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'name', '') or ''
        if obj.product_id:
            return obj.product.product_name or ''
        return ''

    def get_item_code(self, obj):
        if obj.service_catalogue_id:
            return getattr(obj.service_catalogue, 'service_code', '') or ''
        if obj.product_id:
            return obj.product.sku_code or ''
        return ''

    def get_total_value(self, obj):
        return str(obj.total_value)

    def validate(self, data):
        # Exactly-one-of (product, service_catalogue).
        instance = getattr(self, 'instance', None)
        product = data.get('product', getattr(instance, 'product', None) if instance else None)
        service = data.get('service_catalogue', getattr(instance, 'service_catalogue', None) if instance else None)
        populated = sum(1 for v in (product, service) if v)
        if populated == 0:
            raise serializers.ValidationError(
                'Rejection line must reference exactly one of product, machinery, or service_catalogue.'
            )
        if populated > 1:
            raise serializers.ValidationError(
                'Rejection line cannot reference more than one of product, machinery, or service_catalogue.'
            )

        received = data.get('received_quantity', Decimal('0'))
        accepted = data.get('accepted_quantity', Decimal('0'))
        rejected = data.get('rejected_quantity', Decimal('0'))
        if rejected <= 0:
            raise serializers.ValidationError("Rejected quantity must be greater than 0.")
        if rejected > received:
            raise serializers.ValidationError(
                f"Rejected quantity ({rejected}) cannot exceed received quantity ({received})."
            )
        if accepted + rejected != received:
            raise serializers.ValidationError(
                f"Accepted ({accepted}) + Rejected ({rejected}) must equal Received ({received})."
            )
        return data


class MaterialRejectionSerializer(FieldPermissionMixin, serializers.ModelSerializer):
    field_permission_module = 'Material Rejection'
    rejection_lines = MaterialRejectionLineSerializer(many=True, required=False)
    vendor_name = serializers.CharField(source='vendor.vendor_name', read_only=True, default='')
    warehouse_name = serializers.CharField(source='warehouse.name', read_only=True, default='')
    receipt_no = serializers.CharField(source='receipt_advice.receipt_advice_no', read_only=True, default='')
    po_no = serializers.SerializerMethodField()
    rejected_by_name = serializers.SerializerMethodField()
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    return_type_display = serializers.CharField(source='get_return_type_display', read_only=True, default='')
    total_rejected_value = serializers.SerializerMethodField()

    class Meta:
        model = MaterialRejection
        fields = [
            'id', 'rejection_no', 'rejection_date', 'receipt_advice', 'receipt_no',
            'purchase_order', 'po_no', 'vendor', 'vendor_name',
            'warehouse', 'warehouse_name', 'rejected_by', 'rejected_by_name',
            'status', 'status_display',
            'return_to_vendor', 'return_type', 'return_type_display',
            'return_date', 'replacement_expected_date', 'debit_note_required',
            'description', 'remarks',
            'rejection_lines', 'total_rejected_value',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'rejection_no', 'created_at', 'updated_at']
        extra_kwargs = {
            'purchase_order': {'required': False, 'allow_null': True},
            'rejected_by': {'required': False, 'allow_null': True},
            'status': {'required': False},
            'return_to_vendor': {'required': False},
            'return_type': {'required': False, 'allow_blank': True},
            'return_date': {'required': False, 'allow_null': True},
            'replacement_expected_date': {'required': False, 'allow_null': True},
            'debit_note_required': {'required': False},
            'description': {'required': False, 'allow_blank': True},
            'remarks': {'required': False, 'allow_blank': True},
        }

    def get_po_no(self, obj):
        try:
            return obj.purchase_order.po_no if obj.purchase_order else ''
        except Exception:
            return ''

    def get_rejected_by_name(self, obj):
        try:
            return obj.rejected_by.user.get_full_name() if obj.rejected_by else ''
        except Exception:
            return ''

    def get_total_rejected_value(self, obj):
        return str(obj.get_total_rejected_value())

    def create(self, validated_data):
        lines_data = validated_data.pop('rejection_lines', [])
        with transaction.atomic():
            rejection = MaterialRejection.objects.create(**validated_data)
            for line_data in lines_data:
                line_data.pop('id', None)
                MaterialRejectionLine.objects.create(rejection=rejection, **line_data)
        return rejection

    def update(self, instance, validated_data):
        lines_data = validated_data.pop('rejection_lines', None)
        with transaction.atomic():
            for attr, value in validated_data.items():
                setattr(instance, attr, value)
            instance.save()
            if lines_data is not None:
                instance.rejection_lines.all().delete()
                for line_data in lines_data:
                    line_data.pop('id', None)
                    MaterialRejectionLine.objects.create(rejection=instance, **line_data)
        return instance


class VendorProductMappingSerializer(serializers.ModelSerializer):
    """Serializer for vendor product mappings used by the Quote Response
    mismatch-resolution flow."""

    vendor_name = serializers.CharField(source='vendor.vendor_name', read_only=True, default='')
    product_name = serializers.CharField(source='product.product_name', read_only=True, default='')
    product_sku = serializers.CharField(source='product.sku_code', read_only=True, default='')
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        from .models import VendorProductMapping
        model = VendorProductMapping
        fields = [
            'id', 'vendor', 'vendor_name',
            'extracted_text', 'extracted_text_display',
            'product', 'product_name', 'product_sku',
            'created_by', 'created_by_name',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'created_by']

    def get_created_by_name(self, obj):
        try:
            return obj.created_by.user.get_full_name() if obj.created_by else ''
        except Exception:
            return ''


class ProductMismatchLogSerializer(serializers.ModelSerializer):
    """Serializer for product mismatch audit logs. Super-Admin read-only at
    the API layer; write paths are internal (Quote save handler / PO signal)."""

    user_selected_display = serializers.CharField(source='get_user_selected_display', read_only=True)
    match_status_display = serializers.CharField(source='get_match_status_display', read_only=True)
    created_by_name = serializers.SerializerMethodField()
    resolved_by_name = serializers.SerializerMethodField()
    vendor_display_name = serializers.SerializerMethodField()
    rfq_display_no = serializers.SerializerMethodField()
    quote_display_no = serializers.SerializerMethodField()

    class Meta:
        from .models import ProductMismatchLog
        model = ProductMismatchLog
        fields = [
            'id',
            'pr_no', 'rfq', 'rfq_no', 'rfq_display_no',
            'vendor', 'vendor_name', 'vendor_display_name',
            'quote_response', 'quote_response_no', 'quote_display_no',
            'purchase_order', 'po_number',
            'rfq_product', 'rfq_product_name',
            'vendor_product_name',
            'user_selected', 'user_selected_display',
            'match_status', 'match_status_display',
            'similarity_score', 'remarks',
            'created_by', 'created_by_name', 'created_at',
            'resolved_by', 'resolved_by_name', 'resolved_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']

    def get_created_by_name(self, obj):
        try:
            return obj.created_by.user.get_full_name() if obj.created_by else ''
        except Exception:
            return ''

    def get_resolved_by_name(self, obj):
        try:
            return obj.resolved_by.user.get_full_name() if obj.resolved_by else ''
        except Exception:
            return ''

    def get_vendor_display_name(self, obj):
        try:
            return obj.vendor.vendor_name if obj.vendor else (obj.vendor_name or '')
        except Exception:
            return obj.vendor_name or ''

    def get_rfq_display_no(self, obj):
        try:
            return obj.rfq.rfq_no if obj.rfq else (obj.rfq_no or '')
        except Exception:
            return obj.rfq_no or ''

    def get_quote_display_no(self, obj):
        try:
            return obj.quote_response.quote_id if obj.quote_response else (obj.quote_response_no or '')
        except Exception:
            return obj.quote_response_no or ''
