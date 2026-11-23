"""Vendor Ledger (standalone): a running statement per vendor built live from
bills (credit = we owe), advances + payments (debit = we paid). No Tally,
no separate ledger table. Extracted from the full ERP's finance.ledger_views.
"""
from decimal import Decimal, InvalidOperation

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated


def _dec(v):
    try:
        return Decimal(str(v if v is not None else 0))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal('0')


def _date(v):
    return str(v)[:10] if v else ''


def _finalise(rows, payable=True, date_from=None, date_to=None):
    """Sort by date+reference, compute each PARTY's own running balance from the
    full set, return only rows within [date_from, date_to]."""
    rows.sort(key=lambda r: (r['date'] or '9999', r['reference'] or ''))
    party_bal = {}
    for i, r in enumerate(rows, start=1):
        d, c = _dec(r['debit']), _dec(r['credit'])
        key = r.get('party') or ''
        bal = party_bal.get(key, Decimal('0')) + ((c - d) if payable else (d - c))
        party_bal[key] = bal
        r['balance'] = str(bal)
        r['sno'] = i
        r['debit'] = str(d)
        r['credit'] = str(c)
        r.setdefault('link', '')

    visible = rows
    if date_from:
        visible = [r for r in visible if (r['date'] or '') >= date_from]
    if date_to:
        visible = [r for r in visible if (r['date'] or '') <= date_to]

    total_debit = sum((_dec(r['debit']) for r in visible), Decimal('0'))
    total_credit = sum((_dec(r['credit']) for r in visible), Decimal('0'))
    return {
        'results': visible,
        'totals': {
            'total_debit': str(total_debit),
            'total_credit': str(total_credit),
            'closing_balance': str(sum(party_bal.values(), Decimal('0'))),
            'count': len(visible),
        },
    }


class VendorLedgerEntriesView(APIView):
    """GET /api/finance/vendor-ledger-entries/ — every purchase money event.

    Bills credit the ledger (we owe the vendor); advances paid and payments
    made debit it (we paid).
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from purchase.models import VendorBill, PaymentMade, VendorCredit
        date_from = request.query_params.get('date_from') or None
        date_to = request.query_params.get('date_to') or None
        rows = []

        for b in (VendorBill.objects
                  .filter(is_active=True)
                  .exclude(status__in=['DRAFT', 'CANCELLED'])
                  .exclude(vendor_invoice_no__istartswith='DC/')
                  .exclude(tally_guid__startswith='OPENING')
                  .select_related('vendor')):
            vname = getattr(b.vendor, 'vendor_name', '') or ''
            rows.append({
                'date': _date(b.bill_date), 'doc_type': 'Bill', 'reference': b.bill_no,
                'party': vname, 'particulars': (b.notes or '').strip() or f'Bill from {vname}',
                'debit': '0', 'credit': str(b.total_amount or 0), 'status': b.status,
                'link': f'/purchase/bills/{b.id}',
            })

        for c in (VendorCredit.objects
                  .filter(credit_type='ADVANCE').exclude(status='CANCELLED')
                  .select_related('vendor')):
            vname = getattr(c.vendor, 'vendor_name', '') or ''
            rows.append({
                'date': _date(c.credit_date), 'doc_type': 'Advance', 'reference': c.credit_no,
                'party': vname, 'particulars': (c.notes or '').strip() or f'Advance paid to {vname}',
                'debit': str(c.total_amount or 0), 'credit': '0', 'status': c.status,
                'link': f'/purchase/vendor-credits/{c.id}',
            })

        for p in (PaymentMade.objects
                  .exclude(status='CANCELLED').exclude(payment_mode='ADVANCE')
                  .select_related('vendor')):
            vname = getattr(p.vendor, 'vendor_name', '') or ''
            mode = p.get_payment_mode_display() if hasattr(p, 'get_payment_mode_display') else (p.payment_mode or '')
            rows.append({
                'date': _date(p.payment_date), 'doc_type': 'Payment', 'reference': p.payment_no,
                'party': vname, 'particulars': (p.notes or '').strip() or f'Payment to {vname} ({mode})',
                'debit': str(p.amount or 0), 'credit': '0', 'status': p.status,
                'link': f'/purchase/payments-made/{p.id}',
            })

        return Response(_finalise(rows, payable=True, date_from=date_from, date_to=date_to))
