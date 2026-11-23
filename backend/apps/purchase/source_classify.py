"""Source classification for purchase bills: Tally vs ERP-scanned.

The Purchase Analytics pages gain a source toggle (All / Tally sync / ERP
scanned) and a "Tally vs ERP" comparison. A bill's source is derived from the
SAME markers the Bills page already uses (no new fields):

  * TALLY  — has a real (non-OPENING) tally_guid, i.e. it exists in Tally.
  * SCAN   — was captured in the ERP by scan / email-inbox (a CONFIRMED
             InvoiceScanBill, a bill attachment, or the "created from scan/email"
             note), with NO Tally guid.
  * BOTH   — scanned AND present in Tally (the "Scan + Tally matched" bills).

For the toggle, a BOTH bill belongs to EITHER filter (it genuinely exists in
both systems): `tally` → TALLY ∪ BOTH, `scan` → SCAN ∪ BOTH. The comparison
reports the three buckets plus only-Tally / only-scan and the value gap.
"""
from decimal import Decimal

from django.db.models import Exists, OuterRef, Q, Sum, Count, Value, BooleanField


def annotate_source(qs):
    """Add `_has_scan` (CONFIRMED scan / attachment) and `_has_tally` booleans so
    callers can bucket without N+1. Mirrors the Bills-page annotation."""
    from ai_parser.scan_models import InvoiceScanBill
    from purchase.models import PurchaseAttachment

    scan = InvoiceScanBill.objects.filter(
        Q(matched_bill=OuterRef('pk')) | Q(created_bill=OuterRef('pk')),
        status='CONFIRMED')
    scan_att = PurchaseAttachment.objects.filter(module='BILL', record_id=OuterRef('pk'))
    return qs.annotate(_scan_confirmed=Exists(scan), _scan_attach=Exists(scan_att))


# Note-based scan markers (a scan record can be cleaned up but the note remains).
_SCAN_NOTE_Q = (Q(notes__icontains='scanned invoice') | Q(notes__icontains='from scanned')
                | Q(notes__icontains='emailed bill') | Q(notes__icontains='email bill inbox'))
# A real Tally presence = a non-blank tally_guid that is not an OPENING carrier.
_TALLY_Q = ~Q(tally_guid='') & ~Q(tally_guid__startswith='OPENING')
# Scanned = a confirmed scan / attachment (annotations) OR a scan/email note.
_SCAN_Q = Q(_scan_confirmed=True) | Q(_scan_attach=True) | _SCAN_NOTE_Q


def filter_by_source(qs, source):
    """Filter a source-annotated queryset into TWO mutually-exclusive origins —
    where the bill was CREATED, not whether it also appears in the other system:

      'tally'        — created by the Tally import: has a tally_guid AND was NOT
                       scanned/emailed/hand-entered here.
      'scan' / 'erp' — entered in the ERP: scanned, emailed OR hand-entered. A
                       bill you scanned that LATER matched a Tally voucher (so it
                       picked up a tally_guid) is still ERP — you entered it.

    Every bill is exactly one of the two; there is no 'sync'/'both' count. ERP is
    the complement of Tally, so tally_count + erp_count = total, always.
    'all' = no filter.
    """
    s = (source or 'all').lower()
    # ERP origin = a scan/email marker, OR no tally_guid at all (hand-entered).
    _ERP_ORIGIN = _SCAN_Q | ~_TALLY_Q
    # Tally origin = imported from Tally (has a guid) and NOT entered here.
    _TALLY_ORIGIN = _TALLY_Q & ~_SCAN_Q
    if s == 'tally':
        return qs.filter(_TALLY_ORIGIN)
    if s in ('scan', 'erp', 'not_in_tally'):
        return qs.filter(_ERP_ORIGIN)
    return qs


def _money(v):
    return (v or Decimal('0')).quantize(Decimal('0.01'))


def source_breakdown(qs, value_field='total_amount'):
    """Two mutually-exclusive origins, by WHERE the bill was created — no 'both':

      tally — created by the Tally import (tally_guid, not entered here).
      scan  — entered in the ERP (scanned/emailed/hand-entered); a scan that later
              matched a Tally voucher still counts here, because you entered it.

    tally + scan = total, always. `difference` is the gap between the two value
    totals. (only_tally / only_scan are kept as aliases of tally / scan for any
    caller still reading the old keys — there is no separate 'one but not the
    other' here, since every bill is already exactly one origin.)"""
    qs = annotate_source(qs)
    _ERP_ORIGIN = _SCAN_Q | ~_TALLY_Q
    _TALLY_ORIGIN = _TALLY_Q & ~_SCAN_Q
    tally_q = qs.filter(_TALLY_ORIGIN)
    scan_q = qs.filter(_ERP_ORIGIN)

    def agg(q):
        a = q.aggregate(c=Count('id'), v=Sum(value_field))
        return {'count': a['c'] or 0, 'value': str(_money(a['v']))}

    tally, scan = agg(tally_q), agg(scan_q)
    diff = abs(_money(Decimal(tally['value'])) - _money(Decimal(scan['value'])))
    return {
        'tally': tally,
        'scan': scan,
        'both': {'count': 0, 'value': '0.00'},   # no sync bucket by this definition
        'only_tally': tally,
        'only_scan': scan,
        'difference': str(diff),
    }
