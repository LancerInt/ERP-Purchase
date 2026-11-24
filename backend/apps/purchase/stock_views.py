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
        import datetime
        from .models import ReceiptLine
        from inventory.models import OpeningStock

        warehouse_id = (request.query_params.get('warehouse') or '').strip() or None
        company_id = (request.query_params.get('company') or '').strip() or None
        category = (request.query_params.get('category') or '').strip().upper() or None
        search = (request.query_params.get('search') or '').strip()
        # As-of date: stock is computed as opening + receipts UP TO this date.
        # Blank = today (current stock).
        as_of_raw = (request.query_params.get('as_of') or '').strip()
        as_of = None
        if as_of_raw:
            try:
                as_of = datetime.date.fromisoformat(as_of_raw[:10])
            except ValueError:
                as_of = None

        qs = ReceiptLine.objects.filter(is_active=True, product__isnull=False)
        qs = qs.exclude(receipt__approval_status='REJECTED')
        if warehouse_id:
            qs = qs.filter(receipt__warehouse_id=warehouse_id)
        if company_id:
            qs = qs.filter(receipt__warehouse__company_id=company_id)
        if search:
            qs = qs.filter(product__product_name__icontains=search)
        if as_of:
            qs = qs.filter(receipt__receipt_date__lte=as_of)

        rows = (qs.values('product_id', 'product__product_name',
                          'product__sku_code', 'uom')
                  .annotate(on_hand=Sum('quantity_received'),
                            receipts=Count('receipt_id', distinct=True))
                  .order_by('-on_hand'))

        # Opening stock per product: latest OpeningStock as_of_date ≤ the viewed
        # date (or ≤ today). Added on top of receipts in the window.
        opening_qs = OpeningStock.objects.all()
        if warehouse_id:
            opening_qs = opening_qs.filter(warehouse_id=warehouse_id)
        if as_of:
            opening_qs = opening_qs.filter(as_of_date__lte=as_of)
        opening_map = {}
        for op in opening_qs.order_by('product_id', '-as_of_date'):
            if op.product_id not in opening_map:  # first = latest (ordered desc)
                opening_map[op.product_id] = op.quantity or Decimal('0')

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
        seen = set()
        for r in rows:
            pid = r['product_id']
            seen.add(pid)
            pcat = _cat(pid)
            if category and pcat != category:
                continue
            opening = opening_map.get(pid, Decimal('0'))
            received = r['on_hand'] or Decimal('0')
            qty = opening + received
            total_qty += qty
            out.append({
                'product_id': str(pid),
                'product': r['product__product_name'] or '—',
                'sku': r['product__sku_code'] or '',
                'category': _cat(pid),
                'uom': r['uom'] or '',
                'opening': str(opening),
                'received': str(received),
                'on_hand': str(qty),
                'receipts': r['receipts'] or 0,
            })

        # Products that have an opening balance but no receipts in the window.
        if opening_map:
            from master.models import Product
            missing = [pid for pid in opening_map if pid not in seen]
            if missing:
                for p in Product.objects.filter(id__in=missing):
                    opening = opening_map.get(p.id, Decimal('0'))
                    total_qty += opening
                    out.append({
                        'product_id': str(p.id),
                        'product': p.product_name or '—',
                        'sku': p.sku_code or '',
                        'category': _cat(p.id),
                        'uom': '',
                        'opening': str(opening),
                        'received': '0',
                        'on_hand': str(opening),
                        'receipts': 0,
                    })
                out.sort(key=lambda x: Decimal(x['on_hand']), reverse=True)
        return Response({
            'items': out,
            'item_count': len(out),
            'total_qty': str(total_qty),
            'as_of': as_of.isoformat() if as_of else None,
        })

    def post(self, request):
        """Set / update opening stock for a product.

        Body: { product, quantity, as_of_date (YYYY-MM-DD), warehouse?, uom? }
        Upserts the opening row for that product+date so the Stock figures
        recompute dynamically for the viewed period.
        """
        import datetime
        from inventory.models import OpeningStock
        product_id = request.data.get('product')
        qty = request.data.get('quantity')
        as_of = request.data.get('as_of_date')
        if not product_id or qty is None or not as_of:
            return Response({'detail': 'product, quantity and as_of_date are required.'}, status=400)
        try:
            as_of_d = datetime.date.fromisoformat(str(as_of)[:10])
            qty_d = Decimal(str(qty))
        except (ValueError, Exception):
            return Response({'detail': 'invalid quantity or date.'}, status=400)
        row, _ = OpeningStock.objects.update_or_create(
            product_id=product_id, as_of_date=as_of_d,
            warehouse_id=request.data.get('warehouse') or None,
            defaults={'quantity': qty_d, 'uom': request.data.get('uom', '')},
        )
        return Response({'id': str(row.id), 'product': str(row.product_id),
                         'as_of_date': row.as_of_date.isoformat(),
                         'quantity': str(row.quantity)}, status=201)


class StockProductView(APIView):
    """GET /api/purchase/stock/<product_id>/ — the movement history that builds
    one product's on-hand: opening balance(s) + each receipt (date, GRN no,
    vendor, qty). Optional company / as_of filters, same as the list."""
    permission_classes = [IsAuthenticated]

    def get(self, request, product_id):
        import datetime
        from .models import ReceiptLine
        from master.models import Product
        from inventory.models import OpeningStock

        company_id = (request.query_params.get('company') or '').strip() or None
        as_of_raw = (request.query_params.get('as_of') or '').strip()
        as_of = None
        if as_of_raw:
            try:
                as_of = datetime.date.fromisoformat(as_of_raw[:10])
            except ValueError:
                as_of = None

        product = Product.objects.filter(id=product_id).first()
        if not product:
            return Response({'detail': 'product not found.'}, status=404)

        moves = []
        # Opening balances (one or more, latest kept as the base).
        opq = OpeningStock.objects.filter(product_id=product_id)
        if company_id:
            opq = opq.filter(warehouse__company_id=company_id)
        if as_of:
            opq = opq.filter(as_of_date__lte=as_of)
        for op in opq.order_by('as_of_date'):
            moves.append({
                'date': op.as_of_date.isoformat() if op.as_of_date else None,
                'type': 'Opening',
                'reference': 'Opening balance',
                'vendor': '',
                'qty_in': str(op.quantity or 0),
                'uom': op.uom or '',
            })

        # Receipt lines for this product.
        rlq = (ReceiptLine.objects.filter(product_id=product_id, is_active=True)
               .exclude(receipt__approval_status='REJECTED')
               .select_related('receipt', 'receipt__vendor'))
        if company_id:
            rlq = rlq.filter(receipt__warehouse__company_id=company_id)
        if as_of:
            rlq = rlq.filter(receipt__receipt_date__date__lte=as_of)
        for rl in rlq.order_by('receipt__receipt_date'):
            rc = rl.receipt
            moves.append({
                'date': rc.receipt_date.date().isoformat() if rc and rc.receipt_date else None,
                'type': 'Receipt',
                'reference': rc.receipt_advice_no if rc else '',
                'vendor': (rc.vendor.vendor_name if (rc and rc.vendor_id) else ''),
                'qty_in': str(rl.quantity_received or 0),
                'uom': rl.uom or '',
            })

        moves.sort(key=lambda m: (m['date'] or '9999'))
        # Running balance.
        running = Decimal('0')
        for m in moves:
            running += Decimal(str(m['qty_in'] or 0))
            m['balance'] = str(running)

        return Response({
            'product_id': str(product.id),
            'product': product.product_name,
            'sku': product.sku_code or '',
            'on_hand': str(running),
            'moves': moves,
        })
