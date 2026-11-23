"""Field-level permission infrastructure for the Sales module.

Sales-module owned (per the team's change-boundary rule) but the
mixin itself is generic — it just reads `RoleFieldPermission` rows
and applies them to any serializer that declares
`field_permission_module`. Future modules can drop the same mixin
in once they're ready, then move this file to a shared location.

Three access levels:
  * VIEW       — default, no override (field renders normally).
  * READ_ONLY  — field still appears in responses, but the server
                 refuses writes to it. Frontend can detect via the
                 `_readonly_fields` list we surface on each response.
  * HIDDEN     — field is stripped from the response entirely. The
                 server also refuses writes (defense in depth).

Bypass policy:
  * Superusers ignore all field restrictions.
  * Users without an ERPRole assignment get no restrictions
    (legacy admin compatibility — same fail-open policy as the
    warehouse mixin in Phase 1).
"""
from __future__ import annotations

from rest_framework import serializers


# Cache of RoleFieldPermission rows keyed by (user_id, role_id,
# module_name), stashed on the request object itself (see below), so it
# lives exactly as long as the request does — a fresh request starts with
# no cache, which is the isolation we want. Hits the DB at most once per
# (role, module) per request, even when a single response includes 200
# invoice line serializers.
_REQUEST_CACHE_KEY = '_field_perms_cache'


def _get_field_perms_for_user(request, module_name):
    """Return {field_name: access} for the request's user + module.

    Returns {} for superusers, users without a role, and users whose
    role has no field overrides for the module — all the no-op cases.
    Cached on the request for the duration of the request.
    """
    if request is None:
        return {}
    user = getattr(request, 'user', None)
    if user is None or not user.is_authenticated:
        return {}
    if user.is_superuser:
        return {}
    try:
        role = user.erp_role_assignment.role
    except Exception:  # noqa: BLE001 — AttributeError / DoesNotExist
        return {}

    cache = getattr(request, _REQUEST_CACHE_KEY, None)
    if cache is None:
        cache = {}
        setattr(request, _REQUEST_CACHE_KEY, cache)
    key = (user.id, role.id, module_name)
    if key in cache:
        return cache[key]

    from rbac.models import RoleFieldPermission, UserFieldPermissionOverride
    role_rows = RoleFieldPermission.objects.filter(
        role_id=role.id,
        module_name=module_name,
    ).values_list('field_name', 'access')
    result = {fname: access for fname, access in role_rows}

    # Phase 4: per-user overrides on top of role policy. An override
    # row for the same field replaces the role's verdict. Setting an
    # override to 'VIEW' explicitly RESTORES the field even if the
    # role hides it (the absence of a row would otherwise inherit
    # the role's HIDDEN).
    user_rows = UserFieldPermissionOverride.objects.filter(
        user_id=user.id,
        module_name=module_name,
    ).values_list('field_name', 'access')
    for fname, access in user_rows:
        result[fname] = access
    # Drop VIEW entries — those mean "no restriction"; matching the
    # absence-of-row default keeps the rest of the mixin simple.
    result = {f: a for f, a in result.items() if a != 'VIEW'}

    cache[key] = result
    return result


class FieldPermissionMixin:
    """Strip HIDDEN fields and reject writes to HIDDEN / READ_ONLY
    fields based on the requesting user's role.

    Usage:
      class MySerializer(FieldPermissionMixin, serializers.ModelSerializer):
          field_permission_module = 'Sales Order'
          ...

    The module name must match the `module_name` attribute on the
    viewset, which already names the module humanly (e.g. 'Sales Order',
    'Sales Invoice', 'Receivable'). This keeps the field permission
    rows in the DB consistent with the rest of the RBAC layer.
    """

    field_permission_module: str | None = None

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get('request')
        perms = _get_field_perms_for_user(request, self.field_permission_module)
        if not perms:
            return data
        # Strip hidden fields. Modifying the dict in-place is safe —
        # DRF builds a fresh OrderedDict for every instance.
        for fname, access in perms.items():
            if access == 'HIDDEN':
                data.pop(fname, None)
                # Also drop the read-only COMPANION fields the list and
                # detail pages actually render for a reference. The
                # catalog key is the writable FK (e.g. `warehouse`,
                # `company`, `bill`) but the records list / detail page
                # shows the human-readable companion (`warehouse_name`,
                # `company_name`, `bill_no`, …). Stripping only the FK
                # would leave the name visible — so a HIDDEN field would
                # still show its value on those pages. Drop the standard
                # companion suffixes too so the data is fully gone from
                # the response (the frontend then renders the field as
                # blank, the same as any empty field).
                for suffix in ('_name', '_code', '_display', '_no', '_number'):
                    data.pop(f'{fname}{suffix}', None)
        # Surface the read-only field names so the frontend can render
        # the corresponding inputs as disabled. We attach this once
        # per detail response; on list responses every row carries
        # the same list (cheap on the wire — 10 strings).
        ro = [
            f for f, a in perms.items()
            if a == 'READ_ONLY' and f in data
        ]
        if ro:
            data['_readonly_fields'] = ro
        return data

    def validate(self, attrs):
        attrs = super().validate(attrs)
        request = self.context.get('request')
        perms = _get_field_perms_for_user(request, self.field_permission_module)
        if not perms:
            return attrs
        # Silently DROP writes to restricted fields rather than failing
        # the whole request. Both HIDDEN and READ_ONLY are stripped from
        # the validated data, so the field keeps its existing value (on
        # update) or the model default (on create) — it can never be
        # written by a restricted user. This is still the authoritative
        # server-side gate, but it no longer blocks an otherwise-valid
        # submission: a controlled React form always sends its full
        # state (including the inputs the frontend hid/disabled), and a
        # hard reject would make merely *hiding* a field break the form.
        #
        # CREATE guard: on a create (no existing instance) a field that is
        # REQUIRED with no model default cannot be dropped — doing so would
        # build the model without it and raise IntegrityError (HTTP 500).
        # In that case we leave the submitted value through: a restricted
        # user who can still create such a row shouldn't have create rights
        # on it in the first place (gate that with can_create), and a clean
        # row beats a 500. READ_ONLY/HIDDEN still strips on update and still
        # hides the field on read (to_representation), which is the point.
        is_create = getattr(self, 'instance', None) is None
        ser_fields = getattr(self, 'fields', {})
        forbidden = {
            fname for fname, access in perms.items()
            if access in ('HIDDEN', 'READ_ONLY')
        }
        for fname in forbidden & set(attrs.keys()):
            if is_create:
                f = ser_fields.get(fname)
                if f is not None and getattr(f, 'required', False):
                    continue  # required-no-default on create: keep it
            attrs.pop(fname, None)
        return attrs


# ── Manageable-field catalog ────────────────────────────────────────
# Module → list of {key, label, kind} dicts. Drives the Field
# Permissions tab on the Sales admin page; admins pick from this list
# to create RoleFieldPermission overrides.
#
# Catalog covers every editable / displayable field across the three
# Sales modules' header AND line-item serializers. Line items appear
# as separate "module" keys (e.g. 'Sales Order Line') so admins can
# scope restrictions to the lines independently of the header — and
# so the field name `discount` on a line doesn't collide with a
# (hypothetical) header-level `discount` on the same module.
#
# `kind` is a free-form tag the UI can use to group / colour fields
# (financial, workflow, identifier, etc.) — currently informational,
# may drive sub-grouping in a future UI pass.
MANAGEABLE_SALES_FIELDS = {
    'Sales Order': [
        {'key': 'so_no',                 'label': 'SO Number',                'kind': 'identifier'},
        {'key': 'customer',              'label': 'Customer',                 'kind': 'reference'},
        {'key': 'company',               'label': 'Company',                  'kind': 'reference'},
        {'key': 'warehouse',             'label': 'Warehouse',                'kind': 'reference'},
        {'key': 'price_list',            'label': 'Price List',               'kind': 'reference'},
        {'key': 'credit_terms',          'label': 'Credit Terms',             'kind': 'commercial'},
        {'key': 'freight_terms',         'label': 'Freight Terms',            'kind': 'commercial'},
        {'key': 'customer_po_reference', 'label': 'Customer PO Reference',    'kind': 'reference'},
        {'key': 'so_date',               'label': 'SO Date',                  'kind': 'date'},
        {'key': 'required_ship_date',    'label': 'Required Ship Date',       'kind': 'date'},
        {'key': 'delivery_due_date',     'label': 'Delivery Due Date',        'kind': 'date'},
        {'key': 'destination',           'label': 'Destination',              'kind': 'address'},
        {'key': 'payment_terms',         'label': 'Payment Terms',            'kind': 'commercial'},
        {'key': 'currency',              'label': 'Currency',                 'kind': 'financial'},
        {'key': 'delivery_terms',        'label': 'Delivery Terms',           'kind': 'commercial'},
        {'key': 'payment_due_date',      'label': 'Payment Due Date',         'kind': 'commercial'},
        {'key': 'dispatched_through',    'label': 'Dispatched Through',       'kind': 'logistics'},
        {'key': 'consignee_name',        'label': 'Consignee Name',           'kind': 'address'},
        {'key': 'consignee_address',     'label': 'Consignee Address',        'kind': 'address'},
        {'key': 'consignee_gstin',       'label': 'Consignee GSTIN',          'kind': 'address'},
        {'key': 'billing_address',       'label': 'Billing Address',          'kind': 'address'},
        {'key': 'billing_gstin',         'label': 'Billing GSTIN',            'kind': 'address'},
        {'key': 'special_instructions',  'label': 'Special Instructions',     'kind': 'note'},
        {'key': 'remarks',               'label': 'Remarks',                  'kind': 'note'},
        {'key': 'approval_status',       'label': 'Approval Status',          'kind': 'workflow'},
        {'key': 'approved_by',           'label': 'Approved By',              'kind': 'workflow'},
        {'key': 'approval_date',         'label': 'Approval Date',            'kind': 'workflow'},
    ],
    'Sales Order Line': [
        {'key': 'line_no',                  'label': 'Line No',                  'kind': 'identifier'},
        {'key': 'product',                  'label': 'Product',                  'kind': 'reference'},
        {'key': 'batch_preference',         'label': 'Batch Preference',         'kind': 'reference'},
        {'key': 'quantity_ordered',         'label': 'Quantity Ordered',         'kind': 'financial'},
        {'key': 'uom',                      'label': 'UOM',                      'kind': 'identifier'},
        {'key': 'unit_price',               'label': 'Unit Price',               'kind': 'financial'},
        {'key': 'discount',                 'label': 'Discount (%)',             'kind': 'financial'},
        {'key': 'gst',                      'label': 'GST (%)',                  'kind': 'financial'},
        {'key': 'delivery_schedule_date',   'label': 'Delivery Schedule Date',   'kind': 'date'},
        {'key': 'remarks',                  'label': 'Line Remarks',             'kind': 'note'},
        {'key': 'reserved_qty',             'label': 'Reserved Qty',             'kind': 'financial'},
    ],
    'Sales Invoice': [
        {'key': 'invoice_no',          'label': 'Invoice No',            'kind': 'identifier'},
        {'key': 'invoice_date',        'label': 'Invoice Date',          'kind': 'date'},
        {'key': 'company',             'label': 'Company',               'kind': 'reference'},
        {'key': 'company_gstin',       'label': 'Company GSTIN',         'kind': 'address'},
        {'key': 'company_pan',         'label': 'Company PAN',           'kind': 'identifier'},
        {'key': 'company_state',       'label': 'Company State',         'kind': 'address'},
        {'key': 'company_state_code',  'label': 'Company State Code',    'kind': 'address'},
        {'key': 'customer',            'label': 'Customer',              'kind': 'reference'},
        {'key': 'consignee_name',      'label': 'Consignee Name',        'kind': 'address'},
        {'key': 'consignee_address',   'label': 'Consignee Address',     'kind': 'address'},
        {'key': 'consignee_gstin',     'label': 'Consignee GSTIN',       'kind': 'address'},
        {'key': 'consignee_state',     'label': 'Consignee State',       'kind': 'address'},
        {'key': 'consignee_state_code','label': 'Consignee State Code',  'kind': 'address'},
        {'key': 'buyer_name',          'label': 'Buyer Name',            'kind': 'address'},
        {'key': 'buyer_address',       'label': 'Buyer Address',         'kind': 'address'},
        {'key': 'buyer_gstin',         'label': 'Buyer GSTIN',           'kind': 'address'},
        {'key': 'buyer_state',         'label': 'Buyer State',           'kind': 'address'},
        {'key': 'buyer_state_code',    'label': 'Buyer State Code',      'kind': 'address'},
        {'key': 'dc_reference',        'label': 'Dispatch Challan Ref',  'kind': 'reference'},
        {'key': 'so_reference',        'label': 'Sales Order Ref',       'kind': 'reference'},
        {'key': 'buyers_order_no',     'label': "Buyer's Order No",      'kind': 'reference'},
        {'key': 'buyers_order_date',   'label': "Buyer's Order Date",    'kind': 'date'},
        {'key': 'delivery_note',       'label': 'Delivery Note',         'kind': 'reference'},
        {'key': 'delivery_note_date',  'label': 'Delivery Note Date',    'kind': 'date'},
        {'key': 'other_references',    'label': 'Other References',      'kind': 'note'},
        {'key': 'dispatch_doc_no',     'label': 'Dispatch Doc No',       'kind': 'identifier'},
        {'key': 'dispatch_doc_date',   'label': 'Dispatch Doc Date',     'kind': 'date'},
        {'key': 'dispatched_through',  'label': 'Dispatched Through',    'kind': 'logistics'},
        {'key': 'destination',         'label': 'Destination',           'kind': 'address'},
        {'key': 'terms_of_delivery',   'label': 'Terms of Delivery',     'kind': 'commercial'},
        {'key': 'payment_terms',       'label': 'Payment Terms',         'kind': 'commercial'},
        {'key': 'due_date',            'label': 'Due Date',              'kind': 'date'},
        {'key': 'subtotal',            'label': 'Subtotal',              'kind': 'financial'},
        {'key': 'cgst_total',          'label': 'CGST Total',            'kind': 'financial'},
        {'key': 'sgst_total',          'label': 'SGST Total',            'kind': 'financial'},
        {'key': 'igst_total',          'label': 'IGST Total',            'kind': 'financial'},
        {'key': 'round_off',           'label': 'Round Off',             'kind': 'financial'},
        {'key': 'grand_total',         'label': 'Grand Total',           'kind': 'financial'},
        {'key': 'amount_in_words',     'label': 'Amount in Words',       'kind': 'financial'},
        {'key': 'status',              'label': 'Status',                'kind': 'workflow'},
        {'key': 'remarks',             'label': 'Remarks',               'kind': 'note'},
        {'key': 'declaration',         'label': 'Declaration',           'kind': 'note'},
    ],
    'Sales Invoice Line': [
        {'key': 'sl_no',            'label': 'SL No',              'kind': 'identifier'},
        {'key': 'product',          'label': 'Product',            'kind': 'reference'},
        {'key': 'description',      'label': 'Description',        'kind': 'note'},
        {'key': 'batch_no',         'label': 'Batch No',           'kind': 'identifier'},
        {'key': 'hsn_sac',          'label': 'HSN / SAC',          'kind': 'identifier'},
        {'key': 'quantity',         'label': 'Quantity',           'kind': 'financial'},
        {'key': 'uom',              'label': 'UOM',                'kind': 'identifier'},
        {'key': 'rate',             'label': 'Rate',               'kind': 'financial'},
        {'key': 'discount_percent', 'label': 'Discount (%)',       'kind': 'financial'},
        {'key': 'amount',           'label': 'Amount',             'kind': 'financial'},
        {'key': 'gst_rate',         'label': 'GST Rate (%)',       'kind': 'financial'},
        {'key': 'cgst_rate',        'label': 'CGST Rate (%)',      'kind': 'financial'},
        {'key': 'cgst_amount',      'label': 'CGST Amount',        'kind': 'financial'},
        {'key': 'sgst_rate',        'label': 'SGST Rate (%)',      'kind': 'financial'},
        {'key': 'sgst_amount',      'label': 'SGST Amount',        'kind': 'financial'},
        {'key': 'igst_rate',        'label': 'IGST Rate (%)',      'kind': 'financial'},
        {'key': 'igst_amount',      'label': 'IGST Amount',        'kind': 'financial'},
    ],
    'Receivable': [
        {'key': 'customer',          'label': 'Customer',           'kind': 'reference'},
        {'key': 'invoice_reference', 'label': 'Invoice Reference',  'kind': 'reference'},
        {'key': 'invoice_date',      'label': 'Invoice Date',       'kind': 'date'},
        {'key': 'due_date',          'label': 'Due Date',           'kind': 'date'},
        {'key': 'amount',            'label': 'Invoiced Amount',    'kind': 'financial'},
        {'key': 'amount_paid',       'label': 'Amount Paid',        'kind': 'financial'},
        {'key': 'balance',           'label': 'Balance Due',        'kind': 'financial'},
        {'key': 'payment_status',    'label': 'Payment Status',     'kind': 'workflow'},
        {'key': 'escalation_flag',   'label': 'Escalation Flag',    'kind': 'workflow'},
        {'key': 'notes',             'label': 'Notes',              'kind': 'note'},
    ],
    'Receivable Payment': [
        {'key': 'amount',                'label': 'Payment Amount',         'kind': 'financial'},
        {'key': 'payment_date',          'label': 'Payment Date',           'kind': 'date'},
        {'key': 'notes',                 'label': 'Notes',                  'kind': 'note'},
        {'key': 'sourced_from_advance',  'label': 'Sourced from Advance',   'kind': 'reference'},
    ],
    # Outward Freight (warehouse → customer). Page lives at
    # /freight/outward but permission ownership is Sales (see the
    # 'Sales Freight' RBAC module). Fields mirror
    # FreightAdviceOutboundDetailSerializer in sales/serializers.py.
    'Sales Freight': [
        {'key': 'advice_no',         'label': 'Advice No',          'kind': 'identifier'},
        {'key': 'freight_date',      'label': 'Freight Date',       'kind': 'date'},
        {'key': 'invoice_date',      'label': 'Invoice Date',       'kind': 'date'},
        {'key': 'customer_name',     'label': 'Customer Name',      'kind': 'address'},
        {'key': 'destination',       'label': 'Destination',        'kind': 'address'},
        {'key': 'transporter',       'label': 'Transporter',        'kind': 'reference'},
        {'key': 'transporter_name',  'label': 'Transporter Name',   'kind': 'reference'},
        {'key': 'lorry_no',          'label': 'Lorry / Vehicle No', 'kind': 'logistics'},
        {'key': 'freight_type',      'label': 'Freight Type',       'kind': 'commercial'},
        {'key': 'company_name',      'label': 'Company',            'kind': 'reference'},
        {'key': 'factory_name',      'label': 'Warehouse / Factory','kind': 'reference'},
        {'key': 'linked_so_no',      'label': 'Linked SO No',       'kind': 'reference'},
        {'key': 'base_amount',       'label': 'Base Amount',        'kind': 'financial'},
        {'key': 'payable_amount',    'label': 'Payable Amount',     'kind': 'financial'},
        {'key': 'total_paid',        'label': 'Total Paid',         'kind': 'financial'},
        {'key': 'balance',           'label': 'Balance',            'kind': 'financial'},
        {'key': 'calculated_payable','label': 'Calculated Payable', 'kind': 'financial'},
        {'key': 'status',            'label': 'Status',             'kind': 'workflow'},
        {'key': 'remarks',           'label': 'Remarks',            'kind': 'note'},
    ],
    # Per-DC link row inside an outward freight (mapped DCs +
    # invoice + freight-rate breakup). Mirrors FreightDCLinkSerializer.
    'Sales Freight DC Link': [
        {'key': 'dc',              'label': 'DC',              'kind': 'reference'},
        {'key': 'dc_no',           'label': 'DC No',           'kind': 'identifier'},
        {'key': 'invoice_no',      'label': 'Invoice No',      'kind': 'identifier'},
        {'key': 'invoice_date',    'label': 'Invoice Date',    'kind': 'date'},
        {'key': 'destination',     'label': 'Destination',     'kind': 'address'},
        {'key': 'quantity',        'label': 'Quantity',        'kind': 'financial'},
        {'key': 'uom',             'label': 'UOM',             'kind': 'identifier'},
        {'key': 'freight_rate',    'label': 'Freight Rate',    'kind': 'financial'},
        {'key': 'freight_amount',  'label': 'Freight Amount',  'kind': 'financial'},
    ],
    # Payments made against an outward freight. Mirrors
    # FreightPaymentSerializer.
    'Sales Freight Payment': [
        {'key': 'payment_date',  'label': 'Payment Date',     'kind': 'date'},
        {'key': 'amount_paid',   'label': 'Amount Paid',      'kind': 'financial'},
        {'key': 'payment_mode',  'label': 'Payment Mode',     'kind': 'commercial'},
        {'key': 'reference_no',  'label': 'Reference No',     'kind': 'identifier'},
        {'key': 'remarks',       'label': 'Remarks',          'kind': 'note'},
    ],
}
