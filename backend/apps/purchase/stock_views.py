"""Simple purchase-driven Stock view (standalone).

On-hand quantity per product = SUM(ReceiptLine.quantity_received) across all
confirmed receipts. No issues/consumption tracked here (this standalone has no
production/dispatch), so stock = everything received. Optional warehouse filter.
Reporting-only; reads receipts, writes nothing.
"""
from decimal import Decimal

from django.db.models import Sum, Count
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated


class StockView(APIView):
    """GET /api/purchase/stock/?warehouse=&search="""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from .models import ReceiptLine

        warehouse_id = (request.query_params.get('warehouse') or '').strip() or None
        search = (request.query_params.get('search') or '').strip()

        qs = ReceiptLine.objects.filter(is_active=True, product__isnull=False)
        qs = qs.exclude(receipt__approval_status='REJECTED')
        if warehouse_id:
            qs = qs.filter(receipt__warehouse_id=warehouse_id)
        if search:
            qs = qs.filter(product__product_name__icontains=search)

        rows = (qs.values('product_id', 'product__product_name',
                          'product__sku_code', 'uom')
                  .annotate(on_hand=Sum('quantity_received'),
                            receipts=Count('receipt_id', distinct=True))
                  .order_by('-on_hand'))

        # Category (RM / PM) per product: take the dominant purchase category of
        # the bills that product appears on. RM -> RM, PACKING -> PM.
        from collections import Counter
        from .models import VendorBillLine
        cat_map = {}
        for bl in (VendorBillLine.objects.filter(product__isnull=False)
                   .exclude(bill__status='CANCELLED')
                   .values('product_id', 'bill__purchase_category')):
            cat_map.setdefault(bl['product_id'], Counter())[bl['bill__purchase_category'] or ''] += 1

        def _cat(pid):
            c = cat_map.get(pid)
            if not c:
                return ''
            top = c.most_common(1)[0][0]
            return {'RM': 'RM', 'PACKING': 'PM', 'MAIZE': 'RM',
                    'BOUGHT_NOTE': 'RM'}.get(top, top or '')

        out = []
        total_qty = Decimal('0')
        for r in rows:
            qty = r['on_hand'] or Decimal('0')
            total_qty += qty
            out.append({
                'product_id': str(r['product_id']),
                'product': r['product__product_name'] or '—',
                'sku': r['product__sku_code'] or '',
                'category': _cat(r['product_id']),
                'uom': r['uom'] or '',
                'on_hand': str(qty),
                'receipts': r['receipts'] or 0,
            })
        return Response({
            'items': out,
            'item_count': len(out),
            'total_qty': str(total_qty),
        })
