"""Invoice-included freight capture.

When a purchase bill carries freight as a line INSIDE the goods invoice (e.g. a
"Freight Inward" charge), mirror it as a tracking-only FreightAdviceInbound
(freight_source=INVOICE_INCLUDED) linked to that bill, so it shows up in the
freight billed/paid/pending report alongside separate transporter slips.

Key rules (agreed with the business):
 - Tracking-only: it NEVER adds a payable — the bill total already includes the
   freight. There is no separate freight payment for it.
 - Paid follows the bill, GOODS FIRST / FREIGHT LAST (see
   FreightAdviceInbound.invoice_freight_paid).
 - Auto-detected from the charge label (transport family), and editable/removable
   after — re-running this keeps it in step with the bill.
"""
import logging
import re
from decimal import Decimal, InvalidOperation

logger = logging.getLogger(__name__)

# A charge line counts as freight when its label is in the transport family.
_FREIGHT_RE = re.compile(r'freight|transport|cartage|carriage|lorry', re.I)


def _dec(v):
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal('0')


def bill_freight_amount(bill):
    """Sum of the freight/transport charge lines on a bill (from its
    additional_charges). 0 when the bill has no freight line."""
    total = Decimal('0')
    for c in (bill.additional_charges or []):
        if not isinstance(c, dict):
            continue
        label = c.get('label') or c.get('type') or ''
        if _FREIGHT_RE.search(str(label)):
            total += _dec(c.get('amount'))
    return total


def sync_invoice_freight(bill, user=None):
    """Create / update / remove the invoice-included freight record so it matches
    the bill's current freight charge. Idempotent and exception-safe — a freight
    hiccup must never block the bill itself.

    The DB work runs in its OWN savepoint (transaction.atomic): the callers
    (Scan confirm, Email approve) are themselves atomic, so a caught error here
    that had NOT rolled back would poison their transaction and fail the bill.
    The savepoint contains any failure to itself."""
    from django.db import transaction
    from .models import FreightAdviceInbound
    try:
        with transaction.atomic():
            return _sync_invoice_freight_inner(bill, user, FreightAdviceInbound)
    except Exception:  # noqa: BLE001
        logger.exception('sync_invoice_freight failed for bill %s', getattr(bill, 'pk', None))
        return None


def _copy_bill_docs_to_freight(bill, fa):
    """Mirror the bill's own document(s) onto its invoice-included Freight Advice,
    so the source bill is viewable from the freight record too. Idempotent; shares
    the stored file, best-effort."""
    try:
        from .models import PurchaseAttachment
        for att in PurchaseAttachment.objects.filter(module='BILL', record_id=bill.id):
            if PurchaseAttachment.objects.filter(module='FREIGHT', record_id=fa.id,
                                                 file_name=att.file_name).exists():
                continue
            PurchaseAttachment.objects.create(
                module='FREIGHT', record_id=fa.id, file=att.file,
                file_name=att.file_name, file_size=att.file_size,
                file_type=att.file_type, uploaded_by=att.uploaded_by)
    except Exception:  # noqa: BLE001 — attachment mirroring is best-effort
        logger.exception('copy bill docs to freight failed for bill %s', getattr(bill, 'pk', None))


def _sync_invoice_freight_inner(bill, user, FreightAdviceInbound):
    amt = bill_freight_amount(bill)
    existing = FreightAdviceInbound.objects.filter(
        vendor_bill=bill, freight_source='INVOICE_INCLUDED').first()
    if amt <= 0:
        if existing:
            existing.delete()   # freight line no longer on the bill
        return None
    if existing:
        existing.base_amount = amt
        existing.payable_amount = amt
        existing.freight_date = bill.bill_date
        existing.transport_document_no = (bill.vendor_invoice_no or '')[:100]
        existing.save(update_fields=['base_amount', 'payable_amount',
                                     'freight_date', 'transport_document_no', 'updated_at'])
        existing.update_payment_status()
        _copy_bill_docs_to_freight(bill, existing)
        return existing
    fa = FreightAdviceInbound(
        source_type='VENDOR_BILL',
        vendor_bill=bill,
        freight_source='INVOICE_INCLUDED',
        freight_type='LINEHAUL',
        base_amount=amt,
        payable_amount=amt,
        freight_terms='',
        # Tracking-only mirror of a bill's freight line — it never goes through
        # the freight approve/pay workflow, so it starts as DRAFT (its payment
        # status is derived from the bill, not this record's own status).
        status='DRAFT',
        freight_date=bill.bill_date,
        transport_document_no=(bill.vendor_invoice_no or '')[:100],
        remarks=f'Freight included in vendor bill {bill.bill_no}',
        created_by=getattr(user, 'stakeholder_profile', None),
    )
    fa.save()
    fa.update_payment_status()
    _copy_bill_docs_to_freight(bill, fa)
    return fa


def resync_bill_freight_payment(bill):
    """After a bill's payment changes, refresh the linked invoice-included
    freight's paid/pending (goods first, freight last). Own savepoint so a
    failure can't poison the caller's payment transaction."""
    from django.db import transaction
    from .models import FreightAdviceInbound
    try:
        with transaction.atomic():
            for fa in FreightAdviceInbound.objects.filter(
                    vendor_bill=bill, freight_source='INVOICE_INCLUDED'):
                fa.update_payment_status()
    except Exception:  # noqa: BLE001
        logger.exception('resync_bill_freight_payment failed for bill %s', getattr(bill, 'pk', None))
