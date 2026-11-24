"""Simple purchase-driven Stock view (standalone).

On-hand quantity per product = Opening + SUM(ReceiptLine.quantity_received)
− SUM(StockIssue.quantity). Receipts come from confirmed receipts; issues are
entered manually on the Stock page (this standalone has no production/dispatch
feed). 'Used' = total issued, and an item is 'Unused' when nothing has ever
been issued against it. Optional warehouse / company / as-of filters.
"""
from decimal import Decimal

from django.db.models import Sum, Count
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated


# ── UOM ↔ category rules ────────────────────────────────────────────────────
# RM (raw material) is measured by WEIGHT / VOLUME; PM (packing material) is
# counted in PIECES. A weight unit on a packing item (e.g. "MT" for Bag/Liner)
# is almost always a data-entry mistake, so the issue form validates against
# these sets and the API rejects a mismatch with a helpful message.
RM_UOMS = {'MT', 'KG', 'QTL', 'QUINTAL', 'G', 'GM', 'GRAM', 'TON', 'TONNE',
           'L', 'LTR', 'LITRE', 'LITER', 'ML', 'KL'}
PM_UOMS = {'PCS', 'PC', 'NOS', 'NO', 'UNIT', 'UNITS', 'ROLL', 'ROLLS', 'BAG',
           'BAGS', 'BOX', 'BOXES', 'BUNDLE', 'SET', 'SETS', 'PKT', 'PACKET',
           'SHEET', 'SHEETS', 'PAIR', 'DOZEN', 'REAM'}


def uom_fits_category(uom, category):
    """True if `uom` is sensible for the product's `category` (RM / PM).

    Returns True when there is no opinion (unknown category, blank uom, or a
    unit in neither list) so we never block a legitimate custom unit — we only
    flag a clear cross-type mistake (a weight unit on PM, or a count unit on RM).
    """
    u = (uom or '').strip().upper()
    cat = (category or '').strip().upper()
    if not u or cat not in ('RM', 'PM'):
        return True
    if cat == 'RM':
        # Wrong only if it's a KNOWN packing (count) unit.
        return u not in PM_UOMS
    # PM: wrong only if it's a KNOWN weight/volume unit.
    return u not in RM_UOMS


def allowed_uoms_for(category):
    """The suggested UOMs for a category, for the error message."""
    cat = (category or '').strip().upper()
    if cat == 'RM':
        return ['MT', 'KG', 'QTL', 'G', 'L', 'ML']
    if cat == 'PM':
        return ['PCS', 'NOS', 'ROLL', 'BAG', 'BOX', 'SET']
    return []


def product_category(product_id):
    """RM / PM / '' for a product, from the dominant purchase category of the
    (non-cancelled) bills it appears on — same rule the Stock list uses."""
    from collections import Counter
    from .models import VendorBillLine
    c = Counter()
    for bl in (VendorBillLine.objects.filter(product_id=product_id)
               .exclude(bill__status='CANCELLED')
               .values_list('bill__purchase_category', flat=True)):
        c[bl or ''] += 1
    if not c:
        return ''
    top = c.most_common(1)[0][0]
    return {'RM': 'RM', 'PACKING': 'PM', 'MAIZE': 'RM', 'BOUGHT_NOTE': 'RM'}.get(top, top or '')


class StockView(APIView):
    """GET /api/purchase/stock/?warehouse=&search="""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        import datetime
        from .models import ReceiptLine
        from inventory.models import OpeningStock, StockIssue

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

        # Group by PRODUCT only (not uom) so a product received in mixed units
        # shows as ONE row, not one per unit. The representative UOM is the one
        # on the most receipt lines (computed below).
        rows = (qs.values('product_id', 'product__product_name',
                          'product__sku_code')
                  .annotate(on_hand=Sum('quantity_received'),
                            receipts=Count('receipt_id', distinct=True))
                  .order_by('-on_hand'))

        # Dominant UOM per product (most line occurrences).
        from collections import Counter as _Counter
        uom_ctr = {}
        for rl in qs.values('product_id', 'uom'):
            uom_ctr.setdefault(rl['product_id'], _Counter())[rl['uom'] or ''] += 1
        uom_map = {pid: (c.most_common(1)[0][0] if c else '') for pid, c in uom_ctr.items()}

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

        # Issued / used per product: SUM(StockIssue.quantity) up to the viewed
        # date, scoped by the same warehouse / company filters. Subtracted from
        # on-hand; also surfaced as the 'Used' figure.
        from django.db.models import Q
        issue_qs = StockIssue.objects.all()
        if warehouse_id:
            issue_qs = issue_qs.filter(warehouse_id=warehouse_id)
        if company_id:
            # A manually entered issue with NO warehouse is company-agnostic, so
            # a company filter keeps it alongside that company's rows.
            issue_qs = issue_qs.filter(Q(warehouse__company_id=company_id) | Q(warehouse__isnull=True))
        if as_of:
            issue_qs = issue_qs.filter(issue_date__lte=as_of)
        issue_map = {}
        for row in (issue_qs.values('product_id')
                    .annotate(used=Sum('quantity'))):
            issue_map[row['product_id']] = row['used'] or Decimal('0')

        # Bill-line stock-in — so a SCANNED / MANUAL bill (which has no receipt)
        # still adds to stock. DEDUP with receipts: count a bill's lines ONLY
        # when the bill has no linked receipt; if a receipt IS linked, the
        # receipt above already carries the goods (receipt wins → no double).
        from .models import VendorBillLine as _VBL
        bill_in_qs = (_VBL.objects.filter(is_active=True, product__isnull=False,
                                          bill__receipt_advice__isnull=True)
                      .exclude(bill__status='CANCELLED'))
        if warehouse_id:
            bill_in_qs = bill_in_qs.filter(bill__warehouse_id=warehouse_id)
        if company_id:
            bill_in_qs = bill_in_qs.filter(bill__warehouse__company_id=company_id)
        if as_of:
            bill_in_qs = bill_in_qs.filter(bill__bill_date__lte=as_of)
        bill_in_map = {}
        bill_uom_ctr = {}
        for r in bill_in_qs.values('product_id', 'uom').annotate(q=Sum('quantity')):
            bill_in_map[r['product_id']] = bill_in_map.get(r['product_id'], Decimal('0')) + (r['q'] or Decimal('0'))
            bill_uom_ctr.setdefault(r['product_id'], _Counter())[r['uom'] or ''] += 1
        # A product with ONLY bill-in (no receipts) still needs a row + a UOM.
        for pid, ctr in bill_uom_ctr.items():
            uom_map.setdefault(pid, ctr.most_common(1)[0][0] if ctr else '')

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
            # Received = goods from receipts PLUS goods from receipt-less bills
            # (scan / manual). Receipt-linked bills are already in the receipt
            # figure, so they're excluded from bill_in_map (no double count).
            received = (r['on_hand'] or Decimal('0')) + bill_in_map.get(pid, Decimal('0'))
            used = issue_map.get(pid, Decimal('0'))
            qty = opening + received - used
            total_qty += qty
            out.append({
                'product_id': str(pid),
                'product': r['product__product_name'] or '—',
                'sku': r['product__sku_code'] or '',
                'category': _cat(pid),
                'uom': uom_map.get(pid, '') or '',
                'opening': str(opening),
                'received': str(received),
                'used': str(used),
                'is_used': used > 0,
                'on_hand': str(qty),
                'receipts': r['receipts'] or 0,
            })

        # Products with an opening balance OR receipt-less bill-in but no receipt
        # row in the window (so a scan-only / manual-bill-only product still shows).
        extra_pids = (set(opening_map) | set(bill_in_map)) - seen
        if extra_pids:
            from master.models import Product
            for p in Product.objects.filter(id__in=extra_pids):
                pcat = _cat(p.id)
                if category and pcat != category:
                    continue
                opening = opening_map.get(p.id, Decimal('0'))
                received = bill_in_map.get(p.id, Decimal('0'))
                used = issue_map.get(p.id, Decimal('0'))
                qty = opening + received - used
                total_qty += qty
                out.append({
                    'product_id': str(p.id),
                    'product': p.product_name or '—',
                    'sku': p.sku_code or '',
                    'category': pcat,
                    'uom': uom_map.get(p.id, '') or '',
                    'opening': str(opening),
                    'received': str(received),
                    'used': str(used),
                    'is_used': used > 0,
                    'on_hand': str(qty),
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
        """Set opening stock OR record a stock issue (used / consumed), by action.

        action='issue':  record a quantity USED out of stock.
            Body: { action:'issue', product, quantity, issue_date (YYYY-MM-DD),
                    warehouse?, uom?, note? }
        action omitted / 'opening':  set/update opening stock (upsert per date).
            Body: { product, quantity, as_of_date (YYYY-MM-DD), warehouse?, uom? }
        Both recompute the Stock figures dynamically.
        """
        import datetime
        from inventory.models import OpeningStock, StockIssue
        action = (request.data.get('action') or 'opening').strip().lower()
        product_id = request.data.get('product')
        qty = request.data.get('quantity')

        if action == 'issue':
            issue_date = request.data.get('issue_date') or request.data.get('as_of_date')
            if not product_id or qty is None or not issue_date:
                return Response({'detail': 'product, quantity and issue_date are required.'}, status=400)
            try:
                d = datetime.date.fromisoformat(str(issue_date)[:10])
                qty_d = Decimal(str(qty))
            except (ValueError, Exception):
                return Response({'detail': 'invalid quantity or date.'}, status=400)
            if qty_d <= 0:
                return Response({'detail': 'quantity must be greater than 0.'}, status=400)
            # UOM sanity: a packing (PM) item should not be issued in a weight
            # unit, nor a raw-material (RM) item in a count unit. Reject a clear
            # cross-type mistake with a helpful message, unless the caller
            # explicitly overrides via force_uom=true.
            # Store UOM uppercased so it reads consistently with receipt units
            # (MT / KG), never a stray lowercase 'kg'.
            uom = (request.data.get('uom') or '').strip().upper()
            force = str(request.data.get('force_uom', '')).lower() in ('1', 'true', 'yes')
            cat = product_category(product_id)
            if uom and not force and not uom_fits_category(uom, cat):
                allowed = allowed_uoms_for(cat)
                kind = 'packing' if cat == 'PM' else 'raw-material'
                return Response({
                    'detail': f"'{uom.upper()}' doesn't look right for a {kind} ({cat}) item. "
                              f"Try one of: {', '.join(allowed)}.",
                    'code': 'uom_mismatch',
                    'category': cat,
                    'allowed_uoms': allowed,
                }, status=400)
            row = StockIssue.objects.create(
                product_id=product_id, issue_date=d, quantity=qty_d,
                warehouse_id=request.data.get('warehouse') or None,
                uom=uom, note=request.data.get('note', ''),
            )
            return Response({'id': str(row.id), 'product': str(row.product_id),
                             'issue_date': row.issue_date.isoformat(),
                             'quantity': str(row.quantity)}, status=201)

        # Default: set / update opening stock.
        as_of = request.data.get('as_of_date')
        if not product_id or qty is None or not as_of:
            return Response({'detail': 'product, quantity and as_of_date are required.'}, status=400)
        try:
            as_of_d = datetime.date.fromisoformat(str(as_of)[:10])
            qty_d = Decimal(str(qty))
        except (ValueError, Exception):
            return Response({'detail': 'invalid quantity or date.'}, status=400)
        # Same UOM rule as issues: uppercase, and reject a clear PM↔weight /
        # RM↔count mismatch unless force_uom=true.
        uom = (request.data.get('uom') or '').strip().upper()
        force = str(request.data.get('force_uom', '')).lower() in ('1', 'true', 'yes')
        cat = product_category(product_id)
        if uom and not force and not uom_fits_category(uom, cat):
            allowed = allowed_uoms_for(cat)
            kind = 'packing' if cat == 'PM' else 'raw-material'
            return Response({
                'detail': f"'{uom}' doesn't look right for a {kind} ({cat}) item. "
                          f"Try one of: {', '.join(allowed)}.",
                'code': 'uom_mismatch', 'category': cat, 'allowed_uoms': allowed,
            }, status=400)
        row, _ = OpeningStock.objects.update_or_create(
            product_id=product_id, as_of_date=as_of_d,
            warehouse_id=request.data.get('warehouse') or None,
            defaults={'quantity': qty_d, 'uom': uom},
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
        from inventory.models import OpeningStock, StockIssue

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

        from django.db.models import Q
        moves = []
        # Opening balances (one or more, latest kept as the base). A manually
        # entered opening with NO warehouse is company-agnostic, so a company
        # filter keeps it (warehouse is null) alongside that company's rows.
        opq = OpeningStock.objects.filter(product_id=product_id)
        if company_id:
            opq = opq.filter(Q(warehouse__company_id=company_id) | Q(warehouse__isnull=True))
        if as_of:
            opq = opq.filter(as_of_date__lte=as_of)
        for op in opq.order_by('as_of_date'):
            moves.append({
                'date': op.as_of_date.isoformat() if op.as_of_date else None,
                'type': 'Opening Stock',
                'reference': f'Opening stock as on {op.as_of_date.isoformat()}' if op.as_of_date else 'Opening stock',
                'vendor': '',
                'qty_in': str(op.quantity or 0),
                'qty_out': '0',
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
                'qty_out': '0',
                'uom': rl.uom or '',
            })

        # Bill lines from receipt-LESS bills (scan / manual) — these bring goods
        # in just like a receipt. Receipt-linked bills are skipped here because
        # the receipt above already counted them (no double count).
        from .models import VendorBillLine as _VBL
        blq = (_VBL.objects.filter(product_id=product_id, is_active=True,
                                   bill__receipt_advice__isnull=True)
               .exclude(bill__status='CANCELLED')
               .select_related('bill', 'bill__vendor'))
        if company_id:
            blq = blq.filter(bill__warehouse__company_id=company_id)
        if as_of:
            blq = blq.filter(bill__bill_date__lte=as_of)
        for bl in blq.order_by('bill__bill_date'):
            b = bl.bill
            moves.append({
                'date': b.bill_date.isoformat() if b and b.bill_date else None,
                'type': 'Bill',
                'reference': (b.vendor_invoice_no or b.bill_no or '') if b else '',
                'vendor': (b.vendor.vendor_name if (b and b.vendor_id) else ''),
                'qty_in': str(bl.quantity or 0),
                'qty_out': '0',
                'uom': bl.uom or '',
            })

        # Stock issues (used / consumed) — these go OUT. A manually entered issue
        # with NO warehouse is company-agnostic, so a company filter keeps it.
        isq = StockIssue.objects.filter(product_id=product_id)
        if company_id:
            isq = isq.filter(Q(warehouse__company_id=company_id) | Q(warehouse__isnull=True))
        if as_of:
            isq = isq.filter(issue_date__lte=as_of)
        total_used = Decimal('0')
        for si in isq.order_by('issue_date'):
            total_used += si.quantity or Decimal('0')
            moves.append({
                'date': si.issue_date.isoformat() if si.issue_date else None,
                'type': 'Issued',
                'reference': si.note or 'Stock used',
                'vendor': '',
                'qty_in': '0',
                'qty_out': str(si.quantity or 0),
                'uom': si.uom or '',
            })

        moves.sort(key=lambda m: (m['date'] or '9999'))
        # Running balance = cumulative in − out.
        running = Decimal('0')
        for m in moves:
            running += Decimal(str(m['qty_in'] or 0)) - Decimal(str(m['qty_out'] or 0))
            m['balance'] = str(running)

        return Response({
            'product_id': str(product.id),
            'product': product.product_name,
            'sku': product.sku_code or '',
            'on_hand': str(running),
            'used': str(total_used),
            'is_used': total_used > 0,
            'moves': moves,
        })
