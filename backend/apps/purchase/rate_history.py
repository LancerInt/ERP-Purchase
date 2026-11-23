"""Previous-rate history for a (vendor, product) pair.

Surfaces the unit prices this vendor previously QUOTED and the rates they were
actually ORDERED at, so a buyer entering a new quote line can sanity-check the
rate against history. Read-only; most-recent first.
"""
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def vendor_product_rates(request):
    """GET ?vendor=<id>&product=<id> → { quotes: [...], orders: [...] }."""
    vendor_id = request.query_params.get('vendor')
    product_id = request.query_params.get('product')
    if not vendor_id or not product_id:
        return Response({'quotes': [], 'orders': []})

    from .models import POLine, QuoteLine

    quotes = (
        QuoteLine.objects
        .filter(quote__vendor_id=vendor_id, product_service_id=product_id)
        .select_related('quote')
        .order_by('-quote__quote_date')[:10]
    )
    orders = (
        POLine.objects
        .filter(po__vendor_id=vendor_id, product_service_id=product_id)
        .select_related('po')
        .order_by('-po__po_date')[:10]
    )

    return Response({
        'quotes': [{
            'doc': line.quote.quote_id,
            'date': line.quote.quote_date,
            'rate': line.unit_price,
            'qty': line.quantity_offered,
            'uom': line.uom,
            'gst': line.gst,
        } for line in quotes],
        'orders': [{
            'doc': line.po.po_no,
            'date': line.po.po_date,
            'rate': line.unit_price,
            'qty': line.quantity_ordered,
            'uom': line.uom,
            'gst': line.gst,
        } for line in orders],
    })
