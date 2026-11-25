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

        godown_id = (request.query_params.get('godown') or '').strip() or None
        if godown_id:
            qs = qs.filter(godown_location_id=godown_id)

        # Group receipts by PRODUCT × WAREHOUSE × GODOWN so each physical
        # location is its own row. The representative UOM is per-product (the
        # unit on most receipt lines), computed below.
        rows = (qs.values('product_id', 'product__product_name',
                          'product__sku_code',
                          'receipt__warehouse_id', 'godown_location_id')
                  .annotate(on_hand=Sum('quantity_received'),
                            receipts=Count('receipt_id', distinct=True))
                  .order_by('-on_hand'))

        # Dominant UOM per product (most line occurrences).
        from collections import Counter as _Counter
        uom_ctr = {}
        for rl in qs.values('product_id', 'uom'):
            uom_ctr.setdefault(rl['product_id'], _Counter())[rl['uom'] or ''] += 1
        uom_map = {pid: (c.most_common(1)[0][0] if c else '') for pid, c in uom_ctr.items()}

        # Opening stock per (product, warehouse): latest OpeningStock
        # as_of_date ≤ the viewed date. OpeningStock has no godown, so it keys
        # by (pid, warehouse_id) and is attributed to ONE bucket per (pid, wh)
        # below (never split across that warehouse's godowns → no double-count).
        opening_qs = OpeningStock.objects.all()
        if warehouse_id:
            opening_qs = opening_qs.filter(warehouse_id=warehouse_id)
        if as_of:
            opening_qs = opening_qs.filter(as_of_date__lte=as_of)
        opening_map = {}
        for op in opening_qs.order_by('product_id', 'warehouse_id', '-as_of_date'):
            key = (op.product_id, op.warehouse_id)
            if key not in opening_map:  # first = latest (ordered desc)
                opening_map[key] = op.quantity or Decimal('0')

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
        # Keyed by (product, warehouse) — StockIssue has no godown. Attributed
        # to one bucket per (pid, wh) below, same as opening.
        issue_map = {}
        for row in (issue_qs.values('product_id', 'warehouse_id')
                    .annotate(used=Sum('quantity'))):
            issue_map[(row['product_id'], row['warehouse_id'])] = row['used'] or Decimal('0')

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
        # Keyed by (product, warehouse). A bill has no godown, so its stock-in
        # lands on a godown=None bucket for that (pid, wh).
        bill_in_map = {}
        bill_uom_ctr = {}
        for r in bill_in_qs.values('product_id', 'bill__warehouse_id', 'uom').annotate(q=Sum('quantity')):
            k = (r['product_id'], r['bill__warehouse_id'])
            bill_in_map[k] = bill_in_map.get(k, Decimal('0')) + (r['q'] or Decimal('0'))
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

        # Name maps for the warehouse / godown ids that appear, so each row can
        # label its location. Only the ids present are queried.
        wh_ids = {r['receipt__warehouse_id'] for r in rows if r['receipt__warehouse_id']}
        wh_ids |= {k[1] for k in opening_map if k[1]}
        wh_ids |= {k[1] for k in issue_map if k[1]}
        wh_ids |= {k[1] for k in bill_in_map if k[1]}
        gd_ids = {r['godown_location_id'] for r in rows if r['godown_location_id']}
        wh_name, gd_name = {}, {}
        if wh_ids:
            from core.models import Warehouse
            wh_name = {w.id: w.name for w in Warehouse.objects.filter(id__in=wh_ids)}
        if gd_ids:
            from core.models import Godown
            gd_name = {g.id: g.godown_name for g in Godown.objects.filter(id__in=gd_ids)}

        # Opening & Used are per (product, warehouse) — they must NOT be split
        # across that warehouse's godowns (that would double-count). So they're
        # added to exactly ONE bucket per (pid, wh): the first row emitted for
        # that pair (rows are ordered by -received, so the largest godown
        # bucket). Any (pid, wh) that has opening/used but NO receipt bucket is
        # emitted as its own godown=None row below. Received is per location.
        # Grand total_qty = Σ opening + Σ received − Σ used = the old per-product
        # total (location grouping only redistributes the same quantities).
        out = []
        total_qty = Decimal('0')
        opening_applied = set()   # (pid, wh) whose opening/used already placed
        seen_pw = set()           # (pid, wh) that got at least one receipt row

        for r in rows:
            pid = r['product_id']
            wh = r['receipt__warehouse_id']
            gd = r['godown_location_id']
            pcat = _cat(pid)
            if category and pcat != category:
                continue
            seen_pw.add((pid, wh))
            received = r['on_hand'] or Decimal('0')
            # Fold this warehouse's receipt-less bill-in onto its FIRST bucket.
            pw = (pid, wh)
            if pw not in opening_applied:
                received += bill_in_map.get(pw, Decimal('0'))
                opening = opening_map.get(pw, Decimal('0'))
                used = issue_map.get(pw, Decimal('0'))
                opening_applied.add(pw)
            else:
                opening = Decimal('0')
                used = Decimal('0')
            qty = opening + received - used
            total_qty += qty
            out.append({
                'product_id': str(pid),
                'product': r['product__product_name'] or '—',
                'sku': r['product__sku_code'] or '',
                'category': pcat,
                'uom': uom_map.get(pid, '') or '',
                'warehouse_id': str(wh) if wh else '',
                'warehouse': wh_name.get(wh, '') if wh else '',
                'godown_id': str(gd) if gd else '',
                'godown': gd_name.get(gd, '') if gd else '',
                'opening': str(opening),
                'received': str(received),
                'used': str(used),
                'is_used': used > 0,
                'on_hand': str(qty),
                'receipts': r['receipts'] or 0,
            })

        # (product, warehouse) pairs with opening / bill-in / used but no receipt
        # bucket in the window → emit a godown-less row carrying them, so a
        # scan-only / manual / opening-only location still shows.
        extra_pw = (set(opening_map) | set(bill_in_map) | set(issue_map)) - opening_applied
        if extra_pw:
            from master.models import Product
            prod_name = {p.id: p for p in Product.objects.filter(
                id__in={pw[0] for pw in extra_pw})}
            for (pid, wh) in extra_pw:
                p = prod_name.get(pid)
                if not p:
                    continue
                pcat = _cat(pid)
                if category and pcat != category:
                    continue
                if warehouse_id and str(wh) != str(warehouse_id):
                    continue
                if godown_id:   # these carry no godown, so a godown filter excludes them
                    continue
                opening = opening_map.get((pid, wh), Decimal('0'))
                received = bill_in_map.get((pid, wh), Decimal('0'))
                used = issue_map.get((pid, wh), Decimal('0'))
                qty = opening + received - used
                total_qty += qty
                out.append({
                    'product_id': str(pid),
                    'product': p.product_name or '—',
                    'sku': p.sku_code or '',
                    'category': pcat,
                    'uom': uom_map.get(pid, '') or '',
                    'warehouse_id': str(wh) if wh else '',
                    'warehouse': wh_name.get(wh, '') if wh else '',
                    'godown_id': '',
                    'godown': '',
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
