"""Manageable-field catalog for the Purchase Module Permissions admin
page.

This file is data-only. It declares which serializer fields on each
Purchase module the admin grid should expose for VIEW / READ_ONLY /
HIDDEN configuration. The catalog is consumed by the
`/api/rbac/manageable-purchase-fields/` endpoint (defined in
`backend/apps/rbac/views.py`) and rendered into the Field Permissions
tab of the Purchase Permissions React page.

The enforcement layer (`FieldPermissionMixin` and
`_get_field_perms_for_user`) lives in `backend/apps/sales/field_permissions.py`
— it is module-agnostic; it just reads `RoleFieldPermission` rows
keyed by `module_name`. Purchase serializers that want field-level
control can `import` it from there and set `field_permission_module =
'Purchase Order'` (or whichever module name they belong to).

Maintenance: when adding a new field to a Purchase serializer that
should be admin-controllable, add a row to the dict below — no
frontend rebuild needed; the page re-fetches the catalog on load.

Field shape:
  {'key': '<serializer field name>',
   'label': '<human label for the admin UI>',
   'kind': '<grouping tag — informational only>'}

`kind` is one of: identifier, reference, financial, commercial, date,
address, workflow, logistics, note, family-specific values are fine.
"""
from __future__ import annotations


MANAGEABLE_PURCHASE_FIELDS = {
    'Purchase Request': [
        {'key': 'pr_no',                'label': 'PR Number',           'kind': 'identifier'},
        {'key': 'company',              'label': 'Company',             'kind': 'reference'},
        {'key': 'warehouse',            'label': 'Warehouse',           'kind': 'reference'},
        {'key': 'godown',               'label': 'Godown',              'kind': 'reference'},
        {'key': 'requestor_role',       'label': 'Requestor Role',      'kind': 'identifier'},
        {'key': 'requirement_type',     'label': 'Requirement Type',    'kind': 'workflow'},
        {'key': 'priority',             'label': 'Priority',            'kind': 'workflow'},
        {'key': 'required_by_date',     'label': 'Required By Date',    'kind': 'date'},
        {'key': 'justification',        'label': 'Justification',       'kind': 'note'},
        {'key': 'notes',                'label': 'Notes',               'kind': 'note'},
        {'key': 'allow_rfq_skip',       'label': 'Allow RFQ Skip',      'kind': 'workflow'},
        {'key': 'preferred_vendor',     'label': 'Preferred Vendor',    'kind': 'reference'},
        {'key': 'approval_status',      'label': 'Approval Status',     'kind': 'workflow'},
    ],
    'Purchase Request Line': [
        {'key': 'line_no',              'label': 'Line No',             'kind': 'identifier'},
        {'key': 'category',             'label': 'Category',            'kind': 'workflow'},
        {'key': 'product_service',      'label': 'Product',             'kind': 'reference'},
        {'key': 'service_catalogue',    'label': 'Service',             'kind': 'reference'},
        {'key': 'quantity_requested',   'label': 'Quantity',            'kind': 'financial'},
        {'key': 'uom',                  'label': 'UOM',                 'kind': 'identifier'},
        {'key': 'description_override', 'label': 'Description',         'kind': 'note'},
        {'key': 'purpose',              'label': 'Purpose',             'kind': 'workflow'},
    ],
    'RFQ': [
        {'key': 'rfq_no',               'label': 'RFQ Number',          'kind': 'identifier'},
        {'key': 'rfq_mode',             'label': 'RFQ Mode',            'kind': 'workflow'},
        {'key': 'quote_count_expected', 'label': 'Expected Quotes',     'kind': 'workflow'},
        {'key': 'linked_prs',           'label': 'Linked PRs',          'kind': 'reference'},
        {'key': 'preferred_vendors',    'label': 'Preferred Vendors',   'kind': 'reference'},
        {'key': 'rfq_status',           'label': 'RFQ Status',          'kind': 'workflow'},
        {'key': 'closing_date',         'label': 'Closing Date',        'kind': 'date'},
        {'key': 'remarks',              'label': 'Remarks',             'kind': 'note'},
    ],
    'Quote': [
        {'key': 'quote_id',             'label': 'Quote No',            'kind': 'identifier'},
        {'key': 'rfq',                  'label': 'RFQ',                 'kind': 'reference'},
        {'key': 'vendor',               'label': 'Vendor',              'kind': 'reference'},
        {'key': 'quote_date',           'label': 'Quote Date',          'kind': 'date'},
        {'key': 'price_valid_till',     'label': 'Valid Till',          'kind': 'date'},
        {'key': 'currency',             'label': 'Currency',            'kind': 'financial'},
        {'key': 'payment_terms',        'label': 'Payment Terms',       'kind': 'commercial'},
        {'key': 'freight_terms',        'label': 'Freight Terms',       'kind': 'commercial'},
        {'key': 'delivery_terms',       'label': 'Delivery Terms',      'kind': 'commercial'},
        {'key': 'lead_time_days',       'label': 'Lead Time (days)',    'kind': 'commercial'},
        {'key': 'chosen_flag',          'label': 'Chosen Flag',         'kind': 'workflow'},
        {'key': 'remarks',              'label': 'Remarks',             'kind': 'note'},
    ],
    'Quote Line': [
        {'key': 'product_service',      'label': 'Product',             'kind': 'reference'},
        {'key': 'service_catalogue',    'label': 'Service',             'kind': 'reference'},
        {'key': 'specification',        'label': 'Specification',       'kind': 'note'},
        {'key': 'quantity_offered',     'label': 'Quantity',            'kind': 'financial'},
        {'key': 'uom',                  'label': 'UOM',                 'kind': 'identifier'},
        {'key': 'unit_price',           'label': 'Unit Price',          'kind': 'financial'},
        {'key': 'discount',             'label': 'Discount (%)',        'kind': 'financial'},
        {'key': 'gst',                  'label': 'GST (%)',             'kind': 'financial'},
        {'key': 'freight_charge',       'label': 'Freight Charge',      'kind': 'financial'},
        {'key': 'delivery_timeline',    'label': 'Delivery (days)',     'kind': 'commercial'},
    ],
    'Quote Evaluation': [
        {'key': 'evaluation_id',        'label': 'Evaluation ID',       'kind': 'identifier'},
        {'key': 'rfq',                  'label': 'RFQ',                 'kind': 'reference'},
        {'key': 'recommended_vendor',   'label': 'Recommended Vendor',  'kind': 'reference'},
        {'key': 'best_quote_flag',      'label': 'Best Quote Flag',     'kind': 'workflow'},
        {'key': 'justification_notes',  'label': 'Justification',       'kind': 'note'},
        {'key': 'approval_status',      'label': 'Approval Status',     'kind': 'workflow'},
    ],
    'Purchase Order': [
        {'key': 'po_no',                'label': 'PO Number',           'kind': 'identifier'},
        {'key': 'vendor',               'label': 'Vendor',              'kind': 'reference'},
        {'key': 'company',              'label': 'Company',             'kind': 'reference'},
        {'key': 'warehouse',            'label': 'Warehouse',           'kind': 'reference'},
        {'key': 'linked_rfq',           'label': 'Linked RFQ',          'kind': 'reference'},
        {'key': 'linked_prs',           'label': 'Linked PRs',          'kind': 'reference'},
        {'key': 'po_date',              'label': 'PO Date',             'kind': 'date'},
        {'key': 'expected_delivery_start','label': 'Expected Delivery Start','kind': 'date'},
        {'key': 'expected_delivery_end','label': 'Expected Delivery End',  'kind': 'date'},
        {'key': 'freight_terms',        'label': 'Freight Terms',       'kind': 'commercial'},
        {'key': 'payment_terms',        'label': 'Payment Terms',       'kind': 'commercial'},
        {'key': 'currency',             'label': 'Currency',            'kind': 'financial'},
        {'key': 'broker_name',          'label': 'Broker Name',         'kind': 'reference'},
        {'key': 'terms_and_conditions', 'label': 'Terms & Conditions',  'kind': 'note'},
        {'key': 'status',               'label': 'Status',              'kind': 'workflow'},
    ],
    'Purchase Order Line': [
        {'key': 'line_no',              'label': 'Line No',             'kind': 'identifier'},
        {'key': 'product_service',      'label': 'Product',             'kind': 'reference'},
        {'key': 'service_catalogue',    'label': 'Service',             'kind': 'reference'},
        {'key': 'description',          'label': 'Description',         'kind': 'note'},
        {'key': 'quantity_ordered',     'label': 'Quantity',            'kind': 'financial'},
        {'key': 'uom',                  'label': 'UOM',                 'kind': 'identifier'},
        {'key': 'unit_price',           'label': 'Unit Price',          'kind': 'financial'},
        {'key': 'discount',             'label': 'Discount (%)',        'kind': 'financial'},
        {'key': 'gst',                  'label': 'GST (%)',             'kind': 'financial'},
        {'key': 'freight_estimate',     'label': 'Freight Estimate',    'kind': 'financial'},
        {'key': 'delivery_schedule',    'label': 'Delivery Date',       'kind': 'date'},
    ],
    'Receipt Advice': [
        {'key': 'receipt_advice_no',    'label': 'Receipt No',          'kind': 'identifier'},
        {'key': 'receipt_date',         'label': 'Receipt Date',        'kind': 'date'},
        {'key': 'vendor',               'label': 'Vendor',              'kind': 'reference'},
        {'key': 'warehouse',            'label': 'Warehouse',           'kind': 'reference'},
        {'key': 'godown',               'label': 'Godown',              'kind': 'reference'},
        {'key': 'vehicle_number',       'label': 'Vehicle Number',      'kind': 'logistics'},
        {'key': 'driver_name',          'label': 'Driver Name',         'kind': 'logistics'},
        {'key': 'driver_phone',         'label': 'Driver Phone',        'kind': 'logistics'},
        {'key': 'qc_routing',           'label': 'QC Routing',          'kind': 'workflow'},
        {'key': 'qc_status',            'label': 'QC Status',           'kind': 'workflow'},
        {'key': 'approval_status',      'label': 'Approval Status',     'kind': 'workflow'},
        {'key': 'advance_amount',       'label': 'Advance Amount',      'kind': 'financial'},
        {'key': 'freight_value',        'label': 'Freight Value',       'kind': 'financial'},
        {'key': 'freight_terms',        'label': 'Freight Terms',       'kind': 'commercial'},
        {'key': 'invoice_no',           'label': 'Invoice No',          'kind': 'identifier'},
        {'key': 'invoice_date',         'label': 'Invoice Date',        'kind': 'date'},
        {'key': 'invoice_amount',       'label': 'Invoice Amount',      'kind': 'financial'},
        {'key': 'remarks',              'label': 'Remarks',             'kind': 'note'},
    ],
    'Receipt Line': [
        {'key': 'line_no',              'label': 'Line No',             'kind': 'identifier'},
        {'key': 'product',              'label': 'Product',             'kind': 'reference'},
        {'key': 'service_catalogue',    'label': 'Service',             'kind': 'reference'},
        {'key': 'batch_no',             'label': 'Batch No',            'kind': 'identifier'},
        {'key': 'expiry_date',          'label': 'Expiry Date',         'kind': 'date'},
        {'key': 'quantity_received',    'label': 'Quantity Received',   'kind': 'financial'},
        {'key': 'net_quantity',         'label': 'Net Quantity',        'kind': 'financial'},
        {'key': 'uom',                  'label': 'UOM',                 'kind': 'identifier'},
        {'key': 'godown_location',      'label': 'Godown',              'kind': 'reference'},
        {'key': 'rate',                 'label': 'Rate',                'kind': 'financial'},
        {'key': 'gst_percentage',       'label': 'GST (%)',             'kind': 'financial'},
        {'key': 'is_debit_note',        'label': 'Debit Note',          'kind': 'workflow'},
    ],
    # Packing-material subform on the Receipt Advice page. Separate line
    # serializer (PackingMaterialLineSerializer) from Receipt Line, so it
    # gets its own field-permission module — admins can hide / lock the
    # packing-material columns independently of the goods Receipt Lines.
    'Receipt Packing Material': [
        {'key': 'packaging_sku',        'label': 'Packaging SKU',       'kind': 'reference'},
        {'key': 'length',               'label': 'Length',              'kind': 'financial'},
        {'key': 'breadth',              'label': 'Breadth',             'kind': 'financial'},
        {'key': 'width',                'label': 'Width',               'kind': 'financial'},
        {'key': 'weight',               'label': 'Weight',              'kind': 'financial'},
        {'key': 'quantity',             'label': 'Invoice Quantity',    'kind': 'financial'},
        {'key': 'net_quantity',         'label': 'Received Quantity',   'kind': 'financial'},
        {'key': 'uom',                  'label': 'UOM',                 'kind': 'identifier'},
        {'key': 'batch_no',             'label': 'Batch No',            'kind': 'identifier'},
        {'key': 'godown_location',      'label': 'Godown',              'kind': 'reference'},
        {'key': 'remarks',              'label': 'Remarks',             'kind': 'note'},
    ],
    'Vendor Bill': [
        {'key': 'bill_no',              'label': 'Bill Number',         'kind': 'identifier'},
        {'key': 'vendor',               'label': 'Vendor',              'kind': 'reference'},
        {'key': 'purchase_order',       'label': 'Purchase Order',      'kind': 'reference'},
        {'key': 'receipt_advice',       'label': 'Receipt Advice',      'kind': 'reference'},
        {'key': 'vendor_invoice_no',    'label': 'Vendor Invoice No',   'kind': 'identifier'},
        {'key': 'bill_date',            'label': 'Bill Date',           'kind': 'date'},
        {'key': 'due_date',             'label': 'Due Date',            'kind': 'date'},
        {'key': 'subtotal',             'label': 'Subtotal',            'kind': 'financial'},
        {'key': 'discount_amount',      'label': 'Discount',            'kind': 'financial'},
        {'key': 'tax_amount',           'label': 'Tax Amount',          'kind': 'financial'},
        {'key': 'total_amount',         'label': 'Total Amount',        'kind': 'financial'},
        {'key': 'status',               'label': 'Status',              'kind': 'workflow'},
        {'key': 'notes',                'label': 'Notes',               'kind': 'note'},
        {'key': 'terms_and_conditions', 'label': 'Terms & Conditions',  'kind': 'note'},
    ],
    'Payment Made': [
        {'key': 'payment_no',           'label': 'Payment No',          'kind': 'identifier'},
        {'key': 'vendor',               'label': 'Vendor',              'kind': 'reference'},
        {'key': 'bill',                 'label': 'Bill',                'kind': 'reference'},
        {'key': 'payment_date',         'label': 'Payment Date',        'kind': 'date'},
        {'key': 'payment_mode',         'label': 'Payment Mode',        'kind': 'commercial'},
        {'key': 'amount',               'label': 'Amount',              'kind': 'financial'},
        {'key': 'reference_no',         'label': 'Reference No',        'kind': 'identifier'},
        {'key': 'bank_name',            'label': 'Bank Name',           'kind': 'commercial'},
        {'key': 'status',               'label': 'Status',              'kind': 'workflow'},
        {'key': 'notes',                'label': 'Notes',               'kind': 'note'},
    ],
    'Vendor Credit': [
        {'key': 'credit_no',            'label': 'Credit No',           'kind': 'identifier'},
        {'key': 'vendor',               'label': 'Vendor',              'kind': 'reference'},
        {'key': 'bill',                 'label': 'Bill',                'kind': 'reference'},
        {'key': 'credit_type',          'label': 'Credit Type',         'kind': 'workflow'},
        {'key': 'credit_date',          'label': 'Credit Date',         'kind': 'date'},
        {'key': 'reason',               'label': 'Reason',              'kind': 'note'},
        {'key': 'subtotal',             'label': 'Subtotal',            'kind': 'financial'},
        {'key': 'tax_amount',           'label': 'Tax Amount',          'kind': 'financial'},
        {'key': 'total_amount',         'label': 'Total Amount',        'kind': 'financial'},
        {'key': 'amount_applied',       'label': 'Amount Applied',      'kind': 'financial'},
        {'key': 'status',               'label': 'Status',              'kind': 'workflow'},
        {'key': 'notes',                'label': 'Notes',               'kind': 'note'},
    ],
    'Material Rejection': [
        {'key': 'rejection_no',         'label': 'Rejection No',        'kind': 'identifier'},
        {'key': 'rejection_date',       'label': 'Rejection Date',      'kind': 'date'},
        {'key': 'receipt_advice',       'label': 'Receipt Advice',      'kind': 'reference'},
        {'key': 'purchase_order',       'label': 'Purchase Order',      'kind': 'reference'},
        {'key': 'vendor',               'label': 'Vendor',              'kind': 'reference'},
        {'key': 'warehouse',            'label': 'Warehouse',           'kind': 'reference'},
        {'key': 'status',               'label': 'Status',              'kind': 'workflow'},
        {'key': 'return_to_vendor',     'label': 'Return to Vendor',    'kind': 'workflow'},
        {'key': 'return_type',          'label': 'Return Type',         'kind': 'workflow'},
        {'key': 'return_date',          'label': 'Return Date',         'kind': 'date'},
        {'key': 'replacement_expected_date','label': 'Replacement Expected','kind': 'date'},
        {'key': 'debit_note_required',  'label': 'Debit Note Required', 'kind': 'workflow'},
        {'key': 'description',          'label': 'Description',         'kind': 'note'},
        {'key': 'remarks',              'label': 'Remarks',             'kind': 'note'},
    ],
    'Vendor Dues': [
        {'key': 'vendor',               'label': 'Vendor',              'kind': 'reference'},
        {'key': 'total_billed',         'label': 'Total Billed',        'kind': 'financial'},
        {'key': 'total_paid',           'label': 'Total Paid',          'kind': 'financial'},
        {'key': 'balance_due',          'label': 'Balance Due',         'kind': 'financial'},
        {'key': 'overdue_amount',       'label': 'Overdue Amount',      'kind': 'financial'},
        {'key': 'oldest_unpaid_date',   'label': 'Oldest Unpaid Date',  'kind': 'date'},
    ],
}
