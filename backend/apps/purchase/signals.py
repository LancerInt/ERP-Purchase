"""Signal handlers for the purchase app.

Currently:
- post_save on PurchaseOrder → backfill PO number/FK into matching
  ProductMismatchLog rows so the audit table reflects the downstream PO.
- post_save on VendorBill → auto-classify its spend category on create, so
  Day Book / Zoho / Tally imports never leave bills Unclassified.
"""
import logging

from django.db.models.signals import post_save
from django.dispatch import receiver

logger = logging.getLogger(__name__)


@receiver(post_save, sender='purchase.VendorBill')
def auto_classify_vendor_bill(sender, instance, created, **kwargs):
    """Tag a bill's spend category (RM / Packing / Freight / Expenses / Machinery)
    the moment it is created — so imports (Day Book, Zoho, Tally) no longer leave
    bills as "Unclassified" until someone re-runs classify_bills.

    Uses the same rules as the CLI (bill_classification.classify_bill): the vendor's
    Tally creditor group, the is_expense flag, the product sub-type, a Tally voucher
    hint, then the vendor's OWN established category (so name-tagged vendors like
    Shree Kumaran self-heal). A manual override is never touched; classification
    never blocks a bill save."""
    if not created:
        return
    if getattr(instance, 'category_source', '') == 'manual' or getattr(instance, 'purchase_category', ''):
        # already categorised — but still settle it if it's a bought note (below).
        _settle_if_bought_note(instance)
        return
    try:
        from .bill_classification import classify_and_save_bill
        classify_and_save_bill(instance)
    except Exception:
        logger.exception('auto-classify on VendorBill create failed for %s', getattr(instance, 'pk', '?'))
    _settle_if_bought_note(instance)


_TDS_FIELDS = {'computed_tds_amount', 'computed_tds_section', 'tds_status'}


@receiver(post_save, sender='purchase.VendorBill')
def compute_vendor_bill_tds(sender, instance, created, update_fields=None, **kwargs):
    """Compute the EXPECTED TDS on a bill (validate-first) whenever it is created
    or changed. Inert until the company sets tds_engine_enabled=True (apply_tds
    returns None otherwise), and recursion-safe: it skips the computed-fields save
    apply_tds itself makes. Never blocks a bill save."""
    if update_fields is not None and set(update_fields) <= _TDS_FIELDS:
        return  # our own computed-fields write — don't re-enter
    try:
        from .tds_engine import apply_tds
        apply_tds(instance)
    except Exception:
        logger.exception('TDS compute on VendorBill save failed for %s', getattr(instance, 'pk', '?'))


@receiver(post_save, sender='purchase.PaymentMade')
def sync_bill_status_on_payment(sender, instance, **kwargs):
    """Keep a bill's STATUS in step with its amount_paid whenever a payment is booked
    against it. The proper paths (apply_payment_to_bill, settle) set the status, but
    some import/reconcile paths set amount_paid WITHOUT flipping it — so a fully-paid
    bill read OPEN and showed up as overdue (bill 342: the ERP had paid it, status was
    stuck OPEN). This makes the label honest no matter which path booked the payment.
    TDS-aware (a bill settles when amount_paid + tds_withheld >= gross total); leaves a
    deliberate CANCELLED / DRAFT state alone; only writes when the status actually
    changes; never blocks the save."""
    from decimal import Decimal
    _C = Decimal('0.01')
    bill = getattr(instance, 'bill', None)
    if bill is None or bill.status in ('CANCELLED', 'DRAFT'):
        return
    try:
        paid = bill.amount_paid or Decimal('0')
        total = bill.total_amount or Decimal('0')
        if paid <= 0:
            new = 'OPEN'
        elif paid >= total - _C:
            new = 'PAID'
        else:
            # only the net (post-TDS) settlement case needs the TDS lookup
            new = 'PAID' if paid + (bill.tds_withheld or Decimal('0')) >= total - _C else 'PARTIALLY_PAID'
        if bill.status != new:
            bill.status = new
            bill.save(update_fields=['status'])
    except Exception:
        logger.exception('bill status sync on payment %s failed', getattr(instance, 'pk', '?'))


def _settle_if_bought_note(bill):
    # Bought Note / cash auto-settle disabled — payment logic being rebuilt
    pass


@receiver(post_save, sender='purchase.PurchaseOrder')
def backfill_po_into_mismatch_logs(sender, instance, created, **kwargs):
    """When a PO is created/updated, walk its lines back to their source
    QuoteResponses and stamp `purchase_order` + `po_number` onto matching
    ProductMismatchLog rows that don't yet have a PO recorded."""
    from .models import ProductMismatchLog

    try:
        po_lines = instance.po_lines.all().select_related('linked_rfq_line__quote')
    except Exception:
        return

    quote_ids = set()
    for line in po_lines:
        ql = getattr(line, 'linked_rfq_line', None)
        if ql and getattr(ql, 'quote_id', None):
            quote_ids.add(ql.quote_id)

    if not quote_ids:
        return

    try:
        updated = ProductMismatchLog.objects.filter(
            quote_response_id__in=list(quote_ids),
            purchase_order__isnull=True,
            is_active=True,
        ).update(
            purchase_order=instance,
            po_number=instance.po_no or '',
        )
        if updated:
            logger.info('Backfilled PO %s onto %s mismatch log(s)', instance.po_no, updated)
    except Exception:
        logger.exception('Failed to backfill PO into ProductMismatchLog')
