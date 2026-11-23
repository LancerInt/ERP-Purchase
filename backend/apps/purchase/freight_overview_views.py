"""Freight Overview — a management rollup of ALL inward freight, unifying the
two ways freight reaches us:

  * ON-BILL freight  — freight bundled onto a goods (RM) purchase bill. The
                       canonical figure is VendorBill.other_charges (the leg
                       Tally books to "Freight Inward Charges"). This ties the
                       bill_freight_total shown on the Freight Inward page.
  * SEPARATE freight — a standalone transporter slip, tracked in the operational
                       freight module as FreightAdviceInbound(SEPARATE_SLIP),
                       each either matched to the RM bill it carried (vendor_bill)
                       or still unmatched.

The split, the per-transporter leaderboard, the highest-freight purchases and
the unmatched-slip alert are exactly the Exec Freight Overview the Purchase
Analytics "Freight" tile opens. Reporting-only — reads existing data, writes
nothing. Company scoping for separate freight mirrors the operator
freight/summary endpoint's _company_id() derivation so the two agree.
"""
from datetime import date, datetime
from decimal import Decimal

from django.db.models import Q, Sum
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated

from rbac.permissions import HasModulePermission


class FreightOverviewView(APIView):
    """GET /api/purchase/freight-overview/

    Query params:
      company   ERP company id (optional)
      from,to   YYYY-MM-DD — date window (default: this FY). On-bill filters on
                bill_date; separate filters on freight_date.
      top       how many highest-freight purchases to return (default 20)
    """
    permission_classes = [IsAuthenticated, HasModulePermission]
    module_name = 'Freight Inward'

    @staticmethod
    def _money(v):
        return str((v or Decimal('0')).quantize(Decimal('0.01')))

    @staticmethod
    def _pct(part, whole):
        if not whole:
            return 0.0
        return round(float(part) / float(whole) * 100, 1)

    @staticmethod
    def _pd(s):
        try:
            return datetime.strptime(s, '%Y-%m-%d').date() if s else None
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _company_of(fa):
        """Same derivation the operator freight/summary endpoint uses — the
        model has no company FK, so trace it through the linked bill, then the
        transporter, then the receipt-advice warehouse."""
        if fa.vendor_bill_id and fa.vendor_bill and getattr(fa.vendor_bill, 'vendor', None):
            return str(getattr(fa.vendor_bill.vendor, 'company_id', '') or '')
        if fa.transporter_id and getattr(fa.transporter, 'company_id', None):
            return str(fa.transporter.company_id)
        ra = getattr(fa, 'receipt_advice', None)
        if ra and getattr(ra, 'warehouse', None):
            return str(getattr(ra.warehouse, 'company_id', '') or '')
        return ''

    def get(self, request):
        from .models import VendorBill, FreightAdviceInbound

        company = request.query_params.get('company') or None
        # Vendor here is the GOODS supplier whose bills the freight sits on —
        # on-bill freight is VendorBill.other_charges on that vendor's bills,
        # and a separate slip is attributed to the goods bill it covers. The
        # TRANSPORTER is a different axis, already broken out in "Top
        # transporters", so the dashboard's vendor filter scopes by supplier,
        # the same as every other tile. It was never read here, so picking a
        # vendor changed nothing.
        vendor = request.query_params.get('vendor') or None
        today = date.today()
        fy_start = date(today.year if today.month >= 4 else today.year - 1, 4, 1)
        frm = self._pd(request.query_params.get('from')) or fy_start
        to = self._pd(request.query_params.get('to')) or today
        try:
            top_n = max(1, min(100, int(request.query_params.get('top') or 20)))
        except (TypeError, ValueError):
            top_n = 20

        # ---- ON-BILL freight: VendorBill.other_charges (ties Freight Inward) ----
        bqs = (VendorBill.objects.filter(is_active=True, other_charges__gt=0,
                                         bill_date__gte=frm, bill_date__lte=to)
               .exclude(status='CANCELLED').exclude(tally_guid__startswith='OPENING'))
        if company:
            bqs = bqs.filter(vendor__company_id=company)
        if vendor:
            bqs = bqs.filter(vendor_id=vendor)
        onbill_total = bqs.aggregate(t=Sum('other_charges'))['t'] or Decimal('0')
        onbill_bill_count = bqs.count()

        # Per-bill on-bill freight (for the highest-freight-purchases table).
        onbill_by_bill = {}
        for b in bqs.select_related('vendor').order_by('-other_charges')[:500]:
            onbill_by_bill[b.id] = {
                'bill_id': str(b.id),
                'invoice_no': b.vendor_invoice_no or '',
                'party': b.vendor.vendor_name if b.vendor else '',
                'date': b.bill_date.isoformat() if b.bill_date else None,
                'onbill': b.other_charges or Decimal('0'),
                'separate': Decimal('0'),
            }

        # ---- SEPARATE freight: FreightAdviceInbound(SEPARATE_SLIP) ----
        fqs = (FreightAdviceInbound.objects
               .filter(is_active=True, freight_source='SEPARATE_SLIP')
               .exclude(status='CANCELLED')
               .select_related('vendor_bill', 'vendor_bill__vendor', 'transporter',
                               'receipt_advice', 'receipt_advice__warehouse')
               .prefetch_related('covered_bills', 'freight_payments'))
        if frm:
            fqs = fqs.filter(freight_date__gte=frm)
        if to:
            fqs = fqs.filter(freight_date__lte=to)
        if vendor:
            # Keep slips tied to a goods bill from this vendor, through the
            # primary link or any shared/covered bill. Slips linked to no bill
            # (the Unmatched ones) carry no vendor and are therefore excluded
            # while a vendor is selected — they are not that supplier's freight.
            fqs = fqs.filter(Q(vendor_bill__vendor_id=vendor)
                             | Q(covered_bills__vendor_id=vendor)).distinct()

        separate_total = Decimal('0')
        separate_paid = Decimal('0')
        separate_count = 0
        by_transporter = {}          # name -> {amount, count}
        unmatched_rows = []
        unmatched_total = Decimal('0')
        sep_by_bill = {}             # vendor_bill_id -> amount (for match table)

        for fa in fqs:
            if company and self._company_of(fa) != str(company):
                continue
            payable = fa.get_total_payable() or Decimal('0')
            paid = fa.get_total_paid() or Decimal('0')
            separate_total += payable
            separate_paid += paid
            separate_count += 1

            tname = (fa.transporter.name if fa.transporter_id and fa.transporter
                     else 'Unspecified')
            slot = by_transporter.setdefault(tname, {'amount': Decimal('0'), 'count': 0})
            slot['amount'] += payable
            slot['count'] += 1

            # A slip COVERS a bill via the primary vendor_bill OR any of the
            # additional covered_bills (shared / "also covered"). Match on either —
            # a slip linked only through covered_bills (as the scan/backfill paths
            # do, which don't promote the first bill to vendor_bill) shows the bill
            # under "Bills covered" on the detail yet otherwise sits here in
            # Unmatched. Attribute the payable to the primary bill when set, else
            # the first covered bill, so the per-bill match table still balances.
            _covered = list(fa.covered_bills.all())   # prefetched above
            _linked_bill_id = fa.vendor_bill_id or (_covered[0].id if _covered else None)
            if _linked_bill_id:
                sep_by_bill[_linked_bill_id] = sep_by_bill.get(
                    _linked_bill_id, Decimal('0')) + payable
            else:
                unmatched_total += payable
                unmatched_rows.append({
                    'id': str(fa.id),
                    'advice_no': fa.advice_no or '',
                    'date': fa.freight_date.isoformat() if fa.freight_date else None,
                    'transporter': tname,
                    'amount': self._money(payable),
                })

        # Fold matched separate freight into the per-bill table (may add bills
        # that had no on-bill freight of their own).
        # Batch-fetch any bills not already in onbill_by_bill to avoid N+1.
        missing_bill_ids = [bid for bid in sep_by_bill if bid not in onbill_by_bill]
        missing_bills_map = {}
        if missing_bill_ids:
            missing_bills_map = {
                b.id: b for b in
                VendorBill.objects.filter(id__in=missing_bill_ids)
                .select_related('vendor')
            }
        for bill_id, amt in sep_by_bill.items():
            if bill_id in onbill_by_bill:
                onbill_by_bill[bill_id]['separate'] += amt
            else:
                b = missing_bills_map.get(bill_id)
                if not b:
                    continue
                if company and getattr(b.vendor, 'company_id', None) \
                        and str(b.vendor.company_id) != str(company):
                    continue
                if vendor and str(getattr(b, 'vendor_id', '') or '') != str(vendor):
                    # A slip can cover bills from more than one supplier; under a
                    # vendor filter only this supplier's bill belongs in the table.
                    continue
                onbill_by_bill[bill_id] = {
                    'bill_id': str(b.id),
                    'invoice_no': b.vendor_invoice_no or '',
                    'party': b.vendor.vendor_name if b.vendor else '',
                    'date': b.bill_date.isoformat() if b.bill_date else None,
                    'onbill': Decimal('0'),
                    'separate': amt,
                }

        total_freight = onbill_total + separate_total

        # Highest-freight purchases, biggest first.
        top_purchases = sorted(
            onbill_by_bill.values(),
            key=lambda r: (r['onbill'] + r['separate']), reverse=True)[:top_n]
        top_purchases = [{
            'bill_id': r['bill_id'],
            'invoice_no': r['invoice_no'],
            'party': r['party'],
            'date': r['date'],
            'onbill': self._money(r['onbill']),
            'separate': self._money(r['separate']),
            'total': self._money(r['onbill'] + r['separate']),
        } for r in top_purchases]

        # Transporter leaderboard, biggest first.
        leaderboard = sorted(
            ([k, v] for k, v in by_transporter.items()),
            key=lambda kv: kv[1]['amount'], reverse=True)
        by_transporter_out = [{
            'name': name,
            'amount': self._money(v['amount']),
            'count': v['count'],
            'pct': self._pct(v['amount'], separate_total),
        } for name, v in leaderboard]

        # Unmatched, biggest first, capped.
        unmatched_rows.sort(key=lambda r: Decimal(r['amount']), reverse=True)

        return Response({
            'from': frm.isoformat(),
            'to': to.isoformat(),
            # headline split
            'total_freight': self._money(total_freight),
            'onbill_total': self._money(onbill_total),
            'separate_total': self._money(separate_total),
            'onbill_pct': self._pct(onbill_total, total_freight),
            'separate_pct': self._pct(separate_total, total_freight),
            # counts
            'onbill_bill_count': onbill_bill_count,
            'separate_count': separate_count,
            'shipment_count': onbill_bill_count + separate_count,
            # separate payment status (on-bill is paid through the bill itself)
            'separate_paid': self._money(separate_paid),
            'separate_pending': self._money(
                separate_total - separate_paid if separate_total > separate_paid else Decimal('0')),
            # tables
            'by_transporter': by_transporter_out,
            'top_purchases': top_purchases,
            'unmatched': {
                'count': len(unmatched_rows),
                'amount': self._money(unmatched_total),
                'rows': unmatched_rows[:200],
            },
        })
