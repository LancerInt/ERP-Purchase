"""What a vendor owes us, defined ONCE.

Two screens show this: the Vendor details table on Purchase Analytics, and the
vendor ledger behind it. They used to compute it separately - the table with
grouped sums, the ledger with a running balance - and the two agreed only
because someone lined them up by hand. Every change then had to be made twice,
and the owner had to notice and ask for it.

That is the same trap the Tally reconciliation fell into, and the comment on
purchase.tally_purchase.voucher_money says what it cost: two readings that
share a definition cannot disagree, but two readings that share a MISTAKE
cannot disagree either, and the reconciliation reported 0.00 while ex-GST sat
Rs 86,822.92 adrift.

So the rule lives here and nowhere else:

    a BILL          credits the vendor  - we owe more
    a CREDIT NOTE   credits the vendor  - we owe more
    a PAYMENT       debits  the vendor  - we owe less
    a DEBIT NOTE    debits  the vendor  - we owe less (goods went back)
    TDS withheld    lowers it too       - Tally credits the party NET of it,
                                          so the ERP must as well or its
                                          payable sits above Tally's by exactly
                                          the tax withheld

    balance = opening + credits - debits - tds      positive Cr = we owe
                                                    negative Dr = we are ahead

OPENING carriers are excluded from the movement and folded into the opening
balance instead; they are a brought-forward figure, not a purchase.
"""
from collections import defaultdict
from decimal import Decimal

ZERO = Decimal('0')


def _is_opening(bill):
    """A brought-forward balance rather than a document. Marked either way round
    depending on which import wrote it."""
    return ((bill.vendor_invoice_no or '') == 'OPENING'
            or (bill.tally_guid or '').startswith('OPENING'))


def querysets(company_id=None, vendor_id=None, asof=None, start=None, end=None):
    """The four sources, filtered identically for both callers.

    `asof` is a point in time (everything up to it). `start`/`end` bound a
    window. A caller passes one or the other, never both.
    """
    from django.db.models import Q
    from .models import VendorBill, PaymentMade, TdsPayable
    from sales.models import DebitNote

    bills = VendorBill.objects.filter(is_active=True).exclude(status='CANCELLED')
    pays = PaymentMade.objects.filter(is_active=True).exclude(status='CANCELLED')
    notes = DebitNote.objects.filter(side='PURCHASE', is_active=True,
                                     vendor__isnull=False)
    tds = (TdsPayable.objects.filter(is_active=True, amount__gt=0,
                                     vendor_bill__isnull=False)
           .exclude(voucher_type='Opening Balance'))

    if company_id:
        bills = bills.filter(vendor__company_id=company_id)
        pays = pays.filter(vendor__company_id=company_id)
        notes = notes.filter(company_id=company_id)
        tds = tds.filter(vendor_bill__vendor__company_id=company_id)
    if vendor_id:
        bills = bills.filter(vendor_id=vendor_id)
        pays = pays.filter(vendor_id=vendor_id)
        notes = notes.filter(vendor_id=vendor_id)
        tds = tds.filter(vendor_bill__vendor_id=vendor_id)
    if asof:
        bills = bills.filter(bill_date__lte=asof)
        pays = pays.filter(payment_date__lte=asof)
        notes = notes.filter(note_date__lte=asof)
        tds = tds.filter(vendor_bill__bill_date__lte=asof)
    if start:
        bills = bills.filter(bill_date__gte=start)
        pays = pays.filter(payment_date__gte=start)
        notes = notes.filter(note_date__gte=start)
        tds = tds.filter(vendor_bill__bill_date__gte=start)
    if end:
        bills = bills.filter(bill_date__lte=end)
        pays = pays.filter(payment_date__lte=end)
        notes = notes.filter(note_date__lte=end)
        tds = tds.filter(vendor_bill__bill_date__lte=end)
    return bills, pays, notes, tds


def tds_by_bill(tds_qs):
    """{bill_id: tax withheld}. One grouped query, not one per bill."""
    from django.db.models import Sum
    return {r['vendor_bill_id']: (r['t'] or ZERO)
            for r in tds_qs.values('vendor_bill_id').annotate(t=Sum('amount'))}


def events(company_id=None, vendor_id=None, asof=None, start=None, end=None):
    """Every movement on the vendor account, as documents.

    Returns (events, openings) where `openings` is {vendor_id: brought-forward}.
    Each event is a dict the ledger renders directly and the totals below sum -
    which is what stops the two screens drifting.
    """
    bills, pays, notes, tds = querysets(company_id, vendor_id, asof, start, end)
    per_bill = tds_by_bill(tds)

    out, openings = [], defaultdict(lambda: ZERO)

    for b in bills.select_related('vendor'):
        amt = Decimal(str(b.total_amount or 0))
        if _is_opening(b):
            openings[b.vendor_id] += amt
            continue
        out.append({
            'date': str(b.bill_date or ''), 'type': 'Bill',
            'doc_no': b.bill_no or '', 'ref_id': str(b.id),
            'vendor_id': b.vendor_id,
            'vendor': b.vendor.vendor_name if b.vendor_id else '',
            'debit': ZERO, 'credit': amt, 'tds': per_bill.get(b.id, ZERO),
        })

    for p in pays.select_related('vendor'):
        out.append({
            'date': str(p.payment_date or ''), 'type': 'Payment',
            'doc_no': p.payment_no or p.reference_no or 'Payment', 'ref_id': str(p.id),
            'vendor_id': p.vendor_id,
            'vendor': p.vendor.vendor_name if p.vendor_id else '',
            'debit': Decimal(str(p.amount or 0)), 'credit': ZERO, 'tds': ZERO,
        })

    for n in notes.select_related('vendor'):
        amt = Decimal(str(n.amount or 0))
        debit_note = n.note_type == 'DEBIT'      # goods back -> we owe less
        out.append({
            'date': str(n.note_date or ''),
            'type': 'Debit Note' if debit_note else 'Credit Note',
            'doc_no': n.note_no or '', 'ref_id': str(n.id),
            'vendor_id': n.vendor_id,
            'vendor': n.vendor.vendor_name if n.vendor_id else '',
            'debit': amt if debit_note else ZERO,
            'credit': ZERO if debit_note else amt,
            'tds': ZERO,
        })

    out.sort(key=lambda e: (e['date'], e.get('vendor') or '',
                            0 if e['type'] == 'Bill' else 1))
    return out, dict(openings)


def totals(company_id=None, vendor_id=None, asof=None, start=None, end=None):
    """{vendor_id: {billed, paid, balance, ...}}, summed from the SAME events the
    ledger shows. A figure on the table is therefore the figure on the statement
    by construction, not by anyone remembering to change both.

    `billed` is NET of the TDS withheld, matching how Tally credits the party.
    `paid` counts payments AND debit notes, because both reduce what is owed.
    """
    evs, openings = events(company_id, vendor_id, asof, start, end)
    agg = defaultdict(lambda: dict(billed=ZERO, paid=ZERO, credit_notes=ZERO,
                                   tds=ZERO, bill_count=0, vendor_name=''))
    for e in evs:
        a = agg[e['vendor_id']]
        if e['vendor'] and not a['vendor_name']:
            a['vendor_name'] = e['vendor']
        a['tds'] += e['tds']
        if e['type'] == 'Bill':
            a['billed'] += e['credit']
            a['bill_count'] += 1
        elif e['type'] == 'Credit Note':
            a['credit_notes'] += e['credit']
        else:                                    # Payment or Debit Note
            a['paid'] += e['debit']

    for vid, a in agg.items():
        a['opening'] = openings.get(vid, ZERO)
        a['billed_net'] = a['billed'] - a['tds']
        a['balance'] = (a['opening'] + a['billed_net'] + a['credit_notes']
                        - a['paid'])
    for vid, ob in openings.items():             # opening but no movement
        if vid not in agg:
            agg[vid] = dict(billed=ZERO, paid=ZERO, credit_notes=ZERO, tds=ZERO,
                            bill_count=0, vendor_name='', opening=ob,
                            billed_net=ZERO, balance=ob)
    return dict(agg)
