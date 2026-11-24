"""Purchase item rate / qty trend + vendor comparison — the data behind the
Purchase Report's "Top purchased items", "Item qty & rate trend" and
"Vendor comparison" sub-reports.

All computed from VendorBillLine (non-cancelled bills), so every bill source
(scan / receipt / manual) is included. No Tally. Company + date window scoped,
matching the other report endpoints.

GET /api/purchase/item-rate-trend/?from=&to=&company=&mode=
  default              -> { items: [{item, uom, category, total_qty, total_value,
                                     months{YYYY-MM: rate}, change_pct}], months: [] }
  mode=vendor-comparison -> { items: [{item, category, cheapest_vendor,
                                       vendors:[{vendor, qty, rate, amount}]}] }
"""
from collections import defaultdict
from decimal import Decimal
import datetime

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated


Z = Decimal('0')


def _pd(s):
    try:
        return datetime.date.fromisoformat((s or '')[:10])
    except (ValueError, TypeError):
        return None


class PurchaseItemRateTrendView(APIView):
    """Purchase-side item rate/qty trend and vendor comparison, from bill lines."""
    permission_classes = [IsAuthenticated]
    module_name = 'Consolidated Report'

    def get(self, request):
        from .models import VendorBillLine
        from .stock_views import product_category  # dominant RM/PM per product
        self._product_category = product_category

        company = (request.query_params.get('company') or '').strip() or None
        frm = _pd(request.query_params.get('from'))
        to = _pd(request.query_params.get('to'))
        mode = (request.query_params.get('mode') or '').strip().lower()

        qs = (VendorBillLine.objects.filter(is_active=True, product__isnull=False)
              .exclude(bill__status='CANCELLED')
              .select_related('bill', 'bill__vendor', 'product'))
        if company:
            qs = qs.filter(bill__vendor__company_id=company)
        if frm:
            qs = qs.filter(bill__bill_date__gte=frm)
        if to:
            qs = qs.filter(bill__bill_date__lte=to)

        if mode == 'vendor-comparison':
            return Response(self._vendor_comparison(qs))
        return Response(self._rate_trend(qs))

    # ── item qty & rate trend + top items ───────────────────────────────────
    def _rate_trend(self, qs):
        # Per item: total qty, total value, a per-MONTH average rate, and the
        # % change from the first month with a rate to the last.
        items = {}          # item name -> aggregate
        months_seen = set()
        # month -> item -> [qty, value] for a qty-weighted average rate.
        month_acc = defaultdict(lambda: defaultdict(lambda: [Z, Z]))

        from collections import Counter
        uom_votes = defaultdict(Counter)   # item -> Counter of uoms seen
        pid_of = {}                        # item -> a product id (for category)
        for ln in qs:
            name = (ln.product.product_name if ln.product_id else (ln.description or '')).strip() or '—'
            qty = Decimal(str(ln.quantity or 0))
            val = Decimal(str(ln.amount or 0))
            it = items.setdefault(name, {
                'item': name, 'uom': '', 'category': '',
                'total_qty': Z, 'total_value': Z,
            })
            it['total_qty'] += qty
            it['total_value'] += val
            if ln.uom:
                uom_votes[name][ln.uom.strip().upper()] += 1
            if ln.product_id and name not in pid_of:
                pid_of[name] = ln.product_id
            if ln.bill_id and ln.bill.bill_date:
                ym = ln.bill.bill_date.strftime('%Y-%m')
                months_seen.add(ym)
                acc = month_acc[ym][name]
                acc[0] += qty
                acc[1] += val

        months = sorted(months_seen)
        out = []
        for name, it in items.items():
            # Category = the product's DOMINANT purchase category (RM / PM),
            # same rule as the Stock page — not whatever a single line's bill
            # happened to be tagged. UOM = the most-seen unit for the item.
            pid = pid_of.get(name)
            it['category'] = self._product_category(pid) if pid else ''
            it['uom'] = (uom_votes[name].most_common(1)[0][0] if uom_votes[name] else '')
            # One point per month (aligned to `months`): qty-weighted avg rate +
            # total qty, or nulls when nothing was bought that month. This is the
            # exact shape the Report's rate-trend table renders (it.points).
            points = []
            for ym in months:
                q, v = month_acc[ym].get(name, (Z, Z))
                points.append({
                    'month': ym,
                    'rate': round(float(v / q), 2) if q else None,
                    'qty': float(q) if q else None,
                })
            rated = [p['rate'] for p in points if p['rate'] is not None]
            change_pct = None
            if len(rated) >= 2 and rated[0]:
                change_pct = (rated[-1] - rated[0]) / rated[0] * 100
            out.append({
                'item': name, 'uom': it['uom'], 'category': it['category'],
                'total_qty': str(it['total_qty']),
                'total_value': str(it['total_value']),
                'points': points,
                # 'dropped' = the latest rate fell vs the previous one (flag the
                # most-recent cell red in the table).
                'dropped': bool(len(rated) >= 2 and rated[-1] < rated[-2]),
                'change_pct': round(change_pct, 2) if change_pct is not None else None,
            })
        out.sort(key=lambda x: Decimal(x['total_value']), reverse=True)
        return {'items': out, 'months': months}

    # ── vendor comparison ────────────────────────────────────────────────────
    def _vendor_comparison(self, qs):
        # Per item, the vendors who supplied it and each vendor's qty / avg rate /
        # amount, flagging the cheapest (lowest avg rate). Only items bought from
        # 2+ vendors are interesting, so filter to those.
        acc = defaultdict(lambda: {'pid': None, 'vendors': defaultdict(lambda: [Z, Z])})
        for ln in qs:
            name = (ln.product.product_name if ln.product_id else (ln.description or '')).strip() or '—'
            vend = (ln.bill.vendor.vendor_name if (ln.bill_id and ln.bill.vendor_id) else '—')
            qty = Decimal(str(ln.quantity or 0))
            val = Decimal(str(ln.amount or 0))
            entry = acc[name]
            if entry['pid'] is None and ln.product_id:
                entry['pid'] = ln.product_id
            v = entry['vendors'][vend]
            v[0] += qty
            v[1] += val

        items = []
        for name, entry in acc.items():
            vendors = []
            for vend, (qty, val) in entry['vendors'].items():
                rate = float(val / qty) if qty else 0.0
                vendors.append({'vendor': vend, 'qty': str(qty), 'rate': round(rate, 2), 'amount': str(val)})
            if len(vendors) < 2:
                continue   # only multi-vendor items are worth comparing
            vendors.sort(key=lambda x: x['rate'])
            items.append({
                'item': name,
                'category': self._product_category(entry['pid']) if entry['pid'] else '',
                'cheapest_vendor': vendors[0]['vendor'] if vendors else None,
                'vendors': vendors,
            })
        items.sort(key=lambda x: x['item'].lower())
        return {'items': items}
