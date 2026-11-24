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

        out = []
        total_qty = Decimal('0')
        for r in rows:
            qty = r['on_hand'] or Decimal('0')
            total_qty += qty
            out.append({
                'product_id': str(r['product_id']),
                'product': r['product__product_name'] or '—',
                'sku': r['product__sku_code'] or '',
                'uom': r['uom'] or '',
                'on_hand': str(qty),
                'receipts': r['receipts'] or 0,
            })
        return Response({
            'items': out,
            'item_count': len(out),
            'total_qty': str(total_qty),
        })
