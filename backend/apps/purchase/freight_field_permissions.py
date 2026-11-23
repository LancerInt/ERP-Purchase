"""Manageable-field catalog for the Freight Module Permissions admin
page.

Same shape as `apps.purchase.field_permissions.MANAGEABLE_PURCHASE_FIELDS`
and `apps.sales.field_permissions.MANAGEABLE_SALES_FIELDS` — declares
which serializer fields on each Freight module the admin grid should
expose for VIEW / READ_ONLY / HIDDEN configuration. Consumed by the
`/api/rbac/manageable-freight-fields/` endpoint (defined in
`backend/apps/rbac/views.py`) and rendered into the Field Permissions
tab of the Freight Permissions React page.

The enforcement layer (`FieldPermissionMixin` and
`_get_field_perms_for_user`) lives in
`backend/apps/sales/field_permissions.py` and is module-agnostic — it
reads `RoleFieldPermission` rows keyed by `module_name`. To make a
freight serializer enforce these overrides, import the mixin and set
`field_permission_module = 'Freight Advice'` (etc.) on the serializer.

The four modules below correspond to:
  • Freight Advice   — Inward Freight (vendor → warehouse)
  • Freight Payment  — payments against an Inward freight advice
  • Wage Entry       — Loading/Unloading wages claim header + lines
  • Wage Payment     — periodic settlement against open wage lines

Outward Freight is deliberately NOT here — owned by the Sales module
("Sales Freight" slug) and managed on the Sales Permissions page.

Field shape:
  {'key': '<serializer field name>',
   'label': '<human label for the admin UI>',
   'kind': '<grouping tag — informational only>'}

`kind` values used here: identifier, reference, financial, commercial,
date, workflow, logistics, note.
"""
from __future__ import annotations


MANAGEABLE_FREIGHT_FIELDS = {
    'Freight Advice': [
        {'key': 'advice_no',             'label': 'Advice No',           'kind': 'identifier'},
        {'key': 'source_type',           'label': 'Source Type',         'kind': 'workflow'},
        {'key': 'receipt_advice',        'label': 'Linked Receipt',      'kind': 'reference'},
        {'key': 'transfer_source',       'label': 'Linked Transfer',     'kind': 'reference'},
        {'key': 'shifting_source',       'label': 'Linked Shifting',     'kind': 'reference'},
        {'key': 'dispatch_challan_source', 'label': 'Linked DC',         'kind': 'reference'},
        {'key': 'transporter',           'label': 'Transporter',         'kind': 'reference'},
        {'key': 'freight_type',          'label': 'Freight Type',        'kind': 'workflow'},
        {'key': 'freight_terms',         'label': 'Freight Terms',       'kind': 'commercial'},
        {'key': 'base_amount',           'label': 'Base Amount',         'kind': 'financial'},
        {'key': 'discount',              'label': 'Discount',            'kind': 'financial'},
        {'key': 'loading_wages_amount',  'label': 'Loading Wages',       'kind': 'financial'},
        {'key': 'unloading_wages_amount','label': 'Unloading Wages',     'kind': 'financial'},
        {'key': 'other_charges',         'label': 'Other Charges',       'kind': 'financial'},
        {'key': 'quantity_basis',        'label': 'Quantity Basis',      'kind': 'commercial'},
        {'key': 'quantity_uom',          'label': 'Quantity UOM',        'kind': 'identifier'},
        {'key': 'cost_per_unit_calc',    'label': 'Cost / Unit',         'kind': 'financial'},
        {'key': 'destination_state',     'label': 'Destination State',   'kind': 'logistics'},
        {'key': 'payable_amount',        'label': 'Payable Amount',      'kind': 'financial'},
        {'key': 'total_paid',            'label': 'Total Paid',          'kind': 'financial'},
        {'key': 'balance',               'label': 'Balance',             'kind': 'financial'},
        {'key': 'lorry_no',              'label': 'Lorry No',            'kind': 'logistics'},
        {'key': 'driver_name',           'label': 'Driver Name',         'kind': 'logistics'},
        {'key': 'driver_contact',        'label': 'Driver Contact',      'kind': 'logistics'},
        {'key': 'freight_date',          'label': 'Freight Date',        'kind': 'date'},
        {'key': 'dispatch_date',         'label': 'Dispatch Date',       'kind': 'date'},
        {'key': 'expected_arrival_date', 'label': 'Expected Arrival',    'kind': 'date'},
        {'key': 'actual_arrival_date',   'label': 'Actual Arrival',      'kind': 'date'},
        {'key': 'transport_document_no', 'label': 'Transport Doc No',    'kind': 'identifier'},
        {'key': 'delivery_remarks',      'label': 'Delivery Remarks',    'kind': 'note'},
        {'key': 'remarks',               'label': 'Remarks',             'kind': 'note'},
        {'key': 'status',                'label': 'Status',              'kind': 'workflow'},
    ],
    'Freight Payment': [
        {'key': 'payment_date',          'label': 'Payment Date',        'kind': 'date'},
        {'key': 'amount_paid',           'label': 'Amount Paid',         'kind': 'financial'},
        {'key': 'payment_mode',          'label': 'Payment Mode',        'kind': 'commercial'},
        {'key': 'paid_to',               'label': 'Paid To',             'kind': 'reference'},
        {'key': 'reference_no',          'label': 'Reference No',        'kind': 'identifier'},
        {'key': 'notes',                 'label': 'Notes',               'kind': 'note'},
    ],
    'Wage Entry': [
        {'key': 'entry_no',              'label': 'Entry No',            'kind': 'identifier'},
        {'key': 'date',                  'label': 'Date',                'kind': 'date'},
        {'key': 'source_type',           'label': 'Source Type',         'kind': 'workflow'},
        {'key': 'receipt',               'label': 'Linked Receipt',      'kind': 'reference'},
        {'key': 'transfer_source',       'label': 'Linked Transfer',     'kind': 'reference'},
        {'key': 'shifting_source',       'label': 'Linked Shifting',     'kind': 'reference'},
        {'key': 'dispatch_challan_source', 'label': 'Linked DC',         'kind': 'reference'},
        {'key': 'overall_remarks',       'label': 'Overall Remarks',     'kind': 'note'},
        {'key': 'status',                'label': 'Status',              'kind': 'workflow'},
    ],
    'Wage Entry Line': [
        {'key': 'line_no',               'label': 'Line No',             'kind': 'identifier'},
        {'key': 'contractor',            'label': 'Contractor',          'kind': 'reference'},
        {'key': 'workers_count',         'label': 'Workers',             'kind': 'financial'},
        {'key': 'rate_per_worker',       'label': 'Rate / Worker',       'kind': 'financial'},
        {'key': 'wage_amount',           'label': 'Wage Amount',         'kind': 'financial'},
        {'key': 'advance_amount',        'label': 'Advance Amount',      'kind': 'financial'},
        {'key': 'balance',               'label': 'Balance',             'kind': 'financial'},
        {'key': 'remarks',               'label': 'Remarks',             'kind': 'note'},
    ],
    'Wage Payment': [
        {'key': 'payment_no',            'label': 'Payment No',          'kind': 'identifier'},
        {'key': 'contractor',            'label': 'Contractor',          'kind': 'reference'},
        {'key': 'cycle_type',            'label': 'Cycle Type',          'kind': 'workflow'},
        {'key': 'from_date',             'label': 'From Date',           'kind': 'date'},
        {'key': 'to_date',               'label': 'To Date',             'kind': 'date'},
        {'key': 'payment_date',          'label': 'Payment Date',        'kind': 'date'},
        {'key': 'line_count',            'label': 'Line Count',          'kind': 'workflow'},
        {'key': 'gross_wages',           'label': 'Gross Wages',         'kind': 'financial'},
        {'key': 'total_advance',         'label': 'Total Advance',       'kind': 'financial'},
        {'key': 'net_payable',           'label': 'Net Payable',         'kind': 'financial'},
        {'key': 'paid_amount',           'label': 'Paid Amount',         'kind': 'financial'},
        {'key': 'balance_amount',        'label': 'Balance Amount',      'kind': 'financial'},
        {'key': 'payment_mode',          'label': 'Payment Mode',        'kind': 'commercial'},
        {'key': 'reference_no',          'label': 'Reference No',        'kind': 'identifier'},
        {'key': 'remarks',               'label': 'Remarks',             'kind': 'note'},
        {'key': 'status',                'label': 'Status',              'kind': 'workflow'},
    ],
}
