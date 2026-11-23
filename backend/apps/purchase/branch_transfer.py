"""One place that decides whether a VendorBill is an internal branch transfer
rather than a real purchase.

Three kinds are transfers, all excluded from purchase figures:
  1. a "DC/"-prefixed delivery-challan invoice number (stock moved between the
     company's own branches — "NOT FOR SALE");
  2. a bill whose VENDOR is the company's own branch / sister entity
     (Vendor.is_branch — e.g. "SS Biochem (India) Pvt Ltd - Blre"), which carries
     a normal invoice number so the DC/ test alone misses it; and
  3. a bill the operator marked as a Delivery Challan in the Scan / Email inbox,
     stored as purchase_category='BRANCH' (the "DC" button) — a normal invoice
     number from a normal vendor, flagged by hand.

Use branch_transfer_q() in querysets (`.exclude(branch_transfer_q())` to drop
transfers, `.filter(branch_transfer_q())` to keep only them) and
is_branch_transfer_bill(bill) for a single object (serializers).
"""
from django.db.models import Q


def branch_transfer_q():
    """Q matching bills that are internal branch transfers, not purchases."""
    return (Q(vendor_invoice_no__istartswith='DC/')
            | Q(vendor__is_branch=True)
            | Q(purchase_category='BRANCH'))


def is_branch_transfer_bill(bill):
    """True if this bill object is an internal branch transfer."""
    if (getattr(bill, 'vendor_invoice_no', '') or '').strip().upper().startswith('DC/'):
        return True
    if (getattr(bill, 'purchase_category', '') or '') == 'BRANCH':
        return True
    vendor = getattr(bill, 'vendor', None)
    return bool(getattr(vendor, 'is_branch', False))
